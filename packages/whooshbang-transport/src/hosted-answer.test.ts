import { parseInteractionAnswer } from "@agent-relay/protocol";
import { describe, expect, it } from "vitest";

import { validateHostedAnswer } from "./hosted-answer.js";

import type {
  ExpectedHostedRequestIdentity,
  HostedStreamProof,
  LocalHostedRequest,
} from "./hosted-answer.js";
import type { InteractionEvent } from "@whooshbang/contracts";
import type { OperatorInteractionRequestV1 } from "@agent-relay/protocol";

const expiresAt = "2026-07-25T18:00:00.000Z";

const local: LocalHostedRequest = {
  correlationId: "request_select_12345678",
  eventId: "event_select_12345678",
  machineId: "machine_synthetic_a",
  harness: "codex",
  sessionId: "session_synthetic_12345678",
  turnId: "turn_synthetic_12345678",
  state: "open",
  requestKind: "select",
  expiresAt,
  options: [
    {
      token: "decision_alpha_12345678",
      optionId: "option_alpha_12345678",
      label: "Alpha",
    },
    {
      token: "decision_beta_12345678",
      optionId: "option_beta_12345678",
      label: "Beta",
    },
  ],
};

const expected: ExpectedHostedRequestIdentity = {
  correlationId: local.correlationId,
  eventId: local.eventId,
  hostedMessageId: "message_hosted_12345678",
  hostedInteractionId: "interaction_hosted_12345678",
  machineId: local.machineId,
  harness: local.harness,
  sessionId: local.sessionId,
  ...(local.turnId === undefined ? {} : { turnId: local.turnId }),
  interactionType: "select",
  expiresAt,
};

const stream: HostedStreamProof = {
  authenticatedMachineId: local.machineId,
  configuredMachineId: local.machineId,
  schemaValidated: true,
  responseContractVerified: true,
  streamIdentityVerified: true,
};

const event: InteractionEvent = {
  schema: "whooshbang.interaction-event.v1",
  id: "event_hosted_answer_12345678",
  cursor: "mcur_synthetic_12345678",
  type: "interaction.received",
  message_id: expected.hostedMessageId,
  interaction_id: expected.hostedInteractionId,
  correlation_id: expected.correlationId,
  response: { type: "select", value: "decision_beta_12345678" },
  channel_context: {
    binding_id: "binding_synthetic_12345678",
    channel: "telegram",
    conversation_kind: "private_chat",
  },
  occurred_at: "2026-07-25T17:50:00.000Z",
  expires_at: expiresAt,
};

