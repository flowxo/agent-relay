import {
  MemoryLogger,
  RelayStore,
  type HostedAcknowledgementDisposition,
} from "@agent-relay/core";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";
import { NotificationsDeliveryError } from "@agent-relay/notifications-transport";
import type {
  AcknowledgeHostedEventInput,
  HostedInteractionEvent,
  NotificationsInteractionSource,
  NotificationsResolutionPresenter,
  PollHostedEventsOptions,
  ReflectNotificationsResolutionInput,
} from "@agent-relay/notifications-transport";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationsInteractionPoller,
  notificationsStreamKey,
} from "./notifications-poller.js";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

const occurredAt = "2026-07-26T19:00:00.000Z";
const expiresAt = "2026-07-26T19:30:00.000Z";
const bindingId = "binding_notifications_poller_12345678";
const machineId = "machine_notifications_poller_12345678";
const streamKey = notificationsStreamKey(
  "https://notifications.example.test/v1/",
  "machine_client_notifications_poller_12345678",
);

function localEvent(
  suffix: string,
  kind: "confirm" | "select" | "input",
): AgentAttentionEventV1 {
  const base = {
    schema: "agent-attention.v1" as const,
    eventId: `event_notifications_poller_${suffix}_12345678`,
    occurredAt,
    sequence: 1,
    machineId,
    bridgeSessionId: `bridge_notifications_poller_${suffix}_12345678`,
    harness: "codex" as const,
    surface: "cli" as const,
    harnessVersion: "test",
    sessionId: `session_notifications_poller_${suffix}_12345678`,
    turnId: `turn_notifications_poller_${suffix}_12345678`,
    project: makeProjectRef("/workspace/notifications-poller"),
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
  return kind === "input"
    ? {
        ...base,
        type: "turn.stopped",
        request: {
          correlationId: `request_notifications_poller_${suffix}_12345678`,
          kind: "continuation",
          question: "What should continue?",
          expiresAt,
        },
      }
    : {
        ...base,
        type: "input.required",
        request: {
          correlationId: `request_notifications_poller_${suffix}_12345678`,
          kind,
          question: "Choose safely.",
          ...(kind === "select"
            ? {
                options: [
                  { id: "option_notifications_alpha_12345678", label: "Alpha" },
                  { id: "option_notifications_beta_12345678", label: "Beta" },
                ],
              }
            : {}),
          expiresAt,
        },
      };
}

function deliver(
  store: RelayStore,
  event: AgentAttentionEventV1,
  suffix: string,
  interactionType: "confirm" | "select" | "input",
): void {
  store.ingestEvent(event);
  const claimed = store.claimDueEvents("2026-07-26T19:00:01.000Z", 1)[0];
  if (claimed === undefined) {
    throw new Error("synthetic event was not claimable");
  }
  store.markDelivered(
    event.eventId,
    claimed.attemptNumber,
    "notifications",
    `message_notifications_poller_${suffix}_12345678`,
    "2026-07-26T19:00:02.000Z",
    {
      id: `interaction_notifications_poller_${suffix}_12345678`,
      streamKey,
      type: interactionType,
    },
  );
}

function hostedEvent(
  store: RelayStore,
  local: AgentAttentionEventV1,
  suffix: string,
  response: HostedInteractionEvent["response"],
  cursorIndex: number,
): HostedInteractionEvent {
  const request = store.getPendingRequest(local.request!.correlationId)!;
  return {
    schema: "notifications.interaction-event.v1",
    id: `hosted_event_notifications_${suffix}_12345678`,
    cursor: `cursor_notifications_${String(cursorIndex).padStart(2, "0")}_12345678`,
    type: "interaction.received",
    message_id: `message_notifications_poller_${suffix}_12345678`,
    interaction_id: `interaction_notifications_poller_${suffix}_12345678`,
    correlation_id: request.correlationId,
    response,
    channel_context: {
      binding_id: bindingId,
      channel: "telegram",
      conversation_kind: "thread",
    },
    occurred_at: `2026-07-26T19:0${String(cursorIndex)}:00.000Z`,
    expires_at: expiresAt,
  };
}

class OrderedSource implements NotificationsInteractionSource {
  public readonly acknowledgements: AcknowledgeHostedEventInput[] = [];
  private committedCursor: string | undefined;

  public constructor(
    public readonly events: HostedInteractionEvent[],
    private readonly onFinalAcknowledgement?: () => void,
  ) {}

  public async poll(options: PollHostedEventsOptions): Promise<{
    schema: "notifications.machine-events.v1";
    events: HostedInteractionEvent[];
    committed_cursor: string | null;
    server_time: string;
  }> {
    expect(options.after).toBe(this.committedCursor);
    const start =
      this.committedCursor === undefined
        ? 0
        : this.events.findIndex(
            (event) => event.cursor === this.committedCursor,
          ) + 1;
    return {
      schema: "notifications.machine-events.v1",
      events: this.events.slice(start),
      committed_cursor: this.committedCursor ?? null,
      server_time: "2026-07-26T19:10:00.000Z",
    };
  }

  public async acknowledge(input: AcknowledgeHostedEventInput) {
    this.acknowledgements.push(input);
    this.committedCursor = input.cursor;
    if (this.acknowledgements.length === this.events.length) {
      this.onFinalAcknowledgement?.();
    }
    return {
      event_id: input.eventId,
      cursor: input.cursor,
      disposition: input.disposition,
      ...(input.reasonCode === undefined
        ? {}
        : { reason_code: input.reasonCode }),
      acknowledgement_status: "recorded" as const,
      committed_cursor: input.cursor,
      advanced: true,
    };
  }
}

describe("NotificationsInteractionPoller", () => {
  it("isolates and resolves confirm, select, and input events in cursor order", async () => {
    const store = new RelayStore();
    const confirm = localEvent("confirm", "confirm");
    const select = localEvent("select", "select");
    const input = localEvent("input", "input");
    deliver(store, confirm, "confirm", "confirm");
    deliver(store, select, "select", "select");
    deliver(store, input, "input", "input");
    const selectRequest = store.getPendingRequest(
      select.request!.correlationId,
    )!;
    const selectedToken = selectRequest.options.find(
      (option) => option.optionId === "option_notifications_beta_12345678",
    )!.token;
    const controller = new AbortController();
    const source = new OrderedSource([
      {
        ...hostedEvent(
          store,
          confirm,
          "confirm",
          { type: "confirm", value: true },
          1,
        ),
        occurred_at: "2026-07-26T14:01:00-05:00",
        expires_at: "2026-07-26T14:30:00-05:00",
      },
      hostedEvent(
        store,
        select,
        "select",
        { type: "select", value: selectedToken },
        2,
      ),
      hostedEvent(
        store,
        input,
        "input",
        { type: "input", value: "continue with bounded input" },
        3,
      ),
    ]);
    const reflected: ReflectNotificationsResolutionInput[] = [];
    const presenter: NotificationsResolutionPresenter = {
      capability: "supported",
      reflect: async (reflection) => {
        reflected.push(reflection);
        return {
          outcome: "updated",
          operationId: reflection.operationId,
          messageId: reflection.messageId,
        };
      },
    };

    await new NotificationsInteractionPoller({
      store,
      source,
      presenter,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
      sleep: async () => {
        controller.abort();
      },
    }).run(controller.signal);

    expect(
      store.getPendingRequest(confirm.request!.correlationId),
    ).toMatchObject({ state: "answered", answer: "yes_option" });
    expect(
      store.getPendingRequest(select.request!.correlationId),
    ).toMatchObject({
      state: "answered",
      answer: "option_notifications_beta_12345678",
    });
    expect(store.getPendingRequest(input.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "continue with bounded input",
      },
    );
    expect(
      source.acknowledgements.map((acknowledgement) => ({
        disposition: acknowledgement.disposition,
        eventId: acknowledgement.eventId,
      })),
    ).toEqual([
      { disposition: "processed", eventId: source.events[0]!.id },
      { disposition: "processed", eventId: source.events[1]!.id },
      { disposition: "processed", eventId: source.events[2]!.id },
    ]);
    expect(store.hostedPollStatus(streamKey)).toMatchObject({
      committedCursor: source.events[2]!.cursor,
      unacknowledgedEventCount: 0,
      messageUpdates: {
        pending: 0,
        retry: 0,
        updated: 3,
        blocked: 0,
      },
    });
    expect(
      reflected.map((reflection) => ({
        operationId: reflection.operationId,
        presentation: reflection.presentation,
        resolutionSource: reflection.resolutionSource,
      })),
    ).toEqual([
      {
        operationId: `resolution_${sha256(source.events[0]!.id)}`,
        presentation: "answered",
        resolutionSource: "notifications",
      },
      {
        operationId: `resolution_${sha256(source.events[1]!.id)}`,
        presentation: "answered",
        resolutionSource: "notifications",
      },
      {
        operationId: `resolution_${sha256(source.events[2]!.id)}`,
        presentation: "answered",
        resolutionSource: "notifications",
      },
    ]);
    store.close();
  });

  it("quarantines invalid options but stops without ack on unknown correlation", async () => {
    const store = new RelayStore();
    const local = localEvent("poison", "select");
    deliver(store, local, "poison", "select");
    const poison = hostedEvent(
      store,
      local,
      "poison",
      { type: "select", value: "unknown_option_token_12345678" },
      1,
    );
    const quarantineAbort = new AbortController();
    const quarantineSource = new OrderedSource([poison], () =>
      quarantineAbort.abort(),
    );
    await new NotificationsInteractionPoller({
      store,
      source: quarantineSource,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
    }).run(quarantineAbort.signal);
    expect(store.getPendingRequest(local.request!.correlationId)?.state).toBe(
      "open",
    );
    expect(quarantineSource.acknowledgements).toEqual([
      expect.objectContaining({
        disposition: "quarantined",
        reasonCode: "invalid_option",
      }),
    ]);

    const logger = new MemoryLogger();
    const unknownSource: NotificationsInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "notifications.machine-events.v1",
        committed_cursor: null,
        server_time: "2026-07-26T19:10:00.000Z",
        events: [
          {
            ...poison,
            id: "hosted_event_notifications_unknown_12345678",
            cursor: "cursor_notifications_unknown_12345678",
            message_id: "message_notifications_unknown_12345678",
          },
        ],
      }),
      acknowledge: vi.fn(),
    };
    await new NotificationsInteractionPoller({
      store,
      source: unknownSource,
      streamKey: sha256("isolated-unknown-correlation-stream"),
      machineId,
      bindingId,
      logger,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
    }).run(new AbortController().signal);
    expect(unknownSource.acknowledge).not.toHaveBeenCalled();
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        code: "notifications.poll-stopped-on-integrity",
        details: expect.objectContaining({
          reasonCode: "request_not_found",
        }),
      }),
    );
    store.close();
  });

  it("replays a durable acknowledgement after an interrupted retry without resolving twice", async () => {
    const store = new RelayStore();
    const local = localEvent("restart", "confirm");
    deliver(store, local, "restart", "confirm");
    const hosted = hostedEvent(
      store,
      local,
      "restart",
      { type: "confirm", value: true },
      1,
    );
    let nowMs = Date.parse("2026-07-26T19:05:00.000Z");
    const firstAbort = new AbortController();
    const firstSource: NotificationsInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "notifications.machine-events.v1",
        events: [hosted],
        committed_cursor: null,
        server_time: "2026-07-26T19:05:00.000Z",
      }),
      acknowledge: vi.fn().mockRejectedValue(
        Object.assign(new Error("synthetic transient ack failure"), {
          code: "notifications-transport-unavailable",
          retryable: true,
        }),
      ),
    };
    await new NotificationsInteractionPoller({
      store,
      source: firstSource,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => new Date(nowMs),
      sleep: async () => {
        nowMs += 1_000;
        firstAbort.abort();
      },
    }).run(firstAbort.signal);
    expect(store.getHostedAcknowledgementBarrier(streamKey)).toMatchObject({
      state: "retry",
      attemptCount: 1,
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "yes_option",
      },
    );

    const secondAbort = new AbortController();
    const acknowledgement = vi.fn(
      async (input: AcknowledgeHostedEventInput) => {
        secondAbort.abort();
        return {
          event_id: input.eventId,
          cursor: input.cursor,
          disposition: input.disposition as HostedAcknowledgementDisposition,
          acknowledgement_status: "existing" as const,
          committed_cursor: input.cursor,
          advanced: true,
        };
      },
    );
    await new NotificationsInteractionPoller({
      store,
      source: {
        poll: vi.fn(),
        acknowledge: acknowledgement,
      },
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => new Date(nowMs),
    }).run(secondAbort.signal);
    expect(acknowledgement).toHaveBeenCalledOnce();
    expect(store.hostedPollStatus(streamKey)).toMatchObject({
      committedCursor: hosted.cursor,
      unacknowledgedEventCount: 0,
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "yes_option",
      },
    );
    store.close();
  });

  it("requeues a connection-blocked acknowledgement only after explicit restart", async () => {
    const store = new RelayStore();
    const local = localEvent("reconnect_ack", "confirm");
    deliver(store, local, "reconnect_ack", "confirm");
    const hosted = hostedEvent(
      store,
      local,
      "reconnect_ack",
      { type: "confirm", value: true },
      1,
    );
    const firstSource: NotificationsInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "notifications.machine-events.v1",
        events: [hosted],
        committed_cursor: null,
        server_time: "2026-07-26T19:05:00.000Z",
      }),
      acknowledge: vi
        .fn()
        .mockRejectedValue(
          new NotificationsDeliveryError(
            "Synthetic disconnected connection.",
            "notifications-connection-inactive",
            false,
            "terminal",
          ),
        ),
    };
    await new NotificationsInteractionPoller({
      store,
      source: firstSource,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }).run(new AbortController().signal);
    expect(store.getHostedAcknowledgementBarrier(streamKey)).toMatchObject({
      state: "blocked",
      attemptCount: 1,
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        resolvedBy: "notifications",
      },
    );

    const controller = new AbortController();
    const acknowledgement = vi.fn(
      async (input: AcknowledgeHostedEventInput) => {
        controller.abort();
        return {
          event_id: input.eventId,
          cursor: input.cursor,
          disposition: input.disposition,
          acknowledgement_status: "recorded" as const,
          committed_cursor: input.cursor,
          advanced: true,
        };
      },
    );
    const logger = new MemoryLogger();
    await new NotificationsInteractionPoller({
      store,
      source: { poll: vi.fn(), acknowledge: acknowledgement },
      streamKey,
      machineId,
      bindingId,
      logger,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }).run(controller.signal);
    expect(acknowledgement).toHaveBeenCalledOnce();
    expect(store.hostedPollStatus(streamKey)).toMatchObject({
      committedCursor: hosted.cursor,
      unacknowledgedEventCount: 0,
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        resolvedBy: "notifications",
      },
    );
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        code: "notifications.work-recovered",
        details: {
          interrupted: 0,
          requeuedAfterReconnect: 1,
        },
      }),
    );
    store.close();
  });

  it("retries presentation with one deterministic operation and never repeats local resolution", async () => {
    const store = new RelayStore();
    const local = localEvent("presentation_retry", "confirm");
    deliver(store, local, "presentation_retry", "confirm");
    const hosted = hostedEvent(
      store,
      local,
      "presentation_retry",
      { type: "confirm", value: true },
      1,
    );
    const source = new OrderedSource([hosted]);
    const controller = new AbortController();
    let nowMs = Date.parse("2026-07-26T19:05:00.000Z");
    let sleeps = 0;
    const operations: string[] = [];
    const presenter: NotificationsResolutionPresenter = {
      capability: "supported",
      reflect: async (reflection) => {
        operations.push(reflection.operationId);
        if (operations.length === 1) {
          throw new NotificationsDeliveryError(
            "Synthetic response loss.",
            "notifications-transport-outcome-unknown",
            true,
            "retry_same_operation",
          );
        }
        return {
          outcome: "updated",
          operationId: reflection.operationId,
          messageId: reflection.messageId,
        };
      },
    };

    await new NotificationsInteractionPoller({
      store,
      source,
      presenter,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => new Date(nowMs),
      sleep: async () => {
        sleeps += 1;
        nowMs += 1;
        if (sleeps === 2) {
          controller.abort();
        }
      },
    }).run(controller.signal);

    expect(operations).toEqual([
      `resolution_${sha256(hosted.id)}`,
      `resolution_${sha256(hosted.id)}`,
    ]);
    expect(store.getHostedMessageUpdate(streamKey, hosted.id)).toMatchObject({
      state: "updated",
      attemptCount: 2,
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "yes_option",
        resolvedBy: "notifications",
      },
    );
    expect(source.acknowledgements).toHaveLength(1);
    store.close();
  });

  it("blocks an explicit outcome-unknown presentation without inventing a new identity", async () => {
    const store = new RelayStore();
    const local = localEvent("presentation_unknown", "confirm");
    deliver(store, local, "presentation_unknown", "confirm");
    const hosted = hostedEvent(
      store,
      local,
      "presentation_unknown",
      { type: "confirm", value: true },
      1,
    );
    const source = new OrderedSource([hosted]);
    const controller = new AbortController();
    const operations: string[] = [];
    const presenter: NotificationsResolutionPresenter = {
      capability: "supported",
      reflect: async (reflection) => {
        operations.push(reflection.operationId);
        throw new NotificationsDeliveryError(
          "Synthetic provider ambiguity.",
          "notifications-provider-outcome-unknown",
          false,
          "outcome_unknown",
        );
      },
    };
    await new NotificationsInteractionPoller({
      store,
      source,
      presenter,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      sleep: async () => {
        controller.abort();
      },
    }).run(controller.signal);

    expect(operations).toEqual([`resolution_${sha256(hosted.id)}`]);
    expect(store.getHostedMessageUpdate(streamKey, hosted.id)).toMatchObject({
      state: "blocked",
      attemptCount: 1,
      lastErrorCode: "notifications-provider-outcome-unknown",
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        resolvedBy: "notifications",
      },
    );
    expect(source.acknowledgements).toHaveLength(1);
    store.close();
  });

  it("backs off transient poll failures and omits shutdown noise", async () => {
    const store = new RelayStore();
    const controller = new AbortController();
    const logger = new MemoryLogger();
    const source: NotificationsInteractionSource = {
      poll: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("temporary poll failure"), {
            code: "notifications-transport-unavailable",
            retryable: true,
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("repeated temporary poll failure"), {
            code: "notifications-transport-unavailable",
            retryable: true,
          }),
        )
        .mockImplementation(async () => {
          controller.abort();
          return {
            schema: "notifications.machine-events.v1",
            events: [],
            committed_cursor: null,
            server_time: "2026-07-26T19:10:00.000Z",
          };
        }),
      acknowledge: vi.fn(),
    };
    const sleeps: number[] = [];
    await new NotificationsInteractionPoller({
      store,
      source,
      streamKey,
      machineId,
      bindingId,
      logger,
      waitSeconds: 0,
      retryBaseMs: 5,
      retryMaxMs: 10,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    }).run(controller.signal);
    expect(sleeps).toEqual([5, 10]);
    expect(logger.records.map((record) => record.code)).toEqual([
      "notifications.poll-started",
      "notifications.poll-retry",
      "notifications.poll-stopped",
    ]);
    store.close();
  });

  it("bounds a stuck long poll and retries without treating timeout as shutdown", async () => {
    const store = new RelayStore();
    const controller = new AbortController();
    const logger = new MemoryLogger();
    const source: NotificationsInteractionSource = {
      poll: async (options) => {
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw Object.assign(new Error("bounded poll timeout"), {
          code: "notifications-transport-unavailable",
          retryable: true,
        });
      },
      acknowledge: vi.fn(),
    };
    const sleeps: number[] = [];
    await new NotificationsInteractionPoller({
      store,
      source,
      streamKey,
      machineId,
      bindingId,
      logger,
      waitSeconds: 0,
      requestTimeoutMs: 100,
      retryBaseMs: 3,
      retryMaxMs: 3,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        controller.abort();
      },
    }).run(controller.signal);
    expect(sleeps).toEqual([3]);
    expect(logger.records.map((record) => record.code)).toEqual([
      "notifications.poll-started",
      "notifications.poll-retry",
      "notifications.poll-stopped",
    ]);
    store.close();
  });
});
