import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  FakeTelegramTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
  sessionTopicMetadata,
  TelegramReplyRouter,
} from "@agent-relay/core";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { createRelayHttpServer } from "./http-server.js";
import type { WebCredential } from "./web-credential.js";

const webCredential: WebCredential = {
  schema: "agent-relay-web-credential.v1",
  token: "synthetic-local-web-token-1234567890",
  csrfToken: "synthetic-local-csrf-token-123456789",
  createdAt: "2026-07-24T12:00:00.000Z",
};

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

async function setup(
  token?: string,
  telegramWebhookSecret?: string,
  credential?: WebCredential,
) {
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
    ...(credential === undefined ? {} : { webCredential: credential }),
    webStreamPollMs: 10,
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

function webHeaders(
  runtime: Awaited<ReturnType<typeof setup>>,
  options: { csrf?: boolean } = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${webCredential.token}`,
    origin: runtime.baseUrl,
    ...(options.csrf ? { "x-agent-relay-csrf": webCredential.csrfToken } : {}),
  };
}

describe("relay HTTP daemon", () => {
  it("serves the credential-free console shell with a locked-down policy", async () => {
    const runtime = await setup(
      "synthetic-daemon-secret",
      undefined,
      webCredential,
    );
    const page = await fetch(`${runtime.baseUrl}/ui/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const html = await page.text();
    expect(html).toContain("Agent Relay Console");
    expect(html).toContain("data-attention-list");
    expect(html).not.toContain(webCredential.token);
    expect(html).not.toContain(webCredential.csrfToken);

    const app = await fetch(`${runtime.baseUrl}/ui/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    expect(await app.text()).toContain("/v1/web/stream");
    const head = await fetch(`${runtime.baseUrl}/ui/styles.css`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await runtime.close();
  });

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

  it("exposes only bounded, transcript-free browser read models", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_safe_detail_12345678",
      turnId: "turn_web_safe_detail_12345678",
      type: "input.required",
      summary: "Choose a safe label",
      lastAssistantMessage: "PRIVATE_TRANSCRIPT_SENTINEL",
      request: {
        correlationId: "request_web_safe_detail_12345678",
        kind: "select",
        question: "Where should this run?",
        options: [
          { id: "option_web_staging_12345678", label: "Staging" },
          { id: "option_web_prod_1234567890", label: "Production" },
        ],
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    };
    runtime.service.ingest(input);

    const sessions = await fetch(`${runtime.baseUrl}/v1/web/sessions?limit=1`, {
      headers: webHeaders(runtime),
    });
    const attention = await fetch(
      `${runtime.baseUrl}/v1/web/attention?limit=1`,
      { headers: webHeaders(runtime) },
    );
    const detail = await fetch(
      `${runtime.baseUrl}/v1/web/events/${input.eventId}`,
      { headers: webHeaders(runtime) },
    );
    const changes = await fetch(`${runtime.baseUrl}/v1/web/changes?limit=20`, {
      headers: webHeaders(runtime),
    });
    expect(sessions.status).toBe(200);
    expect(attention.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(changes.status).toBe(200);

    const sessionsText = await sessions.text();
    expect(JSON.parse(sessionsText)).toMatchObject({
      sessions: [
        {
          displayId: sessionTopicMetadata(input).shortSessionId,
          state: "waiting",
          lifecycleState: "waiting",
        },
      ],
    });
    const combined = [
      sessionsText,
      await attention.text(),
      await detail.text(),
      await changes.text(),
    ].join("\n");
    expect(combined).not.toContain("PRIVATE_TRANSCRIPT_SENTINEL");
    expect(combined).not.toContain(input.machineId);
    expect(combined).not.toContain(input.sessionId);
    expect(combined).not.toContain("option_token");
    expect(combined).toContain("option_web_staging_12345678");
    expect(combined).toContain("choose-option");
    expect(combined).toContain("example");
    await runtime.close();
  });

  it("requires an independent bearer token and rejects cross-origin browser requests", async () => {
    const runtime = await setup(
      "synthetic-daemon-secret",
      undefined,
      webCredential,
    );
    const missing = await fetch(`${runtime.baseUrl}/v1/web/sessions`);
    expect(missing.status).toBe(401);
    const daemonToken = await fetch(`${runtime.baseUrl}/v1/web/sessions`, {
      headers: { authorization: "Bearer synthetic-daemon-secret" },
    });
    expect(daemonToken.status).toBe(401);
    const crossOrigin = await fetch(`${runtime.baseUrl}/v1/web/sessions`, {
      headers: {
        authorization: `Bearer ${webCredential.token}`,
        origin: "https://attacker.invalid",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(await crossOrigin.text()).not.toContain(webCredential.token);
    await runtime.close();
  });

  it("requires same-origin CSRF validation and bounds browser bodies", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    runtime.service.ingest({
      ...event(),
      eventId: "evt_web_csrf_question_12345678",
      turnId: "turn_web_csrf_question_12345678",
      type: "input.required",
      request: {
        correlationId: "request_web_csrf_question_12345678",
        kind: "input",
        question: "Name?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    });
    const url = `${runtime.baseUrl}/v1/web/requests/request_web_csrf_question_12345678/resolve`;
    const body = JSON.stringify({
      schema: "agent-relay-web-resolve.v1",
      operationId: "operation_web_csrf_12345678",
      answer: "safe-answer",
    });
    const missingCsrf = await fetch(url, {
      method: "POST",
      headers: {
        ...webHeaders(runtime),
        "content-type": "application/json",
      },
      body,
    });
    expect(missingCsrf.status).toBe(403);
    const oversized = await fetch(url, {
      method: "POST",
      headers: {
        ...webHeaders(runtime, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: "agent-relay-web-resolve.v1",
        operationId: "operation_web_oversize_12345678",
        answer: "x".repeat(140_000),
      }),
    });
    expect(oversized.status).toBe(413);
    await runtime.close();
  });

  it("applies idempotent browser answers through the shared first-writer store", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_resolution_12345678",
      turnId: "turn_web_resolution_12345678",
      type: "input.required",
      request: {
        correlationId: "request_web_resolution_12345678",
        kind: "input",
        question: "Release label?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    };
    runtime.service.ingest(input);
    const url = `${runtime.baseUrl}/v1/web/requests/${input.request?.correlationId}/resolve`;
    const request = async (answer: string) =>
      await fetch(url, {
        method: "POST",
        headers: {
          ...webHeaders(runtime, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-resolve.v1",
          operationId: "operation_web_resolution_12345678",
          answer,
        }),
      });

    const first = await request("release-42");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      outcome: "answered",
      replayed: false,
      requestState: "answered",
    });
    const replay = await request("release-42");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      outcome: "answered",
      replayed: true,
    });
    const conflict = await request("release-43");
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.text();
    expect(JSON.parse(conflictBody)).toEqual({
      outcome: "replay_conflict",
      replayed: true,
    });
    expect(conflictBody).not.toContain("release-42");
    expect(
      runtime.store.getPendingRequest(input.request!.correlationId),
    ).toMatchObject({
      answer: "release-42",
      resolvedBy: "web",
    });
    await runtime.close();
  });

  it("streams only changes after the resumable SSE cursor", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    runtime.service.ingest(event());
    const cursor = runtime.store.webChangeBounds().lastCursor ?? 0;
    const nextEvent: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_sse_next_12345678",
      sequence: 2,
      type: "turn.stopped",
      summary: "Second event",
    };
    delete nextEvent.request;
    delete nextEvent.turnId;
    runtime.service.ingest(nextEvent);
    const abort = new AbortController();
    const response = await fetch(`${runtime.baseUrl}/v1/web/stream`, {
      headers: {
        ...webHeaders(runtime),
        "last-event-id": String(cursor),
      },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let payload = "";
    while (!payload.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      payload += decoder.decode(chunk.value, { stream: true });
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    const id = Number(payload.match(/(?:^|\n)id: (\d+)/)?.[1]);
    expect(id).toBeGreaterThan(cursor);
    expect(payload).not.toContain(`id: ${cursor}\n`);
    await runtime.close();
  });

  it("pushes changes that occur after an SSE connection is established", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    runtime.service.ingest(event());
    const cursor = runtime.store.webChangeBounds().lastCursor ?? 0;
    const abort = new AbortController();
    const response = await fetch(
      `${runtime.baseUrl}/v1/web/stream?after=${cursor}`,
      {
        headers: webHeaders(runtime),
        signal: abort.signal,
      },
    );
    const nextEvent: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_sse_live_12345678",
      sequence: 2,
      type: "turn.stopped",
      summary: "Live event",
    };
    delete nextEvent.request;
    delete nextEvent.turnId;
    runtime.service.ingest(nextEvent);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let payload = "";
    while (!/(?:^|\n)id: \d+/.test(payload)) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      payload += decoder.decode(chunk.value, { stream: true });
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    expect(Number(payload.match(/(?:^|\n)id: (\d+)/)?.[1])).toBeGreaterThan(
      cursor,
    );
    expect(payload).toContain("evt_web_sse_live_12345678");
    await runtime.close();
  });
});
