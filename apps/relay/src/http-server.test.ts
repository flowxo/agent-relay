import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  FakeTelegramTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
  TelegramReplyRouter,
} from "@agent-relay/core";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { createRelayHttpServer } from "./http-server.js";

function event(): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_http_server_12345678",
    occurredAt: "2026-07-24T12:00:00.000Z",
    sequence: 1,
    machineId: "machine_http_12345678",
    bridgeSessionId: "bridge_http_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_http_12345678",
    project: makeProjectRef("/workspace/example"),
    type: "turn.stopped",
    summary: "Synthetic HTTP event",
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

async function setup(token?: string, telegramWebhookSecret?: string) {
  const store = new RelayStore();
  const transport = new FakeTelegramTransport();
  const logger = new MemoryLogger();
  const service = new RelayService(store, transport, {
    logger,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const replyRouter = new TelegramReplyRouter(store, transport, {
    operatorUserId: 7001,
    chatId: 9001,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const server = createRelayHttpServer(service, {
    ...(token === undefined ? {} : { token }),
    logger,
    replyRouter,
    ...(telegramWebhookSecret === undefined ? {} : { telegramWebhookSecret }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const close = async () => {
    server.close();
    await once(server, "close");
    store.close();
  };
  return {
    store,
    service,
    transport,
    logger,
    client: new RelayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      ...(token === undefined ? {} : { token }),
      ...(telegramWebhookSecret === undefined ? {} : { telegramWebhookSecret }),
    }),
    baseUrl: `http://127.0.0.1:${address.port}`,
    close,
  };
}

describe("relay HTTP daemon", () => {
  it("ingests, deduplicates, drains, and reports status", async () => {
    const runtime = await setup();
    const input = event();
    expect(await runtime.client.ingest(input)).toMatchObject({
      inserted: true,
      status: "queued",
    });
    expect(await runtime.client.ingest(input)).toMatchObject({
      inserted: false,
    });
    expect(await runtime.client.drain()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    expect(await runtime.client.status()).toMatchObject({
      healthy: true,
      pendingDeliveryCount: 0,
      events: { delivered: 1 },
      topics: { ready: 1 },
      sessionControlRecords: [],
      topicRecords: [
        expect.objectContaining({
          sessionId: input.sessionId,
          provisioningStatus: "ready",
          topicId: "1000",
        }),
      ],
    });
    expect(runtime.transport.deliveries).toHaveLength(1);
    await runtime.close();
  });

  it("persists and deduplicates bounded diagnostics", async () => {
    const runtime = await setup();
    const diagnostic = {
      schema: "agent-relay-diagnostic.v1" as const,
      diagnosticId: "diag_http_server_12345678",
      recordedAt: "2026-07-24T12:00:00.000Z",
      source: "fallback-spool" as const,
      level: "warn" as const,
      code: "fallback.invalid-record",
      message: "Synthetic invalid fallback record",
    };

    await expect(runtime.client.reportDiagnostic(diagnostic)).resolves.toEqual({
      diagnosticId: diagnostic.diagnosticId,
      inserted: true,
    });
    await expect(runtime.client.reportDiagnostic(diagnostic)).resolves.toEqual({
      diagnosticId: diagnostic.diagnosticId,
      inserted: false,
    });
    await expect(runtime.client.listDiagnostics()).resolves.toEqual([
      diagnostic,
    ]);
    expect((await runtime.client.status()).diagnostics).toMatchObject({
      warn: 1,
      total: 1,
    });
    await runtime.close();
  });

  it("runs bounded retention maintenance and rejects unsafe limits", async () => {
    const runtime = await setup();
    await expect(
      runtime.client.maintainRetention({ deliveredDays: 30, limit: 100 }),
    ).resolves.toMatchObject({
      requestsExpired: 0,
      events: 0,
      diagnostics: 0,
    });
    const response = await fetch(
      `${runtime.baseUrl}/v1/maintenance/retention`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliveredDays: 0 }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid-payload",
    });
    await runtime.close();
  });

  it("rejects malformed payloads with actionable issues and logs the failure", async () => {
    const runtime = await setup();
    const response = await fetch(`${runtime.baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "agent-attention.v1" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid-payload",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "eventId" }),
      ]),
    });
    expect(
      runtime.logger.records.some(
        (record) => record.code === "http.request-failed",
      ),
    ).toBe(true);
    await runtime.close();
  });

  it("requires the configured daemon token without reflecting it", async () => {
    const token = "synthetic-daemon-secret";
    const runtime = await setup(token);
    const response = await fetch(`${runtime.baseUrl}/v1/status`);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(token);
    await runtime.close();
  });

  it("exposes terminal and Telegram resolution through one first-writer-wins store", async () => {
    const runtime = await setup();
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_http_question_12345678",
      turnId: "turn_http_question_12345678",
      type: "input.required",
      request: {
        correlationId: "correlation_http_12345678",
        kind: "input",
        question: "Which path?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    };
    await runtime.client.ingest(input);
    await runtime.client.drain();
    expect(
      await runtime.client.resolveTerminal({
        correlationId: "correlation_http_12345678",
        answer: "terminal answer",
        expected: {
          machineId: input.machineId,
          harness: input.harness,
          sessionId: input.sessionId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      await runtime.client.handleTelegramUpdate({
        update_id: 600,
        message: {
          message_id: 700,
          message_thread_id: Number(
            runtime.transport.deliveries[0]?.context.topicId,
          ),
          from: { id: 7001 },
          chat: { id: 9001 },
          text: "late Telegram answer",
          reply_to_message: {
            message_id: Number(
              runtime.transport.deliveries[0]?.receipt.messageId,
            ),
          },
        },
      }),
    ).toMatchObject({ outcome: "duplicate-answer" });
    expect(
      runtime.store.getPendingRequest("correlation_http_12345678")?.answer,
    ).toBe("terminal answer");
    await runtime.close();
  });

  it("validates the Telegram webhook secret before claiming an update", async () => {
    const runtime = await setup(undefined, "synthetic-webhook-secret");
    const response = await fetch(`${runtime.baseUrl}/v1/telegram/updates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 900 }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "telegram-webhook-unauthorized",
    });
    await runtime.close();
  });

  it("authenticates a Telegram webhook independently from the daemon bearer token", async () => {
    const runtime = await setup(
      "synthetic-daemon-secret",
      "synthetic-webhook-secret",
    );
    const response = await fetch(`${runtime.baseUrl}/v1/telegram/updates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "synthetic-webhook-secret",
      },
      body: JSON.stringify({ update_id: 901 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unsupported",
      updateId: 901,
    });
    await runtime.close();
  });
});
