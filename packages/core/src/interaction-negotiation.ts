import { Buffer } from "node:buffer";

import {
  InteractionProviderObservationV1Schema,
  MAX_INTERACTION_OPTIONS,
  MAX_INTERACTION_QUESTIONS,
  MAX_INTERACTION_REQUEST_BYTES,
  MAX_INTERACTION_TEXT_LENGTH,
  type AgentAttentionEventV1,
  type InteractionFeature,
  type InteractionPresentationMode,
  type InteractionProviderObservationV1,
  type OperatorInteractionRequestV1,
} from "@agent-relay/protocol";

export const COMPACT_BUTTON_OPTION_LIMIT = 10;

export interface InteractionNegotiationAttempt {
  mode: InteractionPresentationMode;
  accepted: boolean;
  reason?: string;
}

export type InteractionNegotiationResult =
  | {
      outcome: "selected";
      mode: InteractionPresentationMode;
      transportProviderId: string;
      harnessProviderId: string;
      requiredFeatures: InteractionFeature[];
      attempts: InteractionNegotiationAttempt[];
    }
  | {
      outcome: "unsupported";
      code:
        | "harness-continuation-unsupported"
        | "harness-permission-unsupported"
        | "transport-capabilities-unavailable"
        | "interaction-capabilities-unproven"
        | "provider-kind-mismatch"
        | "harness-feature-unavailable"
        | "interaction-mode-unavailable";
      requiredFeatures: InteractionFeature[];
      attempts: InteractionNegotiationAttempt[];
      reason: string;
    };

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function requiredInteractionFeatures(
  request: OperatorInteractionRequestV1,
): InteractionFeature[] {
  return unique([
    ...request.questions.map((question) => question.kind),
    ...(request.questions.length > 1
      ? (["ordered-question-set"] as const)
      : []),
    "durable-drafts",
    "message-updates",
  ]);
}

function questionOptionCount(
  question: OperatorInteractionRequestV1["questions"][number],
): number {
  if (question.kind === "confirm") {
    return 2;
  }
  return question.kind === "free-text" ? 0 : question.options.length;
}

function modeReason(
  request: OperatorInteractionRequestV1,
  mode: InteractionPresentationMode,
): string | undefined {
  if (mode === "web-handoff") {
    return "local web handoff is not implemented in the Phase 2 relay";
  }
  if (mode === "direct-text") {
    if (!request.questions.some((question) => question.kind === "free-text")) {
      return "direct text requires at least one free-text question";
    }
    const oversizedHybridQuestion = request.questions.find(
      (question) =>
        question.kind === "single-select" &&
        question.options.length > COMPACT_BUTTON_OPTION_LIMIT,
    );
    return oversizedHybridQuestion === undefined
      ? undefined
      : `question ${oversizedHybridQuestion.questionId} exceeds the compact hybrid button budget`;
  }
  if (mode === "numbered-text") {
    return request.questions.every(
      (question) =>
        question.kind === "confirm" || question.kind === "single-select",
    )
      ? undefined
      : "numbered text only supports confirm and single-select questions";
  }
  const oversizedButtonQuestion = request.questions.find(
    (question) =>
      question.kind === "single-select" &&
      questionOptionCount(question) > COMPACT_BUTTON_OPTION_LIMIT,
  );
  return oversizedButtonQuestion === undefined
    ? undefined
    : `question ${oversizedButtonQuestion.questionId} exceeds the compact button budget`;
}

function providerLimitReason(
  request: OperatorInteractionRequestV1,
  provider: InteractionProviderObservationV1,
): string | undefined {
  const limits = provider.capabilities.limits;
  if (request.questions.length > limits.maxQuestions) {
    return "question count exceeds the transport capability";
  }
  if (
    request.questions.some(
      (question) =>
        questionOptionCount(question) > limits.maxOptionsPerQuestion,
    )
  ) {
    return "option count exceeds the transport capability";
  }
  if (
    request.questions.some(
      (question) =>
        question.kind === "free-text" &&
        question.maxLength > limits.maxTextLength,
    )
  ) {
    return "free-text bound exceeds the transport capability";
  }
  if (
    Buffer.byteLength(JSON.stringify(request), "utf8") > limits.maxPayloadBytes
  ) {
    return "serialized request exceeds the transport capability";
  }
  return undefined;
}

