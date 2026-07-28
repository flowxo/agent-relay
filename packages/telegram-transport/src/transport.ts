import { z } from "zod";

import {
  InteractionProviderObservationV1Schema,
  MAX_INTERACTION_OPTIONS,
  MAX_INTERACTION_QUESTIONS,
  MAX_INTERACTION_REQUEST_BYTES,
  MAX_INTERACTION_TEXT_LENGTH,
  sha256,
  type InteractionProviderObservationV1,
} from "@agent-relay/protocol";
import { redactText, renderDeliveryText } from "@agent-relay/core";
import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractiveNotificationTransport,
  TopicCreation,
  TopicCreationContext,
  TopicNotificationTransport,
  TopicReceipt,
} from "@agent-relay/notification-contracts";
import {
  TopicUnavailableError,
  TransportError,
} from "@agent-relay/notification-contracts";

import { cardActionCallbackData } from "./callbacks/card-action.js";
import {
  choiceCallbackData,
  TELEGRAM_INLINE_CHOICE_LIMIT,
} from "./callbacks/choice.js";
import { multiSelectCallbackData } from "./callbacks/multi-select.js";
import { questionSetCallbackData } from "./callbacks/question-set.js";

const successSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        message_id: z.number().int(),
      })
      .passthrough(),
  })
  .passthrough();

const failureSchema = z
  .object({
    ok: z.literal(false),
    error_code: z.number().int().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const forumTopicSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        message_thread_id: z.number().int().positive(),
        name: z.string().min(1).max(128),
      })
      .passthrough(),
  })
  .passthrough();

const polledUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
  })
  .passthrough();

const getUpdatesSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z.array(polledUpdateSchema),
  })
  .passthrough();

const getMeSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        id: z.number().int(),
        is_bot: z.literal(true),
        has_topics_enabled: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const getChatSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        id: z.number().int(),
        type: z.enum(["private", "group", "supergroup", "channel"]),
      })
      .passthrough(),
  })
  .passthrough();

const getWebhookInfoSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        url: z.string(),
        pending_update_count: z.number().int().nonnegative(),
        last_error_date: z.number().int().optional(),
        last_error_message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function identifiesUnavailableTopic(
  method: string,
  payload: Record<string, unknown>,
  status: number,
  description: string,
): boolean {
  if (
    method !== "sendMessage" ||
    !("message_thread_id" in payload) ||
    status !== 400
  ) {
    return false;
  }
  const normalized = description.toLowerCase();
  return [
    "message thread not found",
    "message thread is not found",
    "message thread id is invalid",
    "message_thread_id is invalid",
    "message thread is closed",
    "message thread was closed",
    "topic is closed",
    "topic was closed",
  ].some((fragment) => normalized.includes(fragment));
}

function telegramFailureCode(
  method: string,
  status: number,
  description: string,
): string {
  const normalized = description.toLowerCase();
  if (status === 401 || normalized.includes("unauthorized")) {
    return "telegram-invalid-token";
  }
  if (
    normalized.includes("bot was blocked") ||
    normalized.includes("bot is blocked") ||
    normalized.includes("user is deactivated")
  ) {
    return "telegram-bot-blocked";
  }
  if (
    normalized.includes("chat not found") ||
    normalized.includes("chat_id is invalid") ||
    normalized.includes("peer_id_invalid")
  ) {
    return "telegram-invalid-chat";
  }
  if (
    method === "getUpdates" &&
    (normalized.includes("webhook is active") ||
      normalized.includes("can't use getupdates method while webhook"))
  ) {
    return "telegram-webhook-conflict";
  }
  if (
    method === "getUpdates" &&
    status === 409 &&
    (normalized.includes("terminated by other getupdates request") ||
      normalized.includes("another getupdates request") ||
      normalized.includes("conflict"))
  ) {
    return "telegram-polling-conflict";
  }
  if (
    method === "createForumTopic" &&
    (normalized.includes("not enough rights") ||
      normalized.includes("manage topics") ||
      normalized.includes("forum_create_forbidden") ||
      normalized.includes("not allowed to create"))
  ) {
    return "telegram-topic-permission";
  }
  if (
    method === "createForumTopic" &&
    (normalized.includes("forum is not enabled") ||
      normalized.includes("chat is not a forum") ||
      normalized.includes("channel_forum_missing") ||
      normalized.includes("topics are not enabled"))
  ) {
    return "telegram-topics-disabled";
  }
  return `telegram-http-${status}`;
}

