import { z } from "zod";

import { sha256 } from "@agent-relay/protocol";

import {
  parseCardActionCallbackData,
  type ParsedCardActionCallback,
} from "./card-action.js";
import type { RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import {
  renderDetailsMessages,
  renderDeliveryMessage,
  renderDeliveryText,
  type AttentionCardResolutionState,
} from "./message.js";
import type {
  NumberedChoiceResolutionResult,
  RelayStore,
  ResolutionResult,
} from "./store.js";
import {
  parseChoiceCallbackData,
  TELEGRAM_INLINE_CHOICE_LIMIT,
} from "./telegram-choice.js";
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
    text: z.string().max(4_096).optional(),
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
    data: z.string().min(1).max(128).optional(),
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
  | "no-eligible-request"
  | "ambiguous-request"
  | "invalid-choice"
  | "malformed"
  | "unsupported"
  | "action-completed"
  | "action-duplicate"
  | "action-rejected"
  | "action-failed";

export interface ReplyRouteResult {
  outcome: ReplyRouteOutcome;
  updateId?: number;
  resolution?: NumberedChoiceResolutionResult;
}

type TelegramCallback = NonNullable<TelegramUpdate["callback_query"]>;

export interface TelegramReplyRouterOptions {
  operatorUserId: number;
  chatId: number;
  now?: () => Date;
  logger?: RelayLogger;
}

function routeOutcome(
  result: NumberedChoiceResolutionResult,
): ReplyRouteOutcome {
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
    case "invalid_choice":
      return "invalid-choice";
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
          : (() => {
              const rendered = renderDeliveryMessage(event, {
                now: this.now(),
                resolutionState: cardResolutionState(result),
              });
              const selected =
                result.request?.answer === undefined
                  ? undefined
                  : result.request.options.find(
                      (option) => option.optionId === result.request?.answer,
                    );
              return renderDeliveryText(
                selected === undefined
                  ? rendered
                  : {
                      ...rendered,
                      text: `${rendered.text}\n\nSelected: ${selected.label}`,
                    },
              );
            })(),
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

  private diagnoseTextCorrelation(
    updateId: number,
    code: string,
    message: string,
    level: "info" | "warn" | "error" = "warn",
  ): void {
    const recordedAt = this.now().toISOString();
    this.store.recordDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: `diag_text_${sha256(
        `${String(updateId)}\u001f${code}`,
      ).slice(0, 40)}`,
      recordedAt,
      source: "daemon",
      level,
      code,
      message,
    });
  }

  private async sendTopicGuidance(
    updateId: number,
    topicId: string,
    kind: "none" | "ambiguous" | "incompatible" | "invalid-choice",
  ): Promise<void> {
    const guidance = {
      none: {
        title: "Agent Relay · reply not used",
        text: "No open free-text or continuation request is eligible in this session topic. Use a request card's buttons or wait for a new request.",
      },
      ambiguous: {
        title: "Agent Relay · choose a request",
        text: "More than one text request is waiting in this session topic. Reply to the specific request card so Agent Relay can correlate the answer safely.",
      },
      incompatible: {
        title: "Agent Relay · use the request buttons",
        text: "That request requires a button choice. Ordinary topic text was not used as an answer.",
      },
      "invalid-choice": {
        title: "Agent Relay · invalid option",
        text: "Reply with one number shown on the open choice card. The request is still waiting.",
      },
    }[kind];
    const idempotencyKey = `guidance_${sha256(
      `${String(updateId)}\u001f${kind}`,
    ).slice(0, 40)}`;
    try {
      await this.transport.deliver(
        {
          eventId: idempotencyKey,
          title: guidance.title,
          text: guidance.text,
        },
        { idempotencyKey, topicId },
      );
    } catch (error) {
      const transportError = asTransportError(error);
      this.diagnoseTextCorrelation(
        updateId,
        "telegram.topic-text-guidance-failed",
        `Topic text guidance delivery failed: ${transportError.code}`,
        "error",
      );
      this.logger.log({
        level: "error",
        code: "telegram.topic-text-guidance-failed",
        message: transportError.message,
        at: this.now().toISOString(),
        details: {
          updateId,
          errorCode: transportError.code,
          retryable: transportError.retryable,
        },
      });
    }
  }

  private async resolvePlainTopicText(
    updateId: number,
    topicId: string,
    answer: string,
    receivedAt: string,
    transportScope: string,
  ): Promise<ReplyRouteResult> {
    const correlation = this.store.resolveTopicText({
      transportName: this.transport.name,
      transportScope,
      topicId,
      answer,
      now: receivedAt,
      numberedChoiceMinimumOptions: TELEGRAM_INLINE_CHOICE_LIMIT,
    });
    if (
      correlation.outcome === "topic_not_found" ||
      correlation.outcome === "no_eligible_request"
    ) {
      this.diagnoseTextCorrelation(
        updateId,
        "telegram.topic-text-no-eligible-request",
        "Plain topic text had no eligible request in its session topic",
      );
      await this.sendTopicGuidance(updateId, topicId, "none");
      return {
        outcome: "no-eligible-request",
        updateId,
      };
    }
    if (correlation.outcome === "ambiguous_request") {
      this.diagnoseTextCorrelation(
        updateId,
        "telegram.topic-text-ambiguous-request",
        "Plain topic text matched more than one eligible request",
      );
      await this.sendTopicGuidance(updateId, topicId, "ambiguous");
      return {
        outcome: "ambiguous-request",
        updateId,
      };
    }

    const resolution = correlation.resolution;
    if (resolution.outcome === "invalid_choice") {
      this.diagnoseTextCorrelation(
        updateId,
        "telegram.topic-text-invalid-choice",
        "Numbered choice text did not identify an option on the correlated request",
      );
      await this.sendTopicGuidance(updateId, topicId, "invalid-choice");
      return {
        outcome: "invalid-choice",
        updateId,
        resolution,
      };
    }
    if (correlation.request.transportMessageId !== undefined) {
      await this.editResolved(
        correlation.request.transportMessageId,
        resolution,
      );
    }
    const route = {
      outcome: routeOutcome(resolution),
      updateId,
      resolution,
    };
    this.diagnoseTextCorrelation(
      updateId,
      `telegram.topic-text-${route.outcome}`,
      `Plain topic text correlation outcome: ${route.outcome}`,
      route.outcome === "answered" ? "info" : "warn",
    );
    return route;
  }

  private async rejectChoiceCallback(
    callback: TelegramCallback,
    updateId: number,
    code: string,
    response: string,
  ): Promise<ReplyRouteResult> {
    this.diagnoseCardCallback(updateId, code, response);
    await this.acknowledge(callback.id, response);
    return { outcome: "uncorrelated", updateId };
  }

  private async handleChoiceCallback(
    callback: TelegramCallback,
    token: string,
    updateId: number,
    receivedAt: string,
  ): Promise<ReplyRouteResult> {
    const request = this.store.getPendingForOptionToken(token);
    const messageId =
      callback.message === undefined
        ? undefined
        : String(callback.message.message_id);
    const receipt =
      request === undefined
        ? undefined
        : this.store.getEventTransportReceipt(request.eventId);
    if (request === undefined || receipt === undefined) {
      return await this.rejectChoiceCallback(
        callback,
        updateId,
        "telegram.choice-unknown",
        "Stale or invalid choice",
      );
    }
    if (
      messageId === undefined ||
      request.transportMessageId !== messageId ||
      receipt.transportName !== this.transport.name ||
      receipt.messageId !== messageId
    ) {
      return await this.rejectChoiceCallback(
        callback,
        updateId,
        "telegram.choice-session-mismatch",
        "This choice belongs to a different or stale session card",
      );
    }
    if (isTopicTransport(this.transport)) {
      const topic = this.store.getSessionTopic({
        machineId: request.machineId,
        harness: request.harness,
        sessionId: request.sessionId,
        transportName: this.transport.name,
        transportScope: this.transport.topicScope,
      });
      if (
        topic?.provisioningStatus !== "ready" ||
        topic.topicId === undefined ||
        callback.message?.message_thread_id === undefined ||
        String(callback.message.message_thread_id) !== topic.topicId
      ) {
        return await this.rejectChoiceCallback(
          callback,
          updateId,
          "telegram.choice-topic-mismatch",
          "This choice belongs to a different or stale topic",
        );
      }
    }

    const resolution = this.store.resolveOptionToken(
      token,
      "telegram",
      receivedAt,
      {
        machineId: request.machineId,
        harness: request.harness,
        sessionId: request.sessionId,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        transportMessageId: messageId,
      },
    );
    if (
      resolution.outcome === "not_found" ||
      resolution.outcome === "identity_mismatch"
    ) {
      return await this.rejectChoiceCallback(
        callback,
        updateId,
        "telegram.choice-session-mismatch",
        "This choice belongs to a different or stale session card",
      );
    }

    const acknowledgement = {
      answered: "Recorded",
      duplicate: "Already handled",
      expired: "Request expired",
      cancelled: "Request canceled",
      failed: "Request failed",
    }[resolution.outcome];
    // SQLite is the answer authority. Acknowledge only after its transaction
    // commits so Telegram can never claim an unrecorded selection succeeded.
    await this.acknowledge(callback.id, acknowledgement);
    await this.editResolved(messageId, resolution);
    return {
      outcome: routeOutcome(resolution),
      updateId,
      resolution,
    };
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
        const details = this.store.notificationDetails(action.eventId);
        const pages = renderDetailsMessages(details.events, details.totalCount);
        for (const [index, page] of pages.entries()) {
          await this.transport.deliver(page, {
            idempotencyKey: `${parsed.token}:${String(index + 1)}`,
            ...(topicId === undefined ? {} : { topicId }),
          });
        }
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
        if (
          callback.data?.startsWith("relay-card:") === true ||
          callback.data?.startsWith("relay:") === true
        ) {
          this.diagnoseCardCallback(
            update.update_id,
            callback.data.startsWith("relay-card:")
              ? "telegram.card-action-unauthorized"
              : "telegram.choice-unauthorized",
            "Unauthorized Telegram callback",
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
      } else if (callback.data === undefined) {
        await this.acknowledge(callback.id, "Stale or invalid choice");
        route = { outcome: "uncorrelated", updateId: update.update_id };
      } else {
        const token = parseChoiceCallbackData(callback.data);
        route =
          token === undefined
            ? await this.rejectChoiceCallback(
                callback,
                update.update_id,
                "telegram.choice-malformed",
                "Stale or invalid choice",
              )
            : await this.handleChoiceCallback(
                callback,
                token,
                update.update_id,
                receivedAt,
              );
      }
    } else if (update.message !== undefined) {
      const message = update.message;
      if (!this.authorized(message.from?.id, message.chat.id)) {
        this.diagnoseTextCorrelation(
          update.update_id,
          "telegram.topic-text-unauthorized",
          "Rejected topic text from an unauthorized operator or chat",
        );
        route = { outcome: "unauthorized", updateId: update.update_id };
      } else if (
        message.text === undefined ||
        message.text.trim().length === 0
      ) {
        route = { outcome: "unsupported", updateId: update.update_id };
      } else if (isTopicTransport(this.transport)) {
        const topicId =
          message.message_thread_id === undefined
            ? undefined
            : String(message.message_thread_id);
        const topic =
          topicId === undefined
            ? undefined
            : this.store.getSessionTopicByTopicId({
                transportName: this.transport.name,
                transportScope: this.transport.topicScope,
                topicId,
              });
        if (topicId === undefined || topic === undefined) {
          this.diagnoseTextCorrelation(
            update.update_id,
            "telegram.topic-text-unknown-topic",
            "Topic text did not match a ready Agent Relay session topic",
          );
          route = { outcome: "uncorrelated", updateId: update.update_id };
        } else if (message.reply_to_message !== undefined) {
          const targetMessageId = String(message.reply_to_message.message_id);
          const request =
            this.store.getPendingForTransportMessage(targetMessageId);
          if (request === undefined) {
            this.diagnoseTextCorrelation(
              update.update_id,
              "telegram.topic-text-reply-fallback",
              "Reply target was not a retained request; correlating by the exact session topic",
              "info",
            );
            route = await this.resolvePlainTopicText(
              update.update_id,
              topicId,
              message.text,
              receivedAt,
              this.transport.topicScope,
            );
          } else if (
            request.machineId !== topic.machineId ||
            request.harness !== topic.harness ||
            request.sessionId !== topic.sessionId
          ) {
            this.diagnoseTextCorrelation(
              update.update_id,
              "telegram.topic-text-reply-mismatch",
              "Explicit reply did not match a request in the same session topic",
            );
            route = { outcome: "uncorrelated", updateId: update.update_id };
          } else if (
            request.requestKind === "select" &&
            request.options.length > TELEGRAM_INLINE_CHOICE_LIMIT
          ) {
            const resolution = this.store.resolveTransportNumberedChoice(
              targetMessageId,
              message.text,
              receivedAt,
              TELEGRAM_INLINE_CHOICE_LIMIT,
              {
                machineId: topic.machineId,
                harness: topic.harness,
                sessionId: topic.sessionId,
                ...(request.turnId === undefined
                  ? {}
                  : { turnId: request.turnId }),
              },
            );
            if (resolution.outcome === "invalid_choice") {
              this.diagnoseTextCorrelation(
                update.update_id,
                "telegram.topic-text-invalid-choice",
                "Explicit numbered choice did not identify an option on the correlated request",
              );
              await this.sendTopicGuidance(
                update.update_id,
                topicId,
                "invalid-choice",
              );
            } else {
              await this.editResolved(targetMessageId, resolution);
            }
            route = {
              outcome: routeOutcome(resolution),
              updateId: update.update_id,
              resolution,
            };
          } else if (
            request.requestKind !== "input" &&
            request.requestKind !== "continuation"
          ) {
            this.diagnoseTextCorrelation(
              update.update_id,
              "telegram.topic-text-incompatible-request",
              "Topic text was rejected for a button-only request",
            );
            await this.sendTopicGuidance(
              update.update_id,
              topicId,
              "incompatible",
            );
            route = { outcome: "uncorrelated", updateId: update.update_id };
          } else {
            const resolution = this.store.resolveTransportReply(
              targetMessageId,
              message.text,
              receivedAt,
              {
                machineId: topic.machineId,
                harness: topic.harness,
                sessionId: topic.sessionId,
                ...(request.turnId === undefined
                  ? {}
                  : { turnId: request.turnId }),
              },
            );
            await this.editResolved(targetMessageId, resolution);
            route = {
              outcome: routeOutcome(resolution),
              updateId: update.update_id,
              resolution,
            };
            this.diagnoseTextCorrelation(
              update.update_id,
              `telegram.topic-text-${route.outcome}`,
              `Explicit topic reply correlation outcome: ${route.outcome}`,
              route.outcome === "answered" ? "info" : "warn",
            );
          }
        } else {
          route = await this.resolvePlainTopicText(
            update.update_id,
            topicId,
            message.text,
            receivedAt,
            this.transport.topicScope,
          );
        }
      } else if (message.reply_to_message === undefined) {
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
