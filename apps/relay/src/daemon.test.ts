import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "./daemon.js";

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
  it("starts long polling for a fully configured local Telegram adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "-10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: -10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "poll",
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Promise.all([daemon.close(), daemon.close()]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/getUpdates");
  });

  it("leaves update intake to the HTTP endpoint in webhook mode", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "-10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: -10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "webhook",
      telegramWebhookSecret: "synthetic-webhook-secret",
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    await daemon.close();

    expect(fetchMock).not.toHaveBeenCalled();
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
});
