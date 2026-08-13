import { z } from "zod";

import {
  InteractionQuestionSchema,
  MAX_INTERACTION_QUESTIONS,
  OperatorInteractionAnswerV1Schema,
  OperatorInteractionRequestV1Schema,
} from "./interaction.js";

export const RELAY_MCP_PROTOCOL_VERSION = "2025-11-25";
export const RELAY_MCP_SURFACE_VERSION = "agent-relay-mcp.v1";
export const RELAY_MCP_MAX_WAIT_MS = 120_000;
export const RELAY_MCP_MIN_EXPIRY_MS = 60_000;
export const RELAY_MCP_MAX_EXPIRY_MS = 7 * 24 * 60 * 60_000;

const mcpOpaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must be an opaque identifier without whitespace",
  );

const interactionTiming = {
  expiresInMs: z
    .number()
    .int()
    .min(RELAY_MCP_MIN_EXPIRY_MS)
    .max(RELAY_MCP_MAX_EXPIRY_MS),
  waitTimeoutMs: z.number().int().min(0).max(RELAY_MCP_MAX_WAIT_MS),
};

function validateDurableInteraction(
  input: { requestId: string; title: string; questions: unknown[] },
  context: z.RefinementCtx,
): void {
  const result = OperatorInteractionRequestV1Schema.safeParse({
    schema: "agent-interaction-request.v1",
    requestId: input.requestId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
    title: input.title,
    lifecycle: "pending",
    questions: input.questions,
    fallback: {
      preferredMode: "buttons",
      alternativeModes: ["numbered-text", "web-handoff"],
      whenUnavailable: "use-alternative",
    },
  });
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
  }
}

export const RelayMcpAskV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-ask.v1"),
    requestId: mcpOpaqueId,
    title: z.string().trim().min(1).max(120),
    question: InteractionQuestionSchema,
    ...interactionTiming,
  })
  .strict()
  .superRefine((ask, context) => {
    validateDurableInteraction(
      {
        requestId: ask.requestId,
        title: ask.title,
        questions: [ask.question],
      },
      context,
    );
  });

export const RelayMcpQuestionnaireV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-questionnaire.v1"),
    requestId: mcpOpaqueId,
    title: z.string().trim().min(1).max(120),
    questions: z
      .array(InteractionQuestionSchema)
      .min(2)
      .max(MAX_INTERACTION_QUESTIONS),
    ...interactionTiming,
  })
  .strict()
  .superRefine((questionnaire, context) => {
    const questionIds = questionnaire.questions.map(
      (question) => question.questionId,
    );
    if (new Set(questionIds).size !== questionIds.length) {
      context.addIssue({
        code: "custom",
        message: "question IDs must be unique",
        path: ["questions"],
      });
    }
    validateDurableInteraction(questionnaire, context);
  });

export const RelayMcpCancelV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-cancel.v1"),
    requestId: mcpOpaqueId,
  })
  .strict();

export const RelayMcpStatusV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-status.v1"),
    requestId: mcpOpaqueId.optional(),
  })
  .strict();

export const RelayMcpBindingStateSchema = z.enum([
  "pending",
  "bound",
  "ambiguous",
  "ended",
  "revoked",
]);

export const RelayMcpRequestStateSchema = z.enum([
  "open",
  "answered",
  "expired",
  "cancelled",
  "failed",
]);

export const RelayMcpActivityStateSchema = z.enum([
  "working",
  "needs_input",
  "background_work",
  "idle",
  "done",
  "failed",
  "unknown",
  "ended",
]);

export const RelayMcpAnsweredV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-result.v1"),
    outcome: z.literal("answered"),
    requestId: mcpOpaqueId,
    answer: OperatorInteractionAnswerV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.answer.requestId !== result.requestId) {
      context.addIssue({
        code: "custom",
        message: "answer request ID must match the result request ID",
        path: ["answer", "requestId"],
      });
    }
  });

export const RelayMcpCanceledV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-result.v1"),
    outcome: z.literal("canceled"),
    requestId: mcpOpaqueId,
    requestState: z.literal("cancelled"),
  })
  .strict();

