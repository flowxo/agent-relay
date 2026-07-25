import { describe, expect, it, vi } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { cardActionCallbackData, type CardActionKind } from "./card-action.js";
import type { FakeDelivery } from "./fake-transport.js";
import { FakeTelegramTransport } from "./fake-transport.js";
import { TelegramReplyRouter } from "./reply-router.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const baseTime = "2026-07-25T12:00:00.000Z";

function event(
  eventId: string,
  sessionId: string,
  sequence: number,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: overrides.occurredAt ?? baseTime,
    sequence,
    machineId: "machine_card_actions_12345678",
    bridgeSessionId: `bridge_${sessionId}`,
    harness: overrides.harness ?? "codex",
    surface: overrides.surface ?? "cli",
    harnessVersion: "test",
    sessionId,
    project: {
      ...makeProjectRef(`/workspace/${sessionId}`),
      branch: "codex/card-actions",
    },
    type: overrides.type ?? "turn.stopped",
    summary: overrides.summary ?? `Synthetic event for ${sessionId}`,
    ...(overrides.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: overrides.lastAssistantMessage }),
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function continuationEvent(
  eventId: string,
  sessionId: string,
  sequence: number,
): AgentAttentionEventV1 {
  return event(eventId, sessionId, sequence, {
    request: {
      correlationId: `correlation_${eventId}`,
      kind: "continuation",
      question: "Continue this stopped turn?",
      expiresAt: "2026-07-25T12:05:00.000Z",
    },
  });
}

function questionEvent(
  eventId: string,
  sessionId: string,
  sequence: number,
): AgentAttentionEventV1 {
  return event(eventId, sessionId, sequence, {
    type: "input.required",
    request: {
      correlationId: `correlation_${eventId}`,
      kind: "input",
      question: "What should happen next?",
      expiresAt: "2026-07-25T12:05:00.000Z",
    },
  });
}

function callbackFor(
  delivery: FakeDelivery,
  kind: CardActionKind,
  updateId: number,
  overrides: {
    userId?: number;
    messageId?: number;
    topicId?: number;
    data?: string;
  } = {},
) {
  const action = delivery.message.actions?.find(
    (candidate) => candidate.kind === kind,
  );
  if (action === undefined) {
    throw new Error(`delivery did not include ${kind}`);
  }
  return {
    action,
    update: {
      update_id: updateId,
      callback_query: {
        id: `callback_${String(updateId)}`,
        from: { id: overrides.userId ?? 7001 },
        data:
          overrides.data ?? cardActionCallbackData(action.kind, action.token),
        message: {
          message_id: overrides.messageId ?? Number(delivery.receipt.messageId),
          message_thread_id:
            overrides.topicId ?? Number(delivery.context.topicId),
          chat: { id: 9001 },
        },
      },
    },
  };
}

async function setup() {
  const store = new RelayStore();
  const transport = new FakeTelegramTransport();
  const service = new RelayService(store, transport, {
    now: () => new Date(baseTime),
  });
  const router = new TelegramReplyRouter(store, transport, {
    operatorUserId: 7001,
    chatId: 9001,
    now: () => new Date(baseTime),
  });
  return { store, transport, service, router };
}

