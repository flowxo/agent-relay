import {
  MemoryLogger,
  RelayStore,
  type HostedAcknowledgementDisposition,
} from "@agent-relay/core";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";
import { WhooshBangDeliveryError } from "@agent-relay/whooshbang-transport";
import type {
  AcknowledgeHostedEventInput,
  HostedInteractionEvent,
  WhooshBangInteractionSource,
  WhooshBangResolutionPresenter,
  PollHostedEventsOptions,
  ReflectWhooshBangResolutionInput,
} from "@agent-relay/whooshbang-transport";
import { describe, expect, it, vi } from "vitest";

import {
  WhooshBangInteractionPoller,
  whooshbangStreamKey,
} from "./whooshbang-poller.js";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

const occurredAt = "2026-07-26T19:00:00.000Z";
const expiresAt = "2026-07-26T19:30:00.000Z";
const bindingId = "binding_whooshbang_poller_12345678";
const machineId = "machine_whooshbang_poller_12345678";
const streamKey = whooshbangStreamKey(
  "https://whooshbang.example.test/v1/",
  "machine_client_whooshbang_poller_12345678",
);

function localEvent(
  suffix: string,
  kind: "confirm" | "select" | "input",
): AgentAttentionEventV1 {
  const base = {
    schema: "agent-attention.v1" as const,
    eventId: `event_whooshbang_poller_${suffix}_12345678`,
    occurredAt,
    sequence: 1,
    machineId,
    bridgeSessionId: `bridge_whooshbang_poller_${suffix}_12345678`,
    harness: "codex" as const,
    surface: "cli" as const,
    harnessVersion: "test",
    sessionId: `session_whooshbang_poller_${suffix}_12345678`,
    turnId: `turn_whooshbang_poller_${suffix}_12345678`,
    project: makeProjectRef("/workspace/whooshbang-poller"),
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
          correlationId: `request_whooshbang_poller_${suffix}_12345678`,
          kind: "continuation",
          question: "What should continue?",
          expiresAt,
        },
      }
    : {
        ...base,
        type: "input.required",
        request: {
          correlationId: `request_whooshbang_poller_${suffix}_12345678`,
          kind,
          question: "Choose safely.",
          ...(kind === "select"
            ? {
                options: [
                  { id: "option_whooshbang_alpha_12345678", label: "Alpha" },
                  { id: "option_whooshbang_beta_12345678", label: "Beta" },
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
    "whooshbang",
    `message_whooshbang_poller_${suffix}_12345678`,
    "2026-07-26T19:00:02.000Z",
    {
      id: `interaction_whooshbang_poller_${suffix}_12345678`,
      streamKey,
      type: interactionType,
    },
  );
}

function hostedEvent(
  store: RelayStore,
  local: AgentAttentionEventV1,
  suffix: string,
  response: NonNullable<HostedInteractionEvent["response"]>,
  cursorIndex: number,
): HostedInteractionEvent {
  const request = store.getPendingRequest(local.request!.correlationId)!;
  return {
    schema: "whooshbang.interaction-event.v1",
    id: `hosted_event_whooshbang_${suffix}_12345678`,
    cursor: `cursor_whooshbang_${String(cursorIndex).padStart(2, "0")}_12345678`,
    type: "interaction.received",
    message_id: `message_whooshbang_poller_${suffix}_12345678`,
    interaction_id: `interaction_whooshbang_poller_${suffix}_12345678`,
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

class OrderedSource implements WhooshBangInteractionSource {
  public readonly acknowledgements: AcknowledgeHostedEventInput[] = [];
  private committedCursor: string | undefined;

  public constructor(
    public readonly events: HostedInteractionEvent[],
    private readonly onFinalAcknowledgement?: () => void,
  ) {}

  public async poll(options: PollHostedEventsOptions): Promise<{
    schema: "whooshbang.machine-events.v1";
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
      schema: "whooshbang.machine-events.v1",
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

describe("WhooshBangInteractionPoller", () => {
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
      (option) => option.optionId === "option_whooshbang_beta_12345678",
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
    const reflected: ReflectWhooshBangResolutionInput[] = [];
    const presenter: WhooshBangResolutionPresenter = {
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

    await new WhooshBangInteractionPoller({
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
      answer: "option_whooshbang_beta_12345678",
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
        resolutionSource: "whooshbang",
      },
      {
        operationId: `resolution_${sha256(source.events[1]!.id)}`,
        presentation: "answered",
        resolutionSource: "whooshbang",
      },
      {
        operationId: `resolution_${sha256(source.events[2]!.id)}`,
        presentation: "answered",
        resolutionSource: "whooshbang",
      },
    ]);
    store.close();
  });

  it("acknowledges a content-redacted event without resolving or crashing", async () => {
    const store = new RelayStore();
    const local = localEvent("redacted", "confirm");
    deliver(store, local, "redacted", "confirm");
    const retained = hostedEvent(
      store,
      local,
      "redacted",
      { type: "confirm", value: true },
      1,
    );
    const { response: _removed, ...eventIdentity } = retained;
    const redacted: HostedInteractionEvent = {
      ...eventIdentity,
      answer_retained: false,
    };
    const controller = new AbortController();
    const source = new OrderedSource([redacted], () => controller.abort());

    await new WhooshBangInteractionPoller({
      store,
      source,
      streamKey,
      machineId,
      bindingId,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
    }).run(controller.signal);

    expect(source.acknowledgements).toEqual([
      expect.objectContaining({
        cursor: redacted.cursor,
        disposition: "processed",
        eventId: redacted.id,
      }),
    ]);
    expect(source.acknowledgements[0]).not.toHaveProperty("reasonCode");
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "open",
      },
    );
    expect(store.hostedPollStatus(streamKey)).toMatchObject({
      committedCursor: redacted.cursor,
      unacknowledgedEventCount: 0,
    });
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
    await new WhooshBangInteractionPoller({
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
    const unknownSource: WhooshBangInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "whooshbang.machine-events.v1",
        committed_cursor: null,
        server_time: "2026-07-26T19:10:00.000Z",
        events: [
          {
            ...poison,
            id: "hosted_event_whooshbang_unknown_12345678",
            cursor: "cursor_whooshbang_unknown_12345678",
            message_id: "message_whooshbang_unknown_12345678",
          },
        ],
      }),
      acknowledge: vi.fn(),
    };
    await new WhooshBangInteractionPoller({
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
        code: "whooshbang.poll-stopped-on-integrity",
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
    const firstSource: WhooshBangInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "whooshbang.machine-events.v1",
        events: [hosted],
        committed_cursor: null,
        server_time: "2026-07-26T19:05:00.000Z",
      }),
      acknowledge: vi.fn().mockRejectedValue(
        Object.assign(new Error("synthetic transient ack failure"), {
          code: "whooshbang-transport-unavailable",
          retryable: true,
        }),
      ),
    };
    await new WhooshBangInteractionPoller({
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
    await new WhooshBangInteractionPoller({
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
    const firstSource: WhooshBangInteractionSource = {
      poll: vi.fn().mockResolvedValue({
        schema: "whooshbang.machine-events.v1",
        events: [hosted],
        committed_cursor: null,
        server_time: "2026-07-26T19:05:00.000Z",
      }),
      acknowledge: vi
        .fn()
        .mockRejectedValue(
          new WhooshBangDeliveryError(
            "Synthetic disconnected connection.",
            "whooshbang-connection-inactive",
            false,
            "terminal",
          ),
        ),
    };
    await new WhooshBangInteractionPoller({
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
        resolvedBy: "whooshbang",
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
    await new WhooshBangInteractionPoller({
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
        resolvedBy: "whooshbang",
      },
    );
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        code: "whooshbang.work-recovered",
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
    const presenter: WhooshBangResolutionPresenter = {
      capability: "supported",
      reflect: async (reflection) => {
        operations.push(reflection.operationId);
        if (operations.length === 1) {
          throw new WhooshBangDeliveryError(
            "Synthetic response loss.",
            "whooshbang-transport-outcome-unknown",
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

    await new WhooshBangInteractionPoller({
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
        resolvedBy: "whooshbang",
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
    const presenter: WhooshBangResolutionPresenter = {
      capability: "supported",
      reflect: async (reflection) => {
        operations.push(reflection.operationId);
        throw new WhooshBangDeliveryError(
          "Synthetic provider ambiguity.",
          "whooshbang-provider-outcome-unknown",
          false,
          "outcome_unknown",
        );
      },
    };
    await new WhooshBangInteractionPoller({
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
      lastErrorCode: "whooshbang-provider-outcome-unknown",
    });
    expect(store.getPendingRequest(local.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        resolvedBy: "whooshbang",
      },
    );
    expect(source.acknowledgements).toHaveLength(1);
    store.close();
  });

  it("backs off transient poll failures and omits shutdown noise", async () => {
    const store = new RelayStore();
    const controller = new AbortController();
    const logger = new MemoryLogger();
    const source: WhooshBangInteractionSource = {
      poll: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("temporary poll failure"), {
            code: "whooshbang-transport-unavailable",
            retryable: true,
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("repeated temporary poll failure"), {
            code: "whooshbang-transport-unavailable",
            retryable: true,
          }),
        )
        .mockImplementation(async () => {
          controller.abort();
          return {
            schema: "whooshbang.machine-events.v1",
            events: [],
            committed_cursor: null,
            server_time: "2026-07-26T19:10:00.000Z",
          };
        }),
      acknowledge: vi.fn(),
    };
    const sleeps: number[] = [];
    await new WhooshBangInteractionPoller({
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
      "whooshbang.poll-started",
      "whooshbang.poll-retry",
      "whooshbang.poll-stopped",
    ]);
    store.close();
  });

  it("bounds a stuck long poll and retries without treating timeout as shutdown", async () => {
    const store = new RelayStore();
    const controller = new AbortController();
    const logger = new MemoryLogger();
    const source: WhooshBangInteractionSource = {
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
          code: "whooshbang-transport-unavailable",
          retryable: true,
        });
      },
      acknowledge: vi.fn(),
    };
    const sleeps: number[] = [];
    await new WhooshBangInteractionPoller({
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
      "whooshbang.poll-started",
      "whooshbang.poll-retry",
      "whooshbang.poll-stopped",
    ]);
    store.close();
  });
});
