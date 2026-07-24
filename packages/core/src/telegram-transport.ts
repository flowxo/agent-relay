import { z } from "zod";

import { redactText } from "./redaction.js";
import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractiveNotificationTransport,
} from "./transport.js";
import { TransportError } from "./transport.js";

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

export interface TelegramTransportOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class TelegramBotTransport implements InteractiveNotificationTransport {
  public readonly name = "telegram";
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
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  public async deliver(
    message: DeliveryMessage,
    _context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const body = await this.callApi("sendMessage", {
      chat_id: this.chatId,
      text: `${message.title}\n\n${message.text}`,
      disable_web_page_preview: true,
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

  private async callApi(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
        aborted
          ? "Telegram request timed out"
          : "Telegram request failed before receiving a response",
        aborted ? "telegram-timeout" : "telegram-network",
        true,
      );
    } finally {
      clearTimeout(timer);
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
