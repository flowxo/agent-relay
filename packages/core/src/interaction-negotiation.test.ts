import { describe, expect, it } from "vitest";

import {
  InteractionProviderObservationV1Schema,
  makeProjectRef,
  type AgentAttentionEventV1,
  type InteractionProviderObservationV1,
  type OperatorInteractionRequestV1,
} from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import {
  harnessInteractionObservation,
  negotiateInteraction,
  requiredInteractionFeatures,
} from "./interaction-negotiation.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  NotificationTransport,
} from "./transport.js";

const observedAt = "2026-07-25T12:00:00.000Z";

function request(
  questions: OperatorInteractionRequestV1["questions"],
  fallback: OperatorInteractionRequestV1["fallback"] = {
    preferredMode: "buttons",
    alternativeModes: ["numbered-text"],
    whenUnavailable: "use-alternative",
  },
): OperatorInteractionRequestV1 {
  return {
    schema: "agent-interaction-request.v1",
    requestId: "request_negotiation_0001",
    createdAt: observedAt,
    expiresAt: "2026-07-25T12:05:00.000Z",
    title: "Choose a release configuration",
    lifecycle: "pending",
    questions,
    fallback,
  };
}

function event(
  interaction: OperatorInteractionRequestV1,
  capabilities: AgentAttentionEventV1["capabilities"] = {
    inlineContinue: true,
    lateResume: true,
    activeSteer: false,
    permissionDecision: true,
  },
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_negotiation_00000001",
    occurredAt: observedAt,
    sequence: 1,
    machineId: "machine_negotiation_0001",
    bridgeSessionId: "bridge_negotiation_0001",
    harness: "codex",
    harnessVersion: "codex-cli 0.145.0",
    surface: "cli",
    sessionId: "session_negotiation_0001",
    turnId: "turn_negotiation_000001",
    project: makeProjectRef("/workspace/negotiation"),
    type: "input.required",
    summary: "A structured answer is required",
    request: {
      correlationId: interaction.requestId,
      kind: "question-set",
      question: interaction.title,
      interaction,
      expiresAt: interaction.expiresAt,
    },
    capabilities,
  };
}

function singleSelect(optionCount: number) {
  return {
    questionId: "question_mode_0000001",
    kind: "single-select" as const,
    prompt: "Choose a rollout mode",
    options: Array.from({ length: optionCount }, (_, index) => ({
      optionId: `option_mode_${String(index + 1).padStart(8, "0")}`,
      label: `Mode ${String(index + 1)}`,
    })),
  };
}

function transportObservation(): InteractionProviderObservationV1 {
  return new FakeTelegramTransport().observeInteractionCapabilities(observedAt);
}

