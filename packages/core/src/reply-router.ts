import { z } from "zod";

import { sha256 } from "@agent-relay/protocol";

import {
  parseCardActionCallbackData,
  type ParsedCardActionCallback,
} from "./card-action.js";
import type { RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import {
  renderDetailsMessage,
  renderDeliveryMessage,
  renderDeliveryText,
  type AttentionCardResolutionState,
} from "./message.js";
import type { RelayStore, ResolutionResult } from "./store.js";
import type { NotificationTransport } from "./transport.js";
import {
  asTransportError,
  isInteractiveTransport,
  isTopicTransport,
} from "./transport.js";

const userSchema = z
  .object({
    id: z.number().int(),
  })
  .passthrough();

const chatSchema = z
  .object({
    id: z.number().int(),
  })
  .passthrough();

const messageSchema = z
  .object({
    message_id: z.number().int(),
    message_thread_id: z.number().int().positive().optional(),
    from: userSchema.optional(),
    chat: chatSchema,
    text: z.string().optional(),
    reply_to_message: z
      .object({
        message_id: z.number().int(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const callbackSchema = z
  .object({
    id: z.string().min(1),
    from: userSchema,
    data: z.string().min(1).optional(),
    message: messageSchema.optional(),
  })
  .passthrough();

const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: messageSchema.optional(),
    callback_query: callbackSchema.optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export type ReplyRouteOutcome =
  | "answered"
  | "duplicate-update"
  | "duplicate-answer"
  | "expired"
  | "cancelled"
  | "failed"
  | "unauthorized"
  | "uncorrelated"
  | "malformed"
  | "unsupported"
  | "action-completed"
  | "action-duplicate"
  | "action-rejected"
  | "action-failed";

export interface ReplyRouteResult {
  outcome: ReplyRouteOutcome;
  updateId?: number;
  resolution?: ResolutionResult;
}

type TelegramCallback = NonNullable<TelegramUpdate["callback_query"]>;

export interface TelegramReplyRouterOptions {
  operatorUserId: number;
  chatId: number;
  now?: () => Date;
  logger?: RelayLogger;
}

function routeOutcome(result: ResolutionResult): ReplyRouteOutcome {
  switch (result.outcome) {
    case "answered":
      return "answered";
    case "duplicate":
      return "duplicate-answer";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "not_found":
    case "identity_mismatch":
      return "uncorrelated";
  }
}

function cardResolutionState(
  result: ResolutionResult,
): AttentionCardResolutionState {
  switch (result.outcome) {
    case "answered":
    case "duplicate":
      return "answered";
    case "expired":
      return "expired";
    case "cancelled":
      return "superseded";
    case "failed":
    case "not_found":
    case "identity_mismatch":
      return "failed";
  }
}

export class TelegramReplyRouter {
  private readonly now: () => Date;
  private readonly logger: RelayLogger;

  public constructor(
    private readonly store: RelayStore,
    private readonly transport: NotificationTransport,
    private readonly options: TelegramReplyRouterOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  private authorized(userId: number | undefined, chatId: number): boolean {
    return (
      userId === this.options.operatorUserId && chatId === this.options.chatId
    );
  }

  private async acknowledge(callbackId: string, text: string): Promise<void> {
    if (!isInteractiveTransport(this.transport)) {
      return;
    }
    try {
      await this.transport.acknowledgeCallback(callbackId, text);
    } catch (error) {
      this.logger.log({
        level: "warn",
        code: "telegram.callback-ack-failed",
        message:
          error instanceof Error
            ? error.message
            : "Telegram callback acknowledgment failed",
        at: this.now().toISOString(),
      });
    }
  }

  private async editResolved(
    messageId: string,
    result: ResolutionResult,
  ): Promise<void> {
    if (!isInteractiveTransport(this.transport)) {
      return;
    }
    try {
      const event =
        result.request === undefined
          ? undefined
          : this.store.getEvent(result.request.eventId)?.event;
      await this.transport.editResolvedMessage(
        messageId,
        event === undefined
          ? `Agent Relay request state: ${result.outcome}`
          : renderDeliveryText(
              renderDeliveryMessage(event, {
                now: this.now(),
                resolutionState: cardResolutionState(result),
              }),
            ),
      );
    } catch (error) {
      this.logger.log({
        level: "warn",
        code: "telegram.message-edit-failed",
        message:
          error instanceof Error
            ? error.message
            : "Telegram resolution edit failed",
        at: this.now().toISOString(),
        details: { messageId },
      });
    }
  }

  private diagnoseCardCallback(
    updateId: number,
    code: string,
    message: string,
    level: "warn" | "error" = "warn",
  ): void {
    const recordedAt = this.now().toISOString();
    this.store.recordDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: `diag_card_${sha256(
        `${String(updateId)}\u001f${code}`,
      ).slice(0, 40)}`,
      recordedAt,
      source: "daemon",
      level,
      code,
      message,
    });
  }

  private async rejectCardCallback(
    callback: TelegramCallback,
    updateId: number,
    code: string,
    response: string,
  ): Promise<ReplyRouteResult> {
    this.diagnoseCardCallback(updateId, code, response);
    await this.acknowledge(callback.id, response);
    return { outcome: "action-rejected", updateId };
  }

  private async editCardControl(
    messageId: string,
    event: NonNullable<ReturnType<RelayStore["getEvent"]>>["event"],
    state: string,
  ): Promise<void> {
    if (!isInteractiveTransport(this.transport)) {
      return;
    }
    try {
      await this.transport.editResolvedMessage(
        messageId,
        `${renderDeliveryText(
          renderDeliveryMessage(event, { now: this.now() }),
        )}\n\nSession control: ${state}`,
      );
    } catch (error) {
      this.logger.log({
        level: "warn",
        code: "telegram.card-edit-failed",
        message:
          error instanceof Error ? error.message : "Telegram card edit failed",
        at: this.now().toISOString(),
        details: { messageId },
      });
    }
  }

  private async handleCardCallback(
    callback: TelegramCallback,
    parsed: ParsedCardActionCallback,
    updateId: number,
  ): Promise<ReplyRouteResult> {
    const action = this.store.getCardAction(parsed.token);
    if (action === undefined) {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-unknown",
        "This action is unknown or no longer retained",
      );
    }
    if (action.kind !== parsed.action) {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-kind-mismatch",
        "This action does not match its card",
      );
    }
    const eventRecord = this.store.getEvent(action.eventId);
    const receipt = this.store.getEventTransportReceipt(action.eventId);
    if (
      eventRecord === undefined ||
      receipt === undefined ||
      callback.message === undefined ||
      receipt.transportName !== this.transport.name ||
      receipt.messageId !== String(callback.message.message_id)
    ) {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-session-mismatch",
        "This action belongs to a different or stale session card",
      );
    }

    let topicId: string | undefined;
    if (isTopicTransport(this.transport)) {
      const topic = this.store.getSessionTopic({
        machineId: eventRecord.event.machineId,
        harness: eventRecord.event.harness,
        sessionId: eventRecord.event.sessionId,
        transportName: this.transport.name,
        transportScope: this.transport.topicScope,
      });
      topicId = topic?.topicId;
      if (
        topic?.provisioningStatus !== "ready" ||
        topicId === undefined ||
        callback.message.message_thread_id === undefined ||
        String(callback.message.message_thread_id) !== topicId
      ) {
        return await this.rejectCardCallback(
          callback,
          updateId,
          "telegram.card-action-topic-mismatch",
          "This action belongs to a different or stale topic",
        );
      }
    }

    const execution = this.store.executeCardAction({
      token: parsed.token,
      kind: parsed.action,
      updateId,
      now: this.now().toISOString(),
    });
    if (execution.outcome === "not_found") {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-unknown",
        "This action is unknown or no longer retained",
      );
    }
    if (execution.outcome === "kind_mismatch") {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-kind-mismatch",
        "This action does not match its card",
      );
    }
    if (execution.outcome === "blocked") {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-blocked",
        execution.reason,
      );
    }
    if (execution.outcome === "stale") {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-stale",
        "This action is no longer eligible",
      );
    }
    if (execution.outcome === "duplicate") {
      await this.acknowledge(callback.id, "Already handled");
      return { outcome: "action-duplicate", updateId };
    }

    if (parsed.action === "details") {
      if (execution.outcome !== "claimed") {
        await this.acknowledge(callback.id, "Already handled");
        return { outcome: "action-duplicate", updateId };
      }
      try {
        await this.transport.deliver(renderDetailsMessage(eventRecord.event), {
          idempotencyKey: parsed.token,
          ...(topicId === undefined ? {} : { topicId }),
        });
        this.store.finishCardAction({
          token: parsed.token,
          succeeded: true,
          outcome: "details-delivered",
          now: this.now().toISOString(),
        });
        await this.acknowledge(callback.id, "Details posted");
        return { outcome: "action-completed", updateId };
      } catch (error) {
        const transportError = asTransportError(error);
        this.store.finishCardAction({
          token: parsed.token,
          succeeded: false,
          outcome: transportError.code,
          errorMessage: transportError.message,
          now: this.now().toISOString(),
        });
        this.diagnoseCardCallback(
          updateId,
          "telegram.card-action-failed",
          "Details delivery failed after the action was claimed",
          "error",
        );
        await this.acknowledge(callback.id, "Details failed");
        return { outcome: "action-failed", updateId };
      }
    }

    if (execution.outcome !== "succeeded") {
      return await this.rejectCardCallback(
        callback,
        updateId,
        "telegram.card-action-stale",
        "This action is no longer eligible",
      );
    }
    if (parsed.action === "continue") {
      const pending = this.store.getPendingForEvent(action.eventId);
      if (pending !== undefined) {
        await this.editResolved(String(callback.message.message_id), {
          outcome: "answered",
          request: pending,
        });
      }
      await this.acknowledge(callback.id, "Continuation queued");
    } else if (parsed.action === "mute") {
      await this.editCardControl(
        String(callback.message.message_id),
        eventRecord.event,
        "routine notifications muted; questions and critical failures remain active",
      );
      await this.acknowledge(callback.id, "Routine notifications muted");
    } else {
      await this.editCardControl(
        String(callback.message.message_id),
        eventRecord.event,
        "relay lane ended; the harness process is unchanged",
      );
      await this.acknowledge(
        callback.id,
        "Relay lane ended; harness process unchanged",
      );
    }
    return { outcome: "action-completed", updateId };
  }

  public async handle(updateInput: unknown): Promise<ReplyRouteResult> {
    const parsed = telegramUpdateSchema.safeParse(updateInput);
    if (!parsed.success) {
      this.logger.log({
        level: "warn",
        code: "telegram.malformed-update",
        message: "Telegram update failed validation",
        at: this.now().toISOString(),
        details: {
          issues: parsed.error.issues.slice(0, 8).map((issue) => ({
            path: issue.path.join(".") || "<root>",
            message: issue.message,
          })),
        },
      });
      return { outcome: "malformed" };
    }

    const update = parsed.data;
    const receivedAt = this.now().toISOString();
    if (!this.store.claimTelegramUpdate(update.update_id, receivedAt)) {
      return { outcome: "duplicate-update", updateId: update.update_id };
    }

    let route: ReplyRouteResult;
    if (update.callback_query !== undefined) {
      const callback = update.callback_query;
      const chatId = callback.message?.chat.id;
      if (chatId === undefined || !this.authorized(callback.from.id, chatId)) {
        if (callback.data?.startsWith("relay-card:") === true) {
          this.diagnoseCardCallback(
            update.update_id,
            "telegram.card-action-unauthorized",
            "Unauthorized card action callback",
          );
        }
        await this.acknowledge(callback.id, "Not authorized");
        route = { outcome: "unauthorized", updateId: update.update_id };
      } else if (callback.data?.startsWith("relay-card:") === true) {
        const cardAction = parseCardActionCallbackData(callback.data);
        route =
          cardAction === undefined
            ? await this.rejectCardCallback(
                callback,
                update.update_id,
                "telegram.card-action-malformed",
                "Malformed or unsupported card action",
              )
            : await this.handleCardCallback(
                callback,
                cardAction,
                update.update_id,
              );
      } else if (
        callback.data === undefined ||
        !callback.data.startsWith("relay:")
      ) {
        await this.acknowledge(callback.id, "Stale or invalid choice");
        route = { outcome: "uncorrelated", updateId: update.update_id };
      } else {
        await this.acknowledge(callback.id, "Recorded");
        const resolution = this.store.resolveOptionToken(
          callback.data.slice("relay:".length),
          "telegram",
          receivedAt,
        );
        if (callback.message !== undefined) {
          await this.editResolved(
            String(callback.message.message_id),
            resolution,
          );
        }
        route = {
          outcome: routeOutcome(resolution),
          updateId: update.update_id,
          resolution,
        };
      }
    } else if (update.message !== undefined) {
      const message = update.message;
      if (!this.authorized(message.from?.id, message.chat.id)) {
        route = { outcome: "unauthorized", updateId: update.update_id };
      } else if (
        message.reply_to_message === undefined ||
        message.text === undefined ||
        message.text.trim().length === 0
      ) {
        route = { outcome: "unsupported", updateId: update.update_id };
      } else {
        const resolution = this.store.resolveTransportReply(
          String(message.reply_to_message.message_id),
          message.text,
          receivedAt,
        );
        await this.editResolved(
          String(message.reply_to_message.message_id),
          resolution,
        );
        route = {
          outcome: routeOutcome(resolution),
          updateId: update.update_id,
          resolution,
        };
      }
    } else {
      route = { outcome: "unsupported", updateId: update.update_id };
    }

    this.store.completeTelegramUpdate(update.update_id, route.outcome);
    this.logger.log({
      level:
        route.outcome === "answered" || route.outcome === "action-completed"
          ? "info"
          : "warn",
      code: `telegram.reply-${route.outcome}`,
      message: `Telegram update outcome: ${route.outcome}`,
      at: this.now().toISOString(),
      details: { updateId: update.update_id },
    });
    return route;
  }
}
