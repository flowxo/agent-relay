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

function setup() {
  const testClock = clock();
  const store = new RelayStore();
  const transport = new FakeNotificationTransport();
  const logger = new MemoryLogger();
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
  runtime.service.ingest(event(sessionId, 1, "turn.stopped"));
  await runtime.service.drain();
  runtime.service.ingest(event(sessionId, 2, terminalType));
  await runtime.service.drain();
  return runtime.store
    .listSessionTopics()
    .find((topic) => topic.sessionId === sessionId)!;
}

async function preview(runtime: ReturnType<typeof setup>, updateId = 100) {
  const result = await runtime.router.handle({
    update_id: updateId,
    message: {
      message_id: updateId + 1_000,
      from: { id: 7001 },
      chat: { id: 9001 },
      text: "/cleanup",
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

    const shown = await preview(runtime);
    expect(shown.result).toMatchObject({ outcome: "cleanup-previewed" });
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
    ).toContain("replaced by a newer /cleanup request");
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
