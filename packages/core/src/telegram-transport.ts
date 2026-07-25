import { z } from "zod";

import { sha256 } from "@agent-relay/protocol";

import { redactText } from "./redaction.js";
import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractiveNotificationTransport,
  TopicCreation,
  TopicCreationContext,
  TopicNotificationTransport,
  TopicReceipt,
} from "./transport.js";
import { TransportError } from "./transport.js";

const TELEGRAM_TEXT_LIMIT = 4_096;

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

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const text = redactText(
      `${message.title}\n\n${message.text}`,
      TELEGRAM_TEXT_LIMIT,
    );
    const body = await this.callApi("sendMessage", {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      ...(context.topicId === undefined
        ? {}
        : { message_thread_id: this.parseTopicId(context.topicId) }),
      ...(message.choices === undefined
        ? {}
        : {
            reply_markup: {
              inline_keyboard: [
                message.choices.map((choice) => ({
                  text: choice.label,
                  callback_data: `relay:${choice.token}`,
                })),
              ],
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
    throw new TransportError(
      redactText(description, 500),
      `telegram-http-${status}`,
      status === 429 || status >= 500,
      status,
    );
  }
}
