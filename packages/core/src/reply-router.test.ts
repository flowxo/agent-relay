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
  kind: "input" | "permission" = "input",
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
    type: kind === "permission" ? "permission.required" : "input.required",
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
    await runtime.router.handle({
      update_id: 103,
      message: {
        message_id: 501,
        from: { id: 7001 },
        chat: { id: 9001 },
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