describe("structured interaction capability negotiation", () => {
  it("derives required features and selects compact buttons deterministically", () => {
    const interaction = request([singleSelect(3)]);
    expect(requiredInteractionFeatures(interaction)).toEqual([
      "single-select",
      "durable-drafts",
      "message-updates",
    ]);

    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: transportObservation(),
      }),
    ).toMatchObject({
      outcome: "selected",
      mode: "buttons",
      attempts: [{ mode: "buttons", accepted: true }],
    });
  });

  it("falls back from oversized buttons to correlated numbered text", () => {
    const interaction = request([singleSelect(12)]);
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: transportObservation(),
      }),
    ).toMatchObject({
      outcome: "selected",
      mode: "numbered-text",
      attempts: [
        {
          mode: "buttons",
          accepted: false,
          reason: expect.stringContaining("compact button budget"),
        },
        { mode: "numbered-text", accepted: true },
      ],
    });
  });

  it("honors reject instead of silently choosing an undeclared fallback", () => {
    const interaction = request([singleSelect(12)], {
      preferredMode: "buttons",
      alternativeModes: [],
      whenUnavailable: "reject",
    });
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: transportObservation(),
      }),
    ).toMatchObject({
      outcome: "unsupported",
      code: "interaction-mode-unavailable",
      attempts: [{ mode: "buttons", accepted: false }],
    });
  });

  it("uses direct text for free-text steps with compact button companions", () => {
    const interaction = request(
      [
        {
          questionId: "question_notes_000001",
          kind: "free-text",
          prompt: "Add release notes",
          minLength: 1,
          maxLength: 500,
          multiline: true,
        },
        {
          questionId: "question_confirm_0001",
          kind: "confirm",
          prompt: "Submit the release notes?",
          confirm: { optionId: "confirm_yes_0000001", label: "Submit" },
          decline: { optionId: "confirm_no_00000001", label: "Stop" },
        },
      ],
      {
        preferredMode: "direct-text",
        alternativeModes: [],
        whenUnavailable: "reject",
      },
    );
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: transportObservation(),
      }),
    ).toMatchObject({ outcome: "selected", mode: "direct-text" });
  });

  it("does not advertise local web handoff before the web authority exists", () => {
    const interaction = request([singleSelect(3)], {
      preferredMode: "web-handoff",
      alternativeModes: [],
      whenUnavailable: "reject",
    });
    const transport = transportObservation();
    const syntheticWebClaim = InteractionProviderObservationV1Schema.parse({
      ...transport,
      capabilities: {
        ...transport.capabilities,
        presentationModes: [
          ...transport.capabilities.presentationModes,
          "web-handoff",
        ],
      },
    });
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: syntheticWebClaim,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      reason: expect.stringContaining("not implemented"),
    });
  });

  it("rejects assumed records and harnesses that cannot continue", () => {
    const interaction = request([singleSelect(3)]);
    const transport = transportObservation();
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: { ...transport, status: "assumed" },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      code: "interaction-capabilities-unproven",
    });
    const incapableEvent = event(interaction, {
      inlineContinue: false,
      lateResume: false,
      activeSteer: false,
      permissionDecision: false,
    });
    expect(
      negotiateInteraction({
        request: interaction,
        event: incapableEvent,
        transport,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      code: "harness-continuation-unsupported",
    });
  });

  it("records the exact harness version as version-scoped event evidence", () => {
    const interaction = request([singleSelect(3)]);
    expect(
      harnessInteractionObservation(event(interaction), observedAt),
    ).toMatchObject({
      schema: "agent-interaction-provider-observation.v1",
      status: "proven",
      evidence: "event-contract",
      observedVersion: "codex-cli 0.145.0",
      capabilities: {
        providerId: "harness_codex_cli",
        providerKind: "harness",
      },
    });
  });

  it("enforces provider bounds before trying presentation fallbacks", () => {
    const interaction = request([
      singleSelect(3),
      {
        questionId: "question_confirm_0001",
        kind: "confirm",
        prompt: "Confirm the mode",
        confirm: { optionId: "confirm_yes_0000001", label: "Yes" },
        decline: { optionId: "confirm_no_00000001", label: "No" },
      },
    ]);
    const transport = transportObservation();
    const bounded = InteractionProviderObservationV1Schema.parse({
      ...transport,
      capabilities: {
        ...transport.capabilities,
        limits: { ...transport.capabilities.limits, maxQuestions: 1 },
      },
    });
    expect(
      negotiateInteraction({
        request: interaction,
        event: event(interaction),
        transport: bounded,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      attempts: [
        {
          accepted: false,
          reason: "question count exceeds the transport capability",
        },
        {
          accepted: false,
          reason: "question count exceeds the transport capability",
        },
      ],
    });
  });

  it("dead-letters visibly instead of presenting an interaction on an unknown transport", async () => {
    class UnspecifiedTransport implements NotificationTransport {
      public readonly name = "unspecified";
      public deliveries = 0;

      public async deliver(
        _message: DeliveryMessage,
        _context: DeliveryContext,
      ): Promise<DeliveryReceipt> {
        this.deliveries += 1;
        return { transport: this.name, messageId: "unexpected" };
      }
    }

    const interaction = request([singleSelect(3)]);
    const input = event(interaction);
    const store = new RelayStore();
    const transport = new UnspecifiedTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(observedAt),
    });
    service.ingest(input);

    expect(await service.drain()).toMatchObject({
      claimed: 1,
      delivered: 0,
      deadLettered: 1,
    });
    expect(transport.deliveries).toBe(0);
    expect(store.getEvent(input.eventId)).toMatchObject({
      status: "dead_letter",
    });
    expect(store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "interaction.transport-capabilities-unavailable",
        }),
      ]),
    );
    store.close();
  });

  it("dead-letters and diagnoses a malformed capability record", async () => {
    class MalformedTransport implements NotificationTransport {
      public readonly name = "malformed";
      public deliveries = 0;

      public observeInteractionCapabilities(): InteractionProviderObservationV1 {
        return {
          schema: "not-a-provider-observation",
        } as unknown as InteractionProviderObservationV1;
      }

      public async deliver(): Promise<DeliveryReceipt> {
        this.deliveries += 1;
        return { transport: this.name, messageId: "unexpected" };
      }
    }

    const interaction = request([singleSelect(3)]);
    const input = event(interaction);
    const store = new RelayStore();
    const transport = new MalformedTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(observedAt),
    });
    service.ingest(input);

    expect(await service.drain()).toMatchObject({ deadLettered: 1 });
    expect(transport.deliveries).toBe(0);
    expect(store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "interaction.capability-record-invalid",
        }),
      ]),
    );
    store.close();
  });

  it("does not present legacy continuation input when the harness cannot resume", async () => {
    const interaction = request([singleSelect(3)]);
    const structured = event(interaction, {
      inlineContinue: false,
      lateResume: false,
      activeSteer: false,
      permissionDecision: false,
    });
    const input: AgentAttentionEventV1 = {
      ...structured,
      type: "turn.stopped",
      request: {
        correlationId: "continuation_unsupported_0001",
        kind: "continuation",
        question: "What should the agent do next?",
        expiresAt: structured.request!.expiresAt,
      },
    };
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(observedAt),
    });
    service.ingest(input);

    expect(await service.drain()).toMatchObject({ deadLettered: 1 });
    expect(transport.deliveries).toHaveLength(0);
    expect(store.listDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "interaction.harness-continuation-unsupported",
        }),
      ]),
    );
    store.close();
  });
});
