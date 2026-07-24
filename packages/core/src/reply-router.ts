import { z } from "zod";

import type { RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import type { RelayStore, ResolutionResult } from "./store.js";
import type { NotificationTransport } from "./transport.js";
import { isInteractiveTransport } from "./transport.js";

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
  | "unsupported";

export interface ReplyRouteResult {
  outcome: ReplyRouteOutcome;
  updateId?: number;
  resolution?: ResolutionResult;
}

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
    const answer = result.request?.answer ?? result.outcome;
    const resolvedBy = result.request?.resolvedBy ?? "unknown";
    try {
      await this.transport.editResolvedMessage(
        messageId,
        [
          "Agent Relay request resolved",
          "",
          `Outcome: ${result.outcome}`,
          `Handled by: ${resolvedBy}`,
          `Answer: ${answer}`,
        ].join("\n"),
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
        await this.acknowledge(callback.id, "Not authorized");
        route = { outcome: "unauthorized", updateId: update.update_id };
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
      level: route.outcome === "answered" ? "info" : "warn",
      code: `telegram.reply-${route.outcome}`,
      message: `Telegram update outcome: ${route.outcome}`,
      at: this.now().toISOString(),
      details: { updateId: update.update_id },
    });
    return route;
  }
}
