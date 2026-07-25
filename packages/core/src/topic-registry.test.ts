import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { MemoryLogger } from "./logger.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

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
    const transport = new FakeTelegramTransport();
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
        shortSessionId: "12345678",
        lifecycleState: "waiting",
        provisioningStatus: "ready",
        topicId: "1000",
      }),
    ]);
    store.close();
  });

  it("allows only one topic creator under concurrent first deliveries", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
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
    const transport = new FakeTelegramTransport();
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
      const firstTransport = new FakeTelegramTransport();
      const firstService = new RelayService(firstStore, firstTransport);
      firstService.ingest(event("evt_topic_before_restart", { sequence: 1 }));
      await firstService.drain();
      expect(firstTransport.topics).toHaveLength(1);
      firstStore.close();

      const secondStore = new RelayStore(databasePath);
      const secondTransport = new FakeTelegramTransport();
      const secondService = new RelayService(secondStore, secondTransport);
      secondService.recover();
      secondService.ingest(event("evt_topic_after_restart", { sequence: 2 }));
      await secondService.drain();

      expect(secondTransport.topics).toHaveLength(0);
      expect(secondTransport.deliveries[0]?.context.topicId).toBe("1000");
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
    const transport = new FakeTelegramTransport();
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

  it("dead-letters a non-retryable topic rejection without losing diagnosis", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
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
    const transport = new FakeTelegramTransport();
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
});