export function harnessInteractionObservation(
  event: AgentAttentionEventV1,
  observedAt: string,
): InteractionProviderObservationV1 {
  const canContinue =
    event.capabilities.inlineContinue || event.capabilities.lateResume;
  const features: InteractionFeature[] = canContinue
    ? [
        "confirm",
        "single-select",
        "multi-select",
        "free-text",
        "ordered-question-set",
        "durable-drafts",
        "message-updates",
      ]
    : [];
  return InteractionProviderObservationV1Schema.parse({
    schema: "agent-interaction-provider-observation.v1",
    capabilities: {
      schema: "agent-interaction-capabilities.v1",
      providerId: `harness_${event.harness}_${event.surface}`,
      providerKind: "harness",
      observedAt,
      features,
      presentationModes: [],
      limits: {
        maxQuestions: MAX_INTERACTION_QUESTIONS,
        maxOptionsPerQuestion: MAX_INTERACTION_OPTIONS,
        maxTextLength: MAX_INTERACTION_TEXT_LENGTH,
        maxPayloadBytes: MAX_INTERACTION_REQUEST_BYTES,
      },
    },
    status: "proven",
    evidence: "event-contract",
    observedVersion: event.harnessVersion,
    fixture: `packages/harnesses/fixtures/${event.harness}/stop.json`,
    note: "The validated attention event records the adapter's continuation capability; exact surface evidence remains version-scoped.",
  });
}

export function negotiateInteraction(input: {
  request: OperatorInteractionRequestV1;
  event: AgentAttentionEventV1;
  transport?: InteractionProviderObservationV1;
  harness?: InteractionProviderObservationV1;
}): InteractionNegotiationResult {
  const requiredFeatures = requiredInteractionFeatures(input.request);
  const harness =
    input.harness ??
    harnessInteractionObservation(input.event, input.event.occurredAt);
  if (
    !input.event.capabilities.inlineContinue &&
    !input.event.capabilities.lateResume
  ) {
    return {
      outcome: "unsupported",
      code: "harness-continuation-unsupported",
      requiredFeatures,
      attempts: [],
      reason: `${input.event.harness}/${input.event.surface} cannot continue this session after an answer`,
    };
  }
  if (
    input.event.type === "permission.required" &&
    !input.event.capabilities.permissionDecision
  ) {
    return {
      outcome: "unsupported",
      code: "harness-permission-unsupported",
      requiredFeatures,
      attempts: [],
      reason: `${input.event.harness}/${input.event.surface} cannot apply a permission decision`,
    };
  }
  if (input.transport === undefined) {
    return {
      outcome: "unsupported",
      code: "transport-capabilities-unavailable",
      requiredFeatures,
      attempts: [],
      reason:
        "the notification transport did not provide a typed capability record",
    };
  }
  if (
    input.transport.capabilities.providerKind !== "transport" ||
    harness.capabilities.providerKind !== "harness"
  ) {
    return {
      outcome: "unsupported",
      code: "provider-kind-mismatch",
      requiredFeatures,
      attempts: [],
      reason:
        "interaction capability records were supplied for the wrong provider kind",
    };
  }
  if (input.transport.status !== "proven" || harness.status !== "proven") {
    return {
      outcome: "unsupported",
      code: "interaction-capabilities-unproven",
      requiredFeatures,
      attempts: [],
      reason: "assumed provider capabilities cannot activate an interaction",
    };
  }
  const missingHarnessFeature = requiredFeatures.find(
    (feature) => !harness.capabilities.features.includes(feature),
  );
  if (missingHarnessFeature !== undefined) {
    return {
      outcome: "unsupported",
      code: "harness-feature-unavailable",
      requiredFeatures,
      attempts: [],
      reason: `harness does not advertise ${missingHarnessFeature}`,
    };
  }

  const modes =
    input.request.fallback.whenUnavailable === "reject"
      ? [input.request.fallback.preferredMode]
      : [
          input.request.fallback.preferredMode,
          ...input.request.fallback.alternativeModes,
        ];
  const missingFeature = requiredFeatures.find(
    (feature) => !input.transport!.capabilities.features.includes(feature),
  );
  const limitReason = providerLimitReason(input.request, input.transport);
  const attempts: InteractionNegotiationAttempt[] = [];
  for (const mode of modes) {
    const reason =
      missingFeature === undefined
        ? (limitReason ??
          (!input.transport.capabilities.presentationModes.includes(mode)
            ? `transport does not advertise ${mode}`
            : modeReason(input.request, mode)))
        : `transport does not advertise ${missingFeature}`;
    attempts.push({
      mode,
      accepted: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    });
    if (reason === undefined) {
      return {
        outcome: "selected",
        mode,
        transportProviderId: input.transport.capabilities.providerId,
        harnessProviderId: harness.capabilities.providerId,
        requiredFeatures,
        attempts,
      };
    }
  }
  return {
    outcome: "unsupported",
    code: "interaction-mode-unavailable",
    requiredFeatures,
    attempts,
    reason:
      attempts
        .map((attempt) => `${attempt.mode}: ${attempt.reason}`)
        .join("; ") || "no presentation mode was offered",
  };
}
