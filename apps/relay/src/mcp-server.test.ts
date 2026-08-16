import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { RelayClient } from "./client.js";
import {
  assertLocalMcpDaemonUrl,
  readBoundedMcpLines,
  RelayMcpServer,
} from "./mcp-server.js";

const bindingToken = `mcpbind_${"C".repeat(43)}`;

function request(id: number, method: string, params?: object) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

function askArguments(waitTimeoutMs = 1_000) {
  return {
    schema: "agent-relay-mcp-ask.v1",
    requestId: "request_mcp_server_12345678",
    title: "Synthetic choice",
    question: {
      questionId: "question_mcp_server_12345678",
      kind: "confirm",
      prompt: "Continue the synthetic operation?",
      confirm: {
        optionId: "option_mcp_confirm_12345678",
        label: "Continue",
      },
      decline: {
        optionId: "option_mcp_decline_12345678",
        label: "Stop",
      },
    },
    expiresInMs: 60_000,
    waitTimeoutMs,
  };
}

function server(client: object, clock?: { now: number }) {
  return new RelayMcpServer({
    bindingToken,
    machineId: "machine_mcp_server_12345678",
    bridgeSessionId: "bridge_mcp_server_12345678",
    harness: "codex",
    client: client as RelayClient,
    ...(clock === undefined
      ? {}
      : {
          now: () => clock.now,
          pause: async (milliseconds: number) => {
            clock.now += milliseconds;
          },
        }),
  });
}

