import { z } from "zod";

const opaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.iso.datetime({ offset: true });

export const WebSupportedActionSchema = z.enum([
  "respond-text",
  "choose-option",
]);

export const WebOptionV1Schema = z
  .object({
    optionId: opaqueId,
    label: z.string().min(1).max(120),
  })
  .strict();

export const WebSessionSummaryV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-session.v1"),
    sessionKey: z.string().length(24),
    harness: z.enum(["codex", "claude", "cursor"]),
    surface: z.enum(["cli", "ide", "sdk", "app-server"]),
    repository: z.string().min(1).max(120),
    branch: z.string().min(1).max(240).optional(),
    state: z.enum([
      "active",
      "waiting",
      "stopped",
      "suspected_stalled",
      "exited",
    ]),
    lastEventType: z.string().min(1).max(80).optional(),
    lastSeenAt: timestamp,
    attentionCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export const WebAttentionItemV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-attention.v1"),
    requestId: opaqueId,
    eventId: opaqueId,
    sessionKey: z.string().length(24),
    harness: z.enum(["codex", "claude", "cursor"]),
    requestKind: z.enum([
      "confirm",
      "select",
      "multi-select",
      "question-set",
      "input",
      "permission",
      "continuation",
    ]),
    state: z.literal("open"),
    promptPreview: z.string().max(240),
    expiresAt: timestamp,
    supportedActions: z.array(WebSupportedActionSchema).max(2),
    options: z.array(WebOptionV1Schema).max(20),
  })
  .strict();

export const WebEventDetailV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-event.v1"),
    eventId: opaqueId,
    occurredAt: timestamp,
    harness: z.enum(["codex", "claude", "cursor"]),
    surface: z.enum(["cli", "ide", "sdk", "app-server"]),
    harnessVersion: z.string().min(1).max(120),
    sessionKey: z.string().length(24),
    type: z.string().min(1).max(80),
    deliveryStatus: z.enum([
      "queued",
      "retry",
      "delivering",
      "delivered",
      "dead_letter",
    ]),
    repository: z.string().min(1).max(120),
    branch: z.string().min(1).max(240).optional(),
    summary: z.string().max(1_000).optional(),
    failure: z
      .object({
        code: z.string().min(1).max(120),
        message: z.string().max(500),
      })
      .strict()
      .optional(),
    request: z
      .object({
        requestId: opaqueId,
        kind: z.string().min(1).max(80),
        state: z.enum(["open", "answered", "expired", "cancelled", "failed"]),
        promptPreview: z.string().max(240),
        expiresAt: timestamp,
        supportedActions: z.array(WebSupportedActionSchema).max(2),
        options: z.array(WebOptionV1Schema).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WebResolveRequestV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-resolve.v1"),
    operationId: opaqueId,
    answer: z.string().min(1).max(4_000),
  })
  .strict();

export const WebChangeV1Schema = z
  .object({
    cursor: z.number().int().positive(),
    kind: z.enum([
      "session",
      "event",
      "request",
      "diagnostic",
      "session-control",
    ]),
    action: z.enum(["insert", "update", "delete"]),
    entityId: opaqueId,
    occurredAt: timestamp,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WebSupportedAction = z.infer<typeof WebSupportedActionSchema>;
export type WebOptionV1 = z.infer<typeof WebOptionV1Schema>;
export type WebSessionSummaryV1 = z.infer<typeof WebSessionSummaryV1Schema>;
export type WebAttentionItemV1 = z.infer<typeof WebAttentionItemV1Schema>;
export type WebEventDetailV1 = z.infer<typeof WebEventDetailV1Schema>;
export type WebResolveRequestV1 = z.infer<typeof WebResolveRequestV1Schema>;
export type WebChangeV1 = z.infer<typeof WebChangeV1Schema>;
