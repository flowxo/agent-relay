import type { Readable } from "node:stream";

import {
  RELAY_MCP_PROTOCOL_VERSION,
  RELAY_MCP_SURFACE_VERSION,
  RELAY_MCP_TOOL_DEFINITIONS,
  RelayMcpAskV1Schema,
  RelayMcpCancelV1Schema,
  RelayMcpErrorV1Schema,
  RelayMcpQuestionnaireV1Schema,
  RelayMcpStatusV1Schema,
  RelayMcpToolResultV1Schema,
} from "@agent-relay/protocol";
import type {
  Harness,
  RelayMcpErrorCode,
  RelayMcpToolResultV1,
} from "@agent-relay/protocol";
import { z } from "zod";

import { RelayClient, RelayClientError } from "./client.js";

const LOCAL_FALLBACK =
  "Ask the operator locally with the harness's native question mechanism." as const;
const MAX_MCP_LINE_BYTES = 128 * 1024;
const MAX_MCP_IN_FLIGHT_REQUESTS = 32;
const BINDING_POLL_MS = 50;
const ANSWER_POLL_MS = 100;

const rpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().int(), z.null()]),
    method: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const rpcNotificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface RelayMcpServerOptions {
  bindingToken: string;
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  client: RelayClient;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export type RelayMcpResponse = JsonRpcError | JsonRpcSuccess;

export type RelayMcpInputLine =
  { kind: "line"; value: string } | { kind: "invalid-utf8" | "oversized" };

function decodeMcpLine(parts: readonly Buffer[]): RelayMcpInputLine {
  const bytes =
    parts.length === 1 ? parts[0]! : Buffer.concat(parts as Buffer[]);
  const bounded =
    bytes.at(-1) === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
  try {
    return {
      kind: "line",
      value: new TextDecoder("utf-8", { fatal: true }).decode(bounded),
    };
  } catch {
    return { kind: "invalid-utf8" };
  }
}

export async function* readBoundedMcpLines(
  input: Readable,
): AsyncGenerator<RelayMcpInputLine> {
  let parts: Buffer[] = [];
  let byteLength = 0;
  let discarding = false;

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(String(rawChunk), "utf8");
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index);
      if (!discarding) {
        if (byteLength + part.length > MAX_MCP_LINE_BYTES) {
          discarding = true;
          parts = [];
        } else {
          parts.push(part);
        }
      }
      yield discarding ? { kind: "oversized" } : decodeMcpLine(parts);
      parts = [];
      byteLength = 0;
      discarding = false;
      start = index + 1;
    }
    const remainder = chunk.subarray(start);
    if (!discarding && remainder.length > 0) {
      if (byteLength + remainder.length > MAX_MCP_LINE_BYTES) {
        discarding = true;
        parts = [];
        byteLength = 0;
      } else {
        parts.push(remainder);
        byteLength += remainder.length;
      }
    }
  }

  if (discarding) {
    yield { kind: "oversized" };
  } else if (byteLength > 0) {
    yield decodeMcpLine(parts);
  }
}

function errorResult(
  code: RelayMcpErrorCode,
  retryable: boolean,
  requestId?: string,
  requestState?: "open" | "answered" | "expired" | "cancelled" | "failed",
): RelayMcpToolResultV1 {
  return RelayMcpErrorV1Schema.parse({
    schema: "agent-relay-mcp-error.v1",
    code,
    retryable,
    localFallback: LOCAL_FALLBACK,
    ...(requestId === undefined ? {} : { requestId }),
    ...(requestState === undefined ? {} : { requestState }),
  });
}

function toolResult(value: RelayMcpToolResultV1): object {
  const parsed = RelayMcpToolResultV1Schema.parse(value);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    structuredContent: parsed,
    ...(parsed.schema === "agent-relay-mcp-error.v1" ? { isError: true } : {}),
  };
}