function structured(response: Awaited<ReturnType<RelayMcpServer["handle"]>>) {
  if (response === undefined || !("result" in response)) {
    throw new Error("expected a successful JSON-RPC response");
  }
  return (response.result as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

describe("local Relay stdio MCP protocol", () => {
  it("bounds complete and unterminated stdio lines and rejects invalid UTF-8", async () => {
    const read = async (chunks: Array<Buffer | string>) => {
      const records = [];
      for await (const record of readBoundedMcpLines(Readable.from(chunks))) {
        records.push(record);
      }
      return records;
    };
    await expect(read(['{"jsonrpc":"2.0"}\r\n'])).resolves.toEqual([
      { kind: "line", value: '{"jsonrpc":"2.0"}' },
    ]);
    await expect(
      read([
        Buffer.concat([
          Buffer.from("{"),
          Buffer.from([0xff]),
          Buffer.from("}\n"),
        ]),
      ]),
    ).resolves.toEqual([{ kind: "invalid-utf8" }]);
    await expect(read(["x".repeat(128 * 1024 + 1)])).resolves.toEqual([
      { kind: "oversized" },
    ]);
    await expect(
      read([`${"x".repeat(128 * 1024 + 1)}\n{}\n`]),
    ).resolves.toEqual([{ kind: "oversized" }, { kind: "line", value: "{}" }]);
  });

  it("accepts only a credential-free loopback daemon URL", () => {
    expect(assertLocalMcpDaemonUrl("http://127.0.0.1:4317")).toBe(
      "http://127.0.0.1:4317",
    );
    expect(assertLocalMcpDaemonUrl("http://[::1]:4317/")).toBe(
      "http://[::1]:4317",
    );
    for (const value of [
      "https://127.0.0.1:4317",
      "http://relay.example.test:4317",
      "http://user:password@127.0.0.1:4317",
      "http://127.0.0.1:4317/nested",
    ]) {
      expect(() => assertLocalMcpDaemonUrl(value)).toThrow("loopback HTTP URL");
    }
  });

  it("negotiates MCP and exposes only the frozen four-tool surface", async () => {
    const relay = server({});
    await expect(
      relay.handle(
        request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "synthetic-client", version: "1" },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { version: "agent-relay-mcp.v1" },
      },
    });
    const listed = await relay.handle(request(2, "tools/list", {}));
    expect(listed).toMatchObject({
      result: {
        tools: [
          { name: "relay_ask" },
          { name: "relay_ask_many" },
          { name: "relay_cancel" },
          { name: "relay_status" },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("relay_notify");
    expect(JSON.stringify(listed)).not.toContain("relay_check");
  });

  it("returns a typed answer and never exposes it outside structured tool output", async () => {
    const answer = {
      schema: "agent-interaction-answer.v1" as const,
      answerId: "answer_mcp_server_12345678",
      requestId: "request_mcp_server_12345678",
      submittedAt: "2026-08-13T12:00:01.000Z",
      answers: [
        {
          questionId: "question_mcp_server_12345678",
          kind: "confirm" as const,
          optionId: "option_mcp_confirm_12345678",
        },
      ],
    };
    const client = {
      registerMcpBinding: vi
        .fn()
        .mockResolvedValue({ outcome: "duplicate", bindingState: "bound" }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "bound",
        harness: "codex",
        activityState: "needs_input",
        openRequestCount: 0,
        delivery: "available",
        requestId: answer.requestId,
        requestState: "answered",
        answer,
      }),
      openMcpInteraction: vi
        .fn()
        .mockResolvedValue({ outcome: "opened", requestState: "open" }),
    };
    const response = await server(client).handle(
      request(3, "tools/call", {
        name: "relay_ask",
        arguments: askArguments(),
      }),
    );
    expect(structured(response)).toEqual({
      schema: "agent-relay-mcp-result.v1",
      outcome: "answered",
      requestId: answer.requestId,
      answer,
    });
    expect(client.openMcpInteraction).toHaveBeenCalledOnce();
  });

  it("bounds waiting and leaves the durable request open for a late answer", async () => {
    const clock = { now: 0 };
    const client = {
      registerMcpBinding: vi
        .fn()
        .mockResolvedValue({ outcome: "duplicate", bindingState: "bound" }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "bound",
        harness: "codex",
        activityState: "needs_input",
        openRequestCount: 1,
        delivery: "degraded",
        requestId: "request_mcp_server_12345678",
        requestState: "open",
      }),
      openMcpInteraction: vi
        .fn()
        .mockResolvedValue({ outcome: "opened", requestState: "open" }),
    };
    const response = await server(client, clock).handle(
      request(4, "tools/call", {
        name: "relay_ask",
        arguments: askArguments(250),
      }),
    );
    expect(structured(response)).toEqual({
      schema: "agent-relay-mcp-error.v1",
      code: "answer-timeout",
      retryable: true,
      localFallback:
        "Ask the operator locally with the harness's native question mechanism.",
      requestId: "request_mcp_server_12345678",
      requestState: "open",
    });
    expect(clock.now).toBe(250);
  });

  it("returns a retained late answer from exact request status", async () => {
    const answer = {
      schema: "agent-interaction-answer.v1" as const,
      answerId: "answer_mcp_status_12345678",
      requestId: "request_mcp_server_12345678",
      submittedAt: "2026-08-13T12:00:01.000Z",
      answers: [
        {
          questionId: "question_mcp_server_12345678",
          kind: "confirm" as const,
          optionId: "option_mcp_confirm_12345678",
        },
      ],
    };
    const client = {
      registerMcpBinding: vi
        .fn()
        .mockResolvedValue({ outcome: "duplicate", bindingState: "bound" }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "bound",
        harness: "codex",
        activityState: "idle",
        openRequestCount: 0,
        delivery: "available",
        requestId: answer.requestId,
        requestState: "answered",
        answer,
      }),
    };
    const response = await server(client).handle(
      request(40, "tools/call", {
        name: "relay_status",
        arguments: {
          schema: "agent-relay-mcp-status.v1",
          requestId: answer.requestId,
        },
      }),
    );
    expect(structured(response)).toMatchObject({
      outcome: "status",
      requestState: "answered",
      answer,
    });
  });

  it("cancels one exact owned durable request with a typed result", async () => {
    const client = {
      registerMcpBinding: vi
        .fn()
        .mockResolvedValue({ outcome: "duplicate", bindingState: "bound" }),
      cancelMcpInteraction: vi.fn().mockResolvedValue({
        outcome: "cancelled",
        requestId: "request_mcp_server_12345678",
        requestState: "cancelled",
      }),
    };
    const response = await server(client).handle(
      request(41, "tools/call", {
        name: "relay_cancel",
        arguments: {
          schema: "agent-relay-mcp-cancel.v1",
          requestId: "request_mcp_server_12345678",
        },
      }),
    );
    expect(structured(response)).toEqual({
      schema: "agent-relay-mcp-result.v1",
      outcome: "canceled",
      requestId: "request_mcp_server_12345678",
      requestState: "cancelled",
    });
  });

  it("returns a typed not-found result for an absent exact status request", async () => {
    const client = {
      registerMcpBinding: vi
        .fn()
        .mockResolvedValue({ outcome: "duplicate", bindingState: "bound" }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "bound",
        harness: "codex",
        activityState: "idle",
        openRequestCount: 0,
        delivery: "degraded",
      }),
    };
    const response = await server(client).handle(
      request(42, "tools/call", {
        name: "relay_status",
        arguments: {
          schema: "agent-relay-mcp-status.v1",
          requestId: "request_mcp_absent_12345678",
        },
      }),
    );
    expect(structured(response)).toMatchObject({
      schema: "agent-relay-mcp-error.v1",
      code: "request-not-found",
      retryable: false,
      requestId: "request_mcp_absent_12345678",
    });
  });

  it("fails closed on ambiguous correlation before routing", async () => {
    const client = {
      registerMcpBinding: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        bindingState: "ambiguous",
      }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "ambiguous",
        delivery: "degraded",
      }),
      openMcpInteraction: vi.fn(),
    };
    const response = await server(client).handle(
      request(5, "tools/call", {
        name: "relay_ask",
        arguments: askArguments(0),
      }),
    );
    expect(structured(response)).toMatchObject({
      code: "binding-ambiguous",
      retryable: false,
    });
    expect(client.openMcpInteraction).not.toHaveBeenCalled();
  });

  it("returns content-free typed validation errors and protocol-level unknown-tool errors", async () => {
    const relay = server({ registerMcpBinding: vi.fn() });
    const invalid = await relay.handle(
      request(6, "tools/call", {
        name: "relay_ask",
        arguments: {
          ...askArguments(),
          question: {
            ...askArguments().question,
            prompt: "PRIVATE_INVALID_PROMPT_SENTINEL",
            kind: "permission",
          },
        },
      }),
    );
    expect(structured(invalid)).toMatchObject({ code: "invalid-input" });
    expect(JSON.stringify(invalid)).not.toContain(
      "PRIVATE_INVALID_PROMPT_SENTINEL",
    );
    await expect(
      relay.handle(
        request(7, "tools/call", { name: "relay_unknown", arguments: {} }),
      ),
    ).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("handshakes without a spawn-time session and binds an ask to tools/call thread metadata", async () => {
    const unsupervised = new RelayMcpServer({
      machineId: "machine_mcp_server_12345678",
      bridgeSessionId: "bridge_local_hooks",
      harness: "codex",
      client: {} as RelayClient,
    });
    await expect(
      unsupervised.handle(
        request(8, "initialize", { protocolVersion: "2025-11-25" }),
      ),
    ).resolves.toMatchObject({
      result: { serverInfo: { name: "agent-relay" } },
    });
    const missing = await unsupervised.handle(
      request(9, "tools/call", {
        name: "relay_ask",
        arguments: askArguments(),
      }),
    );
    expect(structured(missing)).toMatchObject({ code: "binding-missing" });

    const client = {
      registerMcpBinding: vi.fn().mockResolvedValue({ outcome: "registered" }),
      claimMcpBinding: vi.fn().mockResolvedValue({ outcome: "bound" }),
      mcpStatus: vi.fn().mockResolvedValue({
        bindingState: "bound",
        harness: "codex",
        activityState: "needs_input",
        openRequestCount: 0,
        delivery: "available",
        requestId: "request_mcp_server_12345678",
        requestState: "answered",
        answer: {
          schema: "agent-interaction-answer.v1",
          answerId: "answer_mcp_server_12345678",
          requestId: "request_mcp_server_12345678",
          submittedAt: "2026-08-13T12:00:01.000Z",
          answers: [
            {
              questionId: "question_mcp_server_12345678",
              kind: "confirm",
              optionId: "option_mcp_confirm_12345678",
            },
          ],
        },
      }),
      openMcpInteraction: vi
        .fn()
        .mockResolvedValue({ outcome: "opened", requestState: "open" }),
    };
    const bound = new RelayMcpServer({
      machineId: "machine_mcp_server_12345678",
      bridgeSessionId: "bridge_local_hooks",
      harness: "codex",
      client: client as unknown as RelayClient,
    });
    await bound.handle(
      request(10, "tools/call", {
        name: "relay_ask",
        arguments: askArguments(),
        _meta: { threadId: "019bbb20-bff6-7130-83aa-bf45ab33250e" },
      }),
    );
    expect(client.registerMcpBinding).toHaveBeenCalled();
    expect(client.claimMcpBinding).toHaveBeenCalled();
    expect(client.openMcpInteraction).toHaveBeenCalledWith(
      {
        machineId: "machine_mcp_server_12345678",
        harness: "codex",
        sessionId: "019bbb20-bff6-7130-83aa-bf45ab33250e",
      },
      expect.objectContaining({ schema: "agent-relay-mcp-ask.v1" }),
    );
  });
});
