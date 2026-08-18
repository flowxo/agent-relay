import {
  TransportError,
  type DeliveryContext,
  type DeliveryMessage,
  type DeliveryReceipt,
  type NotificationTransport,
} from "@agent-relay/notification-contracts";
import {
  makeProjectRef,
  type AgentAttentionEventV1,
} from "@agent-relay/protocol";
import { describe, expect, it } from "vitest";

import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { sessionPublicKey } from "./topic.js";

const now = "2026-07-28T14:00:00.000Z";
const expiresAt = "2026-07-28T14:10:00.000Z";

class RecordingWebhookTransport implements NotificationTransport {
  public readonly name = "webhook";
  public readonly deliveries: Array<{
    message: DeliveryMessage;
    context: DeliveryContext;
  }> = [];

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    this.deliveries.push({ message, context });
    return {
      transport: this.name,
      messageId: `receiver_${context.idempotencyKey}`,
    };
  }
}

function inputEvent(): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "event_webhook_handoff_12345678",
    occurredAt: now,
    sequence: 1,
    machineId: "machine_webhook_handoff_12345678",
    bridgeSessionId: "bridge_webhook_handoff_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_webhook_handoff_12345678",
    turnId: "turn_webhook_handoff_12345678",
    project: {
      ...makeProjectRef("/private/workspace/agent-relay"),
      branch: "codex/webhook-handoff",
    },
    type: "input.required",
    summary: "Agent needs a synthetic answer",
    request: {
      correlationId: "request_webhook_handoff_12345678",
      kind: "input",
      question: "Provide a synthetic answer",
      expiresAt,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function questionSetEvent(): AgentAttentionEventV1 {
  const event = inputEvent();
  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: "request_webhook_questions_12345678",
    createdAt: now,
    expiresAt,
    title: "Release controls",
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: "question_webhook_confirm_12345678",
        kind: "confirm" as const,
        prompt: "Proceed?",
        confirm: {
          optionId: "option_webhook_proceed_12345678",
          label: "Proceed",
        },
        decline: {
          optionId: "option_webhook_stop_12345678",
          label: "Stop",
        },
      },
      {
        questionId: "question_webhook_note_12345678",
        kind: "free-text" as const,
        prompt: "Release note",
        minLength: 3,
        maxLength: 80,
        multiline: false,
      },
    ],
    fallback: {
      preferredMode: "web-handoff" as const,
      alternativeModes: [],
      whenUnavailable: "reject" as const,
    },
  };
  return {
    ...event,
    eventId: "event_webhook_questions_12345678",
    request: {
      correlationId: interaction.requestId,
      kind: "question-set",
      question: interaction.title,
      interaction,
      expiresAt,
    },
  };
}

function runtime(transport: NotificationTransport) {
  const store = new RelayStore();
  const service = new RelayService(store, transport, {
    now: () => new Date(now),
    interactionHandoff: {
      baseUrl: "http://127.0.0.1:4317",
      fallbackWhenTransportUnavailable: true,
    },
  });
  return { service, store };
}

describe("provider-neutral outbound metadata and local web handoff", () => {
  it("normalizes an adversarial slash-heavy handoff URL in bounded time", () => {
    const transport = new RecordingWebhookTransport();
    const store = new RelayStore();
    new RelayService(store, transport, {
      interactionHandoff: {
        baseUrl: `${"/".repeat(50_000)}x`,
      },
    });
    store.close();
  }, 500);

  it("attaches bounded session routing metadata and an exact request handoff", async () => {
    const transport = new RecordingWebhookTransport();
    const { service, store } = runtime(transport);
    const event = inputEvent();
    service.ingest(event);

    await expect(service.drain()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retrying: 0,
      deadLettered: 0,
    });
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0]?.context).toEqual({
      idempotencyKey: event.eventId,
      deliveryMode: "notify",
      source: {
        occurredAt: now,
        eventType: "input.required",
        harness: "codex",
        surface: "cli",
        repository: "agent-relay",
        branch: "codex/webhook-handoff",
        sessionKey: sessionPublicKey(event),
        shortSessionId: expect.stringMatching(/^[a-z]+-[a-z]+-\d{2}$/u),
      },
      handoff: {
        mode: "local-web",
        requestId: "request_webhook_handoff_12345678",
        expiresAt,
        url: "http://127.0.0.1:4317/ui/?request=request_webhook_handoff_12345678",
      },
    });
    expect(JSON.stringify(transport.deliveries[0]?.context)).not.toContain(
      "/private/workspace",
    );
    store.close();
  });

  it("delivers a structured question alert through a noninteractive transport while keeping web authority", async () => {
    const transport = new RecordingWebhookTransport();
    const { service, store } = runtime(transport);
    const event = questionSetEvent();
    service.ingest(event);

    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      deadLettered: 0,
    });
    expect(transport.deliveries[0]?.message.questionSet).toMatchObject({
      requestId: "request_webhook_questions_12345678",
      presentationMode: "web-handoff",
      position: 1,
      total: 2,
    });
    expect(transport.deliveries[0]?.context.handoff?.requestId).toBe(
      "request_webhook_questions_12345678",
    );
    expect(
      store.getPendingRequest("request_webhook_questions_12345678"),
    ).toMatchObject({
      state: "open",
      transportMessageId: "receiver_event_webhook_questions_12345678",
    });
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "interaction.web-handoff-selected",
        level: "warn",
      }),
    );
    store.close();
  });

  it("delivers an honest alert-only question set when the web companion is disabled", async () => {
    const transport = new RecordingWebhookTransport();
    const store = new RelayStore();
    const service = new RelayService(store, transport, {
      now: () => new Date(now),
      interactionHandoff: {
        fallbackWhenTransportUnavailable: true,
      },
    });
    const event = questionSetEvent();
    service.ingest(event);

    await expect(service.drain()).resolves.toMatchObject({
      delivered: 1,
      deadLettered: 0,
    });
    expect(transport.deliveries[0]?.message).toMatchObject({
      eventId: event.eventId,
      text: expect.stringContaining("Release controls"),
    });
    expect(transport.deliveries[0]?.message.questionSet).toBeUndefined();
    expect(transport.deliveries[0]?.context.handoff).toBeUndefined();
    expect(store.listDiagnostics()).toContainEqual(
      expect.objectContaining({
        code: "interaction.alert-only-selected",
        level: "warn",
      }),
    );
    expect(
      store.getPendingRequest("request_webhook_questions_12345678"),
    ).toMatchObject({ state: "open" });
    store.close();
  });

  it("uses a bounded provider Retry-After without changing durable attempt identity", async () => {
    const transport: NotificationTransport = {
      name: "webhook",
      deliver: async () => {
        throw new TransportError(
          "Webhook endpoint returned HTTP 429",
          "webhook-http-429",
          true,
          429,
          120_000,
        );
      },
    };
    const { service, store } = runtime(transport);
    const event = {
      ...inputEvent(),
      eventId: "event_webhook_retry_after_12345678",
      type: "turn.stopped" as const,
      request: undefined,
    };
    service.ingest(event);

    await expect(service.drain()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    expect(store.getEvent(event.eventId)).toMatchObject({ status: "retry" });
    expect(store.claimDueEvents("2026-07-28T14:01:59.999Z")).toHaveLength(0);
    expect(store.claimDueEvents("2026-07-28T14:02:00.000Z")).toMatchObject([
      {
        attemptNumber: 2,
        event: { eventId: event.eventId },
      },
    ]);
    store.close();
  });
});
