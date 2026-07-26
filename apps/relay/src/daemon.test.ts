import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "./daemon.js";
import { WebCredentialSchema } from "./web-credential.js";

const temporaryDirectories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-daemon-"));
  temporaryDirectories.push(directory);
  return join(directory, "relay.sqlite");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("startDaemon Telegram update mode", () => {
  it("creates and reports only the path to a private web credential", async () => {
    const databasePath = await temporaryDatabase();
    const daemon = await startDaemon({
      databasePath,
      port: 0,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    expect(daemon.webCredentialPath).toBe(
      join(dirname(databasePath), "web-credential.json"),
    );
    expect((await stat(daemon.webCredentialPath)).mode & 0o777).toBe(0o600);
    expect(
      WebCredentialSchema.parse(
        JSON.parse(await readFile(daemon.webCredentialPath, "utf8")) as unknown,
      ),
    ).toMatchObject({ schema: "agent-relay-web-credential.v1" });
    expect(JSON.stringify(daemon)).not.toContain("csrfToken");
    await daemon.close();
  });

  it("starts long polling for a fully configured local Telegram adapter", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 10002,
                is_bot: true,
                has_topics_enabled: true,
              },
            }),
          );
        }
        if (url.includes("/getChat")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { id: 10001, type: "private" },
            }),
          );
        }
        if (url.includes("/getWebhookInfo")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { url: "", pending_update_count: 0 },
            }),
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "poll",
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await Promise.all([daemon.close(), daemon.close()]);

    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/getUpdates");
  });

  it("leaves update intake to the HTTP endpoint in webhook mode", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 10002,
                is_bot: true,
                has_topics_enabled: true,
              },
            }),
          );
        }
        if (url.includes("/getChat")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { id: 10001, type: "private" },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: "https://relay.invalid/v1/telegram/updates",
              pending_update_count: 0,
            },
          }),
        );
      });
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "webhook",
      telegramWebhookSecret: "synthetic-webhook-secret",
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    await daemon.close();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/getUpdates"),
      ),
    ).toBe(false);
  });

  it("rejects webhook mode without Telegram's independent secret", async () => {
    await expect(
      startDaemon({
        databasePath: await temporaryDatabase(),
        port: 0,
        telegramToken: "123456:synthetic-token-value",
        telegramChatId: "-10001",
        telegramOperatorUserId: 10002,
        telegramReplyChatId: -10001,
        telegramUpdateMode: "webhook",
      }),
    ).rejects.toThrow(
      "Telegram webhook mode requires AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
    );
  });

  it("fails startup clearly when private topic mode is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 10002,
            is_bot: true,
            has_topics_enabled: false,
          },
        }),
      ),
    );

    await expect(
      startDaemon({
        databasePath: await temporaryDatabase(),
        port: 0,
        telegramToken: "123456:synthetic-token-value",
        telegramChatId: "10001",
        telegramOperatorUserId: 10002,
        telegramReplyChatId: 10001,
        telegramFetch: fetchMock,
        telegramUpdateMode: "poll",
      }),
    ).rejects.toMatchObject({
      code: "telegram-topics-disabled",
      message: expect.stringContaining("enable Threaded Mode"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