function actionableSetupError(error: unknown): TransportError {
  const transportError =
    error instanceof TransportError
      ? error
      : new TransportError(
          "Telegram setup verification failed",
          "telegram-setup-failed",
          true,
        );
  const message = (() => {
    switch (transportError.code) {
      case "telegram-invalid-token":
        return "Telegram rejected AGENT_RELAY_TELEGRAM_TOKEN; replace the bot token and restart";
      case "telegram-bot-blocked":
        return "The Telegram operator has blocked this bot; unblock it, send /start, and restart";
      case "telegram-invalid-chat":
        return "Telegram cannot access AGENT_RELAY_TELEGRAM_CHAT_ID; verify the private chat ID, send /start, and restart";
      case "telegram-webhook-conflict":
        return "Telegram polling cannot start while a webhook is active; inspect getWebhookInfo, remove the stale webhook or select webhook mode, and restart";
      case "telegram-polling-conflict":
        return "Another process is polling this Telegram bot; stop the other getUpdates consumer and restart";
      default:
        return transportError.message;
    }
  })();
  return new TransportError(
    message,
    transportError.code,
    transportError.retryable,
    transportError.status,
  );
}

function rowsOf<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function inlineKeyboard(
  message: DeliveryMessage,
): Array<Array<{ text: string; callback_data: string }>> {
  const choices =
    message.multiSelect === undefined && message.questionSet === undefined
      ? (message.interaction?.options ?? [])
      : [];
  const choiceButtons =
    choices.length > TELEGRAM_INLINE_CHOICE_LIMIT
      ? []
      : choices.map((choice) => ({
          text: choice.label,
          callback_data: choiceCallbackData(choice.value),
        }));
  const actionButtons = (message.actions ?? []).map((action) => ({
    text: action.label,
    callback_data: cardActionCallbackData(action.kind, action.token),
  }));
  const multiSelectButtons = (message.multiSelect?.options ?? []).map(
    (option) => ({
      text: `${option.selected ? "✓" : "○"} ${option.label}`,
      callback_data: multiSelectCallbackData(
        option.selected ? "unselect" : "select",
        option.value,
      ),
    }),
  );
  const multiSelectActions =
    message.multiSelect === undefined
      ? []
      : [
          [
            {
              text: "Submit",
              callback_data: multiSelectCallbackData(
                "submit",
                message.multiSelect.submitToken,
              ),
            },
            {
              text: "Cancel",
              callback_data: multiSelectCallbackData(
                "cancel",
                message.multiSelect.cancelToken,
              ),
            },
          ],
        ];
  const questionSetButtons =
    message.questionSet !== undefined &&
    message.questionSet.presentationMode !== "numbered-text" &&
    message.questionSet.kind !== "free-text"
      ? message.questionSet.options.map((option) => ({
          text: `${option.selected ? "✓" : "○"} ${option.label}`,
          callback_data: questionSetCallbackData(
            message.questionSet?.kind === "multi-select"
              ? option.selected
                ? "unselect"
                : "select"
              : "choose",
            option.value,
          ),
        }))
      : [];
  const questionSetActions =
    message.questionSet === undefined
      ? []
      : [
          [
            ...(message.questionSet.backToken === undefined
              ? []
              : [
                  {
                    text: "Back",
                    callback_data: questionSetCallbackData(
                      "back",
                      message.questionSet.backToken,
                    ),
                  },
                ]),
            ...(message.questionSet.nextToken === undefined
              ? [
                  {
                    text: "Submit",
                    callback_data: questionSetCallbackData(
                      "submit",
                      message.questionSet.submitToken,
                    ),
                  },
                ]
              : [
                  {
                    text: "Next",
                    callback_data: questionSetCallbackData(
                      "next",
                      message.questionSet.nextToken,
                    ),
                  },
                ]),
            {
              text: "Cancel",
              callback_data: questionSetCallbackData(
                "cancel",
                message.questionSet.cancelToken,
              ),
            },
          ],
        ];
  return [
    ...rowsOf(choiceButtons, 2),
    ...rowsOf(multiSelectButtons, 2),
    ...multiSelectActions,
    ...rowsOf(questionSetButtons, 2),
    ...questionSetActions,
    ...rowsOf(actionButtons, 2),
  ];
}

export type TelegramPolledUpdate = z.infer<typeof polledUpdateSchema>;

