import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolError,
  OwnedCodexAppServerRpc,
  type CodexAppServerInbound,
} from "../src/index.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: unknown[] = [];
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  #buffer = "";
  #respondToRequests = true;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const message = JSON.parse(line) as {
          id?: number;
          method: string;
        };
        this.received.push(message);
        if (message.id !== undefined && this.#respondToRequests) {
          const result =
            message.method === "initialize"
              ? {
                  userAgent: CODEX_APP_SERVER_VERSION,
                  codexHome: "/synthetic/codex-home",
                  platformFamily: "unix",
                  platformOs: "macos",
                }
              : {};
          this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  setRespondToRequests(value: boolean): void {
    this.#respondToRequests = value;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    this.emit("exit", this.exitCode, signal);
    return true;
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

describe("OwnedCodexAppServerRpc", () => {
  test("verifies, initializes, correlates requests, and shuts down its child", async () => {
    const child = new FakeChild();
    const messages: CodexAppServerInbound[] = [];
    const rpc = new OwnedCodexAppServerRpc({
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 40,
      versionProbe: () => Promise.resolve(CODEX_APP_SERVER_VERSION),
      processFactory: () => child.asChildProcess(),
    });
    rpc.subscribe((message) => {
      messages.push(message);
    });
    await rpc.start();
    expect(rpc.status()).toMatchObject({
      state: "ready",
      observedVersion: CODEX_APP_SERVER_VERSION,
      processOwned: true,
      pendingRequestCount: 0,
    });
    expect(child.received).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      { method: "initialized" },
    ]);

    await expect(
      rpc.request("turn/interrupt", {
        threadId: "synthetic-thread",
        turnId: "synthetic-turn",
      }),
    ).resolves.toEqual({});
    expect(child.received.at(-1)).toMatchObject({
      id: 2,
      method: "turn/interrupt",
    });

    await rpc.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(rpc.status()).toMatchObject({
      state: "stopped",
      processOwned: false,
    });
    expect(messages.at(-1)).toMatchObject({
      kind: "process_exited",
      intentional: true,
    });
  });

  test("rejects an unverified version before spawning", async () => {
    let spawnCalls = 0;
    const rpc = new OwnedCodexAppServerRpc({
      versionProbe: () => Promise.resolve("codex-cli 0.144.0"),
      processFactory: () => {
        spawnCalls += 1;
        return new FakeChild().asChildProcess();
      },
    });
    await expect(rpc.start()).rejects.toMatchObject({
      safeCode: "native_version_mismatch",
    });
    expect(spawnCalls).toBe(0);
    expect(rpc.status()).toMatchObject({
      state: "failed",
      lastSafeCode: "native_version_mismatch",
    });
  });

  test("fails closed on malformed output and rejects pending work on exit", async () => {
    const child = new FakeChild();
    const rpc = new OwnedCodexAppServerRpc({
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 40,
      versionProbe: () => Promise.resolve(CODEX_APP_SERVER_VERSION),
      processFactory: () => child.asChildProcess(),
    });
    await rpc.start();
    child.setRespondToRequests(false);
    const pending = rpc.request("thread/resume", {
      threadId: "synthetic-thread",
    });
    child.stdout.write("{malformed-json\n");
    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    expect(rpc.status()).toMatchObject({
      state: "failed",
      lastSafeCode: "native_protocol_invalid",
      pendingRequestCount: 0,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("bounds pending native requests by deadline", async () => {
    const child = new FakeChild();
    const rpc = new OwnedCodexAppServerRpc({
      requestTimeoutMs: 10,
      shutdownTimeoutMs: 40,
      versionProbe: () => Promise.resolve(CODEX_APP_SERVER_VERSION),
      processFactory: () => child.asChildProcess(),
    });
    await rpc.start();
    child.setRespondToRequests(false);
    await expect(
      rpc.request("thread/resume", { threadId: "synthetic-thread" }),
    ).rejects.toMatchObject({ safeCode: "native_request_timeout" });
    expect(rpc.status().pendingRequestCount).toBe(0);
    await rpc.stop();
  });
});