export const RelayMcpStatusResultV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-result.v1"),
    outcome: z.literal("status"),
    bindingState: RelayMcpBindingStateSchema,
    harness: z.enum(["codex", "claude", "cursor"]).optional(),
    activityState: RelayMcpActivityStateSchema.optional(),
    openRequestCount: z.number().int().min(0).max(1_000).optional(),
    delivery: z.enum(["available", "degraded", "unavailable"]),
    requestId: mcpOpaqueId.optional(),
    requestState: RelayMcpRequestStateSchema.optional(),
    answer: OperatorInteractionAnswerV1Schema.optional(),
  })
  .strict()
  .superRefine((status, context) => {
    if (
      status.answer !== undefined &&
      (status.requestId === undefined || status.requestState !== "answered")
    ) {
      context.addIssue({
        code: "custom",
        message: "an answer requires one exact answered request",
        path: ["answer"],
      });
    }
    if (
      status.answer !== undefined &&
      status.answer.requestId !== status.requestId
    ) {
      context.addIssue({
        code: "custom",
        message: "answer request ID must match the status request ID",
        path: ["answer", "requestId"],
      });
    }
  });

export const RelayMcpErrorCodeSchema = z.enum([
  "binding-missing",
  "binding-pending",
  "binding-ambiguous",
  "binding-ended",
  "binding-revoked",
  "daemon-unavailable",
  "delivery-unavailable",
  "invalid-input",
  "session-unavailable",
  "request-conflict",
  "request-not-found",
  "request-not-owned",
  "answer-timeout",
  "request-expired",
  "request-canceled",
  "request-failed",
  "internal-error",
]);

export const RelayMcpErrorV1Schema = z
  .object({
    schema: z.literal("agent-relay-mcp-error.v1"),
    code: RelayMcpErrorCodeSchema,
    retryable: z.boolean(),
    localFallback: z.literal(
      "Ask the operator locally with the harness's native question mechanism.",
    ),
    requestId: mcpOpaqueId.optional(),
    requestState: RelayMcpRequestStateSchema.optional(),
  })
  .strict();

export const RelayMcpToolResultV1Schema = z.union([
  RelayMcpAnsweredV1Schema,
  RelayMcpCanceledV1Schema,
  RelayMcpStatusResultV1Schema,
  RelayMcpErrorV1Schema,
]);

export type RelayMcpAskV1 = z.infer<typeof RelayMcpAskV1Schema>;
export type RelayMcpQuestionnaireV1 = z.infer<
  typeof RelayMcpQuestionnaireV1Schema
>;
export type RelayMcpCancelV1 = z.infer<typeof RelayMcpCancelV1Schema>;
export type RelayMcpStatusV1 = z.infer<typeof RelayMcpStatusV1Schema>;
export type RelayMcpBindingState = z.infer<typeof RelayMcpBindingStateSchema>;
export type RelayMcpRequestState = z.infer<typeof RelayMcpRequestStateSchema>;
export type RelayMcpErrorCode = z.infer<typeof RelayMcpErrorCodeSchema>;
export type RelayMcpToolResultV1 = z.infer<typeof RelayMcpToolResultV1Schema>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
}

export const RELAY_MCP_TOOL_DEFINITIONS = [
  {
    name: "relay_ask",
    title: "Ask the operator",
    description:
      "Ask one typed, operator-mediated product or workflow question through Agent Relay and wait for a bounded answer. Use this when remote human input is useful. Never use it for permission, privilege, credential, or security approval; keep those on the harness's native approval path. If Relay reports an error, use the local fallback it returns.",
    inputSchema: jsonSchema(RelayMcpAskV1Schema),
    outputSchema: jsonSchema(
      z.union([RelayMcpAnsweredV1Schema, RelayMcpErrorV1Schema]),
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "relay_ask_many",
    title: "Ask an operator questionnaire",
    description:
      "Ask a small ordered set of typed, operator-mediated product or workflow questions through Agent Relay and wait for one bounded structured answer. Do not use it for permission, privilege, credential, or security approval. If Relay reports an error, use the harness's native local question mechanism.",
    inputSchema: jsonSchema(RelayMcpQuestionnaireV1Schema),
    outputSchema: jsonSchema(
      z.union([RelayMcpAnsweredV1Schema, RelayMcpErrorV1Schema]),
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "relay_cancel",
    title: "Cancel a Relay question",
    description:
      "Cancel one exact outstanding Relay request created by this native session. Cancellation is durable and first-writer-wins with operator answers.",
    inputSchema: jsonSchema(RelayMcpCancelV1Schema),
    outputSchema: jsonSchema(
      z.union([RelayMcpCanceledV1Schema, RelayMcpErrorV1Schema]),
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "relay_status",
    title: "Inspect Relay readiness",
    description:
      "Read the safe binding, activity, delivery, and optional exact-request state for this native session. When an exact request ID has a retained answer, the typed answer is returned. The result contains no transcript, prompt, path, credential, or provider identifier.",
    inputSchema: jsonSchema(RelayMcpStatusV1Schema),
    outputSchema: jsonSchema(
      z.union([RelayMcpStatusResultV1Schema, RelayMcpErrorV1Schema]),
    ),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;
