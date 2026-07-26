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

    const webCredentialPath = daemon.webCredentialPath;
    expect(webCredentialPath).toBe(
      join(dirname(databasePath), "web-credential.json"),
    );
    if (webCredentialPath === undefined) {
      throw new Error("enabled web companion did not create a credential");
    }
    expect((await stat(webCredentialPath)).mode & 0o777).toBe(0o600);
    expect(
      WebCredentialSchema.parse(
        JSON.parse(await readFile(webCredentialPath, "utf8")) as unknown,
      ),
    ).toMatchObject({ schema: "agent-relay-web-credential.v1" });
    expect(JSON.stringify(daemon)).not.toContain("csrfToken");
    await daemon.close();
  });

  it("disables every browser surface without changing the daemon loop", async () => {
    const databasePath = await temporaryDatabase();
    const credentialPath = join(dirname(databasePath), "web-credential.json");
    const daemon = await startDaemon({
      databasePath,
      webEnabled: false,
      port: 0,
      telegramOperatorUserId: 7001,
      telegramReplyChatId: 9001,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("daemon did not expose a TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    expect(daemon.webCredentialPath).toBeUndefined();
    await expect(stat(credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fetch(`${baseUrl}/ui/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/web/sessions`)).status).toBe(404);
    expect(await (await fetch(`${baseUrl}/v1/health`)).json()).toEqual({
      healthy: true,
    });
    expect(await (await fetch(`${baseUrl}/v1/status`)).json()).toMatchObject({
      healthy: true,
      webEnabled: false,
      transport: "fake-telegram",
    });

    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId: "evt_web_disabled_loop_12345678",
      occurredAt: "2026-07-24T12:00:00.000Z",
      sequence: 1,
      machineId: "machine_web_disabled_12345678",
      bridgeSessionId: "bridge_web_disabled_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_web_disabled_12345678",
      project: {
        displayName: "synthetic-demo",
        cwdHash: `sha256:${"a".repeat(64)}`,
      },
      type: "turn.stopped",
      summary: "Synthetic web-disabled delivery",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    expect(await daemon.service.drain()).toMatchObject({ delivered: 1 });
    expect(daemon.service.transport.name).toBe("fake-telegram");
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
