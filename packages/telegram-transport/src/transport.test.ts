import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { TelegramBotTransport } from "./transport.js";

const message = {
  eventId: "evt_telegram_12345678",
  title: "Codex · example",
  text: "Waiting",
};
const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "telegram",
);

describe("TelegramBotTransport", () => {
  it("creates a private topic and delivers into its message thread", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_thread_id: 77,
              name: "Codex · example · 12345678",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
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
      transport.createTopic(
        { name: "Codex · example · 12345678" },
        { idempotencyKey: "topic_key_12345678" },
      ),
    ).resolves.toEqual({ transport: "telegram", topicId: "77" });
    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
        topicId: "77",
      }),
    ).resolves.toEqual({ transport: "telegram", messageId: "42" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("createForumTopic");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      chat_id: "10001",
      name: "Codex · example · 12345678",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("sendMessage");
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      chat_id: "10001",
      message_thread_id: 77,
    });
    expect(transport.topicScope).toMatch(/^chat:[a-f0-9]{24}$/);
    expect(transport.topicScope).not.toContain("10001");
  });

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

  it("rejects malformed topic creation responses and invalid topic ids", async () => {
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_thread_id: "wrong", name: "topic" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(
      transport.createTopic(
        { name: "topic" },
        { idempotencyKey: "topic_key_12345678" },
      ),
    ).rejects.toMatchObject({
      code: "telegram-malformed-response",
      retryable: false,
    });
    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
        topicId: "not-a-number",
      }),
    ).rejects.toMatchObject({
      code: "telegram-invalid-topic",
      retryable: false,
    });
  });

  it("classifies a missing persisted message thread for reconciliation", async () => {
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
        topicId: "77",
      }),
    ).rejects.toMatchObject({
      name: "TopicUnavailableError",
      code: "telegram-topic-unavailable",
      retryable: true,
      status: 400,
    });
  });

  it("classifies a closed persisted topic for reconciliation", async () => {
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread is closed",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(
      transport.deliver(message, {
        idempotencyKey: message.eventId,
        topicId: "77",
      }),
    ).rejects.toMatchObject({
      name: "TopicUnavailableError",
      code: "telegram-topic-unavailable",
      retryable: true,
      status: 400,
    });
  });

  it("deletes a private topic and treats an already-missing topic as success", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: TOPIC_ID_INVALID",
          }),
          {
            status: 400,
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
      transport.deleteTopic("77", {
        idempotencyKey: "cleanup_first_12345678",
      }),
    ).resolves.toEqual({ transport: "telegram", outcome: "deleted" });
    await expect(
      transport.deleteTopic("78", {
        idempotencyKey: "cleanup_second_12345678",
      }),
    ).resolves.toEqual({
      transport: "telegram",
      outcome: "already-missing",
    });
    await expect(
      transport.deleteTopic("79", {
        idempotencyKey: "cleanup_third_12345678",
      }),
    ).resolves.toEqual({
      transport: "telegram",
      outcome: "already-missing",
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      chat_id: "10001",
      message_thread_id: 77,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("deleteForumTopic");
  });

  it("classifies a transient topic deletion failure for durable retry", async () => {
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
          }),
          { status: 429 },
        ),
      ),
    });

    await expect(
      transport.deleteTopic("77", {
        idempotencyKey: "cleanup_retry_12345678",
      }),
    ).rejects.toMatchObject({
      code: "telegram-http-429",
      retryable: true,
      status: 429,
    });
  });

  it("sends and edits bounded operator controls in the requested private topic", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
    });
    const control = {
      text: "2 proven-dead topics are ready for cleanup.",
      buttons: [
        [
          {
            label: "Delete 2 topics",
            callbackData: "relay-c:v1:y:cleanup_0123456789abcdef",
          },
          {
            label: "Cancel",
            callbackData: "relay-c:v1:n:cleanup_0123456789abcdef",
          },
        ],
      ],
    };

    await expect(
      transport.deliverOperatorControl(control, {
        idempotencyKey: "cleanup_preview_12345678",
        topicId: "77",
      }),
    ).resolves.toEqual({ transport: "telegram", messageId: "91" });
    await transport.editOperatorControl("91", {
      text: "Cleanup complete.",
      buttons: [],
    });

    const sent = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(sent).toMatchObject({
      chat_id: "10001",
      message_thread_id: 77,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Delete 2 topics",
              callback_data: "relay-c:v1:y:cleanup_0123456789abcdef",
            },
            {
              text: "Cancel",
              callback_data: "relay-c:v1:n:cleanup_0123456789abcdef",
            },
          ],
        ],
      },
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("editMessageText");
  });

  it("verifies private topic capability and matching polling mode", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 10002,
              is_bot: true,
              has_topics_enabled: true,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 10001, type: "private" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { url: "", pending_update_count: 0 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                command: "purge",
                description: "Review inactive session topics for deletion",
              },
              {
                command: "cleanup",
                description: "Review ended session topics for deletion",
              },
            ],
          }),
        ),
      );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
    });

    await expect(transport.verifySetup("poll")).resolves.toEqual({
      topicsEnabled: true,
      chatType: "private",
      updateMode: "poll",
      webhookConfigured: false,
      commandsConfigured: true,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/getMe"),
      expect.stringContaining("/getChat"),
      expect.stringContaining("/getWebhookInfo"),
      expect.stringContaining("/setMyCommands"),
      expect.stringContaining("/getMyCommands"),
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      commands: [
        {
          command: "purge",
          description: "Review inactive session topics for deletion",
        },
        {
          command: "cleanup",
          description: "Review ended session topics for deletion",
        },
      ],
      scope: { type: "chat", chat_id: "10001" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      scope: { type: "chat", chat_id: "10001" },
    });
  });

  it("fails setup when Telegram does not retain the scoped command menu", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 10002,
              is_bot: true,
              has_topics_enabled: true,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 10001, type: "private" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { url: "", pending_update_count: 0 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                command: "cleanup",
                description: "Review ended session topics for deletion",
              },
            ],
          }),
        ),
      );
    const transport = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: fetchMock,
    });

    await expect(transport.verifySetup("poll")).rejects.toMatchObject({
      code: "telegram-command-registration-mismatch",
      retryable: false,
      message: expect.stringContaining("did not retain"),
    });
  });

  it("rejects non-private and webhook-conflicted topic configurations", async () => {
    const botResult = new Response(
      JSON.stringify({
        ok: true,
        result: {
          id: 10002,
          is_bot: true,
          has_topics_enabled: true,
        },
      }),
    );
    const nonPrivate = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "-10001",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(botResult)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -10001, type: "supergroup" },
            }),
          ),
        ),
    });
    await expect(nonPrivate.verifySetup("poll")).rejects.toMatchObject({
      code: "telegram-private-chat-required",
      message: expect.stringContaining("private chat"),
    });

    const webhookConflict = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 10002,
                is_bot: true,
                has_topics_enabled: true,
              },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: 10001, type: "private" },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                url: "https://old.invalid/webhook",
                pending_update_count: 0,
              },
            }),
          ),
        ),
    });
    await expect(webhookConflict.verifySetup("poll")).rejects.toMatchObject({
      code: "telegram-webhook-conflict",
      message: expect.stringContaining("getWebhookInfo"),
    });

    const missingWebhook = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 10002,
                is_bot: true,
                has_topics_enabled: true,
              },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: 10001, type: "private" },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { url: "", pending_update_count: 0 },
            }),
          ),
        ),
    });
    await expect(missingWebhook.verifySetup("webhook")).rejects.toMatchObject({
      code: "telegram-webhook-missing",
      message: expect.stringContaining("no URL"),
    });
  });

  it("distinguishes invalid chats and blocked bots", async () => {
    const invalidToken = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          }),
          { status: 401 },
        ),
      ),
    });
    await expect(invalidToken.verifySetup("poll")).rejects.toMatchObject({
      code: "telegram-invalid-token",
      message: expect.stringContaining("replace the bot token"),
    });

    const invalidChat = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "99999",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 10002,
                is_bot: true,
                has_topics_enabled: true,
              },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: chat not found",
            }),
            { status: 400 },
          ),
        ),
    });
    await expect(invalidChat.verifySetup("poll")).rejects.toMatchObject({
      code: "telegram-invalid-chat",
      message: expect.stringContaining("send /start"),
    });

    const blocked = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
          }),
          { status: 403 },
        ),
      ),
    });
    await expect(
      blocked.deliver(message, { idempotencyKey: message.eventId }),
    ).rejects.toMatchObject({
      code: "telegram-bot-blocked",
      status: 403,
    });
  });

  it("distinguishes topic permissions and concurrent polling", async () => {
    const deniedTopic = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden: not enough rights to manage topics",
          }),
          { status: 403 },
        ),
      ),
    });
    await expect(
      deniedTopic.createTopic(
        { name: "Codex · denied" },
        { idempotencyKey: "topic_denied_12345678" },
      ),
    ).rejects.toMatchObject({
      code: "telegram-topic-permission",
      status: 403,
    });

    const pollingConflict = new TelegramBotTransport({
      token: "123456:synthetic-token-value",
      chatId: "10001",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 409,
            description:
              "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
          }),
          { status: 409 },
        ),
      ),
    });
    await expect(
      pollingConflict.getUpdates({ timeoutSeconds: 1 }),
    ).rejects.toMatchObject({
      code: "telegram-polling-conflict",
      status: 409,
      retryable: false,
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
        interaction: {
          type: "select",
          correlationId: "correlation_opaque_12345678",
          prompt: "Choose",
          expiresAt: "2026-07-25T12:00:00.000Z",
          options: [{ value: "decision_opaque_12345678", label: "Allow once" }],
        },
        actions: [
          {
            kind: "details",
            token: "card_0123456789abcdef0123456789abcdef",
            label: "Details",
          },
        ],
      },
      { idempotencyKey: message.eventId },
    );
    await transport.acknowledgeCallback("callback_44", "Recorded");
    await transport.editDeliveryMessage("44", {
      ...message,
      text: "Repeated twice",
      actions: [
        {
          kind: "details",
          token: "card_0123456789abcdef0123456789abcdef",
          label: "Details",
        },
      ],
    });
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
    expect(firstBody.reply_markup.inline_keyboard[1]?.[0]).toEqual({
      text: "Details",
      callback_data: "relay-card:v1:d:card_0123456789abcdef0123456789abcdef",
    });
    expect(firstBody).toEqual(
      JSON.parse(
        readFileSync(
          join(fixtures, "single-choice-send-message.v10.2.json"),
          "utf8",
        ),
      ),
    );
    expect(firstBody).not.toHaveProperty("parse_mode");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "answerCallbackQuery",
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("editMessageText");
    expect(
      JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)),
    ).toMatchObject({
      text: expect.stringContaining("Repeated twice"),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Details",
              callback_data:
                "relay-card:v1:d:card_0123456789abcdef0123456789abcdef",
            },
          ],
        ],
      },
    });
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("editMessageText");
  });

  it("falls back to numbered text when a choice set exceeds the compact button budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 45, date: 0 } }),
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
    const choices = Array.from({ length: 11 }, (_, index) => ({
      value: `decision_${String(index + 1).padStart(16, "0")}`,
      label: `Synthetic choice ${String(index + 1)}`,
    }));

    await transport.deliver(
      {
        ...message,
        interaction: {
          type: "select",
          correlationId: "correlation_numbered_12345678",
          prompt: "Choose",
          expiresAt: "2026-07-25T12:00:00.000Z",
          options: choices,
        },
      },
      { idempotencyKey: "evt_numbered_fallback_12345678" },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      text: string;
      reply_markup?: unknown;
    };
    expect(body.reply_markup).toBeUndefined();
    expect(body.text).toContain("Reply with one option number:");
    expect(body.text).toContain("11. Synthetic choice 11");
    expect(body.text).not.toContain("decision_");
  });

  it("renders durable multi-select set actions with Submit and Cancel", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 46, date: 0 } }),
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
      {
        ...message,
        multiSelect: {
          options: [
            {
              value: "decision_00000000-0000-4000-8000-000000000001",
              label: "Unit one",
              selected: false,
            },
            {
              value: "decision_00000000-0000-4000-8000-000000000002",
              label: "Unit two",
              selected: true,
            },
          ],
          minSelections: 1,
          maxSelections: 2,
          submitToken: "draft_submit_00000000-0000-4000-8000-000000000003",
          cancelToken: "draft_cancel_00000000-0000-4000-8000-000000000004",
        },
      },
      { idempotencyKey: "evt_multi_select_12345678" },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      text: string;
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    };
    expect(body.text).toContain("Selection draft: 1 selected · choose 1–2.");
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        {
          text: "○ Unit one",
          callback_data:
            "relay-m:s:decision_00000000-0000-4000-8000-000000000001",
        },
        {
          text: "✓ Unit two",
          callback_data:
            "relay-m:u:decision_00000000-0000-4000-8000-000000000002",
        },
      ],
      [
        {
          text: "Submit",
          callback_data:
            "relay-m:x:draft_submit_00000000-0000-4000-8000-000000000003",
        },
        {
          text: "Cancel",
          callback_data:
            "relay-m:c:draft_cancel_00000000-0000-4000-8000-000000000004",
        },
      ],
    ]);
    expect(
      body.reply_markup.inline_keyboard
        .flat()
        .every((button) => Buffer.byteLength(button.callback_data) <= 64),
    ).toBe(true);
    expect(JSON.stringify(body.reply_markup)).not.toContain("multi_option");
    expect(body).toEqual(
      JSON.parse(
        readFileSync(
          join(fixtures, "multi-select-send-message.v10.2.json"),
          "utf8",
        ),
      ),
    );
  });

  it("renders an ordered question-set step with review navigation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 47, date: 0 } }),
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
      {
        ...message,
        questionSet: {
          requestId: "request_release_12345678",
          questionId: "question_units_000001",
          kind: "multi-select",
          presentationMode: "buttons",
          requestTitle: "Release configuration",
          prompt: "Which units should run?",
          position: 2,
          total: 3,
          options: [
            {
              value: "decision_00000000-0000-4000-8000-000000000001",
              label: "Core",
              selected: true,
            },
            {
              value: "decision_00000000-0000-4000-8000-000000000002",
              label: "UI",
              selected: false,
            },
          ],
          backToken: "wizard_back_00000000-0000-4000-8000-000000000003",
          nextToken: "wizard_next_00000000-0000-4000-8000-000000000004",
          submitToken: "wizard_submit_00000000-0000-4000-8000-000000000005",
          cancelToken: "wizard_cancel_00000000-0000-4000-8000-000000000006",
        },
      },
      { idempotencyKey: "evt_question_set_12345678" },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      text: string;
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    };
    expect(body.text).toContain("Request: Release configuration · 12345678");
    expect(body.text).toContain("Question 2 of 3: Which units should run?");
    expect(
      body.reply_markup.inline_keyboard
        .flat()
        .every((button) => Buffer.byteLength(button.callback_data) <= 64),
    ).toBe(true);
    expect(JSON.stringify(body.reply_markup)).not.toContain(
      "question_units_000001",
    );
    expect(body).toEqual(
      JSON.parse(
        readFileSync(
          join(fixtures, "question-set-send-message.v10.2.json"),
          "utf8",
        ),
      ),
    );
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