describe("Telegram card actions", () => {
  it("commits Continue before acknowledging and never resumes twice", async () => {
    const runtime = await setup();
    const input = continuationEvent(
      "evt_card_continue_12345678",
      "session_card_continue_12345678",
      1,
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const delivery = runtime.transport.deliveries[0];
    if (delivery === undefined) {
      throw new Error("missing continuation delivery");
    }
    const callback = callbackFor(delivery, "continue", 201);
    vi.spyOn(runtime.transport, "acknowledgeCallback").mockImplementation(
      async (callbackId, text) => {
        expect(runtime.store.getCardAction(callback.action.token)?.state).toBe(
          "succeeded",
        );
        expect(
          runtime.store.getPendingRequest(input.request?.correlationId ?? "")
            ?.state,
        ).toBe("answered");
        runtime.transport.callbackAcknowledgements.push({ callbackId, text });
      },
    );

    await expect(runtime.router.handle(callback.update)).resolves.toMatchObject(
      {
        outcome: "action-completed",
      },
    );
    const claim = runtime.store.claimNextResume({
      machineId: input.machineId,
      bridgeSessionId: input.bridgeSessionId,
      harness: input.harness,
      ownerId: "supervisor_card_actions_12345678",
      now: baseTime,
    });
    expect(claim.outcome).toBe("claimed");

    const duplicate = callbackFor(delivery, "continue", 202);
    await expect(
      runtime.router.handle(duplicate.update),
    ).resolves.toMatchObject({
      outcome: "action-duplicate",
    });
    expect(
      runtime.store.getPendingRequest(input.request?.correlationId ?? "")
        ?.answer,
    ).toBe("Continue.");
    runtime.store.close();
  });

  it("posts bounded Details once and preserves the full durable event", async () => {
    const runtime = await setup();
    const finalSentence = "FINAL DETAILS SENTENCE";
    const input = event(
      "evt_card_details_12345678",
      "session_card_details_12345678",
      1,
      {
        lastAssistantMessage: `${"Long detail. ".repeat(200)}${finalSentence}`,
      },
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const card = runtime.transport.deliveries[0];
    if (card === undefined) {
      throw new Error("missing details card");
    }
    const callback = callbackFor(card, "details", 203);

    await expect(runtime.router.handle(callback.update)).resolves.toMatchObject(
      {
        outcome: "action-completed",
      },
    );
    expect(runtime.transport.deliveries).toHaveLength(2);
    expect(runtime.transport.deliveries[1]?.message.text).toContain(
      finalSentence,
    );
    expect(runtime.store.getCardAction(callback.action.token)).toMatchObject({
      state: "succeeded",
      outcome: "details-delivered",
    });

    const duplicate = callbackFor(card, "details", 204);
    await expect(
      runtime.router.handle(duplicate.update),
    ).resolves.toMatchObject({
      outcome: "action-duplicate",
    });
    expect(runtime.transport.deliveries).toHaveLength(2);
    runtime.store.close();
  });

  it("mutes routine events while keeping questions and failures visible", async () => {
    const runtime = await setup();
    const sessionId = "session_card_mute_12345678";
    runtime.service.ingest(
      event("evt_card_mute_source_12345678", sessionId, 1, {
        type: "session.started",
      }),
    );
    await runtime.service.drain();
    const card = runtime.transport.deliveries[0];
    if (card === undefined) {
      throw new Error("missing mute card");
    }
    const callback = callbackFor(card, "mute", 205);
    await expect(runtime.router.handle(callback.update)).resolves.toMatchObject(
      {
        outcome: "action-completed",
      },
    );
    expect(
      runtime.store.getSessionControl(event("", sessionId, 1)),
    ).toMatchObject({ mutedAt: baseTime });

    runtime.service.ingest(
      event("evt_card_muted_routine_12345678", sessionId, 2, {
        type: "turn.activity",
      }),
    );
    await runtime.service.drain();
    expect(runtime.transport.deliveries).toHaveLength(1);
    expect(
      runtime.store.getEvent("evt_card_muted_routine_12345678")?.status,
    ).toBe("delivered");

    runtime.service.ingest(
      questionEvent("evt_card_muted_question_12345678", sessionId, 3),
    );
    await runtime.service.drain();
    expect(runtime.transport.deliveries).toHaveLength(2);
    runtime.store.close();
  });

  it("blocks End while a question is open, then ends only the relay lane", async () => {
    const runtime = await setup();
    const sessionId = "session_card_end_12345678";
    const input = questionEvent("evt_card_end_question_12345678", sessionId, 1);
    runtime.service.ingest(input);
    await runtime.service.drain();
    const card = runtime.transport.deliveries[0];
    if (card === undefined) {
      throw new Error("missing end card");
    }

    const blocked = callbackFor(card, "end", 206);
    await expect(runtime.router.handle(blocked.update)).resolves.toMatchObject({
      outcome: "action-rejected",
    });
    expect(runtime.store.getCardAction(blocked.action.token)?.state).toBe(
      "open",
    );
    expect(runtime.store.getSessionControl(input)).toBeUndefined();
    expect(
      runtime.store.getPendingRequest(input.request?.correlationId ?? "")
        ?.state,
    ).toBe("open");

    runtime.service.resolveTerminal({
      correlationId: input.request?.correlationId ?? "",
      answer: "Handled before ending",
      expected: {
        machineId: input.machineId,
        harness: input.harness,
        sessionId: input.sessionId,
      },
    });
    const accepted = callbackFor(card, "end", 207);
    await expect(runtime.router.handle(accepted.update)).resolves.toMatchObject(
      {
        outcome: "action-completed",
      },
    );
    expect(runtime.store.getSessionControl(input)).toMatchObject({
      endedAt: baseTime,
    });
    expect(runtime.transport.messageEdits.at(-1)?.text).toContain(
      "harness process is unchanged",
    );
    runtime.store.close();
  });

  it("rejects cross-topic and cross-session callbacks durably", async () => {
    const runtime = await setup();
    runtime.service.ingest(
      event("evt_card_cross_a_12345678", "session_card_cross_a_12345678", 1, {
        type: "session.started",
      }),
    );
    runtime.service.ingest(
      event("evt_card_cross_b_12345678", "session_card_cross_b_12345678", 1, {
        type: "session.started",
      }),
    );
    await runtime.service.drain();
    const first = runtime.transport.deliveries[0];
    const second = runtime.transport.deliveries[1];
    if (first === undefined || second === undefined) {
      throw new Error("missing cross-session cards");
    }
    const forged = callbackFor(first, "mute", 208, {
      messageId: Number(second.receipt.messageId),
      topicId: Number(second.context.topicId),
    });

    await expect(runtime.router.handle(forged.update)).resolves.toMatchObject({
      outcome: "action-rejected",
    });
    expect(runtime.store.getCardAction(forged.action.token)?.state).toBe(
      "open",
    );
    expect(runtime.store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "telegram.card-action-session-mismatch",
      }),
    );
    runtime.store.close();
  });

  it("diagnoses malformed, unknown, and unauthorized callbacks", async () => {
    const runtime = await setup();
    runtime.service.ingest(
      event(
        "evt_card_rejections_12345678",
        "session_card_rejections_12345678",
        1,
        { type: "session.started" },
      ),
    );
    await runtime.service.drain();
    const card = runtime.transport.deliveries[0];
    if (card === undefined) {
      throw new Error("missing rejection card");
    }

    const malformed = callbackFor(card, "mute", 209, {
      data: "relay-card:v2:m:not-valid",
    });
    const unknown = callbackFor(card, "mute", 210, {
      data: "relay-card:v1:m:card_00000000000000000000000000000000",
    });
    const unauthorized = callbackFor(card, "mute", 211, { userId: 9999 });
    await expect(
      runtime.router.handle(malformed.update),
    ).resolves.toMatchObject({
      outcome: "action-rejected",
    });
    await expect(runtime.router.handle(unknown.update)).resolves.toMatchObject({
      outcome: "action-rejected",
    });
    await expect(
      runtime.router.handle(unauthorized.update),
    ).resolves.toMatchObject({ outcome: "unauthorized" });

    expect(
      runtime.store.listDiagnostics().map((diagnostic) => diagnostic.code),
    ).toEqual(
      expect.arrayContaining([
        "telegram.card-action-malformed",
        "telegram.card-action-unknown",
        "telegram.card-action-unauthorized",
      ]),
    );
    runtime.store.close();
  });

  it("records an ambiguous Details failure and refuses to repeat it", async () => {
    const runtime = await setup();
    runtime.service.ingest(
      event(
        "evt_card_details_failure_12345678",
        "session_card_details_failure_12345678",
        1,
        { lastAssistantMessage: "x".repeat(2_000) },
      ),
    );
    await runtime.service.drain();
    const card = runtime.transport.deliveries[0];
    if (card === undefined) {
      throw new Error("missing failing details card");
    }
    runtime.transport.failNext(1);
    const callback = callbackFor(card, "details", 212);
    await expect(runtime.router.handle(callback.update)).resolves.toMatchObject(
      {
        outcome: "action-failed",
      },
    );
    expect(runtime.store.getCardAction(callback.action.token)).toMatchObject({
      state: "failed",
      outcome: "fake-timeout",
    });

    const duplicate = callbackFor(card, "details", 213);
    await expect(
      runtime.router.handle(duplicate.update),
    ).resolves.toMatchObject({
      outcome: "action-duplicate",
    });
    expect(
      runtime.transport.attempts.filter(
        (attempt) =>
          attempt.eventId === "evt_card_details_failure_12345678" &&
          attempt.outcome === "failed",
      ),
    ).toHaveLength(1);
    runtime.store.close();
  });
});
