import {
  EventTypeSchema,
  HarnessSchema,
  InteractionPresentationModeSchema,
  SurfaceSchema,
} from "@agent-relay/protocol";
import { z } from "zod";

const identifier = z.string().min(1).max(512);
const boundedText = z.string().max(8_192);
const timestamp = z.iso.datetime({ offset: true });

const DeliveryChoiceSchema = z
  .object({
    value: identifier,
    label: z.string().min(1).max(240),
  })
  .strict();

const DeliveryInteractionSchema = z
  .object({
    type: z.enum(["confirm", "select", "input"]),
    correlationId: identifier,
    prompt: z.string().min(1).max(1_000),
    expiresAt: timestamp,
    options: z.array(DeliveryChoiceSchema).max(20).optional(),
  })
  .strict();

const DeliveryMultiSelectSchema = z
  .object({
    options: z
      .array(
        DeliveryChoiceSchema.extend({
          selected: z.boolean(),
        }).strict(),
      )
      .max(20),
    minSelections: z.number().int().nonnegative().max(20),
    maxSelections: z.number().int().positive().max(20),
    submitToken: identifier,
    cancelToken: identifier,
  })
  .strict();

const DeliveryQuestionSetSchema = z
  .object({
    requestId: identifier,
    questionId: identifier,
    kind: z.enum(["confirm", "single-select", "multi-select", "free-text"]),
    presentationMode: InteractionPresentationModeSchema,
    requestTitle: z.string().min(1).max(240),
    prompt: z.string().min(1).max(1_000),
    position: z.number().int().positive().max(20),
    total: z.number().int().positive().max(20),
    options: z
      .array(
        DeliveryChoiceSchema.extend({
          selected: z.boolean(),
        }).strict(),
      )
      .max(20),
    backToken: identifier.optional(),
    nextToken: identifier.optional(),
    submitToken: identifier,
    cancelToken: identifier,
    textInput: z
      .object({
        minLength: z.number().int().nonnegative().max(4_000),
        maxLength: z.number().int().positive().max(4_000),
        multiline: z.boolean(),
        hasDraft: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WebhookDeliveryMessageV1Schema = z
  .object({
    eventId: identifier,
    title: z.string().min(1).max(1_024),
    text: boundedText,
    interaction: DeliveryInteractionSchema.optional(),
    multiSelect: DeliveryMultiSelectSchema.optional(),
    questionSet: DeliveryQuestionSetSchema.optional(),
    actions: z
      .array(
        z
          .object({
            kind: z.enum(["continue", "details", "mute", "end"]),
            token: identifier,
            label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export const WebhookDeliverySourceV1Schema = z
  .object({
    occurredAt: timestamp,
    eventType: EventTypeSchema,
    harness: HarnessSchema,
    surface: SurfaceSchema,
    repository: z.string().min(1).max(120),
    branch: z.string().min(1).max(240).optional(),
    sessionKey: z.string().regex(/^[a-f0-9]{24}$/),
    shortSessionId: z.string().min(1).max(64),
  })
  .strict();

export const WebhookDeliveryHandoffV1Schema = z
  .object({
    mode: z.literal("local-web"),
    requestId: identifier,
    expiresAt: timestamp,
    url: z.url().max(2_048),
  })
  .strict();

export const WebhookDeliveryEnvelopeV1Schema = z
  .object({
    schema: z.literal("agent-relay-webhook.v1"),
    deliveryId: identifier,
    deliveryMode: z.enum(["notify", "silent"]).optional(),
    message: WebhookDeliveryMessageV1Schema,
    source: WebhookDeliverySourceV1Schema.optional(),
    handoff: WebhookDeliveryHandoffV1Schema.optional(),
  })
  .strict();

export type WebhookDeliveryEnvelopeV1 = z.infer<
  typeof WebhookDeliveryEnvelopeV1Schema
>;

export const WebhookDeliveryAckV1Schema = z
  .object({
    schema: z.literal("agent-relay-webhook-ack.v1"),
    deliveryId: identifier,
    messageId: identifier.optional(),
  })
  .strict();

export type WebhookDeliveryAckV1 = z.infer<typeof WebhookDeliveryAckV1Schema>;
