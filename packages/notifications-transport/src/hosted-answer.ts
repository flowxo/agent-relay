import type { InteractionEvent } from "@flowxo/notifications-contracts";
import type {
  Harness,
  OperatorInteractionRequestV1,
} from "@agent-relay/protocol";

export interface LocalHostedRequest {
  correlationId: string;
  eventId: string;
  machineId: string;
  harness: Harness;
  sessionId: string;
  turnId?: string;
  state: "open" | "answered" | "expired" | "cancelled" | "failed";
  requestKind:
    | "confirm"
    | "select"
    | "multi-select"
    | "question-set"
    | "input"
    | "permission"
    | "continuation";
  expiresAt: string;
  options: ReadonlyArray<{
    token: string;
    optionId: string;
    label: string;
  }>;
}

export interface ExpectedHostedRequestIdentity {
  correlationId: string;
  eventId: string;
  hostedMessageId: string;
  hostedInteractionId: string;
  machineId: string;
  harness: Harness;
  sessionId: string;
  turnId?: string;
  interactionType: "confirm" | "select" | "input";
  expiresAt: string;
  bindingId?: string;
  structuredRequest?: OperatorInteractionRequestV1;
}

export interface HostedStreamProof {
  authenticatedMachineId: string;
  configuredMachineId: string;
  schemaValidated: boolean;
  responseContractVerified: boolean;
  streamIdentityVerified: boolean;
}

export interface HostedResolutionInput {
  correlationId: string;
  answer: string;
  resolvedBy: "notifications";
  now: string;
  expected: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    turnId?: string;
  };
}

export type HostedAnswerValidation =
  | {
      outcome: "ready";
      acknowledgement: "processed";
      resolution: HostedResolutionInput;
    }
  | {
      outcome: "duplicate";
      acknowledgement: "processed";
      reasonCode: "already_resolved";
    }
  | {
      outcome: "terminal";
      acknowledgement: "processed";
      reasonCode: "locally_cancelled" | "locally_expired";
    }
  | {
      outcome: "quarantine";
      acknowledgement: "quarantined";
      reasonCode:
        | "answer_after_expiry"
        | "answer_kind_mismatch"
        | "invalid_answer"
        | "invalid_option"
        | "local_request_failed";
    }
  | {
      outcome: "stop";
      acknowledgement: "none";
      reasonCode:
        | "authentication_identity_mismatch"
        | "correlation_mismatch"
        | "local_identity_mismatch"
        | "request_not_found"
        | "contract_integrity_failure"
        | "schema_integrity_failure"
        | "stream_identity_failure";
    };

function sameOptional(left: string | undefined, right: string | undefined) {
  return left === right;
}

function localInteractionType(
  local: LocalHostedRequest,
  expected: ExpectedHostedRequestIdentity,
): "confirm" | "select" | "input" | undefined {
  if (local.requestKind === "confirm") {
    return "confirm";
  }
  if (local.requestKind === "select" || local.requestKind === "permission") {
    return "select";
  }
  if (local.requestKind === "input" || local.requestKind === "continuation") {
    return "input";
  }
  if (
    local.requestKind !== "question-set" ||
    expected.structuredRequest?.requestId !== local.correlationId ||
    Date.parse(expected.structuredRequest.expiresAt) !==
      Date.parse(local.expiresAt) ||
    expected.structuredRequest.questions.length !== 1
  ) {
    return undefined;
  }
  const question = expected.structuredRequest.questions[0];
  if (question?.kind === "confirm") {
    return "confirm";
  }
  if (question?.kind === "single-select") {
    return "select";
  }
  return question?.kind === "free-text" ? "input" : undefined;
}

function stableStructuredAnswer(
  event: InteractionEvent,
  request: OperatorInteractionRequestV1,
  answer: string,
): string | undefined {
  const question = request.questions[0];
  if (request.questions.length !== 1 || question === undefined) {
    return undefined;
  }
  if (
    (question.kind === "confirm" &&
      answer !== question.confirm.optionId &&
      answer !== question.decline.optionId) ||
    (question.kind === "single-select" &&
      !question.options.some((option) => option.optionId === answer)) ||
    (question.kind === "free-text" &&
      (answer.length < question.minLength ||
        answer.length > question.maxLength ||
        (!question.multiline && /[\r\n]/u.test(answer))))
  ) {
    return undefined;
  }
  const item =
    question.kind === "confirm"
      ? {
          questionId: question.questionId,
          kind: "confirm" as const,
          optionId: answer,
        }
      : question.kind === "single-select"
        ? {
            questionId: question.questionId,
            kind: "single-select" as const,
            optionId: answer,
          }
        : question.kind === "free-text"
          ? {
              questionId: question.questionId,
              kind: "free-text" as const,
              text: answer,
            }
          : undefined;
  if (item === undefined) {
    return undefined;
  }
  return JSON.stringify({
    schema: "agent-interaction-answer.v1",
    answerId: event.id,
    requestId: request.requestId,
    submittedAt: event.occurred_at,
    answers: [item],
  });
}

