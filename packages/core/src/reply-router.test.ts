import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { TelegramReplyRouter } from "./reply-router.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const baseTime = "2026-07-24T12:00:00.000Z";

function questionEvent(
  correlationId: string,
  sessionId: string,
  sequence: number,
  kind: "input" | "permission" | "continuation" = "input",
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `evt_${correlationId}`,
    occurredAt: baseTime,
    sequence,
    machineId: "machine_replies_12345678",
    bridgeSessionId: "bridge_replies_12345678",
    harness: sequence % 2 === 0 ? "claude" : "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId,
    turnId: `turn_replies_${String(sequence).padStart(4, "0")}`,
    project: makeProjectRef(`/workspace/${sessionId}`),
    type:
      kind === "permission"
        ? "permission.required"
        : kind === "continuation"
          ? "turn.stopped"
          : "input.required",
    summary: `Question for ${sessionId}`,
    request: {
      correlationId,
      kind,
      question: `Continue ${sessionId}?`,
      expiresAt: "2026-07-24T12:05:00.000Z",
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
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

describe("Telegram reply correlation", () => {
  it("isolates simultaneous free-text questions by replied-to message", async () => {
    const runtime = await setup();
    const first = questionEvent(
      "correlation_session_one",
      "session_replies_one",
      1,
    );
    const second = questionEvent(
      "correlation_session_two",
      "session_replies_two",
      2,
    );
    runtime.service.ingest(first);
    runtime.service.ingest(second);
    expect(await runtime.service.drain()).toMatchObject({ delivered: 2 });
    const firstMessage = runtime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === first.eventId,
    );
    expect(firstMessage).toBeDefined();

    const result = await runtime.router.handle({
      update_id: 100,
      message: {
        message_id: 500,
        from: { id: 7001 },
        chat: { id: 9001 },
        message_thread_id: Number(firstMessage?.context.topicId),
        text: "Answer only the first session",
        reply_to_message: {
          message_id: Number(firstMessage?.receipt.messageId),
        },
      },
    });
    expect(result.outcome).toBe("answered");
    expect(
      runtime.store.getPendingRequest(first.request?.correlationId ?? "")
        ?.answer,
    ).toBe("Answer only the first session");
    expect(
      runtime.store.getPendingRequest(second.request?.correlationId ?? "")
        ?.state,
    ).toBe("open");
    runtime.store.close();
  });

  it("correlates plain text to the only eligible request in its session topic", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_plain_topic",
      "session_plain_topic",
      1,
      "continuation",
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const delivery = runtime.transport.deliveries[0];

    const result = await runtime.router.handle({
      update_id: 106,
      message: {
        message_id: 506,
        message_thread_id: Number(delivery?.context.topicId),
        from: { id: 7001 },
        chat: { id: 9001 },
        text: "Continue with the focused fix",
      },
    });

    expect(result).toMatchObject({ outcome: "answered" });
    expect(
      runtime.store.getPendingRequest("correlation_plain_topic"),
    ).toMatchObject({
      state: "answered",
      answer: "Continue with the focused fix",
      resolvedBy: "telegram",
    });
    expect(runtime.transport.messageEdits).toHaveLength(1);
    expect(
      runtime.store
        .listDiagnostics()
        .find(
          (diagnostic) => diagnostic.code === "telegram.topic-text-answered",
        ),
    ).toMatchObject({
      level: "info",
      message: "Plain topic text correlation outcome: answered",
    });
    expect(JSON.stringify(runtime.store.listDiagnostics())).not.toContain(
      "Continue with the focused fix",
    );
    runtime.store.close();
  });

  it("ignores non-request reply metadata when one topic request is unambiguous", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_automatic_topic_reply",
      "session_automatic_topic_reply",
      1,
      "continuation",
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const delivery = runtime.transport.deliveries[0];

    const result = await runtime.router.handle({
      update_id: 114,
      message: {
        message_id: 514,
        message_thread_id: Number(delivery?.context.topicId),
        from: { id: 7001 },
        chat: { id: 9001 },
        text: "Continue despite automatic topic reply metadata",
        reply_to_message: {
          message_id: 999_999,
        },
      },
    });

    expect(result).toMatchObject({ outcome: "answered" });
    expect(
      runtime.store.getPendingRequest("correlation_automatic_topic_reply"),
    ).toMatchObject({
      state: "answered",
      answer: "Continue despite automatic topic reply metadata",
      resolvedBy: "telegram",
    });
    expect(runtime.store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          code: "telegram.topic-text-reply-fallback",
        }),
        expect.objectContaining({
          level: "info",
          code: "telegram.topic-text-answered",
        }),
      ]),
    );
    expect(JSON.stringify(runtime.store.listDiagnostics())).not.toContain(
      "Continue despite automatic topic reply metadata",
    );
    runtime.store.close();
  });

  it("guides without guessing when zero or multiple text requests are eligible", async () => {
    const runtime = await setup();
    const structured = questionEvent(
      "correlation_button_only",
      "session_guidance",
      1,
      "permission",
    );
    runtime.service.ingest(structured);
    await runtime.service.drain();
    const topicId = Number(runtime.transport.deliveries[0]?.context.topicId);

    expect(
      await runtime.router.handle({
        update_id: 107,
        message: {
          message_id: 507,
          message_thread_id: topicId,
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "ordinary topic chatter",
        },
      }),
    ).toEqual({ outcome: "no-eligible-request", updateId: 107 });
    expect(
      runtime.store.getPendingRequest("correlation_button_only")?.state,
    ).toBe("open");
    expect(runtime.transport.deliveries.at(-1)?.message.text).toContain(
      "No open free-text or continuation request",
    );

    const first = questionEvent(
      "correlation_ambiguous_one",
      "session_guidance",
      3,
    );
    const second = questionEvent(
      "correlation_ambiguous_two",
      "session_guidance",
      5,
      "continuation",
    );
    runtime.service.ingest(first);
    runtime.service.ingest(second);
    await runtime.service.drain();

    expect(
      await runtime.router.handle({
        update_id: 108,
        message: {
          message_id: 508,
          message_thread_id: topicId,
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "do not guess",
        },
      }),
    ).toEqual({ outcome: "ambiguous-request", updateId: 108 });
    expect(
      runtime.store.getPendingRequest("correlation_ambiguous_one")?.state,
    ).toBe("open");
    expect(
      runtime.store.getPendingRequest("correlation_ambiguous_two")?.state,
    ).toBe("open");
    expect(runtime.transport.deliveries.at(-1)?.message.text).toContain(
      "More than one text request",
    );

    const firstDelivery = runtime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === first.eventId,
    );
    expect(
      await runtime.router.handle({
        update_id: 109,
        message: {
          message_id: 509,
          message_thread_id: topicId,
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "answer only the selected request",
          reply_to_message: {
            message_id: Number(firstDelivery?.receipt.messageId),
          },
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      runtime.store.getPendingRequest("correlation_ambiguous_one"),
    ).toMatchObject({
      state: "answered",
      answer: "answer only the selected request",
    });
    expect(
      runtime.store.getPendingRequest("correlation_ambiguous_two")?.state,
    ).toBe("open");
    runtime.store.close();
  });

  it("rejects explicit replies from another topic and text for button-only requests", async () => {
    const runtime = await setup();
    const textRequest = questionEvent(
      "correlation_cross_topic",
      "session_cross_topic_one",
      1,
    );
    const otherSession = questionEvent(
      "correlation_other_topic",
      "session_cross_topic_two",
      2,
    );
    runtime.service.ingest(textRequest);
    runtime.service.ingest(otherSession);
    await runtime.service.drain();
    const textDelivery = runtime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === textRequest.eventId,
    );
    const otherDelivery = runtime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === otherSession.eventId,
    );

    expect(
      await runtime.router.handle({
        update_id: 109,
        message: {
          message_id: 509,
          message_thread_id: Number(otherDelivery?.context.topicId),
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "wrong topic",
          reply_to_message: {
            message_id: Number(textDelivery?.receipt.messageId),
          },
        },
      }),
    ).toEqual({ outcome: "uncorrelated", updateId: 109 });
    expect(
      runtime.store.getPendingRequest("correlation_cross_topic")?.state,
    ).toBe("open");

    const buttonOnly = questionEvent(
      "correlation_explicit_button_only",
      "session_cross_topic_two",
      4,
      "permission",
    );
    runtime.service.ingest(buttonOnly);
    await runtime.service.drain();
    const buttonDelivery = runtime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === buttonOnly.eventId,
    );
    expect(
      await runtime.router.handle({
        update_id: 110,
        message: {
          message_id: 510,
          message_thread_id: Number(buttonDelivery?.context.topicId),
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "allow",
          reply_to_message: {
            message_id: Number(buttonDelivery?.receipt.messageId),
          },
        },
      }),
    ).toEqual({ outcome: "uncorrelated", updateId: 110 });
    expect(
      runtime.store.getPendingRequest("correlation_explicit_button_only")
        ?.state,
    ).toBe("open");
    expect(runtime.transport.deliveries.at(-1)?.message.text).toContain(
      "requires a button choice",
    );
    runtime.store.close();
  });

  it("keeps first-writer-wins when concurrent plain messages target one request", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_plain_race",
      "session_plain_race",
      1,
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const topicId = Number(runtime.transport.deliveries[0]?.context.topicId);
    const makeUpdate = (updateId: number, text: string) => ({
      update_id: updateId,
      message: {
        message_id: updateId + 1_000,
        message_thread_id: topicId,
        from: { id: 7001 },
        chat: { id: 9001 },
        text,
      },
    });

    const outcomes = await Promise.all([
      runtime.router.handle(makeUpdate(111, "first candidate")),
      runtime.router.handle(makeUpdate(112, "second candidate")),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "answered",
      "no-eligible-request",
    ]);
    expect(
      ["first candidate", "second candidate"].includes(
        runtime.store.getPendingRequest("correlation_plain_race")?.answer ?? "",
      ),
    ).toBe(true);
    runtime.store.close();
  });

  it("durably diagnoses a topic guidance delivery failure", async () => {
    const runtime = await setup();
    const buttonOnly = questionEvent(
      "correlation_guidance_failure",
      "session_guidance_failure",
      1,
      "permission",
    );
    runtime.service.ingest(buttonOnly);
    await runtime.service.drain();
    const topicId = Number(runtime.transport.deliveries[0]?.context.topicId);
    runtime.transport.failNext(1);

    expect(
      await runtime.router.handle({
        update_id: 113,
        message: {
          message_id: 1_113,
          message_thread_id: topicId,
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "not a button",
        },
      }),
    ).toEqual({ outcome: "no-eligible-request", updateId: 113 });
    expect(runtime.store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "telegram.topic-text-guidance-failed",
          message: "Topic text guidance delivery failed: fake-timeout",
        }),
        expect.objectContaining({
          code: "telegram.topic-text-no-eligible-request",
        }),
      ]),
    );
    expect(
      runtime.store.getPendingRequest("correlation_guidance_failure")?.state,
    ).toBe("open");
    runtime.store.close();
  });

  it("uses opaque callback tokens and makes duplicate updates harmless", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_permission",
      "session_permission",
      3,
      "permission",
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const delivery = runtime.transport.deliveries[0];
    const choice = delivery?.message.choices?.find(
      (candidate) => candidate.label === "Allow once",
    );
    expect(choice?.token).toMatch(/^decision_/);
    expect(choice?.token).not.toContain(input.sessionId);
    const update = {
      update_id: 101,
      callback_query: {
        id: "callback_101",
        from: { id: 7001 },
        data: `relay:${choice?.token ?? ""}`,
        message: {
          message_id: Number(delivery?.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    };

    expect(await runtime.router.handle(update)).toMatchObject({
      outcome: "answered",
    });
    expect(await runtime.router.handle(update)).toEqual({
      outcome: "duplicate-update",
      updateId: 101,
    });
    expect(
      runtime.store.getPendingRequest("correlation_permission")?.answer,
    ).toBe("allow_once");
    expect(runtime.transport.callbackAcknowledgements).toHaveLength(1);
    expect(runtime.transport.messageEdits).toHaveLength(1);
    expect(runtime.transport.messageEdits[0]?.text).toContain("Answered");
    expect(runtime.transport.messageEdits[0]?.text).toContain(
      "session rmission",
    );
    expect(runtime.transport.messageEdits[0]?.text).not.toContain("allow_once");
    runtime.store.close();
  });

  it("enforces terminal-first as the single terminal outcome", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_terminal_first",
      "session_terminal_first",
      4,
      "permission",
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const delivery = runtime.transport.deliveries[0];
    const choice = delivery?.message.choices?.[0];
    expect(
      runtime.service.resolveTerminal({
        correlationId: "correlation_terminal_first",
        answer: "handled at terminal",
        expected: {
          machineId: input.machineId,
          harness: input.harness,
          sessionId: input.sessionId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "answered" });

    const telegram = await runtime.router.handle({
      update_id: 102,
      callback_query: {
        id: "callback_102",
        from: { id: 7001 },
        data: `relay:${choice?.token ?? ""}`,
        message: {
          message_id: Number(delivery?.receipt.messageId),
          chat: { id: 9001 },
        },
      },
    });
    expect(telegram.outcome).toBe("duplicate-answer");
    expect(
      runtime.store.getPendingRequest("correlation_terminal_first")?.answer,
    ).toBe("handled at terminal");
    runtime.store.close();
  });

  it("enforces Telegram-first and rejects a mismatched or duplicate terminal answer", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_telegram_first",
      "session_telegram_first",
      5,
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    const messageId = runtime.transport.deliveries[0]?.receipt.messageId;
    const topicId = runtime.transport.deliveries[0]?.context.topicId;
    await runtime.router.handle({
      update_id: 103,
      message: {
        message_id: 501,
        from: { id: 7001 },
        chat: { id: 9001 },
        message_thread_id: Number(topicId),
        text: "telegram won",
        reply_to_message: { message_id: Number(messageId) },
      },
    });

    expect(
      runtime.service.resolveTerminal({
        correlationId: "correlation_telegram_first",
        answer: "terminal lost",
        expected: {
          machineId: input.machineId,
          harness: input.harness,
          sessionId: input.sessionId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "duplicate" });
    expect(
      runtime.store.getPendingRequest("correlation_telegram_first")?.answer,
    ).toBe("telegram won");
    runtime.store.close();
  });

  it("expires stale replies and leaves identity-mismatched requests open", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const input = questionEvent(
      "correlation_stale_answer",
      "session_stale_answer",
      6,
    );
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-24T12:06:00.000Z"),
    });
    service.ingest(input);
    await service.drain();
    const router = new TelegramReplyRouter(store, transport, {
      operatorUserId: 7001,
      chatId: 9001,
      now: () => new Date("2026-07-24T12:06:00.000Z"),
    });
    expect(
      await router.handle({
        update_id: 104,
        message: {
          message_id: 502,
          from: { id: 7001 },
          chat: { id: 9001 },
          message_thread_id: Number(transport.deliveries[0]?.context.topicId),
          text: "too late",
          reply_to_message: {
            message_id: Number(transport.deliveries[0]?.receipt.messageId),
          },
        },
      }),
    ).toMatchObject({ outcome: "expired" });

    const second = questionEvent(
      "correlation_identity_check",
      "session_identity_check",
      7,
    );
    service.ingest(second);
    expect(
      service.resolveTerminal({
        correlationId: "correlation_identity_check",
        answer: "wrong turn",
        expected: {
          machineId: second.machineId,
          harness: second.harness,
          sessionId: "session_wrong_target",
          ...(second.turnId === undefined ? {} : { turnId: second.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "identity_mismatch" });
    expect(store.getPendingRequest("correlation_identity_check")?.state).toBe(
      "open",
    );
    store.close();
  });

  it("rejects an unauthorized operator without resolving the request", async () => {
    const runtime = await setup();
    const input = questionEvent(
      "correlation_unauthorized",
      "session_unauthorized",
      8,
    );
    runtime.service.ingest(input);
    await runtime.service.drain();
    expect(
      await runtime.router.handle({
        update_id: 105,
        message: {
          message_id: 503,
          from: { id: 9999 },
          chat: { id: 9001 },
          message_thread_id: Number(
            runtime.transport.deliveries[0]?.context.topicId,
          ),
          text: "malicious reply",
          reply_to_message: {
            message_id: Number(
              runtime.transport.deliveries[0]?.receipt.messageId,
            ),
          },
        },
      }),
    ).toMatchObject({ outcome: "unauthorized" });
    expect(
      runtime.store.getPendingRequest("correlation_unauthorized")?.state,
    ).toBe("open");
    runtime.store.close();
  });
});
