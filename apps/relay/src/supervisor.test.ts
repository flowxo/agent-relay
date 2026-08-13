import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FakeNotificationTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
} from "@agent-relay/core";
import { TelegramReplyRouter } from "@agent-relay/telegram-transport";

import { RelayClient } from "./client.js";
import { createRelayHttpServer } from "./http-server.js";
import { runHook } from "./hook-runner.js";
import {
  classifyOwnedExit,
  runSupervisor,
  spawnOwnedChild,
} from "./supervisor.js";
import type { ChildRunRequest, OwnedChildResult } from "./supervisor.js";

const machineId = "machine_supervisor_12345678";
const bridgeSessionId = "bridge_supervisor_12345678";
const supervisorId = "supervisor_test_12345678";
const silentLogger = { log: () => undefined };

const codexStop = JSON.stringify({
  session_id: "session_supervisor_12345678",
  transcript_path: null,
  cwd: "/workspace/example",
  hook_event_name: "Stop",
  turn_id: "turn_supervisor_12345678",
  stop_hook_active: false,
  last_assistant_message: "Synthetic supervised stop.",
});

const cursorStop = JSON.stringify({
  hook_event_name: "stop",
  conversation_id: "cursor-supervisor-12345678",
  status: "completed",
  loop_count: 0,
  workspace_roots: ["/workspace/example"],
  transcript_path: "/workspace/synthetic-transcript.jsonl",
});

interface ChildResultOverrides {
  startedAt?: string;
  exitedAt?: string;
  pid?: number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  requestedSignal?: NodeJS.Signals;
  spawnErrorCode?: string;
}

function childResult(overrides: ChildResultOverrides = {}): OwnedChildResult {
  const pid = overrides.pid === null ? undefined : (overrides.pid ?? 4242);
  const exitCode =
    overrides.exitCode === null ? undefined : (overrides.exitCode ?? 0);
  return {
    startedAt: overrides.startedAt ?? "2026-07-24T12:00:00.000Z",
    exitedAt: overrides.exitedAt ?? "2026-07-24T12:00:01.000Z",
    ...(pid === undefined ? {} : { pid }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.requestedSignal === undefined
      ? {}
      : { requestedSignal: overrides.requestedSignal }),
    ...(overrides.spawnErrorCode === undefined
      ? {}
      : { spawnErrorCode: overrides.spawnErrorCode }),
  };
}

