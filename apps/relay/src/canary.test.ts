import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeNotificationTransport } from "@agent-relay/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import type { TelegramCanaryClient } from "./canary.js";
import { runTelegramCanary } from "./canary.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function client(
  request:
    | {
        state: "open" | "answered" | "expired" | "cancelled" | "failed";
        resolvedBy?: "terminal" | "telegram";
        answer?: string;
      }
    | undefined,
  delivered = 1,
): TelegramCanaryClient {
  const record =
    request === undefined
      ? undefined
      : {
          correlationId: "correlation_telegram_canary_12345678",
          eventId: "evt_telegram_canary_12345678",
          machineId: "machine_telegram_canary_12345678",
          harness: "codex" as const,
          sessionId: "session_telegram_canary_12345678",
          state: request.state,
          requestKind: "input" as const,
          question: "Synthetic canary question",
          expiresAt: "2026-07-24T12:05:00.000Z",
          options: [],
          ...(delivered === 0 ? {} : { transportMessageId: "1001" }),
          ...(request.resolvedBy === undefined
            ? {}
            : { resolvedBy: request.resolvedBy }),
          ...(request.answer === undefined ? {} : { answer: request.answer }),
        };
  return {
    ingest: vi.fn(async (event) => ({
      eventId: event.eventId,
      inserted: true,
      status: "queued" as const,
    })),
    drain: vi.fn(async () => ({
      claimed: 1,
      delivered,
      retrying: delivered === 0 ? 1 : 0,
      deadLettered: 0,
    })),
    getRequest: vi.fn(async () => record),
    waitForAnswer: vi.fn(async (correlationId) =>
      record === undefined ? undefined : { ...record, correlationId },
    ),
  };
}

describe("Telegram activation canary", () => {
  it("delivers a bounded correlated question and confirms a Telegram reply", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "relay-canary-ok",
    });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      randomId: () => "12345678-1234-1234-1234-123456789012",
    });

    expect(result).toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
      drain: { delivered: 1 },
    });
    const event = vi.mocked(fake.ingest).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "input.required",
      request: {
        kind: "input",
        question: expect.stringContaining("relay-canary-ok"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("relay-canary-ok");
  });

  it("fails before waiting when Telegram delivery is queued for retry", async () => {
    const fake = client({ state: "open" }, 0);

    await expect(
      runTelegramCanary({
        client: fake,
        machineId: "machine_telegram_canary_12345678",
        projectPath: "/workspace/example",
        waitMs: 1_000,
        pollIntervalMs: 50,
      }),
    ).resolves.toMatchObject({ outcome: "delivery-failed" });
    expect(fake.waitForAnswer).not.toHaveBeenCalled();
  });

  it("waits for a delivery receipt claimed by the daemon background worker", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "relay-canary-ok",
    });
    const delivered = await fake.getRequest(
      "correlation_telegram_canary_12345678",
    );
    expect(delivered).toBeDefined();
    const {
      transportMessageId: _receipt,
      resolvedBy: _resolvedBy,
      answer: _answer,
      ...record
    } = delivered!;
    const pending = { ...record, state: "open" as const };
    vi.mocked(fake.getRequest)
      .mockReset()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(delivered);

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result).toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
    });
    expect(fake.getRequest).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout without copying the reply or question into output", async () => {
    const fake = client({ state: "open" });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toBe("timeout");
    expect(result).not.toHaveProperty("answer");
    expect(result).not.toHaveProperty("question");
  });

  it("fails closed when the Telegram answer does not match the challenge", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "wrong reply",
    });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toBe("unexpected-answer");
    expect(JSON.stringify(result)).not.toContain("wrong reply");
  });

  it("completes the full daemon loop through the fake Telegram transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-canary-"));
    temporaryDirectories.push(directory);
    const daemon = await startDaemon({
      databasePath: join(directory, "relay.sqlite"),
      port: 0,
      telegramOperatorUserId: 7001,
      telegramReplyChatId: 9001,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const address = daemon.server.address() as AddressInfo;
    const relayClient = new RelayClient({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
    });
    expect(daemon.service.transport).toBeInstanceOf(FakeNotificationTransport);
    const transport = daemon.service.transport as FakeNotificationTransport;
    const running = runTelegramCanary({
      client: relayClient,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 2_000,
      pollIntervalMs: 50,
      randomId: () => "12345678-1234-1234-1234-123456789012",
    });

    await vi.waitFor(() => expect(transport.deliveries).toHaveLength(1));
    await relayClient.handleTelegramUpdate({
      update_id: 909,
      message: {
        message_id: 808,
        message_thread_id: Number(transport.deliveries[0]?.context.topicId),
        from: { id: 7001 },
        chat: { id: 9001 },
        text: "relay-canary-ok",
        reply_to_message: {
          message_id: Number(transport.deliveries[0]?.receipt.messageId),
        },
      },
    });

    await expect(running).resolves.toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
    });
    await daemon.close();
  });
});