function bindingError(state: string): RelayMcpToolResultV1 {
  switch (state) {
    case "missing":
      return errorResult("binding-missing", true);
    case "pending":
      return errorResult("binding-pending", true);
    case "ambiguous":
      return errorResult("binding-ambiguous", false);
    case "ended":
      return errorResult("binding-ended", false);
    case "revoked":
      return errorResult("binding-revoked", false);
    default:
      return errorResult("internal-error", false);
  }
}

function requestError(
  state: "open" | "answered" | "expired" | "cancelled" | "failed",
  requestId: string,
): RelayMcpToolResultV1 {
  switch (state) {
    case "open":
      return errorResult("answer-timeout", true, requestId, state);
    case "expired":
      return errorResult("request-expired", false, requestId, state);
    case "cancelled":
      return errorResult("request-canceled", false, requestId, state);
    case "failed":
      return errorResult("request-failed", false, requestId, state);
    case "answered":
      return errorResult("request-failed", false, requestId, state);
  }
}

export class RelayMcpServer {
  private readonly now: () => number;
  private readonly pause: (milliseconds: number) => Promise<void>;

  public constructor(private readonly options: RelayMcpServerOptions) {
    this.now = options.now ?? Date.now;
    this.pause =
      options.pause ??
      (async (milliseconds) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        });
      });
  }

  private async registerBinding(): Promise<void> {
    await this.options.client.registerMcpBinding(this.options.bindingToken, {
      machineId: this.options.machineId,
      bridgeSessionId: this.options.bridgeSessionId,
      harness: this.options.harness,
    });
  }

  private async awaitBound(deadline: number) {
    for (;;) {
      const status = await this.options.client.mcpStatus(
        this.options.bindingToken,
        { schema: "agent-relay-mcp-status.v1" },
      );
      if (status.bindingState !== "pending" || this.now() >= deadline) {
        return status;
      }
      await this.pause(Math.min(BINDING_POLL_MS, deadline - this.now()));
    }
  }

  private async ask(argumentsValue: unknown): Promise<RelayMcpToolResultV1> {
    const parsed = RelayMcpAskV1Schema.safeParse(argumentsValue);
    if (!parsed.success) {
      return errorResult("invalid-input", false);
    }
    const input = parsed.data;
    await this.registerBinding();
    const deadline = this.now() + input.waitTimeoutMs;
    const binding = await this.awaitBound(deadline);
    if (binding.bindingState !== "bound") {
      return bindingError(binding.bindingState);
    }
    const opened = await this.options.client.openMcpInteraction(
      this.options.bindingToken,
      input,
    );
    if (opened.outcome !== "opened" && opened.outcome !== "duplicate") {
      return opened.outcome === "request-conflict"
        ? errorResult("request-conflict", false, input.requestId)
        : opened.outcome === "session-unavailable"
          ? errorResult("session-unavailable", true, input.requestId)
          : bindingError(
              opened.bindingState ?? opened.outcome.replace("binding-", ""),
            );
    }
    return await this.awaitAnswer(input.requestId, deadline);
  }

  private async askMany(
    argumentsValue: unknown,
  ): Promise<RelayMcpToolResultV1> {
    const parsed = RelayMcpQuestionnaireV1Schema.safeParse(argumentsValue);
    if (!parsed.success) {
      return errorResult("invalid-input", false);
    }
    const input = parsed.data;
    await this.registerBinding();
    const deadline = this.now() + input.waitTimeoutMs;
    const binding = await this.awaitBound(deadline);
    if (binding.bindingState !== "bound") {
      return bindingError(binding.bindingState);
    }
    const opened = await this.options.client.openMcpInteraction(
      this.options.bindingToken,
      input,
    );
    if (opened.outcome !== "opened" && opened.outcome !== "duplicate") {
      return opened.outcome === "request-conflict"
        ? errorResult("request-conflict", false, input.requestId)
        : opened.outcome === "session-unavailable"
          ? errorResult("session-unavailable", true, input.requestId)
          : bindingError(
              opened.bindingState ?? opened.outcome.replace("binding-", ""),
            );
    }
    return await this.awaitAnswer(input.requestId, deadline);
  }

  private async awaitAnswer(
    requestId: string,
    deadline: number,
  ): Promise<RelayMcpToolResultV1> {
    for (;;) {
      const status = await this.options.client.mcpStatus(
        this.options.bindingToken,
        { schema: "agent-relay-mcp-status.v1", requestId },
      );
      if (status.bindingState !== "bound") {
        return bindingError(status.bindingState);
      }
      if (status.requestState === "answered" && status.answer !== undefined) {
        return {
          schema: "agent-relay-mcp-result.v1",
          outcome: "answered",
          requestId,
          answer: status.answer,
        };
      }
      if (status.requestState !== undefined && status.requestState !== "open") {
        return requestError(status.requestState, requestId);
      }
      if (status.requestState === undefined) {
        return errorResult("request-not-found", false, requestId);
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return errorResult(
          "answer-timeout",
          true,
          requestId,
          status.requestState ?? "open",
        );
      }
      await this.pause(Math.min(ANSWER_POLL_MS, remaining));
    }
  }

  private async cancel(argumentsValue: unknown): Promise<RelayMcpToolResultV1> {
    const parsed = RelayMcpCancelV1Schema.safeParse(argumentsValue);
    if (!parsed.success) {
      return errorResult("invalid-input", false);
    }
    await this.registerBinding();
    const result = await this.options.client.cancelMcpInteraction(
      this.options.bindingToken,
      parsed.data,
    );
    if (result.outcome === "cancelled") {
      return {
        schema: "agent-relay-mcp-result.v1",
        outcome: "canceled",
        requestId: parsed.data.requestId,
        requestState: "cancelled",
      };
    }
    if (result.outcome === "not_found") {
      return errorResult("request-not-found", false, parsed.data.requestId);
    }
    if (result.outcome === "request-not-owned") {
      return errorResult("request-not-owned", false, parsed.data.requestId);
    }
    return result.outcome.startsWith("binding-")
      ? bindingError(result.outcome.replace("binding-", ""))
      : result.requestState === undefined
        ? errorResult("request-failed", false, parsed.data.requestId)
        : requestError(result.requestState, parsed.data.requestId);
  }

  private async status(argumentsValue: unknown): Promise<RelayMcpToolResultV1> {
    const parsed = RelayMcpStatusV1Schema.safeParse(argumentsValue);
    if (!parsed.success) {
      return errorResult("invalid-input", false);
    }
    await this.registerBinding();
    const status = await this.options.client.mcpStatus(
      this.options.bindingToken,
      parsed.data,
    );
    if (status.bindingState === "missing") {
      return bindingError("missing");
    }
    if (
      parsed.data.requestId !== undefined &&
      status.bindingState !== "bound"
    ) {
      return bindingError(status.bindingState);
    }
    if (
      parsed.data.requestId !== undefined &&
      status.requestState === undefined
    ) {
      return errorResult("request-not-found", false, parsed.data.requestId);
    }
    return {
      schema: "agent-relay-mcp-result.v1",
      outcome: "status",
      bindingState: status.bindingState,
      ...(status.harness === undefined ? {} : { harness: status.harness }),
      ...(status.activityState === undefined
        ? {}
        : { activityState: status.activityState }),
      ...(status.openRequestCount === undefined
        ? {}
        : { openRequestCount: status.openRequestCount }),
      delivery: status.delivery,
      ...(status.requestId === undefined
        ? {}
        : { requestId: status.requestId }),
      ...(status.requestState === undefined
        ? {}
        : { requestState: status.requestState }),
      ...(status.answer === undefined ? {} : { answer: status.answer }),
    };
  }

  private async callTool(
    params: Record<string, unknown> | undefined,
  ): Promise<object> {
    const name = params?.["name"];
    const argumentsValue = params?.["arguments"] ?? {};
    let value: RelayMcpToolResultV1;
    try {
      switch (name) {
        case "relay_ask":
          value = await this.ask(argumentsValue);
          break;
        case "relay_ask_many":
          value = await this.askMany(argumentsValue);
          break;
        case "relay_cancel":
          value = await this.cancel(argumentsValue);
          break;
        case "relay_status":
          value = await this.status(argumentsValue);
          break;
        default:
          throw new Error("unknown-tool");
      }
    } catch (error) {
      value =
        error instanceof RelayClientError &&
        (error.code === "daemon-timeout" || error.code === "daemon-unavailable")
          ? errorResult("daemon-unavailable", true)
          : errorResult("internal-error", false);
    }
    return toolResult(value);
  }

  public async handle(input: unknown): Promise<RelayMcpResponse | undefined> {
    const notification = rpcNotificationSchema.safeParse(input);
    if (notification.success && !("id" in notification.data)) {
      return undefined;
    }
    const parsed = rpcRequestSchema.safeParse(input);
    if (!parsed.success) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }
    const { id, method, params } = parsed.data;
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: RELAY_MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "agent-relay",
              version: RELAY_MCP_SURFACE_VERSION,
            },
            instructions:
              "Use Relay only for operator-mediated product or workflow questions. Never replace native permission, privilege, credential, or security approval prompts.",
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: RELAY_MCP_TOOL_DEFINITIONS },
        };
      case "tools/call":
        if (typeof params?.["name"] !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params" },
          };
        }
        if (
          !RELAY_MCP_TOOL_DEFINITIONS.some(
            (tool) => tool.name === params["name"],
          )
        ) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: await this.callTool(params),
        };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        };
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required ${name}`);
  }
  return value;
}

export function assertLocalMcpDaemonUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AGENT_RELAY_DAEMON_URL must be a loopback HTTP URL");
  }
  const loopback = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "::1",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
  ]);
  if (
    parsed.protocol !== "http:" ||
    !loopback.has(parsed.hostname) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("AGENT_RELAY_DAEMON_URL must be a loopback HTTP URL");
  }
  return parsed.origin;
}

export async function runRelayMcpServer(): Promise<void> {
  const harness = z
    .enum(["codex", "claude", "cursor"])
    .parse(requiredEnvironment("AGENT_RELAY_MCP_HARNESS"));
  const bindingToken = requiredEnvironment("AGENT_RELAY_MCP_BINDING");
  const daemonUrl = assertLocalMcpDaemonUrl(
    process.env["AGENT_RELAY_DAEMON_URL"] ?? "http://127.0.0.1:4317",
  );
  const server = new RelayMcpServer({
    bindingToken,
    machineId: requiredEnvironment("AGENT_RELAY_MACHINE_ID"),
    bridgeSessionId: requiredEnvironment("AGENT_RELAY_BRIDGE_SESSION_ID"),
    harness,
    client: new RelayClient({
      baseUrl: daemonUrl,
      ...(process.env["AGENT_RELAY_DAEMON_TOKEN"] === undefined
        ? {}
        : { token: process.env["AGENT_RELAY_DAEMON_TOKEN"] }),
      timeoutMs: 5_000,
    }),
  });
  let writes = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const enqueue = (response: RelayMcpResponse) => {
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(`${JSON.stringify(response)}\n`, (error) => {
            if (error === null || error === undefined) resolve();
            else reject(error);
          });
        }),
    );
  };
  for await (const record of readBoundedMcpLines(process.stdin)) {
    if (record.kind !== "line") {
      enqueue({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    let input: unknown;
    try {
      input = JSON.parse(record.value) as unknown;
    } catch {
      enqueue({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    if (inFlight.size >= MAX_MCP_IN_FLIGHT_REQUESTS) {
      await Promise.race(inFlight);
    }
    const task = server
      .handle(input)
      .then((response) => {
        if (response !== undefined) enqueue(response);
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  await writes;
}