export interface TelegramGetUpdatesOptions {
  offset?: number;
  limit?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface TelegramTransportOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface TelegramSetupReport {
  topicsEnabled: true;
  chatType: "private";
  updateMode: "poll" | "webhook";
  webhookConfigured: boolean;
}

export class TelegramBotTransport
  implements InteractiveNotificationTransport, TopicNotificationTransport
{
  public readonly name = "telegram";
  public readonly topicScope: string;
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: TelegramTransportOptions) {
    if (
      options.token.trim().length === 0 ||
      options.chatId.trim().length === 0
    ) {
      throw new Error("Telegram token and chat id are required");
    }
    this.token = options.token;
    this.chatId = options.chatId;
    const botId = options.token.split(":", 1)[0] ?? "";
    this.topicScope = `chat:${sha256(`${botId}:${options.chatId}`).slice(
      0,
      24,
    )}`;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  public observeInteractionCapabilities(
    observedAt: string,
  ): InteractionProviderObservationV1 {
    return InteractionProviderObservationV1Schema.parse({
      schema: "agent-interaction-provider-observation.v1",
      capabilities: {
        schema: "agent-interaction-capabilities.v1",
        providerId: "transport_telegram_bot_api",
        providerKind: "transport",
        observedAt,
        features: [
          "confirm",
          "single-select",
          "multi-select",
          "free-text",
          "ordered-question-set",
          "durable-drafts",
          "message-updates",
        ],
        presentationModes: ["buttons", "direct-text", "numbered-text"],
        limits: {
          maxQuestions: MAX_INTERACTION_QUESTIONS,
          maxOptionsPerQuestion: MAX_INTERACTION_OPTIONS,
          maxTextLength: MAX_INTERACTION_TEXT_LENGTH,
          maxPayloadBytes: MAX_INTERACTION_REQUEST_BYTES,
        },
      },
      status: "proven",
      evidence: "live-canary",
      observedVersion: "Telegram Bot API 10.2",
      fixture: "telegram-question-set-send-message-v10.2",
      documentation: "https://core.telegram.org/bots/api",
      note: "Inline callbacks, topic-bound text, numbered replies, and message edits are implemented; local web handoff is intentionally not advertised.",
    });
  }

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const text = renderDeliveryText(message);
    const keyboard = inlineKeyboard(message);
    const body = await this.callApi("sendMessage", {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      ...(context.topicId === undefined
        ? {}
        : { message_thread_id: this.parseTopicId(context.topicId) }),
      ...(keyboard.length === 0
        ? {}
        : {
            reply_markup: {
              inline_keyboard: keyboard,
            },
          }),
    });
    const success = successSchema.safeParse(body);
    if (!success.success) {
      throw new TransportError(
        "Telegram sendMessage response did not include a message id",
        "telegram-malformed-response",
        false,
      );
    }
    return {
      transport: this.name,
      messageId: String(success.data.result.message_id),
    };
  }

  public async createTopic(
    topic: TopicCreation,
    _context: TopicCreationContext,
  ): Promise<TopicReceipt> {
    const name = [...topic.name].slice(0, 128).join("").trim();
    if (name.length === 0) {
      throw new TransportError(
        "Telegram topic name must not be empty",
        "telegram-invalid-topic",
        false,
      );
    }
    const body = await this.callApi("createForumTopic", {
      chat_id: this.chatId,
      name,
    });
    const success = forumTopicSuccessSchema.safeParse(body);
    if (!success.success) {
      throw new TransportError(
        "Telegram createForumTopic response did not include a topic id",
        "telegram-malformed-response",
        false,
      );
    }
    return {
      transport: this.name,
      topicId: String(success.data.result.message_thread_id),
    };
  }

