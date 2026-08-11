import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createWhooshBangContractMock,
} from "@whooshbang/contract-mock";
import { makeProjectRef } from "@agent-relay/protocol";
import { webhookSignature } from "@agent-relay/webhook-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "./daemon.js";
import {
  acquireTelegramPollingLease,
  TelegramPollingLeaseError,
} from "./telegram-polling-lease.js";
import { whooshbangStreamKey } from "./whooshbang-poller.js";
import { WebCredentialSchema } from "./web-credential.js";

const temporaryDirectories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-daemon-"));
  temporaryDirectories.push(directory);
  return join(directory, "relay.sqlite");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic daemon lease port is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("startDaemon Telegram update mode", () => {
  it("rejects an invalid startup backlog age before opening the daemon", async () => {
    await expect(
      startDaemon({
        databasePath: await temporaryDatabase(),
        startupBacklogMaxAgeMs: -1,
      }),
    ).rejects.toThrow("startup backlog max age");
  });

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

  it("does not select or contact Telegram merely because credentials exist", async () => {
    const telegramFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("unselected Telegram must not be contacted"),
      );
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "fake",
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramFetch,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId: "evt_explicit_fake_transport_12345678",
      occurredAt: "2026-07-26T21:00:00.000Z",
      sequence: 1,
      machineId: "machine_explicit_fake_12345678",
      bridgeSessionId: "bridge_explicit_fake_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_explicit_fake_12345678",
      project: {
        displayName: "synthetic-explicit-fake",
        cwdHash: `sha256:${"b".repeat(64)}`,
      },
      type: "turn.stopped",
      summary: "Synthetic explicit fake delivery",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(daemon.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    expect(daemon.service.transport.name).toBe("fake-telegram");
    expect(telegramFetch).not.toHaveBeenCalled();
    await daemon.close();
  });

  it("delivers through an explicitly selected signed webhook and exposes only safe runtime status", async () => {
    const secret = "synthetic-daemon-webhook-secret-0001";
    const received: Array<{
      body: string;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({ body, headers: request.headers });
        const deliveryId = (JSON.parse(body) as { deliveryId: string })
          .deliveryId;
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            schema: "agent-relay-webhook-ack.v1",
            deliveryId,
            messageId: "receiver_daemon_webhook_12345678",
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", () => {
        receiver.off("error", reject);
        resolve();
      });
    });
    const receiverAddress = receiver.address();
    if (receiverAddress === null || typeof receiverAddress === "string") {
      throw new Error("synthetic webhook receiver did not open a TCP port");
    }
    const telegramFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("unselected Telegram must not be contacted"),
      );
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "webhook",
      webhook: {
        endpoint: `http://127.0.0.1:${String(receiverAddress.port)}/agent-relay`,
        secret,
        now: () => new Date("2026-07-28T14:00:00.000Z"),
      },
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    try {
      daemon.service.ingest({
        schema: "agent-attention.v1",
        eventId: "event_daemon_webhook_12345678",
        occurredAt: "2026-07-28T14:00:00.000Z",
        sequence: 1,
        machineId: "machine_daemon_webhook_12345678",
        bridgeSessionId: "bridge_daemon_webhook_12345678",
        harness: "codex",
        surface: "cli",
        harnessVersion: "test",
        sessionId: "session_daemon_webhook_12345678",
        project: {
          ...makeProjectRef("/private/workspace/agent-relay"),
          branch: "codex/webhook-daemon",
        },
        type: "turn.stopped",
        summary: "Synthetic signed webhook delivery",
        capabilities: {
          inlineContinue: true,
          lateResume: true,
          activeSteer: false,
          permissionDecision: true,
        },
      });
      await expect(daemon.service.drain()).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        retrying: 0,
        deadLettered: 0,
      });
      expect(received).toHaveLength(1);
      const delivery = received[0]!;
      const timestamp = String(delivery.headers["x-agent-relay-timestamp"]);
      expect(delivery.headers["idempotency-key"]).toBe(
        "event_daemon_webhook_12345678",
      );
      expect(delivery.headers["x-agent-relay-signature"]).toBe(
        webhookSignature(secret, timestamp, delivery.body),
      );
      expect(JSON.parse(delivery.body)).toMatchObject({
        schema: "agent-relay-webhook.v1",
        deliveryId: "event_daemon_webhook_12345678",
        source: {
          harness: "codex",
          repository: "agent-relay",
          branch: "codex/webhook-daemon",
          sessionKey: expect.stringMatching(/^[a-f0-9]{24}$/u),
        },
      });
      expect(delivery.body).not.toContain("/private/workspace");
      expect(delivery.body).not.toContain(secret);
      expect(telegramFetch).not.toHaveBeenCalled();

      const daemonAddress = daemon.server.address();
      if (daemonAddress === null || typeof daemonAddress === "string") {
        throw new Error("daemon did not expose a TCP address");
      }
      const status = await (
        await fetch(`http://127.0.0.1:${daemonAddress.port}/v1/status`)
      ).json();
      expect(status).toMatchObject({
        selectedTransport: "webhook",
        transport: "webhook",
        transportRuntime: {
          webhook: {
            delivery: {
              lastError: null,
              lastSuccessfulSendAt: expect.any(String),
            },
            spool: {
              deadLetter: 0,
              pending: 0,
              retrying: 0,
            },
          },
        },
      });
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(status)).not.toContain(receiverAddress.port);
    } finally {
      await daemon.close();
      await new Promise<void>((resolve, reject) => {
        receiver.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });

  it("delivers only through explicitly selected WhooshBang and reports safe runtime state", async () => {
    const mock = createWhooshBangContractMock();
    const whooshbangFetch = vi.fn<typeof fetch>(
      async (input, init) => await mock.fetch(new Request(input, init)),
    );
    const telegramFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("unselected Telegram must not be contacted"),
      );
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "whooshbang",
      whooshbang: {
        baseUrl: "https://whooshbang.mock.test",
        credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
        subscriberId: "agent_relay_operator",
        notifierId: "default",
        bindingId: "binding_synthetic_relay",
        machineClientId: "machine_client_synthetic_001",
        machineId: "machine_synthetic_a",
        fetch: whooshbangFetch,
      },
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramFetch,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId: "evt_explicit_whooshbang_12345678",
      occurredAt: "2026-07-26T21:05:00.000Z",
      sequence: 1,
      machineId: "machine_explicit_whooshbang_12345678",
      bridgeSessionId: "bridge_explicit_whooshbang_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_explicit_whooshbang_12345678",
      project: {
        displayName: "synthetic-explicit-whooshbang",
        cwdHash: `sha256:${"c".repeat(64)}`,
      },
      type: "turn.stopped",
      summary: "Synthetic explicit WhooshBang delivery",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(daemon.service.drain()).resolves.toMatchObject({
      delivered: 1,
      retrying: 0,
      deadLettered: 0,
    });
    expect(mock.inspect().messages).toHaveLength(1);
    expect(whooshbangFetch).toHaveBeenCalled();
    expect(telegramFetch).not.toHaveBeenCalled();

    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("daemon did not expose a TCP address");
    }
    const status = (await (
      await fetch(`http://127.0.0.1:${address.port}/v1/status`)
    ).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      selectedTransport: "whooshbang",
      transport: "whooshbang",
      transportRuntime: {
        selection: {
          configured: true,
          selected: "whooshbang",
          source: "command-line",
        },
        whooshbang: {
          circuit: { blocked: false },
          delivery: {
            lastError: null,
            lastSuccessfulSendAt: expect.any(String),
          },
          polling: {
            committedCursorRef: null,
            lastError: null,
            lastSuccessfulPollAt: expect.any(String),
            state: "active",
            unacknowledgedEventCount: 0,
          },
          spool: {
            deadLetter: 0,
            pending: 0,
            retrying: 0,
          },
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain(
      CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
    );
    await daemon.close();
  });

  it("resolves and acknowledges a hosted choice through the running daemon", async () => {
    const mock = createWhooshBangContractMock({
      scenario: "interaction-select",
    });
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "whooshbang",
      whooshbang: {
        baseUrl: "https://whooshbang.mock.test",
        credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
        subscriberId: "agent_relay_operator",
        notifierId: "default",
        bindingId: "binding_synthetic_relay",
        machineClientId: "machine_client_synthetic_001",
        machineId: "machine_synthetic_a",
        fetch: async (input, init) =>
          await mock.fetch(new Request(input, init)),
      },
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const correlationId = "request_daemon_hosted_choice_12345678";
    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId: "event_daemon_hosted_choice_12345678",
      occurredAt: "2026-07-25T17:45:00.000Z",
      sequence: 1,
      machineId: "machine_synthetic_a",
      bridgeSessionId: "bridge_daemon_hosted_choice_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_daemon_hosted_choice_12345678",
      turnId: "turn_daemon_hosted_choice_12345678",
      project: makeProjectRef("/workspace/daemon-hosted-choice"),
      type: "input.required",
      request: {
        correlationId,
        kind: "select",
        question: "Choose one synthetic path.",
        options: [
          { id: "option_daemon_alpha_12345678", label: "Alpha" },
          { id: "option_daemon_beta_12345678", label: "Beta" },
        ],
        expiresAt: "2026-07-25T18:00:00.000Z",
      },
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(daemon.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    const pending = daemon.service.store.getPendingRequest(correlationId)!;
    const beta = pending.options.find(
      (option) => option.optionId === "option_daemon_beta_12345678",
    );
    const messageId = mock.inspect().messages[0]?.id;
    if (beta === undefined || messageId === undefined) {
      throw new Error("hosted choice identities were not persisted");
    }
    await expect(
      mock.control.submitInteraction({
        messageId,
        response: { type: "select", value: beta.token },
      }),
    ).resolves.toMatchObject({ eventCreated: true, outcome: "authorized" });

    const streamKey = whooshbangStreamKey(
      "https://whooshbang.mock.test",
      "machine_client_synthetic_001",
    );
    await vi.waitFor(
      () => {
        expect(
          daemon.service.store.getPendingRequest(correlationId),
        ).toMatchObject({
          state: "answered",
          answer: "option_daemon_beta_12345678",
          resolvedBy: "whooshbang",
        });
        expect(mock.inspect().cursorCommits).toHaveLength(1);
        expect(
          daemon.service.store.hostedPollStatus(streamKey).messageUpdates,
        ).toMatchObject({
          blocked: 1,
          pending: 0,
          retry: 0,
          updated: 0,
        });
      },
      { timeout: 2_000 },
    );
    const rawCursor =
      daemon.service.store.hostedPollStatus(streamKey).committedCursor;
    const address = daemon.server.address();
    if (
      rawCursor === undefined ||
      address === null ||
      typeof address === "string"
    ) {
      throw new Error("hosted daemon cursor/status evidence is unavailable");
    }
    const status = await (
      await fetch(`http://127.0.0.1:${address.port}/v1/status`)
    ).json();
    expect(status).toMatchObject({
      transportRuntime: {
        whooshbang: {
          polling: {
            committedCursorRef: expect.stringMatching(/^cursor_[a-f0-9]{12}$/u),
            state: "active",
            unacknowledgedEventCount: 0,
          },
          presentation: {
            capability: "unsupported",
            blocked: 1,
            pending: 0,
            retrying: 0,
            updated: 0,
            lastError: {
              category: "operator-action",
              classification: "terminal",
              code: "whooshbang-resolution-update-unsupported",
            },
          },
        },
      },
    });
    const serializedStatus = JSON.stringify(status);
    expect(serializedStatus).not.toContain(rawCursor);
    expect(serializedStatus).not.toContain(messageId);
    expect(serializedStatus).not.toContain(correlationId);
    expect(serializedStatus).not.toContain(beta.token);
    expect(serializedStatus).not.toContain("binding_synthetic_relay");
    expect(serializedStatus).not.toContain("machine_synthetic_a");
    await daemon.close();
  });

  it("stops hosted calls after disconnect, preserves local authority, and recovers after restart", async () => {
    const databasePath = await temporaryDatabase();
    const mock = createWhooshBangContractMock();
    let active = true;
    const connectionGuard = async () => active;
    const hostedFetch: typeof fetch = async (input, init) =>
      await mock.fetch(new Request(input, init));
    const whooshbang = {
      baseUrl: "https://whooshbang.mock.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      subscriberId: "agent_relay_operator",
      notifierId: "default",
      bindingId: "binding_synthetic_relay",
      machineClientId: "machine_client_synthetic_001",
      machineId: "machine_synthetic_a",
      connectionGuard,
      fetch: hostedFetch,
    };
    const daemon = await startDaemon({
      databasePath,
      port: 0,
      selectedTransport: "whooshbang",
      whooshbang,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const correlationId = "request_daemon_disconnect_12345678";
    const eventId = "event_daemon_disconnect_12345678";
    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId,
      occurredAt: "2026-07-25T17:45:00.000Z",
      sequence: 1,
      machineId: "machine_synthetic_a",
      bridgeSessionId: "bridge_daemon_disconnect_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_daemon_disconnect_12345678",
      turnId: "turn_daemon_disconnect_12345678",
      project: makeProjectRef("/workspace/daemon-disconnect"),
      type: "input.required",
      request: {
        correlationId,
        kind: "confirm",
        question: "Confirm synthetic disconnect preservation.",
        expiresAt: "2026-07-25T18:00:00.000Z",
      },
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(daemon.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    const hostedMessageId = mock.inspect().messages[0]?.id;
    if (hostedMessageId === undefined) {
      throw new Error("disconnect fixture did not create a hosted message");
    }
    expect(
      daemon.service.store.resolveRequest({
        correlationId,
        answer: "yes_option",
        resolvedBy: "terminal",
        now: "2026-07-25T17:46:00.000Z",
      }),
    ).toMatchObject({ outcome: "answered" });

    active = false;
    await vi.waitFor(() => {
      expect(
        daemon.service.store.hostedPollStatus(
          whooshbangStreamKey(whooshbang.baseUrl, whooshbang.machineClientId),
        ).lastError,
      ).toMatchObject({ code: "whooshbang-connection-inactive" });
    });
    daemon.service.ingest({
      schema: "agent-attention.v1",
      eventId: "event_daemon_disconnected_delivery_12345678",
      occurredAt: "2026-07-25T17:47:00.000Z",
      sequence: 2,
      machineId: "machine_synthetic_a",
      bridgeSessionId: "bridge_daemon_disconnect_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_daemon_disconnect_12345678",
      project: makeProjectRef("/workspace/daemon-disconnect"),
      type: "turn.stopped",
      summary: "Retain this local event while disconnected.",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(daemon.service.drain()).resolves.toMatchObject({
      deadLettered: 1,
      delivered: 0,
    });
    expect(mock.inspect().messages).toHaveLength(1);
    expect(daemon.service.store.getPendingRequest(correlationId)).toMatchObject(
      {
        state: "answered",
        resolvedBy: "terminal",
      },
    );
    expect(
      daemon.service.store.getHostedDeliveryForMessage(
        whooshbangStreamKey(whooshbang.baseUrl, whooshbang.machineClientId),
        hostedMessageId,
      ),
    ).toMatchObject({ eventId });
    await daemon.close();

    active = true;
    const restarted = await startDaemon({
      databasePath,
      port: 0,
      selectedTransport: "whooshbang",
      whooshbang,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    restarted.service.ingest({
      schema: "agent-attention.v1",
      eventId: "event_daemon_reconnected_delivery_12345678",
      occurredAt: "2026-07-25T17:48:00.000Z",
      sequence: 3,
      machineId: "machine_synthetic_a",
      bridgeSessionId: "bridge_daemon_disconnect_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_daemon_disconnect_12345678",
      project: makeProjectRef("/workspace/daemon-disconnect"),
      type: "turn.stopped",
      summary: "Deliver after explicit reconnect restart.",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(restarted.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    expect(mock.inspect().messages).toHaveLength(2);
    expect(
      restarted.service.store.getPendingRequest(correlationId),
    ).toMatchObject({
      state: "answered",
      resolvedBy: "terminal",
    });
    await restarted.close();
  });

  it("keeps polling ownership until delayed shutdown settles even when another component fails", async () => {
    let pollCalls = 0;
    let finishPollAbort: (() => void) | undefined;
    let observePollAbort: (() => void) | undefined;
    const pollAbortObserved = new Promise<void>((resolve) => {
      observePollAbort = resolve;
    });
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
        if (url.includes("/setMyCommands")) {
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        if (url.includes("/getMyCommands")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  command: "status",
                  description: "Show this session or all open sessions",
                },
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
          );
        }
        if (url.includes("/getUpdates")) {
          pollCalls += 1;
          if (pollCalls === 1) {
            return new Response(JSON.stringify({ ok: true, result: [] }));
          }
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            observePollAbort?.();
            finishPollAbort = () =>
              reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
    const pollingLeasePort = await availablePort();
    const runnerBridge = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        throw new Error("synthetic runner stop failure");
      }),
      status: () => ({ enabled: true, state: "ready" }),
    };
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "telegram",
      telegramToken: "123456:synthetic-token-value",
      telegramChatId: "10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "poll",
      telegramPollingLeasePort: pollingLeasePort,
      runnerBridge,
      runnerBridgeEnabled: true,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Telegram daemon did not expose a TCP address");
    }
    const status = await (
      await fetch(`http://127.0.0.1:${String(address.port)}/v1/status`)
    ).json();
    expect(status).toMatchObject({
      transportRuntime: {
        telegram: {
          intake: {
            mode: "poll",
            localOwnership: "held",
            state: "active",
            replyReady: true,
            lastSuccessfulPollAt: expect.any(String),
            lastError: null,
          },
        },
      },
    });
    const storeClose = vi.spyOn(daemon.service.store, "close");
    const close = daemon.close();
    expect(daemon.close()).toBe(close);
    await pollAbortObserved;
    await expect(
      acquireTelegramPollingLease({ port: pollingLeasePort }),
    ).rejects.toBeInstanceOf(TelegramPollingLeaseError);
    finishPollAbort?.();
    await expect(close).rejects.toThrow("synthetic runner stop failure");
    expect(storeClose).toHaveBeenCalledOnce();

    const replacement = await acquireTelegramPollingLease({
      port: pollingLeasePort,
    });
    await replacement.release();

    expect(String(fetchMock.mock.calls[5]?.[0])).toContain("/getUpdates");
  });

  it("refuses a second isolated local poller before any provider setup call", async () => {
    const pollingLeasePort = await availablePort();
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
        if (url.includes("/setMyCommands")) {
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        if (url.includes("/getMyCommands")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  command: "status",
                  description: "Show this session or all open sessions",
                },
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
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
    const options = {
      port: 0,
      selectedTransport: "telegram" as const,
      telegramToken: "223456:synthetic-shared-token-value",
      telegramChatId: "10001",
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "poll" as const,
      telegramPollingLeasePort: pollingLeasePort,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    };
    const first = await startDaemon({
      ...options,
      databasePath: await temporaryDatabase(),
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/getUpdates"),
        ),
      ).toBe(true),
    );
    const providerCallsBeforeConflict = fetchMock.mock.calls.length;

    await expect(
      startDaemon({ ...options, databasePath: await temporaryDatabase() }),
    ).rejects.toMatchObject({
      code: "telegram-poller-already-owned",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(providerCallsBeforeConflict);

    await first.close();
    const replacement = await startDaemon({
      ...options,
      databasePath: await temporaryDatabase(),
    });
    await replacement.close();
  });

  it("reports one terminal provider polling conflict without retrying or leaking identity", async () => {
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
        if (url.includes("/getWebhookInfo")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { url: "", pending_update_count: 0 },
            }),
          );
        }
        if (url.includes("/setMyCommands")) {
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        if (url.includes("/getMyCommands")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  command: "status",
                  description: "Show this session or all open sessions",
                },
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
          );
        }
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 409,
            description:
              "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
          }),
          { status: 409 },
        );
      });
    const privateToken = "323456:synthetic-private-token-value";
    const privateChat = "10001";
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "telegram",
      telegramToken: privateToken,
      telegramChatId: privateChat,
      telegramOperatorUserId: 10002,
      telegramReplyChatId: 10001,
      telegramFetch: fetchMock,
      telegramUpdateMode: "poll",
      telegramPollingLeasePort: await availablePort(),
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Telegram daemon did not expose a TCP address");
    }
    let status: unknown;
    await vi.waitFor(async () => {
      status = await (
        await fetch(`http://127.0.0.1:${String(address.port)}/v1/status`)
      ).json();
      expect(status).toMatchObject({
        transportRuntime: {
          telegram: {
            intake: {
              mode: "poll",
              localOwnership: "held",
              state: "blocked",
              replyReady: false,
              lastSuccessfulPollAt: null,
              lastError: {
                code: "telegram-polling-conflict",
                at: expect.any(String),
              },
            },
          },
        },
      });
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/getUpdates"),
      ),
    ).toHaveLength(1);
    const blockedEvent = {
      schema: "agent-attention.v1",
      eventId: "event_blocked_telegram_delivery_12345678",
      occurredAt: "2026-08-10T22:50:21.000Z",
      sequence: 1,
      machineId: "machine_blocked_telegram_12345678",
      bridgeSessionId: "bridge_blocked_telegram_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_blocked_telegram_12345678",
      turnId: "turn_blocked_telegram_12345678",
      project: makeProjectRef("/workspace/blocked-telegram"),
      type: "input.required",
      request: {
        correlationId: "request_blocked_telegram_12345678",
        kind: "input",
        question: "Synthetic blocked reply intake.",
        expiresAt: "2026-08-10T23:50:21.000Z",
      },
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    } as const;
    const blockedActivation = await fetch(
      `http://127.0.0.1:${String(address.port)}/v1/canaries/telegram`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(blockedEvent),
      },
    );
    expect(blockedActivation.status).toBe(409);
    await expect(blockedActivation.json()).resolves.toMatchObject({
      code: "telegram-intake-not-ready",
    });
    expect(daemon.service.store.getEvent(blockedEvent.eventId)).toBeUndefined();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/sendMessage"),
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(status)).not.toContain(privateToken);
    expect(JSON.stringify(status)).not.toContain(privateChat);
    await daemon.close();
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
        if (url.includes("/getWebhookInfo")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                url: "https://relay.invalid/v1/telegram/updates",
                pending_update_count: 0,
              },
            }),
          );
        }
        if (url.includes("/setMyCommands")) {
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                command: "status",
                description: "Show this session or all open sessions",
              },
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
        );
      });
    const daemon = await startDaemon({
      databasePath: await temporaryDatabase(),
      port: 0,
      selectedTransport: "telegram",
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

    expect(fetchMock).toHaveBeenCalledTimes(5);
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
        selectedTransport: "telegram",
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
        selectedTransport: "telegram",
        telegramToken: "123456:synthetic-token-value",
        telegramChatId: "10001",
        telegramOperatorUserId: 10002,
        telegramReplyChatId: 10001,
        telegramFetch: fetchMock,
        telegramUpdateMode: "poll",
        telegramPollingLeasePort: await availablePort(),
      }),
    ).rejects.toMatchObject({
      code: "telegram-topics-disabled",
      message: expect.stringContaining("enable Threaded Mode"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
