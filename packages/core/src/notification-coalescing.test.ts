import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { cardActionCallbackData } from "./card-action.js";
import { FakeTelegramTransport } from "./fake-transport.js";
import { renderDetailsMessages, renderDeliveryText } from "./message.js";
import { TelegramReplyRouter } from "./reply-router.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const baseTime = "2026-07-25T12:00:00.000Z";

function event(
  eventId: string,
  sequence: number,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: overrides.occurredAt ?? baseTime,
    sequence,
    machineId: "machine_notification_coalescing_12345678",
    bridgeSessionId: "bridge_notification_coalescing_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: overrides.sessionId ?? "session_coalescing_12345678",
    project: {
      ...makeProjectRef("/workspace/notification-coalescing"),
      branch: "codex/notification-coalescing",
    },
    type: overrides.type ?? "turn.stopped",
    summary: overrides.summary ?? "Equivalent routine notification",
    ...(overrides.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: overrides.lastAssistantMessage }),
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

describe("notification coalescing", () => {
  it("edits one durable card with an exact count and latest timestamp", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-25T12:00:10.000Z"),
      coalescingWindowMs: 60_000,
    });
    const first = event("evt_coalescing_first_12345678", 1);
    const second = event("evt_coalescing_second_12345678", 2, {
      occurredAt: "2026-07-25T12:00:10.000Z",
    });
    service.ingest(first);
    service.ingest(second);

    await expect(service.drain()).resolves.toMatchObject({
      claimed: 2,
      delivered: 2,
      retrying: 0,
    });

    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveryMessageEdits).toHaveLength(1);
    expect(transport.deliveryMessageEdits[0]).toMatchObject({
      messageId: "1",
      message: {
        eventId: first.eventId,
        text: expect.stringContaining(
          "2 equivalent events · latest 2026-07-25T12:00:10.000Z",
        ),
        actions: expect.arrayContaining([
          expect.objectContaining({ kind: "details" }),
        ]),
      },
    });
    expect(store.getEvent(second.eventId)?.status).toBe("delivered");
    expect(store.getEventTransportReceipt(second.eventId)).toEqual({
      transportName: "fake-telegram",
      messageId: "1",
    });
    expect(store.notificationDetails(first.eventId)).toMatchObject({
      totalCount: 2,
      events: [{ eventId: first.eventId }, { eventId: second.eventId }],
    });
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "notification.coalesced",
        message:
          "equivalent routine event coalesced into an existing session card",
      }),
    );
    const detailsAction =
      transport.deliveryMessageEdits[0]?.message.actions?.find(
        (action) => action.kind === "details",
      );
    const anchorDelivery = transport.deliveries[0];
    if (detailsAction === undefined || anchorDelivery === undefined) {
      throw new Error("missing coalesced Details action");
    }
    const router = new TelegramReplyRouter(store, transport, {
      operatorUserId: 7001,
      chatId: 9001,
      now: () => new Date("2026-07-25T12:00:10.000Z"),
    });
    await expect(
      router.handle({
        update_id: 500,
        callback_query: {
          id: "callback_coalesced_details_12345678",
          from: { id: 7001 },
          data: cardActionCallbackData(detailsAction.kind, detailsAction.token),
          message: {
            message_id: Number(anchorDelivery.receipt.messageId),
            message_thread_id: Number(anchorDelivery.context.topicId),
            chat: { id: 9001 },
          },
        },
      }),
    ).resolves.toMatchObject({ outcome: "action-completed" });
    expect(transport.deliveries).toHaveLength(2);
    expect(transport.deliveries[1]?.message.text).toContain("Event 1 of 2");
    expect(transport.deliveries[1]?.message.text).toContain("Event 2 of 2");
    service.ingest(
      event("evt_coalescing_after_details_12345678", 3, {
        occurredAt: "2026-07-25T12:00:10.000Z",
      }),
    );
    await service.drain();
    expect(transport.deliveries).toHaveLength(3);
    expect(transport.deliveryMessageEdits).toHaveLength(1);
    store.close();
  });

  it("starts a new card outside the configured window or for different content", async () => {
    let now = new Date(baseTime);
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => now,
      coalescingWindowMs: 1_000,
    });
    service.ingest(event("evt_window_first_12345678", 1));
    await service.drain();

    now = new Date("2026-07-25T12:00:00.500Z");
    service.ingest(
      event("evt_window_distinct_12345678", 2, {
        occurredAt: now.toISOString(),
        summary: "A different routine notification",
      }),
    );
    await service.drain();

    now = new Date("2026-07-25T12:00:02.000Z");
    service.ingest(
      event("evt_window_expired_12345678", 3, {
        occurredAt: now.toISOString(),
      }),
    );
    await service.drain();

    expect(transport.deliveries).toHaveLength(3);
    expect(transport.deliveryMessageEdits).toHaveLength(0);
    expect(
      () => new RelayService(store, transport, { coalescingWindowMs: -1 }),
    ).toThrow("notification coalescing window must be between");
    store.close();
  });

  it("returns the latest ten grouped events with the true durable count", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(baseTime),
    });
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      service.ingest(
        event(`evt_latest_ten_${String(sequence)}_12345678`, sequence),
      );
    }
    await service.drain();

    const details = store.notificationDetails("evt_latest_ten_1_12345678");
    expect(details.totalCount).toBe(12);
    expect(details.events).toHaveLength(10);
    expect(details.events.map((candidate) => candidate.sequence)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveryMessageEdits).toHaveLength(11);
    store.close();
  });

  it("reuses a durable coalescing anchor after a daemon restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-coalescing-"));
    const databasePath = join(directory, "relay.sqlite");
    const transport = new FakeTelegramTransport();
    try {
      const firstStore = new RelayStore(databasePath);
      const firstService = new RelayService(firstStore, transport, {
        now: () => new Date(baseTime),
      });
      firstService.ingest(event("evt_restart_anchor_12345678", 1));
      await firstService.drain();
      firstStore.close();

      const secondStore = new RelayStore(databasePath);
      const secondService = new RelayService(secondStore, transport, {
        now: () => new Date("2026-07-25T12:00:10.000Z"),
      });
      secondService.ingest(
        event("evt_restart_coalesced_12345678", 2, {
          occurredAt: "2026-07-25T12:00:10.000Z",
        }),
      );
      await secondService.drain();

      expect(transport.deliveries).toHaveLength(1);
      expect(transport.deliveryMessageEdits).toHaveLength(1);
      expect(
        secondStore.notificationDetails("evt_restart_anchor_12345678"),
      ).toMatchObject({ totalCount: 2 });
      secondStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("turns a concurrent group race into one coalesced event and one visible retry", async () => {
    let now = new Date(baseTime);
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => now,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    service.ingest(event("evt_concurrent_anchor_12345678", 1));
    await service.drain();
    service.ingest(event("evt_concurrent_second_12345678", 2));
    service.ingest(event("evt_concurrent_third_12345678", 3));

    const results = await Promise.all([service.drain(1), service.drain(1)]);
    expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.retrying, 0)).toBe(1);
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "notification.coalescing-commit-raced",
      }),
    );

    now = new Date("2026-07-25T12:00:01.000Z");
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(transport.deliveries).toHaveLength(2);
    expect([
      store.getEvent("evt_concurrent_second_12345678")?.status,
      store.getEvent("evt_concurrent_third_12345678")?.status,
    ]).toEqual(["delivered", "delivered"]);
    store.close();
  });

  it("never hides questions, crashes, stale warnings, or failed delivery attempts", async () => {
    let now = new Date(baseTime);
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => now,
      coalescingWindowMs: 60_000,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
      },
    });
    for (const sequence of [1, 2]) {
      service.ingest(
        event(`evt_question_visible_${String(sequence)}_12345678`, sequence, {
          type: "input.required",
          request: {
            correlationId: `correlation_visible_${String(sequence)}_12345678`,
            kind: "input",
            question: "What should happen next?",
            expiresAt: "2026-07-25T12:05:00.000Z",
          },
        }),
      );
    }
    for (const sequence of [3, 4]) {
      service.ingest(
        event(`evt_crash_visible_${String(sequence)}_12345678`, sequence, {
          type: "turn.failed",
          failure: {
            class: "synthetic",
            message: "Synthetic crash",
          },
        }),
      );
    }
    for (const sequence of [5, 6]) {
      service.ingest(
        event(`evt_stale_visible_${String(sequence)}_12345678`, sequence, {
          type: "process.stale",
        }),
      );
    }
    await service.drain();
    expect(transport.deliveries).toHaveLength(6);

    service.ingest(event("evt_retry_anchor_12345678", 7));
    await service.drain();
    transport.failNext(1);
    service.ingest(event("evt_retry_visible_12345678", 8));
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 0,
      retrying: 1,
    });
    expect(store.getEvent("evt_retry_visible_12345678")?.status).toBe("retry");
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "notification.coalescing-edit-failed",
        message:
          "coalesced card edit failed; the event will retry as a visible card",
      }),
    );

    now = new Date("2026-07-25T12:00:01.000Z");
    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
    });
    expect(transport.deliveries).toHaveLength(8);
    expect(transport.deliveryMessageEdits).toHaveLength(0);
    store.close();
  });

  it("diagnoses mute suppression while still delivering critical failures", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(baseTime),
    });
    const source = event("evt_mute_source_12345678", 1, {
      type: "session.started",
    });
    service.ingest(source);
    await service.drain();
    const muteAction = transport.deliveries[0]?.message.actions?.find(
      (action) => action.kind === "mute",
    );
    if (muteAction === undefined) {
      throw new Error("missing mute action");
    }
    store.executeCardAction({
      token: muteAction.token,
      kind: "mute",
      updateId: 501,
      now: baseTime,
    });

    service.ingest(
      event("evt_muted_routine_12345678", 2, { type: "turn.activity" }),
    );
    service.ingest(
      event("evt_muted_failure_12345678", 3, {
        type: "turn.failed",
        failure: { class: "synthetic", message: "Visible critical failure" },
      }),
    );
    await service.drain();

    expect(transport.deliveries).toHaveLength(2);
    expect(transport.deliveries[1]?.message.eventId).toBe(
      "evt_muted_failure_12345678",
    );
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "notification.suppressed",
        message: "notification suppressed because the relay lane is muted",
      }),
    );
    store.close();
  });

  it("bounds details to eight Telegram-safe pages without losing the durable events", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      event(`evt_details_page_${String(index)}_12345678`, index + 1, {
        lastAssistantMessage: "x".repeat(4_000),
      }),
    );
    const pages = renderDetailsMessages(events, events.length);

    expect(pages).toHaveLength(8);
    expect(pages.at(-1)?.text).toContain("…[truncated]");
    expect(
      pages.every((page) => [...renderDeliveryText(page)].length <= 4_096),
    ).toBe(true);
    expect(events).toHaveLength(10);
  });
});