  public async acknowledgeCallback(
    callbackId: string,
    text: string,
  ): Promise<void> {
    await this.callApi("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: redactText(text, 160),
    });
  }

  public async verifySetup(
    updateMode: "poll" | "webhook",
  ): Promise<TelegramSetupReport> {
    try {
      const me = getMeSuccessSchema.safeParse(await this.callApi("getMe", {}));
      if (!me.success) {
        throw new TransportError(
          "Telegram getMe response did not include bot topic capability",
          "telegram-malformed-response",
          false,
        );
      }
      if (me.data.result.has_topics_enabled !== true) {
        throw new TransportError(
          "Telegram private topics are disabled; enable Threaded Mode for this bot in BotFather and restart",
          "telegram-topics-disabled",
          false,
        );
      }

      const chat = getChatSuccessSchema.safeParse(
        await this.callApi("getChat", { chat_id: this.chatId }),
      );
      if (!chat.success) {
        throw new TransportError(
          "Telegram getChat response did not identify the configured chat",
          "telegram-malformed-response",
          false,
        );
      }
      if (chat.data.result.type !== "private") {
        throw new TransportError(
          "AGENT_RELAY_TELEGRAM_CHAT_ID must identify a private chat; non-topic compatibility mode is not enabled",
          "telegram-private-chat-required",
          false,
        );
      }

      const webhook = getWebhookInfoSuccessSchema.safeParse(
        await this.callApi("getWebhookInfo", {}),
      );
      if (!webhook.success) {
        throw new TransportError(
          "Telegram getWebhookInfo response was malformed",
          "telegram-malformed-response",
          false,
        );
      }
      const webhookConfigured = webhook.data.result.url.length > 0;
      if (updateMode === "poll" && webhookConfigured) {
        throw new TransportError(
          "Telegram polling cannot start while a webhook is active; inspect getWebhookInfo, remove the stale webhook or select webhook mode, and restart",
          "telegram-webhook-conflict",
          false,
        );
      }
      if (updateMode === "webhook" && !webhookConfigured) {
        throw new TransportError(
          "Telegram webhook mode is selected but getWebhookInfo has no URL; configure the HTTPS webhook endpoint and restart",
          "telegram-webhook-missing",
          false,
        );
      }
      return {
        topicsEnabled: true,
        chatType: "private",
        updateMode,
        webhookConfigured,
      };
    } catch (error) {
      throw actionableSetupError(error);
    }
  }

  public async editDeliveryMessage(
    messageId: string,
    message: DeliveryMessage,
  ): Promise<void> {
    await this.callApi("editMessageText", {
      chat_id: this.chatId,
      message_id: Number(messageId),
      text: renderDeliveryText(message),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard(message) },
    });
  }

  public async editResolvedMessage(
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.callApi("editMessageText", {
      chat_id: this.chatId,
      message_id: Number(messageId),
      text: redactText(text, 4_000),
      reply_markup: { inline_keyboard: [] },
    });
  }

  public async getUpdates(
    options: TelegramGetUpdatesOptions = {},
  ): Promise<TelegramPolledUpdate[]> {
    const offset = options.offset;
    const limit = options.limit ?? 100;
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new Error("Telegram update offset must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Telegram update limit must be between 1 and 100");
    }
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 50
    ) {
      throw new Error(
        "Telegram long-poll timeout must be between 1 and 50 seconds",
      );
    }

    const body = await this.callApi(
      "getUpdates",
      {
        ...(offset === undefined ? {} : { offset }),
        limit,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      timeoutSeconds * 1_000 + 5_000,
      options.signal,
    );
    const parsed = getUpdatesSuccessSchema.safeParse(body);
    if (!parsed.success) {
      throw new TransportError(
        "Telegram getUpdates response did not include a valid update array",
        "telegram-malformed-response",
        false,
      );
    }
    return parsed.data.result;
  }

  private parseTopicId(topicId: string): number {
    const parsed = Number(topicId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new TransportError(
        "Telegram topic id must be a positive integer",
        "telegram-invalid-topic",
        false,
      );
    }
    return parsed;
  }

  private async callApi(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let externallyAborted = externalSignal?.aborted ?? false;
    const abortFromExternal = (): void => {
      externallyAborted = true;
      controller.abort();
    };
    if (externallyAborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternal, {
        once: true,
      });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || controller.signal.aborted);
      throw new TransportError(
        externallyAborted
          ? "Telegram request was cancelled"
          : aborted
            ? "Telegram request timed out"
            : "Telegram request failed before receiving a response",
        externallyAborted
          ? "telegram-aborted"
          : aborted
            ? "telegram-timeout"
            : "telegram-network",
        !externallyAborted,
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new TransportError(
        `Telegram returned non-JSON status ${response.status}`,
        "telegram-malformed-response",
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    if (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      "ok" in body &&
      body.ok === true
    ) {
      return body;
    }

    const failure = failureSchema.safeParse(body);
    const status = failure.success
      ? (failure.data.error_code ?? response.status)
      : response.status;
    const description = failure.success
      ? (failure.data.description ?? "Telegram rejected the request")
      : "Telegram response did not match the Bot API schema";
    if (identifiesUnavailableTopic(method, payload, status, description)) {
      throw new TopicUnavailableError(
        redactText(description, 500),
        "telegram-topic-unavailable",
        status,
      );
    }
    throw new TransportError(
      redactText(description, 500),
      telegramFailureCode(method, status, description),
      status === 429 || status >= 500,
      status,
    );
  }
}
