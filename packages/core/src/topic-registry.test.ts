import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeNotificationTransport } from "./notifications/adapters/fake.js";
import { MemoryLogger } from "./logger.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { sessionTopicMetadata } from "./topic.js";

function event(
  eventId: string,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: overrides.occurredAt ?? "2026-07-25T12:00:00.000Z",
    sequence: overrides.sequence ?? 1,
    machineId: overrides.machineId ?? "machine_topic_12345678",
    bridgeSessionId:
      overrides.bridgeSessionId ?? "bridge_topic_session_12345678",
    harness: overrides.harness ?? "codex",
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "test",
    sessionId: overrides.sessionId ?? "session_topic_12345678",
    project: overrides.project ?? {
      ...makeProjectRef("/workspace/example"),
      branch: "codex/topic-registry",
    },
    type: overrides.type ?? "turn.stopped",
    summary: overrides.summary ?? "Synthetic topic event",
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function clock(start = "2026-07-25T12:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe("durable session topic registry", () => {
  it("reuses one topic for repeated events from the same session", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    service.ingest(event("evt_topic_replay_one", { sequence: 1 }));
    service.ingest(event("evt_topic_replay_two", { sequence: 2 }));

    await expect(service.drain()).resolves.toMatchObject({
      claimed: 2,
      delivered: 2,
    });

    expect(transport.topics).toHaveLength(1);
    expect(
      new Set(transport.deliveries.map((item) => item.context.topicId)),
    ).toEqual(new Set(["1000"]));
    expect(store.listSessionTopics()).toEqual([
      expect.objectContaining({
        provider: "codex",
        repository: "example",
        branch: "codex/topic-registry",
        shortSessionId: expect.stringMatching(/^12345678-[a-f0-9]{6}$/),
        lifecycleState: "waiting",
        activity: expect.objectContaining({ state: "idle" }),
        provisioningStatus: "ready",
        topicId: "1000",
      }),
    ]);
    store.close();
  });

  it("allows only one topic creator under concurrent first deliveries", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    service.ingest(event("evt_topic_concurrent_one", { sequence: 1 }));
    service.ingest(event("evt_topic_concurrent_two", { sequence: 2 }));

    const firstPass = await Promise.all([service.drain(1), service.drain(1)]);

    expect(firstPass.reduce((sum, result) => sum + result.delivered, 0)).toBe(
      1,
    );
    expect(firstPass.reduce((sum, result) => sum + result.retrying, 0)).toBe(1);
    expect(transport.topics).toHaveLength(1);
    expect(
      transport.topicAttempts.filter(
        (attempt) => attempt.outcome === "created",
      ),
    ).toHaveLength(1);

    testClock.advance(1_000);
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(transport.topics).toHaveLength(1);
    expect(
      new Set(transport.deliveries.map((item) => item.context.topicId)),
    ).toEqual(new Set(["1000"]));
    store.close();
  });

  it("never shares a topic between simultaneous sessions", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    service.ingest(
      event("evt_topic_isolation_codex", {
        harness: "codex",
        sessionId: "session_isolated_codex",
      }),
    );
    service.ingest(
      event("evt_topic_isolation_claude", {
        harness: "claude",
        sessionId: "session_isolated_claude",
      }),
    );

    await service.drain();

    expect(transport.topics).toHaveLength(2);
    expect(
      new Set(transport.deliveries.map((item) => item.context.topicId)).size,
    ).toBe(2);
    expect(store.listSessionTopics()).toHaveLength(2);
    store.close();
  });

  it("preserves the mapping across a database close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-topics-"));
    const databasePath = join(directory, "relay.sqlite");
    try {
      const firstStore = new RelayStore(databasePath);
      const firstTransport = new FakeNotificationTransport();
      const firstService = new RelayService(firstStore, firstTransport);
      firstService.ingest(event("evt_topic_before_restart", { sequence: 1 }));
      await firstService.drain();
      expect(firstTransport.topics).toHaveLength(1);
      firstStore.close();

      const secondStore = new RelayStore(databasePath);
      const secondService = new RelayService(secondStore, firstTransport);
      secondService.recover();
      secondService.ingest(
        event("evt_topic_after_restart", {
          sequence: 2,
          summary: "Distinct event after restart",
        }),
      );
      await secondService.drain();

      expect(firstTransport.topics).toHaveLength(1);
      expect(firstTransport.topicAttempts).toHaveLength(1);
      expect(firstTransport.deliveries[1]?.context.topicId).toBe("1000");
      expect(secondStore.listSessionTopics()).toEqual([
        expect.objectContaining({
          provisioningStatus: "ready",
          topicId: "1000",
          attemptCount: 1,
        }),
      ]);
      secondStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries topic creation through the event spool and records a diagnostic", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const logger = new MemoryLogger();
    transport.failNextTopicCreation(1);
    const service = new RelayService(store, transport, {
      logger,
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    const input = event("evt_topic_retry_12345678");
    service.ingest(input);

    await expect(service.drain()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
      delivered: 0,
    });
    expect(store.getEvent(input.eventId)?.status).toBe("retry");
    expect(store.status().topics).toMatchObject({ retry: 1, ready: 0 });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "retry",
      attemptCount: 1,
      lastErrorCode: "fake-topic-timeout",
    });
    expect(store.listDiagnostics()).toEqual([
      expect.objectContaining({
        level: "warn",
        code: "topic.create-failed",
      }),
    ]);

    testClock.advance(1_000);
    await expect(service.drain()).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    expect(store.status().topics).toMatchObject({ retry: 0, ready: 1 });
    expect(transport.topics).toHaveLength(1);
    expect(
      logger.records.some((record) => record.code === "topic.created"),
    ).toBe(true);
    store.close();
  });

  it("preserves the assigned topic across retryable delivery failures", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    transport.failNext(1);
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    service.ingest(event("evt_topic_delivery_retry_12345678"));

    await expect(service.drain()).resolves.toMatchObject({
      delivered: 0,
      retrying: 1,
    });
    expect(transport.topics).toHaveLength(1);
    expect(transport.attempts).toEqual([
      expect.objectContaining({ outcome: "failed", topicId: "1000" }),
    ]);

    testClock.advance(1_000);
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(transport.topics).toHaveLength(1);
    expect(transport.attempts.map((attempt) => attempt.topicId)).toEqual([
      "1000",
      "1000",
    ]);
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "ready",
      topicId: "1000",
      attemptCount: 1,
    });
    store.close();
  });

  it("diagnoses and recreates a deleted topic without falling back to the general chat", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    service.ingest(event("evt_topic_before_delete_12345678", { sequence: 1 }));
    await service.drain();
    expect(transport.simulateTopicDeletion("1000")).toBe(true);

    service.ingest(
      event("evt_topic_after_delete_12345678", {
        sequence: 2,
        summary: "Distinct event after topic deletion",
      }),
    );
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 0,
      retrying: 1,
    });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "retry",
      lastErrorCode: "fake-topic-unavailable",
    });
    expect(store.listSessionTopics()[0]?.topicId).toBeUndefined();
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        code: "topic.reconciliation-required",
      }),
    );
    expect(
      transport.attempts.find(
        (attempt) =>
          attempt.eventId === "evt_topic_after_delete_12345678" &&
          attempt.outcome === "failed",
      ),
    ).toMatchObject({ topicId: "1000" });

    testClock.advance(1_000);
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "ready",
      topicId: "1001",
      attemptCount: 2,
    });
    expect(
      transport.deliveries.map((delivery) => delivery.context.topicId),
    ).toEqual(["1000", "1001"]);
    expect(
      transport.deliveries.every(
        (delivery) => delivery.context.topicId !== undefined,
      ),
    ).toBe(true);
    store.close();
  });

  it("diagnoses and replaces a closed topic deterministically", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    service.ingest(event("evt_topic_before_close_12345678", { sequence: 1 }));
    await service.drain();
    expect(transport.simulateTopicClosure("1000")).toBe(true);

    service.ingest(
      event("evt_topic_after_close_12345678", {
        sequence: 2,
        summary: "Distinct event after topic closure",
      }),
    );
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 0,
      retrying: 1,
    });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "retry",
      lastErrorCode: "fake-topic-closed",
    });

    testClock.advance(1_000);
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "ready",
      topicId: "1001",
    });
    expect(
      transport.deliveries.map((delivery) => delivery.context.topicId),
    ).toEqual(["1000", "1001"]);
    store.close();
  });

  it("isolates duplicate, delayed, and out-of-order events across interleaved sessions", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    const sessionA = "session_interleaved_a_12345678";
    const sessionB = "session_interleaved_b_87654321";
    const lateHighSequence = event("evt_interleaved_a_high", {
      occurredAt: "2026-07-25T12:00:03.000Z",
      sequence: 3,
      sessionId: sessionA,
      type: "turn.failed",
      failure: {
        class: "synthetic",
        message: "Synthetic interleaved failure",
      },
    });

    service.ingest(lateHighSequence);
    service.ingest(
      event("evt_interleaved_b_middle", {
        occurredAt: "2026-07-25T12:00:02.000Z",
        sequence: 2,
        sessionId: sessionB,
        type: "turn.stopped",
      }),
    );
    service.ingest(
      event("evt_interleaved_a_delayed", {
        occurredAt: "2026-07-25T12:00:01.000Z",
        sequence: 1,
        sessionId: sessionA,
        type: "session.started",
      }),
    );
    expect(service.ingest(lateHighSequence).inserted).toBe(false);

    await expect(service.drain()).resolves.toMatchObject({
      claimed: 3,
      delivered: 3,
    });
    const topicByEvent = new Map(
      transport.deliveries.map((delivery) => [
        delivery.message.eventId,
        delivery.context.topicId,
      ]),
    );
    expect(topicByEvent.get("evt_interleaved_a_high")).toBe(
      topicByEvent.get("evt_interleaved_a_delayed"),
    );
    expect(topicByEvent.get("evt_interleaved_a_high")).not.toBe(
      topicByEvent.get("evt_interleaved_b_middle"),
    );
    expect(
      transport.deliveries.every(
        (delivery) => delivery.context.topicId !== undefined,
      ),
    ).toBe(true);
    expect(transport.topics).toHaveLength(2);
    store.close();
  });

  it("dead-letters a non-retryable topic rejection without losing diagnosis", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    transport.failNextTopicCreation(1, {
      code: "fake-topics-disabled",
      message: "threaded mode is disabled",
      retryable: false,
    });
    const service = new RelayService(store, transport);
    const input = event("evt_topic_nonretryable_12345678");
    service.ingest(input);

    await expect(service.drain()).resolves.toMatchObject({
      deadLettered: 1,
      delivered: 0,
    });
    expect(store.getEvent(input.eventId)?.status).toBe("dead_letter");
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "failed",
      lastErrorCode: "fake-topics-disabled",
      lastErrorMessage: "threaded mode is disabled",
    });
    expect(store.listDiagnostics()[0]).toMatchObject({
      level: "error",
      code: "topic.create-failed",
    });
    store.close();
  });

  it("sanitizes topic metadata without persisting path or secret text in the name", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    const secret = "sk-syntheticSecretToken123456789";
    service.ingest(
      event("evt_topic_privacy_12345678", {
        project: {
          ...makeProjectRef("/workspace/example"),
          displayName: "/Users/private-owner/code/private-repository",
          branch: `C:\\Users\\private-owner\\${secret}`,
        },
      }),
    );

    await service.drain();

    const topic = store.listSessionTopics()[0];
    expect(topic).toMatchObject({
      repository: "private-repository",
      branch: "[REDACTED_OPENAI_KEY]",
    });
    expect(topic?.topicName).not.toContain("/Users/");
    expect(topic?.topicName).not.toContain("\\Users\\");
    expect(topic?.topicName).not.toContain(secret);
    expect(JSON.stringify(transport.topics)).not.toContain(secret);
    expect([...(topic?.topicName ?? "")].length).toBeLessThanOrEqual(128);
    store.close();
  });

  it("keeps collision-resistant identity visible when readable suffixes match", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    service.ingest(
      event("evt_topic_collision_one_12345678", {
        sessionId: "session_collision_alpha_12345678",
        project: {
          ...makeProjectRef("/workspace/example"),
          displayName: "x".repeat(120),
          branch: "y".repeat(240),
        },
      }),
    );
    service.ingest(
      event("evt_topic_collision_two_12345678", {
        sessionId: "session_collision_bravo_12345678",
        project: {
          ...makeProjectRef("/workspace/example"),
          displayName: "x".repeat(120),
          branch: "y".repeat(240),
        },
      }),
    );

    await service.drain();

    const topics = store.listSessionTopics();
    expect(new Set(topics.map((topic) => topic.topicName)).size).toBe(2);
    for (const topic of topics) {
      expect(topic.shortSessionId).toMatch(/^12345678-[a-f0-9]{6}$/);
      expect(topic.topicName.endsWith(topic.shortSessionId)).toBe(true);
      expect([...topic.topicName].length).toBeLessThanOrEqual(128);
    }
    store.close();
  });

  it("keeps stable topic identity while synchronizing state titles", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, { now: testClock.now });
    const sessionId = "session_topic_states_12345678";
    const started = event("evt_topic_state_running_12345678", {
      sessionId,
      sequence: 1,
      type: "turn.started",
    });
    service.ingest(started);
    await service.drain();
    const originalName = store.listSessionTopics(
      testClock.now().toISOString(),
    )[0]?.topicName;
    if (originalName === undefined) {
      throw new Error("missing original topic name");
    }
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity,
    ).toMatchObject({ state: "working", muted: false });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟢 ${originalName}`);

    service.ingest(
      event("evt_topic_state_waiting_12345678", {
        sessionId,
        sequence: 2,
        type: "input.required",
        request: {
          correlationId: "request_topic_state_12345678",
          kind: "input",
          question: "Synthetic bounded question",
          expiresAt: "2026-07-25T12:10:00.000Z",
        },
      }),
    );
    await service.drain();
    await expect(service.drainTopicTitleUpdates()).resolves.toMatchObject({
      scheduled: 1,
      updated: 1,
    });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity,
    ).toMatchObject({ state: "needs_input", muted: false });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟡 ${originalName}`);

    const muteAction = transport.deliveries
      .at(-1)
      ?.message.actions?.find((action) => action.kind === "mute");
    if (muteAction === undefined) {
      throw new Error("missing mute action for topic state fixture");
    }
    expect(
      store.executeCardAction({
        token: muteAction.token,
        kind: "mute",
        updateId: 401,
        now: "2026-07-25T12:00:01.000Z",
      }).outcome,
    ).toBe("succeeded");
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity,
    ).toMatchObject({ state: "needs_input", muted: true });
    await expect(service.drainTopicTitleUpdates()).resolves.toMatchObject({
      scheduled: 0,
      updated: 0,
    });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟡 ${originalName}`);

    expect(
      store.resolveRequest({
        correlationId: "request_topic_state_12345678",
        answer: "Synthetic answer",
        resolvedBy: "telegram",
        now: testClock.now().toISOString(),
      }).outcome,
    ).toBe("answered");
    service.ingest(
      event("evt_topic_state_recovery_12345678", {
        sessionId,
        sequence: 3,
        type: "turn.started",
      }),
    );
    await service.drain();
    await service.drainTopicTitleUpdates();
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟢 ${originalName}`);

    store.applySessionActivityInput(
      {
        machineId: started.machineId,
        harness: started.harness,
        sessionId,
      },
      {
        kind: "turn_failed",
        observedAt: testClock.now().toISOString(),
        source: "codex_app_server",
        correlationKey: "turn_topic_state_failure_12345678",
      },
    );
    await service.drainTopicTitleUpdates();
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity.state,
    ).toBe("failed");
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🔴 ${originalName}`);

    service.ingest(
      event("evt_topic_state_second_recovery_12345678", {
        sessionId,
        sequence: 5,
        type: "turn.started",
      }),
    );
    await service.drain();
    await service.drainTopicTitleUpdates();
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity.state,
    ).toBe("working");
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟢 ${originalName}`);

    service.ingest(
      event("evt_topic_state_stale_12345678", {
        sessionId,
        sequence: 6,
        type: "process.stale",
      }),
    );
    await service.drain();
    await service.drainTopicTitleUpdates();
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]?.activity.state,
    ).toBe("unknown");
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0]
        ?.displayTopicName,
    ).toBe(`🟠 ${originalName}`);

    service.ingest(
      event("evt_topic_state_ended_12345678", {
        sessionId,
        sequence: 7,
        type: "session.ended",
        surface: "app-server",
      }),
    );
    await service.drain();
    await service.drainTopicTitleUpdates();
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0],
    ).toMatchObject({
      activity: expect.objectContaining({ state: "ended", muted: true }),
      topicName: originalName,
      displayTopicName: `⚫ ${originalName}`,
    });
    expect(transport.topics).toHaveLength(1);
    expect(transport.topics[0]?.topic.name).toBe(`⚫ ${originalName}`);
    expect(transport.topicEdits).toHaveLength(5);
    store.close();
  });

  it("durably retries a transient state-title failure", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    const sessionId = "session_topic_title_retry_12345678";
    service.ingest(
      event("evt_topic_title_retry_started_12345678", {
        sessionId,
        sequence: 1,
        type: "turn.started",
      }),
    );
    await service.drain();
    transport.failNextTopicEdit(1);
    service.ingest(
      event("evt_topic_title_retry_waiting_12345678", {
        sessionId,
        sequence: 2,
        type: "turn.stopped",
      }),
    );
    await service.drain();

    await expect(service.drainTopicTitleUpdates()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
      updated: 0,
    });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0],
    ).toMatchObject({
      titleUpdateStatus: "retry",
      titleAttemptCount: 1,
      titleLastErrorCode: "fake-topic-edit-timeout",
    });
    expect(store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          code: "topic-title.update-retrying",
        }),
      ]),
    );

    testClock.advance(1_000);
    await expect(service.drainTopicTitleUpdates()).resolves.toMatchObject({
      claimed: 1,
      updated: 1,
      retrying: 0,
    });
    expect(
      store.listSessionTopics(testClock.now().toISOString())[0],
    ).toMatchObject({
      titleUpdateStatus: "ready",
      titleAttemptCount: 2,
      displayTopicName: expect.stringMatching(/^⚪ /u),
    });
    store.close();
  });

  it("recovers an interrupted state-title lease after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-title-"));
    const databasePath = join(directory, "relay.sqlite");
    const testClock = clock();
    const transport = new FakeNotificationTransport();
    const sessionId = "session_topic_title_recovery_12345678";
    try {
      const firstStore = new RelayStore(databasePath);
      const firstService = new RelayService(firstStore, transport, {
        now: testClock.now,
      });
      firstService.ingest(
        event("evt_topic_title_recovery_started_12345678", {
          sessionId,
          sequence: 1,
          type: "turn.started",
        }),
      );
      await firstService.drain();
      firstService.ingest(
        event("evt_topic_title_recovery_waiting_12345678", {
          sessionId,
          sequence: 2,
          type: "turn.stopped",
        }),
      );
      await firstService.drain();
      expect(
        firstStore.reconcileSessionTopicTitles({
          transportName: transport.name,
          transportScope: transport.topicScope,
          now: testClock.now().toISOString(),
        }),
      ).toBe(1);
      expect(
        firstStore.claimNextSessionTopicTitleUpdate({
          transportName: transport.name,
          transportScope: transport.topicScope,
          now: testClock.now().toISOString(),
        }),
      ).toMatchObject({
        attemptNumber: 1,
        topic: { titleUpdateStatus: "updating" },
      });
      firstStore.close();

      testClock.advance(1_000);
      const secondStore = new RelayStore(databasePath);
      const secondService = new RelayService(secondStore, transport, {
        now: testClock.now,
      });
      secondService.recover();
      expect(
        secondStore.listSessionTopics(testClock.now().toISOString())[0],
      ).toMatchObject({
        titleUpdateStatus: "retry",
        titleLastErrorCode: "topic-title-update-interrupted",
      });
      await expect(
        secondService.drainTopicTitleUpdates(),
      ).resolves.toMatchObject({
        claimed: 1,
        updated: 1,
      });
      expect(
        secondStore.listSessionTopics(testClock.now().toISOString())[0],
      ).toMatchObject({
        titleUpdateStatus: "ready",
        displayTopicName: expect.stringMatching(/^⚪ /u),
      });
      secondStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a topic that disappears during a state-title edit", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, { now: testClock.now });
    const sessionId = "session_topic_title_missing_12345678";
    service.ingest(
      event("evt_topic_title_missing_started_12345678", {
        sessionId,
        sequence: 1,
        type: "turn.started",
      }),
    );
    await service.drain();
    const topicId = store.listSessionTopics(testClock.now().toISOString())[0]
      ?.topicId;
    service.ingest(
      event("evt_topic_title_missing_stopped_12345678", {
        sessionId,
        sequence: 2,
        type: "turn.stopped",
      }),
    );
    await service.drain();
    if (topicId === undefined || !transport.simulateTopicDeletion(topicId)) {
      throw new Error("missing synthetic topic");
    }

    await expect(service.drainTopicTitleUpdates()).resolves.toMatchObject({
      claimed: 1,
      unavailable: 1,
      updated: 0,
    });
    expect(store.listSessionTopics()[0]).toMatchObject({
      provisioningStatus: "retry",
      titleUpdateStatus: "ready",
      lastErrorCode: "fake-topic-unavailable",
    });
    expect(store.listSessionTopics()[0]?.topicId).toBeUndefined();
    expect(store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          code: "topic-title.topic-unavailable",
        }),
      ]),
    );
    store.close();
  });

  it("suppresses and cancels delayed work after a session is ended", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport);
    const sessionId = "session_topic_ended_12345678";
    service.ingest(
      event("evt_topic_ended_started_12345678", {
        sessionId,
        sequence: 1,
        type: "session.started",
      }),
    );
    await service.drain();
    service.ingest(
      event("evt_topic_ended_terminal_12345678", {
        sessionId,
        sequence: 10,
        type: "session.ended",
        surface: "app-server",
      }),
    );
    await service.drain();

    const delayed = event("evt_topic_ended_delayed_12345678", {
      sessionId,
      sequence: 5,
      type: "input.required",
      request: {
        correlationId: "correlation_topic_ended_delayed_12345678",
        kind: "input",
        question: "This delayed question must not reopen the lane",
        expiresAt: "2026-07-25T12:05:00.000Z",
      },
    });
    service.ingest(delayed);
    await expect(service.drain()).resolves.toMatchObject({ delivered: 1 });

    expect(transport.deliveries).toHaveLength(2);
    expect(store.getEvent(delayed.eventId)?.status).toBe("delivered");
    expect(store.getEventTransportReceipt(delayed.eventId)).toMatchObject({
      transportName: "session-control",
      messageId: "suppressed:ended",
    });
    expect(
      store.getPendingRequest(delayed.request?.correlationId ?? ""),
    ).toMatchObject({ state: "cancelled" });
    expect(store.listSessionTopics()[0]?.laneState).toBe("ended");
    expect(store.listSessions()[0]?.lastEventType).toBe("session.ended");
    store.close();
  });

  it("recovers interrupted topic creation in bounded restart batches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-recovery-"));
    const databasePath = join(directory, "relay.sqlite");
    const input = event("evt_topic_interrupted_12345678");
    try {
      const firstStore = new RelayStore(databasePath);
      firstStore.ingestEvent(input);
      const metadata = sessionTopicMetadata(input);
      expect(
        firstStore.claimSessionTopic({
          machineId: input.machineId,
          harness: input.harness,
          sessionId: input.sessionId,
          transportName: "fake-telegram",
          transportScope: "fake:private-chat",
          ...metadata,
          now: input.occurredAt,
        }),
      ).toMatchObject({ outcome: "claimed" });
      firstStore.close();

      const secondStore = new RelayStore(databasePath);
      expect(
        secondStore.recoverInterruptedTopics("2026-07-25T12:00:01.000Z", 1),
      ).toBe(1);
      expect(secondStore.listSessionTopics()[0]).toMatchObject({
        provisioningStatus: "retry",
        lastErrorCode: "topic-creation-interrupted",
      });
      expect(() =>
        secondStore.recoverInterruptedTopics("2026-07-25T12:00:01.000Z", 0),
      ).toThrow("topic recovery limit must be between 1 and 5000");

      const transport = new FakeNotificationTransport();
      const service = new RelayService(secondStore, transport, {
        now: () => new Date("2026-07-25T12:00:01.000Z"),
      });
      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 });
      expect(secondStore.listSessionTopics()[0]).toMatchObject({
        provisioningStatus: "ready",
        topicId: "1000",
      });
      secondStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates and backfills the latest event type for an existing store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-migration-"));
    const databasePath = join(directory, "relay.sqlite");
    const input = event("evt_topic_migration_12345678", {
      sequence: 3,
      type: "turn.failed",
      failure: {
        class: "synthetic",
        message: "Synthetic migrated failure",
      },
    });
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE sessions (
          machine_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          session_id TEXT NOT NULL,
          bridge_session_id TEXT NOT NULL,
          surface TEXT NOT NULL,
          harness_version TEXT NOT NULL,
          project_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          state TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (machine_id, harness, session_id)
        );
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          lease_started_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          transport_name TEXT,
          transport_message_id TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT
        );
      `);
      legacy
        .prepare(
          `
          INSERT INTO sessions (
            machine_id, harness, session_id, bridge_session_id, surface,
            harness_version, project_json, capabilities_json, state,
            last_seen_at, last_sequence, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.machineId,
          input.harness,
          input.sessionId,
          input.bridgeSessionId,
          input.surface,
          input.harnessVersion,
          JSON.stringify(input.project),
          JSON.stringify(input.capabilities),
          "stopped",
          input.occurredAt,
          input.sequence,
          input.occurredAt,
        );
      legacy
        .prepare(
          `
          INSERT INTO events (
            event_id, machine_id, harness, session_id, type, payload_json,
            status, next_attempt_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, ?)
        `,
        )
        .run(
          input.eventId,
          input.machineId,
          input.harness,
          input.sessionId,
          input.type,
          JSON.stringify(input),
          input.occurredAt,
          input.occurredAt,
        );
      legacy.close();

      const migrated = new RelayStore(databasePath);
      expect(migrated.listSessions()).toEqual([
        expect.objectContaining({
          state: "stopped",
          lastEventType: "turn.failed",
        }),
      ]);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