async function setup() {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-supervisor-runtime-"),
  );
  const store = new RelayStore();
  const transport = new FakeNotificationTransport();
  const service = new RelayService(store, transport, {
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const router = new TelegramReplyRouter(store, transport, {
    operatorUserId: 7001,
    chatId: 9001,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const server = createRelayHttpServer(service, { replyRouter: router });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const close = async () => {
    server.close();
    await once(server, "close");
    store.close();
  };
  return {
    store,
    service,
    transport,
    router,
    client: new RelayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
    }),
    fallbackPath: join(directory, "fallback.ndjson"),
    close,
  };
}

describe("owned child exit classification", () => {
  it("distinguishes clean, non-zero, signal, forwarded signal, and spawn errors", () => {
    expect(classifyOwnedExit(childResult(), supervisorId)).toMatchObject({
      unexpected: false,
      terminalExitCode: 0,
      evidence: { classification: "clean-exit", expected: true },
    });
    expect(
      classifyOwnedExit(childResult({ exitCode: 9 }), supervisorId),
    ).toMatchObject({
      unexpected: true,
      terminalExitCode: 9,
      evidence: { classification: "nonzero-exit", exitCode: 9 },
    });
    expect(
      classifyOwnedExit(
        childResult({ exitCode: null, signal: "SIGKILL" }),
        supervisorId,
      ),
    ).toMatchObject({
      unexpected: true,
      terminalExitCode: 137,
      evidence: { classification: "signal", signal: "SIGKILL" },
    });
    expect(
      classifyOwnedExit(
        childResult({
          exitCode: null,
          signal: "SIGTERM",
          requestedSignal: "SIGTERM",
        }),
        supervisorId,
      ),
    ).toMatchObject({
      unexpected: false,
      terminalExitCode: 143,
      evidence: { classification: "signal", expected: true },
    });
    expect(
      classifyOwnedExit(
        childResult({
          exitCode: 130,
          requestedSignal: "SIGINT",
        }),
        supervisorId,
      ),
    ).toMatchObject({
      unexpected: false,
      terminalExitCode: 130,
      evidence: {
        classification: "nonzero-exit",
        exitCode: 130,
        expected: true,
      },
      summary: "Supervised child stopped after forwarded SIGINT",
    });
    expect(
      classifyOwnedExit(
        childResult({
          exitCode: 1,
          requestedSignal: "SIGINT",
        }),
        supervisorId,
      ),
    ).toMatchObject({
      unexpected: true,
      terminalExitCode: 1,
      evidence: {
        classification: "nonzero-exit",
        exitCode: 1,
        expected: false,
      },
    });
    expect(
      classifyOwnedExit(
        childResult({
          pid: null,
          exitCode: null,
          spawnErrorCode: "ENOENT",
        }),
        supervisorId,
      ),
    ).toMatchObject({
      unexpected: true,
      terminalExitCode: 127,
      evidence: { classification: "spawn-error" },
    });
  });

  it("observes real child exit codes, signals, and startup failures", async () => {
    const nonzero = await spawnOwnedChild({
      executable: process.execPath,
      args: ["-e", "process.exit(23)"],
      cwd: process.cwd(),
      env: {},
    });
    expect(nonzero).toMatchObject({ exitCode: 23 });

    const signaled = await spawnOwnedChild({
      executable: process.execPath,
      args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
      cwd: process.cwd(),
      env: {},
    });
    expect(signaled).toMatchObject({ signal: "SIGTERM" });

    const missing = await spawnOwnedChild({
      executable: join(
        tmpdir(),
        "agent-relay-intentionally-missing-executable",
      ),
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    expect(missing).toMatchObject({ spawnErrorCode: "ENOENT" });
  });
});

describe("opt-in harness supervisor", () => {
  it("emits a durable owned-child event for a non-zero exit", async () => {
    const runtime = await setup();
    const result = await runSupervisor({
      harness: "claude",
      harnessVersion: "2.1.219",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/workspace/example",
      initialInvocation: { executable: "synthetic-claude", args: [] },
      client: runtime.client,
      logger: silentLogger,
      childRunner: async () =>
        childResult({
          startedAt: "2026-07-24T11:59:59.000Z",
          exitedAt: "2026-07-24T12:00:00.000Z",
          exitCode: 17,
        }),
      resumeWaitMs: 0,
    });

    expect(result).toMatchObject({
      exitCode: 17,
      classification: "nonzero-exit",
      resumed: 0,
    });
    const stored = runtime.store.getEvent(
      result.unexpectedExitEventId ?? "",
    )?.event;
    expect(stored).toMatchObject({
      type: "process.exited",
      failure: { class: "exit-code" },
      processExit: {
        source: "owned-child",
        supervisorId,
        exitCode: 17,
        expected: false,
      },
    });
    expect(await runtime.service.drain()).toMatchObject({ delivered: 1 });
    expect(runtime.transport.deliveries[0]?.message.text).toContain(
      "exited with status 17",
    );
    await runtime.close();
  });

  it("records normalized crash evidence when the daemon is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-supervisor-"));
    const fallbackPath = join(directory, "fallback.ndjson");
    const result = await runSupervisor({
      harness: "cursor",
      harnessVersion: "3.12.30",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/workspace/example",
      initialInvocation: {
        executable: "/private/machine/path/cursor-agent",
        args: ["--model", "secret-looking-argument"],
      },
      client: new RelayClient({
        fetch: async () => {
          throw new TypeError("synthetic connection refused");
        },
      }),
      fallbackPath,
      logger: silentLogger,
      childRunner: async () =>
        childResult({ exitCode: null, signal: "SIGKILL" }),
      resumeWaitMs: 0,
    });

    expect(result).toMatchObject({
      exitCode: 137,
      classification: "signal",
      diagnostic: {
        code: "process-exit-ingest-failed",
        fallbackRecorded: true,
      },
    });
    const record = JSON.parse(
      (await readFile(fallbackPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      schema: "agent-relay-fallback.v1",
      kind: "event",
      payload: {
        type: "process.exited",
        processExit: {
          source: "owned-child",
          signal: "SIGKILL",
        },
      },
    });
    expect(JSON.stringify(record)).not.toContain("/private/machine/path");
    expect(JSON.stringify(record)).not.toContain("secret-looking");
  });

  it("resumes the exact stopped Codex session once from a fake Telegram reply", async () => {
    const runtime = await setup();
    const invocations: ChildRunRequest[] = [];
    let telegramOutcome: unknown;
    const runner = async (
      request: ChildRunRequest,
    ): Promise<OwnedChildResult> => {
      invocations.push(request);
      if (invocations.length === 1) {
        await runHook({
          harness: "codex",
          surface: "cli",
          harnessVersion: "0.145.0",
          raw: codexStop,
          machineId,
          bridgeSessionId,
          occurredAt: "2026-07-24T12:00:00.000Z",
          client: runtime.client,
          fallbackPath: runtime.fallbackPath,
          lateResume: true,
          lateResumeTtlMs: 60_000,
        });
        await runtime.service.drain();
        const messageId = Number(
          runtime.transport.deliveries[0]?.receipt.messageId,
        );
        const topicId = Number(
          runtime.transport.deliveries[0]?.context.topicId,
        );
        telegramOutcome = await runtime.router.handle({
          update_id: 700,
          message: {
            message_id: 701,
            message_thread_id: topicId,
            from: { id: 7001 },
            chat: { id: 9001 },
            text: "Continue only this Codex turn",
            reply_to_message: { message_id: messageId },
          },
        });
        expect(
          await runtime.router.handle({
            update_id: 700,
            message: {
              message_id: 701,
              message_thread_id: topicId,
              from: { id: 7001 },
              chat: { id: 9001 },
              text: "duplicate",
              reply_to_message: { message_id: messageId },
            },
          }),
        ).toMatchObject({ outcome: "duplicate-update" });
        return childResult();
      }
      return childResult({
        startedAt: "2026-07-24T12:00:01.000Z",
        exitedAt: "2026-07-24T12:00:02.000Z",
        pid: 4243,
      });
    };

    const result = await runSupervisor({
      harness: "codex",
      harnessVersion: "0.145.0",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/workspace/example",
      initialInvocation: { executable: "synthetic-codex", args: ["exec"] },
      client: runtime.client,
      logger: silentLogger,
      childRunner: runner,
      resumeWaitMs: 100,
      pollIntervalMs: 25,
      maxResumes: 1,
      env: {
        AGENT_RELAY_TELEGRAM_TOKEN: "must-not-reach-child",
        AGENT_RELAY_DAEMON_TOKEN: "synthetic-daemon-token",
      },
    });

    expect(telegramOutcome).toMatchObject({ outcome: "answered" });
    expect(result).toMatchObject({
      exitCode: 0,
      classification: "clean-exit",
      resumed: 1,
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatchObject({
      executable: "codex",
      args: [
        "exec",
        "resume",
        "-c",
        'sandbox_mode="read-only"',
        "session_supervisor_12345678",
        "Continue only this Codex turn",
      ],
    });
    expect(invocations[0]?.env["AGENT_RELAY_SUPERVISED"]).toBe("1");
    expect(invocations[1]?.env["AGENT_RELAY_SUPERVISED"]).toBe("0");
    expect(invocations[0]?.env["AGENT_RELAY_TELEGRAM_TOKEN"]).toBeUndefined();
    expect(invocations[0]?.env["AGENT_RELAY_DAEMON_TOKEN"]).toBe(
      "synthetic-daemon-token",
    );
    expect(invocations[0]?.env["AGENT_RELAY_MCP_BINDING"]).toMatch(
      /^mcpbind_[A-Za-z0-9_-]{32,96}$/u,
    );
    expect(invocations[0]?.env["AGENT_RELAY_MCP_HARNESS"]).toBe("codex");
    expect(runtime.store.listResumeCommands()).toEqual([
      expect.objectContaining({
        state: "succeeded",
        sessionId: "session_supervisor_12345678",
        answer: "Continue only this Codex turn",
        exitCode: 0,
      }),
    ]);
    await runtime.close();
  });

  it("resumes Cursor with the exact executable and initial safety context", async () => {
    const runtime = await setup();
    const invocations: ChildRunRequest[] = [];
    const logger = new MemoryLogger();
    const runner = async (
      request: ChildRunRequest,
    ): Promise<OwnedChildResult> => {
      invocations.push(request);
      if (invocations.length === 1) {
        await runHook({
          harness: "cursor",
          surface: "cli",
          harnessVersion: "2026.07.23-e383d2b",
          raw: cursorStop,
          machineId,
          bridgeSessionId,
          occurredAt: "2026-07-24T12:00:00.000Z",
          client: runtime.client,
          fallbackPath: runtime.fallbackPath,
          lateResume: true,
          lateResumeTtlMs: 60_000,
        });
        await runtime.service.drain();
        const delivery = runtime.transport.deliveries[0];
        await runtime.router.handle({
          update_id: 810,
          message: {
            message_id: 811,
            message_thread_id: Number(delivery?.context.topicId),
            from: { id: 7001 },
            chat: { id: 9001 },
            text: "Continue read-only",
            reply_to_message: {
              message_id: Number(delivery?.receipt.messageId),
            },
          },
        });
      }
      return childResult();
    };

    const result = await runSupervisor({
      harness: "cursor",
      harnessVersion: "2026.07.23-e383d2b",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/isolated/workspace",
      initialInvocation: {
        executable: "/approved/cursor-agent-2026.07.23-e383d2b",
        args: [
          "--print",
          "--mode",
          "plan",
          "--sandbox",
          "enabled",
          "--trust",
          "--workspace",
          "/isolated/workspace",
          "--add-dir",
          "/workspace/example",
          "--",
          "bounded prompt",
        ],
      },
      client: runtime.client,
      logger,
      childRunner: runner,
      resumeWaitMs: 100,
      pollIntervalMs: 25,
      maxResumes: 1,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      classification: "clean-exit",
      resumed: 1,
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatchObject({
      executable: "/approved/cursor-agent-2026.07.23-e383d2b",
      cwd: "/isolated/workspace",
      args: [
        "--resume=cursor-supervisor-12345678",
        "--print",
        "--mode",
        "plan",
        "--sandbox",
        "enabled",
        "--workspace",
        "/isolated/workspace",
        "--add-dir",
        "/workspace/example",
        "--trust",
        "--",
        "Continue read-only",
      ],
    });
    expect(invocations[0]?.env["AGENT_RELAY_SUPERVISED"]).toBe("1");
    expect(invocations[1]?.env["AGENT_RELAY_SUPERVISED"]).toBe("0");
    expect(JSON.stringify(logger.records)).not.toContain("/isolated/workspace");
    expect(JSON.stringify(logger.records)).not.toContain("/workspace/example");
    expect(JSON.stringify(logger.records)).not.toContain("/approved/");
    expect(JSON.stringify(logger.records)).not.toContain("Continue read-only");
    await runtime.close();
  });

  it("keeps Cursor resume spawn-failure diagnostics free of argv and paths", async () => {
    const runtime = await setup();
    const invocations: ChildRunRequest[] = [];
    const logger = new MemoryLogger();
    const runner = async (
      request: ChildRunRequest,
    ): Promise<OwnedChildResult> => {
      invocations.push(request);
      if (invocations.length === 1) {
        await runHook({
          harness: "cursor",
          surface: "cli",
          harnessVersion: "2026.07.23-e383d2b",
          raw: cursorStop,
          machineId,
          bridgeSessionId,
          occurredAt: "2026-07-24T12:00:00.000Z",
          client: runtime.client,
          fallbackPath: runtime.fallbackPath,
          lateResume: true,
          lateResumeTtlMs: 60_000,
        });
        await runtime.service.drain();
        const delivery = runtime.transport.deliveries[0];
        await runtime.router.handle({
          update_id: 820,
          message: {
            message_id: 821,
            message_thread_id: Number(delivery?.context.topicId),
            from: { id: 7001 },
            chat: { id: 9001 },
            text: "Private resume answer",
            reply_to_message: {
              message_id: Number(delivery?.receipt.messageId),
            },
          },
        });
        return childResult();
      }
      return childResult({
        pid: null,
        exitCode: null,
        spawnErrorCode: "ENOENT",
      });
    };

    const result = await runSupervisor({
      harness: "cursor",
      harnessVersion: "2026.07.23-e383d2b",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/private/isolated-workspace",
      initialInvocation: {
        executable: "/private/exact-cursor-agent",
        args: [
          "--mode=plan",
          "--sandbox=enabled",
          "--trust",
          "--workspace=/private/isolated-workspace",
          "--add-dir=/private/repository",
          "--",
          "private initial prompt",
        ],
      },
      client: runtime.client,
      logger,
      childRunner: runner,
      resumeWaitMs: 100,
      pollIntervalMs: 25,
      maxResumes: 1,
    });

    expect(result).toMatchObject({
      exitCode: 127,
      classification: "spawn-error",
      resumed: 1,
    });
    expect(invocations).toHaveLength(2);
    expect(runtime.store.listResumeCommands()).toEqual([
      expect.objectContaining({
        state: "failed",
        errorCode: "resume-spawn-error",
        errorMessage: "Supervised child could not be started (ENOENT)",
      }),
    ]);
    const observable = JSON.stringify({
      result,
      logs: logger.records,
    });
    expect(observable).not.toContain("/private/");
    expect(observable).not.toContain("private initial prompt");
    expect(observable).not.toContain("Private resume answer");
    await runtime.close();
  });

  it("keeps polling through a transient daemon outage", async () => {
    const runtime = await setup();
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-supervisor-"));
    const fallbackPath = join(directory, "fallback.ndjson");
    const logger = new MemoryLogger();
    let invocationCount = 0;
    const runner = async (): Promise<OwnedChildResult> => {
      invocationCount += 1;
      if (invocationCount === 1) {
        await runHook({
          harness: "codex",
          surface: "cli",
          harnessVersion: "0.145.0",
          raw: codexStop,
          machineId,
          bridgeSessionId,
          occurredAt: "2026-07-24T12:00:00.000Z",
          client: runtime.client,
          fallbackPath: runtime.fallbackPath,
          lateResume: true,
          lateResumeTtlMs: 60_000,
        });
        await runtime.service.drain();
        const delivery = runtime.transport.deliveries[0];
        await runtime.router.handle({
          update_id: 750,
          message: {
            message_id: 751,
            message_thread_id: Number(delivery?.context.topicId),
            from: { id: 7001 },
            chat: { id: 9001 },
            text: "Continue after the daemon restarts",
          },
        });
      }
      return childResult();
    };
    const claim = runtime.client.claimNextResume.bind(runtime.client);
    vi.spyOn(runtime.client, "claimNextResume")
      .mockRejectedValueOnce(new TypeError("synthetic connection refused"))
      .mockImplementation(claim);

    const result = await runSupervisor({
      harness: "codex",
      harnessVersion: "0.145.0",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/workspace/example",
      initialInvocation: { executable: "synthetic-codex", args: ["exec"] },
      client: runtime.client,
      fallbackPath,
      logger,
      childRunner: runner,
      resumeWaitMs: 1_000,
      pollIntervalMs: 25,
      maxResumes: 1,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      classification: "clean-exit",
      resumed: 1,
    });
    expect(invocationCount).toBe(2);
    expect(logger.records.map((record) => record.code)).toEqual(
      expect.arrayContaining([
        "supervisor.resume-claim-retrying",
        "supervisor.resume-claim-recovered",
      ]),
    );
    const fallback = JSON.parse(
      (await readFile(fallbackPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(fallback).toMatchObject({
      schema: "agent-relay-fallback.v1",
      kind: "diagnostic",
      payload: {
        code: "resume-claim-retrying",
      },
    });
    await runtime.close();
  });

  it("diagnoses an operator-interrupted resumed process", async () => {
    const runtime = await setup();
    let invocationCount = 0;
    const runner = async (): Promise<OwnedChildResult> => {
      invocationCount += 1;
      if (invocationCount === 1) {
        await runHook({
          harness: "codex",
          surface: "cli",
          harnessVersion: "0.145.0",
          raw: codexStop,
          machineId,
          bridgeSessionId,
          occurredAt: "2026-07-24T12:00:00.000Z",
          client: runtime.client,
          fallbackPath: runtime.fallbackPath,
          lateResume: true,
          lateResumeTtlMs: 60_000,
        });
        await runtime.service.drain();
        const messageId = Number(
          runtime.transport.deliveries[0]?.receipt.messageId,
        );
        const topicId = Number(
          runtime.transport.deliveries[0]?.context.topicId,
        );
        await runtime.router.handle({
          update_id: 800,
          message: {
            message_id: 801,
            message_thread_id: topicId,
            from: { id: 7001 },
            chat: { id: 9001 },
            text: "Continue",
            reply_to_message: { message_id: messageId },
          },
        });
        return childResult();
      }
      return childResult({
        exitCode: null,
        signal: "SIGTERM",
        requestedSignal: "SIGTERM",
      });
    };

    const result = await runSupervisor({
      harness: "codex",
      harnessVersion: "0.145.0",
      machineId,
      bridgeSessionId,
      supervisorId,
      cwd: "/workspace/example",
      initialInvocation: { executable: "synthetic-codex", args: ["exec"] },
      client: runtime.client,
      logger: silentLogger,
      childRunner: runner,
      resumeWaitMs: 100,
      pollIntervalMs: 25,
    });

    expect(result).toMatchObject({
      exitCode: 143,
      classification: "signal",
      resumed: 1,
    });
    expect(runtime.store.listResumeCommands()).toEqual([
      expect.objectContaining({
        state: "failed",
        errorCode: "resume-interrupted",
        signal: "SIGTERM",
      }),
    ]);
    await runtime.close();
  });
});
