import { z } from "zod";

import {
  InteractionQuestionAnswerSchema,
  InteractionQuestionSchema,
} from "@agent-relay/protocol";
import {
  SESSION_ACTIVITY_FIXTURE_SET_VERSION,
  SESSION_ACTIVITY_POLICY_VERSION,
  SESSION_ACTIVITY_SCHEMA,
  SessionActivityConfidenceSchema,
  SessionActivityReasonSchema,
  SessionActivitySourceSchema,
  SessionActivityStateSchema,
} from "@agent-relay/core";

export const WEB_API_VERSION = "3";
export const WEB_ASSET_VERSION = "4";

const opaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.iso.datetime({ offset: true });

export const WebMetaV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-meta.v1"),
    apiVersion: z.literal(WEB_API_VERSION),
    assetVersion: z.literal(WEB_ASSET_VERSION),
    commandSchemas: z
      .array(
        z.enum([
          "agent-relay-web-resolve.v1",
          "agent-relay-web-session-action.v1",
        ]),
      )
      .length(2),
  })
  .strict();

export const WebSupportedActionSchema = z.enum([
  "continue",
  "respond-text",
  "choose-option",
  "choose-multiple",
  "answer-question-set",
]);

export const WebSessionActionSchema = z.enum([
  "continue",
  "details",
  "mute",
  "end",
]);

export const WebOptionV1Schema = z
  .object({
    optionId: opaqueId,
    label: z.string().min(1).max(120),
  })
  .strict();

export const WebSessionSummaryV2Schema = z
  .object({
    schema: z.literal("agent-relay-web-session.v2"),
    sessionKey: z.string().length(24),
    displayId: z.string().regex(/^[A-Za-z0-9_]{8}-[a-f0-9]{6}$/),
    harness: z.enum(["codex", "claude", "cursor"]),
    surface: z.enum(["cli", "ide", "sdk", "app-server"]),
    repository: z.string().min(1).max(120),
    branch: z.string().min(1).max(240).optional(),
    activity: z
      .object({
        schema: z.literal(SESSION_ACTIVITY_SCHEMA),
        policyVersion: z.literal(SESSION_ACTIVITY_POLICY_VERSION),
        fixtureSetVersion: z.literal(SESSION_ACTIVITY_FIXTURE_SET_VERSION),
        state: SessionActivityStateSchema,
        stateLabel: z.enum([
          "Working",
          "Needs input",
          "Background work",
          "Idle",
          "Done",
          "Failed",
          "Unknown",
          "Ended",
        ]),
        confidence: SessionActivityConfidenceSchema,
        reason: SessionActivityReasonSchema,
        reasonText: z.string().min(1).max(120),
        source: SessionActivitySourceSchema,
        lastObservedAt: timestamp,
        idleSince: timestamp.optional(),
        inFlightCount: z.number().int().nonnegative().max(1_000),
        requestCount: z.number().int().nonnegative().max(1_000),
        muted: z.boolean(),
        epoch: z.number().int().nonnegative(),
        lastAppliedSequence: z.number().int().nonnegative(),
      })
      .strict(),
    lifecycleState: z.enum([
      "active",
      "waiting",
      "stopped",
      "suspected_stalled",
      "exited",
    ]),
    lastEventType: z.string().min(1).max(80).optional(),
    lastSeenAt: timestamp,
    attentionCount: z.number().int().nonnegative().max(10_000),
    latestEventId: opaqueId.optional(),
    supportedActions: z.array(WebSessionActionSchema).max(4),
  })
  .strict();

const WebResponseFormV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      minLength: z.number().int().min(1).max(4_000),
      maxLength: z.number().int().min(1).max(4_000),
      multiline: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("single-select"),
      options: z.array(WebOptionV1Schema).min(2).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("multi-select"),
      options: z.array(WebOptionV1Schema).min(2).max(20),
      minSelections: z.number().int().min(0).max(20),
      maxSelections: z.number().int().min(1).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("question-set"),
      title: z.string().min(1).max(120),
      questions: z.array(InteractionQuestionSchema).min(1).max(10),
    })
    .strict(),
]);

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
    form: WebResponseFormV1Schema.optional(),
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
        form: WebResponseFormV1Schema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WebResolveRequestV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-resolve.v1"),
    operationId: opaqueId,
    sessionKey: z.string().length(24),
    response: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("text"),
          text: z.string().min(1).max(4_000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("option"),
          optionId: opaqueId,
        })
        .strict(),
      z
        .object({
          kind: z.literal("multi-select"),
          optionIds: z.array(opaqueId).max(20),
        })
        .strict(),
      z
        .object({
          kind: z.literal("question-set"),
          answers: z.array(InteractionQuestionAnswerSchema).min(1).max(10),
        })
        .strict(),
    ]),
  })
  .strict();

export const WebSessionActionV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-session-action.v1"),
    operationId: opaqueId,
    eventId: opaqueId,
    action: WebSessionActionSchema.exclude(["details"]),
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

export const WebTimelineEntryV1Schema = z
  .object({
    id: z.string().min(8).max(256),
    kind: z.enum([
      "hook-event",
      "delivery",
      "request",
      "operator-action",
      "continuation",
    ]),
    at: timestamp,
    status: z.string().min(1).max(120),
    label: z.string().min(1).max(120),
    eventId: opaqueId.optional(),
    correlationId: opaqueId.optional(),
    detailCode: z.string().min(1).max(120).optional(),
  })
  .strict();

export const WebEventRevealV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-event-reveal.v1"),
    eventId: opaqueId,
    notice: z.literal("explicit-private-content"),
    summary: z.string().max(2_000).optional(),
    assistantExcerpt: z.string().max(2_000).optional(),
    failure: z
      .object({
        code: z.string().min(1).max(120),
        message: z.string().max(1_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WebDiagnosticExportV1Schema = z
  .object({
    schema: z.literal("agent-relay-web-diagnostics.v1"),
    generatedAt: timestamp,
    sanitized: z.literal(true),
    retention: z
      .object({
        defaultDays: z.number().int().positive(),
        limit: z.number().int().positive().max(500),
      })
      .strict(),
    diagnostics: z
      .array(
        z
          .object({
            diagnosticId: opaqueId,
            recordedAt: timestamp,
            source: z.enum([
              "hook",
              "supervisor",
              "fallback-spool",
              "installer",
              "daemon",
            ]),
            level: z.enum(["info", "warn", "error"]),
            code: z.string().min(1).max(120),
            message: z.string().max(500),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type WebSupportedAction = z.infer<typeof WebSupportedActionSchema>;
export type WebSessionAction = z.infer<typeof WebSessionActionSchema>;
export type WebMetaV1 = z.infer<typeof WebMetaV1Schema>;
export type WebOptionV1 = z.infer<typeof WebOptionV1Schema>;
export type WebSessionSummaryV2 = z.infer<typeof WebSessionSummaryV2Schema>;
export type WebAttentionItemV1 = z.infer<typeof WebAttentionItemV1Schema>;
export type WebEventDetailV1 = z.infer<typeof WebEventDetailV1Schema>;
export type WebResolveRequestV1 = z.infer<typeof WebResolveRequestV1Schema>;
export type WebSessionActionV1 = z.infer<typeof WebSessionActionV1Schema>;
export type WebChangeV1 = z.infer<typeof WebChangeV1Schema>;
export type WebTimelineEntryV1 = z.infer<typeof WebTimelineEntryV1Schema>;
export type WebEventRevealV1 = z.infer<typeof WebEventRevealV1Schema>;
export type WebDiagnosticExportV1 = z.infer<typeof WebDiagnosticExportV1Schema>;
