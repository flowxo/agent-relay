import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";
import {
  FakeNotificationTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

import { TelegramReplyRouter } from "./reply-router.js";

const baseTime = "2026-07-28T12:00:00.000Z";

function event(
  sessionId: string,
  sequence: number,
  type: AgentAttentionEventV1["type"],
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `evt_cleanup_${sessionId}_${String(sequence)}`,
    occurredAt: baseTime,
    sequence,
    machineId: "machine_cleanup_12345678",
    bridgeSessionId: `bridge_${sessionId}`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId,
    project: makeProjectRef(`/workspace/${sessionId}`),
    type,
    summary: `Cleanup fixture ${type}`,
    ...(type === "process.exited"
      ? {
          failure: {
            class: "signal" as const,
            message: "Synthetic owned child received SIGKILL",
          },
          processExit: {
            source: "owned-child" as const,
            supervisorId: "supervisor_cleanup_12345678",
            startedAt: "2026-07-28T11:59:00.000Z",
            exitedAt: baseTime,
            signal: "SIGKILL",
            classification: "signal" as const,
            expected: false,
          },
        }
      : {}),
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function clock() {
  let current = new Date(baseTime);
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function setup(
  options: {
    storePath?: string;
    testClock?: ReturnType<typeof clock>;
    transport?: FakeNotificationTransport;
    logger?: MemoryLogger;
  } = {},
) {
  const testClock = options.testClock ?? clock();
  const store =
    options.storePath === undefined
      ? new RelayStore()
      : new RelayStore(options.storePath);
  const transport = options.transport ?? new FakeNotificationTransport();
  const logger = options.logger ?? new MemoryLogger();
  const service = new RelayService(store, transport, {
    now: testClock.now,
    logger,
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
    },
  });
  const router = new TelegramReplyRouter(store, transport, {
    operatorUserId: 7001,
    chatId: 9001,
    now: testClock.now,
    logger,
    topicCleanup: service,
  });
  return { testClock, store, transport, logger, service, router };
}

async function createTopic(
  runtime: ReturnType<typeof setup>,
  sessionId: string,
  terminalType: "session.ended" | "process.exited" | "turn.started",
) {
  await createWaitingTopic(runtime, sessionId);
  runtime.service.ingest(event(sessionId, 2, terminalType));
  await runtime.service.drain();
  return runtime.store
    .listSessionTopics()
    .find((topic) => topic.sessionId === sessionId)!;
}

async function createWaitingTopic(
  runtime: ReturnType<typeof setup>,
  sessionId: string,
  lastAssistantMessage?: string,
) {
  runtime.service.ingest({
    ...event(sessionId, 1, "turn.stopped"),
    ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
  });
  await runtime.service.drain();
  return runtime.store
    .listSessionTopics()
    .find((topic) => topic.sessionId === sessionId)!;
}

async function preview(
  runtime: ReturnType<typeof setup>,
  updateId = 100,
  text = "/cleanup",
  messageThreadId?: number,
) {
  const result = await runtime.router.handle({
    update_id: updateId,
    message: {
      message_id: updateId + 1_000,
      from: { id: 7001 },
      chat: { id: 9001 },
      text,
      ...(messageThreadId === undefined
        ? {}
        : { message_thread_id: messageThreadId }),
    },
  });
  const control = runtime.transport.operatorControls.at(-1);
  expect(control).toBeDefined();
  return { result, control: control! };
}

function callbackData(
  control: ReturnType<typeof setup>["transport"]["operatorControls"][number],
  index: number,
): string {
  const value = control.message.buttons[0]?.[index]?.callbackData;
  if (value === undefined) {
    throw new Error("cleanup callback fixture is missing");
  }
  return value;
}

describe("Telegram proven-dead topic cleanup", () => {
  it("previews, confirms, deletes, and makes repeated confirmation harmless", async () => {
    const runtime = setup();
    const topic = await createTopic(
      runtime,
      "session_cleanup_complete",
      "session.ended",
    );

    const shown = await preview(runtime, 100, "/cleanup", 4_100);
    expect(shown.result).toMatchObject({ outcome: "cleanup-previewed" });
    expect(shown.control.context.topicId).toBe("4100");
    expect(shown.control.message.text).toContain(
      "Delete 1 proven-dead session topic",
    );
    expect(shown.control.message.text).toContain("session_cleanup_complete");

    const confirmed = await runtime.router.handle({
      update_id: 101,
      callback_query: {
        id: "callback_cleanup_confirm",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          message_thread_id: 4_100,
          chat: { id: 9001 },
        },
      },
    });
    expect(confirmed).toMatchObject({ outcome: "cleanup-confirmed" });

    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      supported: true,
      claimed: 1,
      deleted: 1,
      completedOperations: 1,
    });
    expect(runtime.transport.topicDeletionAttempts).toEqual([
      expect.objectContaining({
        topicId: topic.topicId,
        outcome: "deleted",
      }),
    ]);
    expect(
      runtime.store.getSessionTopic({
        ...topic,
        transportName: runtime.transport.name,
        transportScope: runtime.transport.topicScope,
      }),
    ).toBeUndefined();
    expect(
      runtime.transport.operatorControlEdits.at(-1)?.message.text,
    ).toContain("topic cleanup complete");
    expect(runtime.store.status().topicCleanups.completed).toBe(1);

    await expect(
      runtime.router.handle({
        update_id: 102,
        callback_query: {
          id: "callback_cleanup_duplicate",
          from: { id: 7001 },
          data: callbackData(shown.control, 0),
          message: {
            message_id: Number(shown.control.receipt.messageId),
            message_thread_id: 4_100,
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-duplicate" });
    expect(runtime.transport.topicDeletionAttempts).toHaveLength(1);
    runtime.testClock.advance(31 * 24 * 60 * 60_000);
    expect(runtime.service.maintainRetention()).toMatchObject({
      topicCleanupOperations: 1,
    });
    expect(runtime.store.listTopicCleanupOperations()).toHaveLength(0);
    runtime.store.close();
  });

  it("excludes crashes and active sessions, then skips a candidate whose state changes", async () => {
    const runtime = setup();
    const ended = await createTopic(
      runtime,
      "session_cleanup_ended",
      "session.ended",
    );
    await createTopic(runtime, "session_cleanup_crashed", "process.exited");
    await createTopic(runtime, "session_cleanup_active", "turn.started");

    const shown = await preview(runtime);
    expect(shown.control.message.text).toContain("session_cleanup_ended");
    expect(shown.control.message.text).not.toContain("session_cleanup_crashed");
    expect(shown.control.message.text).not.toContain("session_cleanup_active");

    runtime.service.ingest(event("session_cleanup_ended", 3, "turn.activity"));
    await runtime.router.handle({
      update_id: 103,
      callback_query: {
        id: "callback_cleanup_state_change",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });

    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 0,
      skipped: 1,
      completedOperations: 1,
    });
    expect(runtime.transport.topicDeletionAttempts).toHaveLength(0);
    expect(
      runtime.store.getSessionTopic({
        ...ended,
        transportName: runtime.transport.name,
        transportScope: runtime.transport.topicScope,
      }),
    ).toBeDefined();
    runtime.store.close();
  });

  it("expires stale confirmations without deleting anything", async () => {
    const runtime = setup();
    await createTopic(runtime, "session_cleanup_expired", "session.ended");
    const shown = await preview(runtime);
    runtime.testClock.advance(10 * 60_000 + 1);

    await expect(
      runtime.router.handle({
        update_id: 104,
        callback_query: {
          id: "callback_cleanup_expired",
          from: { id: 7001 },
          data: callbackData(shown.control, 0),
          message: {
            message_id: Number(shown.control.receipt.messageId),
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-expired" });
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(runtime.transport.topicDeletionAttempts).toHaveLength(0);
    expect(
      runtime.transport.operatorControlEdits.at(-1)?.message.text,
    ).toContain("Confirmation expired");
    runtime.store.close();
  });

  it("supersedes an older preview and honors explicit cancellation", async () => {
    const runtime = setup();
    const topic = await createTopic(
      runtime,
      "session_cleanup_cancelled",
      "session.ended",
    );
    const first = await preview(runtime, 108);
    const second = await preview(runtime, 109);

    expect(
      runtime.transport.operatorControlEdits.find(
        (edit) => edit.messageId === first.control.receipt.messageId,
      )?.message.text,
    ).toContain("replaced by a newer topic-deletion request");
    await expect(
      runtime.router.handle({
        update_id: 110,
        callback_query: {
          id: "callback_cleanup_cancel",
          from: { id: 7001 },
          data: callbackData(second.control, 1),
          message: {
            message_id: Number(second.control.receipt.messageId),
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-cancelled" });
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(runtime.transport.topicDeletionAttempts).toHaveLength(0);
    expect(
      runtime.store.getSessionTopic({
        ...topic,
        transportName: runtime.transport.name,
        transportScope: runtime.transport.topicScope,
      }),
    ).toBeDefined();
    runtime.store.close();
  });

  it("durably retries transient deletion failures and recovers an interrupted claim", async () => {
    const runtime = setup();
    await createTopic(runtime, "session_cleanup_retry", "session.ended");
    const shown = await preview(runtime);
    await runtime.router.handle({
      update_id: 105,
      callback_query: {
        id: "callback_cleanup_retry",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });

    const interrupted = runtime.store.claimNextTopicCleanupCandidate(
      runtime.testClock.now().toISOString(),
    );
    expect(interrupted.outcome).toBe("claimed");
    expect(runtime.service.recover()).toBe(0);
    runtime.transport.failNextTopicDeletion(1);

    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    runtime.testClock.advance(2_000);
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 1,
      deleted: 1,
      completedOperations: 1,
    });
    expect(
      runtime.transport.topicDeletionAttempts.map((entry) => entry.outcome),
    ).toEqual(["failed", "deleted"]);
    expect(
      runtime.logger.records.some(
        (record) => record.code === "topic-cleanup.recovered",
      ),
    ).toBe(true);
    runtime.store.close();
  });

  it("rejects unauthorized and malformed cleanup callbacks", async () => {
    const runtime = setup();
    await expect(
      runtime.router.handle({
        update_id: 106,
        callback_query: {
          id: "callback_cleanup_unauthorized",
          from: { id: 7999 },
          data: "relay-c:v1:y:cleanup_0123456789abcdef0123456789abcdef",
          message: {
            message_id: 500,
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "unauthorized" });
    await expect(
      runtime.router.handle({
        update_id: 107,
        callback_query: {
          id: "callback_cleanup_malformed",
          from: { id: 7001 },
          data: "relay-c:v1:y:cleanup_readable",
          message: {
            message_id: 501,
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-rejected" });
    expect(runtime.store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "telegram.topic-cleanup-unauthorized",
        }),
        expect.objectContaining({
          code: "telegram.topic-cleanup-malformed",
        }),
      ]),
    );
    runtime.store.close();
  });
});

describe("Telegram inactive-topic pruning", () => {
  it("accepts /purge, defaults to 24 hours, deletes only after confirmation, and recreates a later topic without ending the session", async () => {
    const runtime = setup();
    const original = await createWaitingTopic(
      runtime,
      "session_prune_recreate",
    );

    const tooSoon = await preview(runtime, 200, "/purge");
    expect(tooSoon.result).toMatchObject({ outcome: "cleanup-previewed" });
    expect(tooSoon.control.message.text).toContain(
      "No safe session topics have been inactive for at least 1 day",
    );

    runtime.testClock.advance(24 * 60 * 60_000 + 1);
    const shown = await preview(runtime, 201, "/purge", 4_201);
    expect(shown.control.context.topicId).toBe("4201");
    expect(shown.control.message.text).toContain(
      "Purge 1 session topic(s) inactive for at least 1 day",
    );
    expect(shown.control.message.text).toContain("session_prune_recreate");
    expect(shown.control.message.text).toContain(
      "a later event recreates a fresh topic",
    );

    await runtime.router.handle({
      update_id: 202,
      callback_query: {
        id: "callback_prune_confirm",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          message_thread_id: 4_201,
          chat: { id: 9001 },
        },
      },
    });
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      deleted: 1,
      completedOperations: 1,
    });
    expect(runtime.store.getSessionControl(original)).toBeUndefined();
    expect(
      runtime.store
        .listSessions()
        .find((session) => session.sessionId === original.sessionId),
    ).toMatchObject({ state: "waiting" });

    runtime.service.ingest(event(original.sessionId, 2, "turn.stopped"));
    await runtime.service.drain();
    const recreated = runtime.store.getSessionTopic({
      ...original,
      transportName: runtime.transport.name,
      transportScope: runtime.transport.topicScope,
    });
    expect(recreated?.topicId).toBeDefined();
    expect(recreated?.topicId).not.toBe(original.topicId);
    runtime.store.close();
  });

  it("supports bounded hour/day thresholds and explains malformed durations", async () => {
    const runtime = setup();
    await createWaitingTopic(runtime, "session_prune_duration");
    runtime.testClock.advance(2 * 60 * 60_000);

    const threeHours = await preview(runtime, 203, "/purge 3h");
    expect(threeHours.control.message.text).toContain(
      "No safe session topics have been inactive for at least 3 hours",
    );
    const oneHour = await preview(runtime, 204, "/purge@AgentRelayBot 1h");
    expect(oneHour.control.message.text).toContain("session_prune_duration");

    const malformed = await runtime.router.handle({
      update_id: 205,
      message: {
        message_id: 1_205,
        message_thread_id: 4_205,
        from: { id: 7001 },
        chat: { id: 9001 },
        text: "/purge 31d",
      },
    });
    expect(malformed).toMatchObject({ outcome: "cleanup-rejected" });
    expect(runtime.transport.operatorControls.at(-1)?.message.text).toContain(
      "between 1 hour and 30 days",
    );
    expect(runtime.transport.operatorControls.at(-1)?.message.text).toContain(
      "Usage: /purge",
    );
    expect(runtime.transport.operatorControls.at(-1)?.context.topicId).toBe(
      "4205",
    );
    expect(runtime.store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "telegram.topic-prune-invalid-duration",
      }),
    );
    runtime.store.close();
  });

  it("retains /prune as a compatibility alias", async () => {
    const runtime = setup();
    await createWaitingTopic(runtime, "session_prune_compatibility");
    runtime.testClock.advance(24 * 60 * 60_000 + 1);

    const shown = await preview(runtime, 216, "/prune");
    expect(shown.result).toMatchObject({ outcome: "cleanup-previewed" });
    expect(shown.control.message.text).toContain("session_prune_compatibility");
    runtime.store.close();
  });

  it("offers a one-tap inactive preview when proven-dead cleanup finds nothing", async () => {
    const runtime = setup();
    await createWaitingTopic(runtime, "session_prune_discovery");
    runtime.testClock.advance(24 * 60 * 60_000 + 1);

    const cleanup = await preview(runtime, 206, "/cleanup", 4_206);
    expect(cleanup.control.context.topicId).toBe("4206");
    expect(cleanup.control.message.text).toContain(
      "To review inactive topics without marking their sessions ended",
    );
    const startData = callbackData(cleanup.control, 0);
    expect(startData).toBe("relay-p:v1:24h");

    await expect(
      runtime.router.handle({
        update_id: 207,
        callback_query: {
          id: "callback_prune_start",
          from: { id: 7001 },
          data: startData,
          message: {
            message_id: Number(cleanup.control.receipt.messageId),
            message_thread_id: 4_206,
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-previewed" });
    expect(runtime.transport.operatorControls.at(-1)?.message.text).toContain(
      "session_prune_discovery",
    );
    expect(runtime.transport.operatorControls.at(-1)?.context.topicId).toBe(
      "4206",
    );
    expect(runtime.transport.callbackAcknowledgements.at(-1)).toEqual({
      callbackId: "callback_prune_start",
      text: "Purge preview ready",
    });
    runtime.store.close();
  });

  it("excludes active, open-request, claimed-resume, and queued-delivery sessions", async () => {
    const runtime = setup();
    const eligible = await createWaitingTopic(
      runtime,
      "session_prune_eligible",
    );
    await createTopic(runtime, "session_prune_active", "turn.started");
    await createTopic(runtime, "session_prune_ended", "session.ended");

    const openSessionId = "session_prune_open_request";
    await createWaitingTopic(runtime, openSessionId);
    runtime.service.ingest({
      ...event(openSessionId, 2, "input.required"),
      request: {
        correlationId: "correlation_prune_open_request",
        kind: "input",
        question: "Keep this topic?",
        expiresAt: "2026-07-31T12:00:00.000Z",
      },
    });
    await runtime.service.drain();

    const resumeSessionId = "session_prune_resume";
    await createWaitingTopic(runtime, resumeSessionId);
    const continuation = {
      ...event(resumeSessionId, 2, "turn.stopped"),
      bridgeSessionId: `bridge_${resumeSessionId}`,
      turnId: "turn_prune_resume",
      request: {
        correlationId: "correlation_prune_resume",
        kind: "continuation" as const,
        question: "Continue?",
        expiresAt: "2026-07-31T12:00:00.000Z",
      },
    };
    runtime.service.ingest(continuation);
    await runtime.service.drain();

    const queuedSessionId = "session_prune_queued";
    await createWaitingTopic(runtime, queuedSessionId);
    runtime.testClock.advance(25 * 60 * 60_000);
    expect(
      runtime.service.resolveTerminal({
        correlationId: continuation.request.correlationId,
        answer: "continue",
        expected: {
          machineId: continuation.machineId,
          harness: continuation.harness,
          sessionId: continuation.sessionId,
          turnId: continuation.turnId,
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      runtime.service.claimNextResume({
        machineId: continuation.machineId,
        bridgeSessionId: continuation.bridgeSessionId,
        harness: continuation.harness,
        ownerId: "owner_prune_resume",
      }),
    ).toMatchObject({ outcome: "claimed" });
    runtime.service.ingest(event(queuedSessionId, 2, "turn.stopped"));

    const shown = await preview(runtime, 208, "/prune");
    expect(shown.control.message.text).toContain(eligible.sessionId);
    expect(shown.control.message.text).not.toContain("session_prune_active");
    expect(shown.control.message.text).not.toContain("session_prune_ended");
    expect(shown.control.message.text).not.toContain(openSessionId);
    expect(shown.control.message.text).not.toContain(resumeSessionId);
    expect(shown.control.message.text).not.toContain(queuedSessionId);
    expect(
      runtime.store.getTopicCleanupOperation(
        runtime.store.listTopicCleanupOperations().at(-1)!.operationId,
      ),
    ).toMatchObject({
      mode: "inactive",
      inactiveBefore: "2026-07-28T13:00:00.000Z",
      eligibleCount: 1,
    });
    runtime.store.close();
  });

  it("treats /purge as a command instead of an answer to an open request", async () => {
    const runtime = setup();
    const sessionId = "session_purge_command_isolation";
    const topic = await createWaitingTopic(runtime, sessionId);
    runtime.service.ingest({
      ...event(sessionId, 2, "input.required"),
      request: {
        correlationId: "correlation_purge_command_isolation",
        kind: "input",
        question: "What should happen next?",
        expiresAt: "2026-07-31T12:00:00.000Z",
      },
    });
    await runtime.service.drain();

    await expect(
      runtime.router.handle({
        update_id: 217,
        message: {
          message_id: 1_217,
          message_thread_id: Number(topic.topicId),
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "/purge",
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-previewed" });
    expect(
      runtime.store.getPendingRequest("correlation_purge_command_isolation"),
    ).toMatchObject({ state: "open" });
    runtime.store.close();
  });

  it("revalidates each session independently and retains no transcript text", async () => {
    const runtime = setup();
    const privateSentinel = "PRIVATE_TRANSCRIPT_SENTINEL_DO_NOT_RETAIN";
    const first = await createWaitingTopic(
      runtime,
      "session_prune_first",
      privateSentinel,
    );
    const second = await createWaitingTopic(runtime, "session_prune_second");
    runtime.testClock.advance(25 * 60 * 60_000);
    const shown = await preview(runtime, 209, "/prune");
    const operation = runtime.store.listTopicCleanupOperations().at(-1)!;
    expect(operation.candidates).toHaveLength(2);
    expect(JSON.stringify(operation)).not.toContain(privateSentinel);
    expect(shown.control.message.text).not.toContain(privateSentinel);

    runtime.service.ingest(event(first.sessionId, 2, "turn.activity"));
    await runtime.router.handle({
      update_id: 210,
      callback_query: {
        id: "callback_prune_isolation",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 1,
      deleted: 1,
      skipped: 1,
      completedOperations: 1,
    });
    expect(runtime.transport.topicDeletionAttempts).toEqual([
      expect.objectContaining({ topicId: second.topicId }),
    ]);
    expect(
      runtime.store.getSessionTopic({
        ...first,
        transportName: runtime.transport.name,
        transportScope: runtime.transport.topicScope,
      }),
    ).toBeDefined();
    runtime.store.close();
  });

  it("blocks delivery into a claimed deletion and lets new work cancel the prune safely", async () => {
    const runtime = setup();
    const topic = await createWaitingTopic(runtime, "session_prune_claim_race");
    runtime.testClock.advance(25 * 60 * 60_000);
    const shown = await preview(runtime, 215, "/prune");
    await runtime.router.handle({
      update_id: 216,
      callback_query: {
        id: "callback_prune_claim_race",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });
    expect(
      runtime.store.claimNextTopicCleanupCandidate(
        runtime.testClock.now().toISOString(),
      ),
    ).toMatchObject({ outcome: "claimed" });

    const deliveryAttemptsBefore = runtime.transport.attempts.length;
    runtime.service.ingest(event(topic.sessionId, 2, "turn.stopped"));
    await expect(runtime.service.drain()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
      delivered: 0,
    });
    expect(runtime.transport.attempts).toHaveLength(deliveryAttemptsBefore);
    expect(runtime.logger.records).toContainEqual(
      expect.objectContaining({
        code: "delivery.retry-scheduled",
        details: expect.objectContaining({
          errorCode: "topic-deletion-busy",
        }),
      }),
    );

    runtime.service.recover();
    await expect(runtime.service.drainTopicCleanups()).resolves.toMatchObject({
      claimed: 0,
      skipped: 1,
      completedOperations: 1,
    });
    expect(runtime.transport.topicDeletionAttempts).toHaveLength(0);
    runtime.testClock.advance(2_000);
    await expect(runtime.service.drain()).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
      retrying: 0,
    });
    expect(
      runtime.store.getSessionTopic({
        ...topic,
        transportName: runtime.transport.name,
        transportScope: runtime.transport.topicScope,
      })?.topicId,
    ).toBe(topic.topicId);
    runtime.store.close();
  });

  it("persists prune mode and cutoff while recovering an interrupted deletion across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-prune-"));
    const storePath = join(directory, "relay.sqlite");
    const runtime = setup({ storePath });
    await createWaitingTopic(runtime, "session_prune_restart");
    runtime.testClock.advance(25 * 60 * 60_000);
    const shown = await preview(runtime, 213, "/prune");
    await runtime.router.handle({
      update_id: 214,
      callback_query: {
        id: "callback_prune_restart",
        from: { id: 7001 },
        data: callbackData(shown.control, 0),
        message: {
          message_id: Number(shown.control.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });
    expect(
      runtime.store.claimNextTopicCleanupCandidate(
        runtime.testClock.now().toISOString(),
      ),
    ).toMatchObject({
      outcome: "claimed",
      operation: {
        mode: "inactive",
        inactiveBefore: "2026-07-28T13:00:00.000Z",
      },
    });
    runtime.store.close();

    const restarted = setup({
      storePath,
      testClock: runtime.testClock,
      transport: runtime.transport,
      logger: runtime.logger,
    });
    restarted.service.recover();
    restarted.transport.failNextTopicDeletion(1);
    await expect(restarted.service.drainTopicCleanups()).resolves.toMatchObject(
      {
        claimed: 1,
        retrying: 1,
      },
    );
    restarted.testClock.advance(2_000);
    await expect(restarted.service.drainTopicCleanups()).resolves.toMatchObject(
      {
        claimed: 1,
        deleted: 1,
        completedOperations: 1,
      },
    );
    expect(restarted.store.listTopicCleanupOperations().at(-1)).toMatchObject({
      mode: "inactive",
      inactiveBefore: "2026-07-28T13:00:00.000Z",
      state: "completed",
    });
    expect(
      restarted.logger.records.some(
        (record) => record.code === "topic-cleanup.recovered",
      ),
    ).toBe(true);
    restarted.store.close();
  });

  it("rejects unauthorized and accepts authorized threaded prune-start controls", async () => {
    const runtime = setup();
    await expect(
      runtime.router.handle({
        update_id: 211,
        callback_query: {
          id: "callback_prune_unauthorized",
          from: { id: 7999 },
          data: "relay-p:v1:24h",
          message: { message_id: 1_211, chat: { id: 9001 } },
        },
      }),
    ).resolves.toMatchObject({ outcome: "unauthorized" });
    await expect(
      runtime.router.handle({
        update_id: 212,
        callback_query: {
          id: "callback_prune_threaded",
          from: { id: 7001 },
          data: "relay-p:v1:24h",
          message: {
            message_id: 1_212,
            message_thread_id: 123,
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "cleanup-previewed" });
    expect(runtime.transport.operatorControls.at(-1)?.context.topicId).toBe(
      "123",
    );
    expect(runtime.store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "telegram.topic-prune-unauthorized",
        }),
      ]),
    );
    runtime.store.close();
  });
});
