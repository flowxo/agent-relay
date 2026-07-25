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

  it("enforces Telegram's text limit with a visible truncation marker", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 43, date: 0 } }),
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

    await transport.deliver(
      { ...message, text: "x".repeat(5_000) },
      { idempotencyKey: message.eventId },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      text: string;
    };
    expect(body.text.length).toBeLessThanOrEqual(4_096);
    expect(body.text.endsWith("…[truncated]")).toBe(true);
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

  it("long-polls only supported reply updates and returns validated update ids", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 73,
              message: { message_id: 9, chat: { id: 10001 }, text: "yes" },
            },
          ],
        }),
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
      transport.getUpdates({
        offset: 70,
        limit: 25,
        timeoutSeconds: 20,
      }),
    ).resolves.toEqual([
      {
        update_id: 73,
        message: { message_id: 9, chat: { id: 10001 }, text: "yes" },
      },
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      offset: number;
      limit: number;
      timeout: number;
      allowed_updates: string[];
    };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("getUpdates");
    expect(body).toEqual({
      offset: 70,
      limit: 25,
      timeout: 20,
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("rejects a malformed getUpdates response without retrying poison data", async () => {
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: [{ update_id: "wrong" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(transport.getUpdates()).rejects.toMatchObject({
      code: "telegram-malformed-response",
      retryable: false,
    });
  });

  it("cancels an active long poll promptly during shutdown", async () => {
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
    });
    const controller = new AbortController();
    const polling = transport.getUpdates({
      timeoutSeconds: 50,
      signal: controller.signal,
    });

    controller.abort();

    await expect(polling).rejects.toMatchObject({
      code: "telegram-aborted",
      retryable: false,
    });
  });
});