describe("hosted answer validation", () => {
  it("produces a pure whooshbang resolution only after every identity check", () => {
    expect(
      validateHostedAnswer({ event, localRequest: local, expected, stream }),
    ).toEqual({
      outcome: "ready",
      acknowledgement: "processed",
      resolution: {
        correlationId: local.correlationId,
        answer: "option_beta_12345678",
        resolvedBy: "whooshbang",
        now: event.occurred_at,
        expected: {
          machineId: local.machineId,
          harness: local.harness,
          sessionId: local.sessionId,
          turnId: local.turnId,
        },
      },
    });
  });

  it("stops the stream when the authenticated channel binding changes", () => {
    expect(
      validateHostedAnswer({
        event: {
          ...event,
          channel_context: {
            ...event.channel_context,
            binding_id: "binding_foreign_12345678",
          },
        },
        localRequest: local,
        expected: {
          ...expected,
          bindingId: event.channel_context.binding_id,
        },
        stream,
      }),
    ).toEqual({
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "stream_identity_failure",
    });
  });

  it.each([
    ["confirm", true, "option_alpha_12345678"],
    ["confirm", false, "option_beta_12345678"],
    ["input", "continue safely", "continue safely"],
  ] as const)(
    "maps %s answers through local authority",
    (type, value, answer) => {
      const requestKind = type === "confirm" ? "confirm" : "input";
      const candidateLocal: LocalHostedRequest = {
        ...local,
        requestKind,
        options: type === "input" ? [] : local.options,
      };
      const result = validateHostedAnswer({
        event: {
          ...event,
          response:
            type === "confirm"
              ? { type, value: value as boolean }
              : { type, value: value as string },
        },
        localRequest: candidateLocal,
        expected: { ...expected, interactionType: type },
        stream,
      });
      expect(result).toMatchObject({
        outcome: "ready",
        resolution: { answer },
      });
    },
  );

  it("preserves a one-question agent-interaction.v1 answer envelope", () => {
    const structuredRequest: OperatorInteractionRequestV1 = {
      schema: "agent-interaction-request.v1",
      requestId: local.correlationId,
      createdAt: "2026-07-25T17:45:00.000Z",
      expiresAt,
      title: "Choose",
      lifecycle: "pending",
      questions: [
        {
          questionId: "question_select_12345678",
          kind: "single-select",
          prompt: "Choose one",
          options: [
            { optionId: "option_alpha_12345678", label: "Alpha" },
            { optionId: "option_beta_12345678", label: "Beta" },
          ],
        },
      ],
      fallback: {
        preferredMode: "buttons",
        alternativeModes: [],
        whenUnavailable: "reject",
      },
    };
    const result = validateHostedAnswer({
      event,
      localRequest: { ...local, requestKind: "question-set" },
      expected: { ...expected, structuredRequest },
      stream,
    });
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") {
      throw new Error("Expected a structured resolution.");
    }
    const parsed = parseInteractionAnswer(
      structuredRequest,
      JSON.parse(result.resolution.answer) as unknown,
    );
    expect(parsed.answer).toMatchObject({
      answerId: event.id,
      requestId: structuredRequest.requestId,
      submittedAt: event.occurred_at,
      answers: [
        {
          questionId: "question_select_12345678",
          kind: "single-select",
          optionId: "option_beta_12345678",
        },
      ],
    });
  });

  it.each([
    [
      "schema",
      { stream: { ...stream, schemaValidated: false } },
      "schema_integrity_failure",
    ],
    [
      "response contract",
      { stream: { ...stream, responseContractVerified: false } },
      "contract_integrity_failure",
    ],
    [
      "stream",
      { stream: { ...stream, streamIdentityVerified: false } },
      "stream_identity_failure",
    ],
    [
      "authenticated machine",
      {
        stream: {
          ...stream,
          authenticatedMachineId: "machine_synthetic_b",
        },
      },
      "authentication_identity_mismatch",
    ],
    [
      "message",
      { event: { ...event, message_id: "message_other_12345678" } },
      "correlation_mismatch",
    ],
    [
      "interaction",
      {
        event: {
          ...event,
          interaction_id: "interaction_other_12345678",
        },
      },
      "correlation_mismatch",
    ],
    [
      "session",
      { localRequest: { ...local, sessionId: "session_other_12345678" } },
      "local_identity_mismatch",
    ],
    [
      "turn",
      { localRequest: { ...local, turnId: "turn_other_12345678" } },
      "local_identity_mismatch",
    ],
  ] as const)(
    "stops without acknowledgement on %s mismatch",
    (_name, override, reasonCode) => {
      expect(
        validateHostedAnswer({
          event,
          localRequest: local,
          expected,
          stream,
          ...override,
        }),
      ).toEqual({
        outcome: "stop",
        acknowledgement: "none",
        reasonCode,
      });
    },
  );

  it("derives kind compatibility from the local request, not caller expectation", () => {
    expect(
      validateHostedAnswer({
        event,
        localRequest: { ...local, requestKind: "multi-select" },
        expected,
        stream,
      }),
    ).toEqual({
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "local_identity_mismatch",
    });
  });

  it("compares equivalent RFC 3339 offsets as instants", () => {
    const result = validateHostedAnswer({
      event: {
        ...event,
        occurred_at: "2026-07-25T12:50:00-05:00",
        expires_at: "2026-07-25T13:00:00-05:00",
      },
      localRequest: {
        ...local,
        expiresAt: "2026-07-25T13:00:00-05:00",
      },
      expected,
      stream,
    });
    expect(result).toMatchObject({ outcome: "ready" });
  });

  it.each([
    [
      "kind mismatch",
      { event: { ...event, response: { type: "input", value: "wrong" } } },
      "answer_kind_mismatch",
    ],
    [
      "unknown option",
      {
        event: {
          ...event,
          response: { type: "select", value: "decision_unknown_12345678" },
        },
      },
      "invalid_option",
    ],
    [
      "expired occurrence",
      { event: { ...event, occurred_at: expiresAt } },
      "answer_after_expiry",
    ],
  ] as const)(
    "returns a quarantine candidate for %s without mutating local state",
    (_name, override, reasonCode) => {
      const input = {
        event: override.event,
        localRequest: local,
        expected,
        stream,
      };
      expect(validateHostedAnswer(input)).toEqual({
        outcome: "quarantine",
        acknowledgement: "quarantined",
        reasonCode,
      });
      expect(local.state).toBe("open");
    },
  );

  it("proves an already durable terminal request as a harmless duplicate", () => {
    expect(
      validateHostedAnswer({
        event,
        localRequest: {
          ...local,
          state: "answered",
        },
        expected,
        stream,
      }),
    ).toEqual({
      outcome: "duplicate",
      acknowledgement: "processed",
      reasonCode: "already_resolved",
    });
  });

  it.each([
    ["expired", "terminal", "processed", "locally_expired"],
    ["cancelled", "terminal", "processed", "locally_cancelled"],
    ["failed", "quarantine", "quarantined", "local_request_failed"],
  ] as const)(
    "gives the durable %s state an explicit acknowledgement rationale",
    (state, outcome, acknowledgement, reasonCode) => {
      expect(
        validateHostedAnswer({
          event,
          localRequest: { ...local, state },
          expected,
          stream,
        }),
      ).toEqual({ outcome, acknowledgement, reasonCode });
    },
  );

  // WhooshBang closes a seven-day content window on the answer while keeping
  // the event, its cursor, and its references. The event is neither poison nor
  // a late answer, so it must acknowledge as processed and advance the cursor
  // instead of quarantining, and it must not resolve the local request.
  it("acknowledges an event whose answer content is gone without resolving it", () => {
    const { response: _pruned, ...contentWindowClosed } = event;
    expect(
      validateHostedAnswer({
        event: contentWindowClosed as unknown as typeof event,
        localRequest: local,
        expected,
        stream,
      }),
    ).toEqual({
      outcome: "terminal",
      acknowledgement: "processed",
      reasonCode: "answer_unavailable",
    });
    expect(local.state).toBe("open");
  });

  it("keeps every identity check ahead of a missing answer", () => {
    const { response: _pruned, ...contentWindowClosed } = event;
    expect(
      validateHostedAnswer({
        event: {
          ...contentWindowClosed,
          correlation_id: "request_other_12345678",
        } as unknown as typeof event,
        localRequest: local,
        expected,
        stream,
      }),
    ).toEqual({
      outcome: "stop",
      acknowledgement: "none",
      reasonCode: "correlation_mismatch",
    });
  });
});
