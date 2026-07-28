import { execFile as execFileCallback, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import {
  CODEX_APP_SERVER_MAXIMUM_LINE_BYTES,
  CODEX_APP_SERVER_MAXIMUM_PENDING_REQUESTS,
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolError,
  decodeCodexAppServerLine,
  InitializeResponseSchema,
  type CodexAppServerInbound,
  type CodexRequestId,
} from "./protocol.js";

const execFile = promisify(execFileCallback);

export type CodexAppServerMessageHandler = (
  message: CodexAppServerInbound,
) => void | Promise<void>;

export interface CodexAppServerRpc {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: CodexRequestId, result: unknown): Promise<void>;
  reject(id: CodexRequestId, safeCode: string): Promise<void>;
  subscribe(handler: CodexAppServerMessageHandler): () => void;
  status(): CodexAppServerRpcStatus;
}

export interface CodexAppServerRpcStatus {
  readonly state:
    | "stopped"
    | "checking_version"
    | "starting"
    | "initializing"
    | "ready"
    | "stopping"
    | "failed";
  readonly configuredVersion: string;
  readonly observedVersion?: string;
  readonly processOwned: boolean;
  readonly pendingRequestCount: number;
  readonly lastSafeCode?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface OwnedCodexAppServerRpcOptions {
  readonly executable?: string;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly versionProbe?: (executable: string) => Promise<string>;
  readonly processFactory?: (
    executable: string,
  ) => ChildProcessWithoutNullStreams;
}

async function defaultVersionProbe(executable: string): Promise<string> {
  const { stdout } = await execFile(executable, ["--version"], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return stdout.trim();
}

function defaultProcessFactory(
  executable: string,
): ChildProcessWithoutNullStreams {
  return spawn(executable, ["app-server"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function safeError(safeCode: string): CodexAppServerProtocolError {
  return new CodexAppServerProtocolError(safeCode);
}

export class OwnedCodexAppServerRpc implements CodexAppServerRpc {
  readonly #executable: string;
  readonly #requestTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #versionProbe: (executable: string) => Promise<string>;
  readonly #processFactory: (
    executable: string,
  ) => ChildProcessWithoutNullStreams;
  readonly #subscribers = new Set<CodexAppServerMessageHandler>();
  readonly #pending = new Map<CodexRequestId, PendingRequest>();
  #state: CodexAppServerRpcStatus["state"] = "stopped";
  #process: ChildProcessWithoutNullStreams | undefined;
  #observedVersion: string | undefined;
  #lastSafeCode: string | undefined;
  #nextRequestId = 1;
  #stdoutBuffer = Buffer.alloc(0);
  #intentionalStop = false;

  constructor(options: OwnedCodexAppServerRpcOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#versionProbe = options.versionProbe ?? defaultVersionProbe;
    this.#processFactory = options.processFactory ?? defaultProcessFactory;
    if (
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 120_000 ||
      this.#shutdownTimeoutMs < 20 ||
      this.#shutdownTimeoutMs > 30_000
    ) {
      throw new TypeError("Codex app-server process limits are invalid.");
    }
  }

  status(): CodexAppServerRpcStatus {
    return {
      state: this.#state,
      configuredVersion: CODEX_APP_SERVER_VERSION,
      ...(this.#observedVersion === undefined
        ? {}
        : { observedVersion: this.#observedVersion }),
      processOwned: this.#process !== undefined,
      pendingRequestCount: this.#pending.size,
      ...(this.#lastSafeCode === undefined
        ? {}
        : { lastSafeCode: this.#lastSafeCode }),
    };
  }

  subscribe(handler: CodexAppServerMessageHandler): () => void {
    this.#subscribers.add(handler);
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.#state === "ready") {
      return;
    }
    if (this.#state !== "stopped" && this.#state !== "failed") {
      throw safeError("native_start_in_progress");
    }
    this.#lastSafeCode = undefined;
    this.#intentionalStop = false;
    try {
      this.#state = "checking_version";
      this.#observedVersion = await this.#versionProbe(this.#executable);
      if (this.#observedVersion !== CODEX_APP_SERVER_VERSION) {
        throw safeError("native_version_mismatch");
      }
      this.#state = "starting";
      const child = this.#processFactory(this.#executable);
      this.#process = child;
      child.stdout.on("data", (chunk: Buffer | string) => {
        this.#acceptStdout(chunk);
      });
      child.stderr.on("data", () => {
        // Drain without retaining provider output.
      });
      child.once("error", () => {
        this.#fail("native_process_error");
      });
      child.once("exit", (code, signal) => {
        this.#onExit(code, signal);
      });
      this.#state = "initializing";
      const initialize = await this.#requestDuringStartup("initialize", {
        clientInfo: {
          name: "agent_relay_runner_bridge",
          title: "Agent Relay runner bridge",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      InitializeResponseSchema.parse(initialize);
      await this.#write({ method: "initialized" });
      this.#state = "ready";
    } catch (error) {
      this.#lastSafeCode =
        error instanceof CodexAppServerProtocolError
          ? error.safeCode
          : "native_start_failed";
      this.#state = "failed";
      await this.#terminateOwnedProcess();
      throw safeError(this.#lastSafeCode);
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped" && this.#process === undefined) {
      return;
    }
    this.#intentionalStop = true;
    this.#state = "stopping";
    await this.#terminateOwnedProcess();
    this.#rejectPending("native_process_stopped");
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#state = "stopped";
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#state !== "ready") {
      return Promise.reject(safeError("native_not_ready"));
    }
    return this.#sendRequest(method, params);
  }

  async respond(id: CodexRequestId, result: unknown): Promise<void> {
    if (this.#state !== "ready") {
      throw safeError("native_not_ready");
    }
    await this.#write({ id, result });
  }

  async reject(id: CodexRequestId, safeCode: string): Promise<void> {
    if (this.#state !== "ready") {
      throw safeError("native_not_ready");
    }
    await this.#write({
      id,
      error: {
        code: -32601,
        message: safeCode.slice(0, 120),
      },
    });
  }

  #requestDuringStartup(method: string, params: unknown): Promise<unknown> {
    if (this.#state !== "initializing") {
      return Promise.reject(safeError("native_not_initializing"));
    }
    return this.#sendRequest(method, params);
  }

  #sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#pending.size >= CODEX_APP_SERVER_MAXIMUM_PENDING_REQUESTS) {
      return Promise.reject(safeError("native_pending_limit"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(safeError("native_request_timeout"));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      void this.#write({ id, method, params }).catch(() => {
        const pending = this.#pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.#pending.delete(id);
          pending.reject(safeError("native_write_failed"));
        }
      });
    });
  }

  async #write(value: unknown): Promise<void> {
    const child = this.#process;
    if (!child || child.stdin.destroyed) {
      throw safeError("native_process_unavailable");
    }
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > CODEX_APP_SERVER_MAXIMUM_LINE_BYTES) {
      throw safeError("native_request_too_large");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  #acceptStdout(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes]);
    if (
      this.#stdoutBuffer.length > CODEX_APP_SERVER_MAXIMUM_LINE_BYTES &&
      !this.#stdoutBuffer.includes(0x0a)
    ) {
      this.#fail("native_line_too_large");
      return;
    }
    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.length > 0) {
        try {
          this.#acceptMessage(decodeCodexAppServerLine(line.toString("utf8")));
        } catch {
          this.#fail("native_protocol_invalid");
          return;
        }
      }
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  #acceptMessage(message: CodexAppServerInbound): void {
    if (message.kind === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fail("native_response_unknown");
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(safeError("native_request_rejected"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    void this.#publish(message);
  }

  async #publish(message: CodexAppServerInbound): Promise<void> {
    await Promise.all(
      [...this.#subscribers].map(async (subscriber) => {
        try {
          await subscriber(message);
        } catch {
          this.#lastSafeCode = "native_observer_failed";
        }
      }),
    );
  }

