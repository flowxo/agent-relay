import { describe, expect, it, vi } from "vitest";

import { TelegramBotTransport } from "./telegram-transport.js";

const message = {
  eventId: "evt_telegram_12345678",
  title: "Codex · example",
  text: "Waiting",
};

describe("TelegramBotTransport", () => {
  it("maps a Bot API response to a delivery receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 42, date: 0 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
    });

    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
      }),
    ).resolves.toEqual({ transport: "telegram", messageId: "42" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies rate limits as retryable and never exposes the bot token", async () => {
    const token = "123456:synthetic-token-value";
    const transport = new TelegramBotTransport({
      token,
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    try {
      await transport.deliver(message, {
        idempotencyKey: message.eventId,
      });
      throw new Error("expected Telegram delivery to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "telegram-http-429",
        retryable: true,
      });
      expect(String(error)).not.toContain(token);
    }
  });

  it("classifies a timeout as a retryable diagnostic", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
      }),
    ).rejects.toMatchObject({
      code: "telegram-timeout",
      retryable: true,
    });
  });

  it("renders opaque buttons and supports callback acknowledgement and message edits", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 44 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 44 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
    });
    await transport.deliver(
      {
        ...message,
        choices: [{ token: "decision_opaque_12345678", label: "Allow once" }],
      },
      { idempotencyKey: message.eventId },
    );
    await transport.acknowledgeCallback("callback_44", "Recorded");
    await transport.editResolvedMessage("44", "Handled via Telegram");

    const firstBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    };
    expect(firstBody.reply_markup.inline_keyboard[0]?.[0]).toEqual({
      text: "Allow once",
      callback_data: "relay:decision_opaque_12345678",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "answerCallbackQuery",
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("editMessageText");
  });
});
