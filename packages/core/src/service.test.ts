import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import {
  makeProjectRef,
  makeStableEventId,
  sha256,
} from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { MemoryLogger } from "./logger.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { TransportError, type NotificationTransport } from "./transport.js";

function event(
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  const harness = overrides.harness ?? "codex";
  const sessionId = overrides.sessionId ?? "session_12345678";
  const sequence = overrides.sequence ?? 1;
  const type = overrides.type ?? "turn.stopped";
  const machineId = overrides.machineId ?? "machine_12345678";
  return {
    schema: "agent-attention.v1",
    eventId:
      overrides.eventId ??
      makeStableEventId({
        machineId,
        harness,
        sessionId,
        type,
        sequence,
      }),
    occurredAt: overrides.occurredAt ?? "2026-07-24T12:00:00.000Z",
    sequence,
    machineId,
    bridgeSessionId: overrides.bridgeSessionId ?? "bridge_session_12345678",
    harness,
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "test",
    sessionId,
    project: overrides.project ?? makeProjectRef("/workspace/example"),
    type,
    summary: overrides.summary ?? "Synthetic event",
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: overrides.lastAssistantMessage }),
    ...(overrides.processExit === undefined
      ? {}
      : { processExit: overrides.processExit }),
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
  };
}

function clock(start = "2026-07-24T12:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe("RelayService durable delivery loop", () => {
  it("deduplicates repeated event ingestion and user-visible delivery", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const input = event();

    expect(service.ingest(input).inserted).toBe(true);
    expect(service.ingest(input).inserted).toBe(false);
    expect(await service.drain()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    expect(await service.drain()).toMatchObject({ claimed: 0 });
    expect(transport.deliveries).toHaveLength(1);
    expect(store.status().events.delivered).toBe(1);
    expect(
      store.transportDeliverySummary("fake-telegram", "fake-"),
    ).toMatchObject({
      lastSuccessfulSendAt: expect.any(String),
    });
    store.close();
  });

  it("logs only hashed delivery identities", async () => {
    const store = new RelayStore();
    const logger = new MemoryLogger();
    const providerMessageId = "message_private_provider_12345678";
    const transport: NotificationTransport = {
      name: "notifications",
      deliver: async () => ({
        transport: "notifications",
        messageId: providerMessageId,
      }),
    };
    const service = new RelayService(store, transport, { logger });
    const input = event({
      eventId: "event_private_delivery_12345678",
      sessionId: "session_private_delivery_12345678",
    });
    service.ingest(input);

    await expect(service.drain()).resolves.toMatchObject({ delivered: 1 });

    const delivered = logger.records.find(
      (record) => record.code === "delivery.succeeded",
    );
    expect(delivered?.details).toEqual({
      eventRef: sha256(input.eventId).slice(0, 12),
      transport: "notifications",
      messageRef: sha256(`notifications\u001f${providerMessageId}`).slice(
        0,
        12,
      ),
    });
    expect(JSON.stringify(delivered)).not.toContain(input.eventId);
    expect(JSON.stringify(delivered)).not.toContain(providerMessageId);
    store.close();
  });

  it("renders a distinct correlated question in the notification", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    service.ingest(
      event({
        eventId: "evt_render_question_12345678",
        type: "input.required",
        summary: "The agent needs an operator decision.",
        request: {
          correlationId: "correlation_render_question_12345678",
          kind: "input",
          question: "Which deployment should continue?",
          expiresAt: "2026-07-24T12:05:00.000Z",
        },
      }),
    );

    await service.drain();

    expect(transport.deliveries[0]?.message.text).toContain(
      "Question: Which deployment should continue?",
    );
    store.close();
  });

  it("keeps a long assistant message retrievable behind a compact Details action", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const finalSentence = "This final sentence must reach Telegram.";
    const input = event({
      eventId: "evt_complete_stop_message_12345678",
      summary: "A shortened summary that must not win.",
      lastAssistantMessage: `${"Detailed result. ".repeat(120)}${finalSentence}`,
    });
    service.ingest(input);

    await service.drain();

    const delivery = transport.deliveries[0]?.message;
    const details = delivery?.actions?.find(
      (action) => action.kind === "details",
    );
    expect(delivery?.text).not.toContain(finalSentence);
    expect(delivery?.text).not.toContain(
      "A shortened summary that must not win.",
    );
    expect(delivery?.text).toContain("…[truncated]");
    expect(details).toBeDefined();
    const registered =
      details === undefined ? undefined : store.getCardAction(details.token);
    expect(registered).toMatchObject({
      eventId: input.eventId,
      kind: "details",
    });
    expect(
      registered === undefined
        ? undefined
        : store.getEvent(registered.eventId)?.event.lastAssistantMessage,
    ).toContain(finalSentence);
    store.close();
  });

  it("marks an assistant message that exceeds the delivery content bound", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    service.ingest(
      event({
        eventId: "evt_truncated_stop_message_12345678",
        lastAssistantMessage: "x".repeat(4_000),
      }),
    );

    await service.drain();

    expect(transport.deliveries[0]?.message.text).toContain("…[truncated]");
    store.close();
  });

  it("queues offline failures and delivers once after the retry deadline", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    transport.setOnline(false);
    const service = new RelayService(store, transport, {
      now: testClock.now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    const input = event();
    service.ingest(input);

    expect(await service.drain()).toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    expect((await service.drain()).claimed).toBe(0);

    transport.setOnline(true);
    testClock.advance(1_000);
    expect(await service.drain()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    expect(transport.deliveries).toHaveLength(1);
    expect(store.getEvent(input.eventId)?.status).toBe("delivered");
    store.close();
  });

  it("dead-letters a non-retryable transport rejection with a visible log", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    transport.failNext(1, {
      code: "fake-bad-request",
      message: "synthetic rejected message",
      retryable: false,
    });
    const logger = new MemoryLogger();
    const service = new RelayService(store, transport, { logger });
    const input = event();
    service.ingest(input);

    expect(await service.drain()).toMatchObject({
      claimed: 1,
      deadLettered: 1,
    });
    expect(store.getEvent(input.eventId)?.status).toBe("dead_letter");
    expect(
      logger.records.some((record) => record.code === "delivery.dead-lettered"),
    ).toBe(true);
    expect(store.transportDeliverySummary("fake-telegram", "fake-")).toEqual({
      lastError: {
        at: expect.any(String),
        code: "fake-bad-request",
      },
    });
    store.close();
  });

  it("rate-limits repeated hosted failure logs while retaining every failed event", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const logger = new MemoryLogger();
    const transport: NotificationTransport = {
      name: "notifications",
      deliver: async () => {
        throw new TransportError(
          "Notifications connection is inactive.",
          "notifications-connection-inactive",
          false,
        );
      },
    };
    const service = new RelayService(store, transport, {
      logger,
      now: testClock.now,
      transportFailureLogIntervalMs: 60_000,
    });
    const input = (sequence: number) =>
      event({
        eventId: `event_hosted_log_limit_${String(sequence)}_12345678`,
        sequence,
        type: "input.required",
        request: {
          correlationId: `request_hosted_log_limit_${String(sequence)}_12345678`,
          kind: "input",
          question: "Synthetic bounded input.",
          expiresAt: "2026-07-24T12:10:00.000Z",
        },
      });
    service.ingest(input(1));
    service.ingest(input(2));
    await expect(service.drain()).resolves.toMatchObject({
      deadLettered: 2,
    });
    expect(
      logger.records.filter(
        (record) => record.code === "delivery.dead-lettered",
      ),
    ).toHaveLength(1);
    expect(store.status().events.dead_letter).toBe(2);

    testClock.advance(60_001);
    service.ingest(input(3));
    await expect(service.drain()).resolves.toMatchObject({
      deadLettered: 1,
    });
    const failureLogs = logger.records.filter(
      (record) => record.code === "delivery.dead-lettered",
    );
    expect(failureLogs).toHaveLength(2);
    expect(failureLogs[1]?.details).toMatchObject({
      errorCode: "notifications-connection-inactive",
      suppressedSinceLast: 1,
    });
    expect(store.status().events.dead_letter).toBe(3);
    store.close();
  });

  it("recovers a delivery lease left behind by an interrupted daemon", async () => {
    const testClock = clock();
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: testClock.now,
    });
    service.ingest(event());
    expect(store.claimDueEvents(testClock.now().toISOString())).toHaveLength(1);
    testClock.advance(100);

    expect(service.recover()).toBe(1);
    expect(await service.drain()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    store.close();
  });

  it("isolates concurrent sessions and never lets an older heartbeat rewind state", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const first = event({
      eventId: "evt_concurrent_session_one",
      sessionId: "session_concurrent_one",
      sequence: 2,
    });
    const second = event({
      eventId: "evt_concurrent_session_two",
      harness: "claude",
      sessionId: "session_concurrent_two",
      sequence: 4,
    });
    service.ingest(first);
    service.ingest(second);

    expect(
      service.heartbeat({
        schema: "agent-heartbeat.v1",
        machineId: first.machineId,
        harness: first.harness,
        sessionId: first.sessionId,
        observedAt: "2026-07-24T12:01:00.000Z",
        state: "active",
        sequence: 1,
      }),
    ).toBe(true);
    expect(await service.drain()).toMatchObject({
      claimed: 2,
      delivered: 2,
    });
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(
      sessions.find((session) => session.sessionId === first.sessionId)?.state,
    ).toBe("waiting");
    expect(
      new Set(transport.deliveries.map((item) => item.message.eventId)),
    ).toEqual(new Set([first.eventId, second.eventId]));
    store.close();
  });

  it("rejects an event-id collision instead of silently swallowing it", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport());
    const first = event({ eventId: "evt_collision_12345678" });
    service.ingest(first);

    expect(() =>
      service.ingest({
        ...first,
        summary: "Different payload with the same event id",
      }),
    ).toThrow("event id collision");
    store.close();
  });

  it("reports a proven supervised process exit as a distinct event class", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const exit = event({
      eventId: "evt_process_exit_12345678",
      type: "process.exited",
      summary: "Supervised child exited with status 137",
      failure: {
        class: "signal",
        message: "Child received SIGKILL",
      },
      processExit: {
        source: "owned-child",
        supervisorId: "supervisor_service_12345678",
        startedAt: "2026-07-24T11:59:00.000Z",
        exitedAt: "2026-07-24T12:00:00.000Z",
        pid: 4242,
        signal: "SIGKILL",
        classification: "signal",
        expected: false,
      },
    });
    service.ingest(exit);

    expect(await service.drain()).toMatchObject({ delivered: 1 });
    expect(store.listSessions()[0]?.state).toBe("exited");
    expect(transport.deliveries[0]?.message.text).toContain("Process exited");
    store.close();
  });

  it("redacts known credential shapes before transport and logs", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const logger = new MemoryLogger();
    const service = new RelayService(store, transport, { logger });
    const secret = "sk-syntheticSecretToken123456789";
    service.ingest(
      event({
        eventId: "evt_redaction_12345678",
        summary: `Request failed with ${secret}`,
      }),
    );
    await service.drain();

    expect(transport.deliveries[0]?.message.text).toContain(
      "[REDACTED_OPENAI_KEY]",
    );
    expect(JSON.stringify(transport.deliveries)).not.toContain(secret);
    expect(JSON.stringify(logger.records)).not.toContain(secret);
    store.close();
  });

  it("durably deduplicates diagnostics and redacts their messages", () => {
    const store = new RelayStore();
    const logger = new MemoryLogger();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      logger,
    });
    const diagnostic = {
      schema: "agent-relay-diagnostic.v1" as const,
      diagnosticId: "diag_service_12345678",
      recordedAt: "2026-07-24T12:00:00.000Z",
      source: "fallback-spool" as const,
      level: "error" as const,
      code: "hook.invalid-payload",
      message: "failed with sk-syntheticSecretToken123456789",
    };

    expect(service.reportDiagnostic(diagnostic).inserted).toBe(true);
    expect(service.reportDiagnostic(diagnostic).inserted).toBe(false);
    expect(store.status().diagnostics).toEqual({
      info: 0,
      warn: 0,
      error: 1,
      total: 1,
    });
    expect(store.listDiagnostics()[0]?.message).toContain(
      "[REDACTED_OPENAI_KEY]",
    );
    expect(JSON.stringify(logger.records)).not.toContain(
      "sk-syntheticSecretToken123456789",
    );
    store.close();
  });
});