  #fail(safeCode: string): void {
    this.#lastSafeCode = safeCode;
    this.#state = "failed";
    this.#rejectPending(safeCode);
    const child = this.#process;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const intentional = this.#intentionalStop;
    this.#process = undefined;
    this.#rejectPending(
      intentional ? "native_process_stopped" : "native_process_exited",
    );
    if (!intentional) {
      this.#state = "failed";
      this.#lastSafeCode ??= "native_process_exited";
    }
    void this.#publish({
      kind: "process_exited",
      exitCode: code,
      signal,
      intentional,
    });
  }

  #rejectPending(safeCode: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(safeError(safeCode));
    }
    this.#pending.clear();
  }

  async #terminateOwnedProcess(): Promise<void> {
    const child = this.#process;
    if (!child || child.exitCode !== null) {
      this.#process = undefined;
      return;
    }
    child.stdin.end();
    const firstWait = Math.floor(this.#shutdownTimeoutMs / 2);
    if (await this.#waitForExit(child, firstWait)) {
      return;
    }
    child.kill("SIGTERM");
    if (await this.#waitForExit(child, this.#shutdownTimeoutMs - firstWait)) {
      return;
    }
    child.kill("SIGKILL");
    await this.#waitForExit(child, 250);
  }

  async #waitForExit(
    child: ChildProcessWithoutNullStreams,
    milliseconds: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || this.#process !== child) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve(false);
        }
      }, milliseconds);
      child.once("exit", () => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });
  }
}