function answerFor(
  event: InteractionEvent,
  local: LocalHostedRequest,
  expected: ExpectedHostedRequestIdentity,
): string | undefined {
  let answer: string | undefined;
  if (event.response.type === "confirm") {
    const option = local.options[event.response.value ? 0 : 1];
    answer = option?.optionId;
  } else if (event.response.type === "select") {
    answer = local.options.find(
      (option) => option.token === event.response.value,
    )?.optionId;
  } else {
    const normalized = event.response.value.trim();
    answer =
      normalized.length > 0 && normalized.length <= 4_000
        ? normalized
        : undefined;
  }
  if (answer === undefined) {
    return undefined;
  }
  return expected.structuredRequest === undefined
    ? answer
    : stableStructuredAnswer(event, expected.structuredRequest, answer);
}

export function validateHostedAnswer(input: {
  event: InteractionEvent;
  localRequest?: LocalHostedRequest;
  expected: ExpectedHostedRequestIdentity;
  stream: HostedStreamProof;
}): HostedAnswerValidation {
  if (!input.stream.schemaValidated) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "schema_integrity_failure",
    };
  }
  if (!input.stream.responseContractVerified) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "contract_integrity_failure",
    };
  }
  if (
    input.stream.authenticatedMachineId !== input.stream.configuredMachineId
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "authentication_identity_mismatch",
    };
  }
  if (
    !input.stream.streamIdentityVerified ||
    input.expected.machineId !== input.stream.configuredMachineId ||
    (input.expected.bindingId !== undefined &&
      input.event.channel_context.binding_id !== input.expected.bindingId)
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "stream_identity_failure",
    };
  }
  const local = input.localRequest;
  if (local === undefined) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "request_not_found",
    };
  }
  if (
    input.event.correlation_id !== input.expected.correlationId ||
    local.correlationId !== input.expected.correlationId ||
    input.event.message_id !== input.expected.hostedMessageId ||
    input.event.interaction_id !== input.expected.hostedInteractionId
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "correlation_mismatch",
    };
  }
  if (
    local.eventId !== input.expected.eventId ||
    local.machineId !== input.expected.machineId ||
    local.harness !== input.expected.harness ||
    local.sessionId !== input.expected.sessionId ||
    !sameOptional(local.turnId, input.expected.turnId)
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "local_identity_mismatch",
    };
  }
  const compatibleType = localInteractionType(local, input.expected);
  if (
    compatibleType === undefined ||
    compatibleType !== input.expected.interactionType
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "local_identity_mismatch",
    };
  }
  if (local.state === "answered") {
    return {
      outcome: "duplicate",
      acknowledgement: "processed",
      reasonCode: "already_resolved",
    };
  }
  if (local.state === "expired" || local.state === "cancelled") {
    return {
      outcome: "terminal",
      acknowledgement: "processed",
      reasonCode:
        local.state === "expired" ? "locally_expired" : "locally_cancelled",
    };
  }
  if (local.state === "failed") {
    return {
      outcome: "quarantine",
      acknowledgement: "quarantined",
      reasonCode: "local_request_failed",
    };
  }
  const occurredAt = Date.parse(input.event.occurred_at);
  const eventExpiresAt = Date.parse(input.event.expires_at);
  const expectedExpiresAt = Date.parse(input.expected.expiresAt);
  const localExpiresAt = Date.parse(local.expiresAt);
  if (
    !Number.isFinite(occurredAt) ||
    !Number.isFinite(eventExpiresAt) ||
    !Number.isFinite(expectedExpiresAt) ||
    !Number.isFinite(localExpiresAt)
  ) {
    return {
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "schema_integrity_failure",
    };
  }
  if (
    eventExpiresAt !== expectedExpiresAt ||
    localExpiresAt !== expectedExpiresAt ||
    occurredAt >= expectedExpiresAt
  ) {
    return {
      outcome: "quarantine",
      acknowledgement: "quarantined",
      reasonCode: "answer_after_expiry",
    };
  }
  if (input.event.response.type !== input.expected.interactionType) {
    return {
      outcome: "quarantine",
      acknowledgement: "quarantined",
      reasonCode: "answer_kind_mismatch",
    };
  }
  const answer = answerFor(input.event, local, input.expected);
  if (answer === undefined) {
    return {
      outcome: "quarantine",
      acknowledgement: "quarantined",
      reasonCode:
        input.event.response.type === "select" ||
        input.event.response.type === "confirm"
          ? "invalid_option"
          : "invalid_answer",
    };
  }
  return {
    outcome: "ready",
    acknowledgement: "processed",
    resolution: {
      correlationId: local.correlationId,
      answer,
      resolvedBy: "notifications",
      now: new Date(occurredAt).toISOString(),
      expected: {
        machineId: local.machineId,
        harness: local.harness,
        sessionId: local.sessionId,
        ...(local.turnId === undefined ? {} : { turnId: local.turnId }),
      },
    },
  };
}
