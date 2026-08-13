import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  FakeNotificationTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
  sessionTopicMetadata,
} from "@agent-relay/core";
import { TelegramReplyRouter } from "@agent-relay/telegram-transport";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { createRelayHttpServer } from "./http-server.js";
import type { WebCredential } from "./web-credential.js";
import { WebSessionAuthority } from "./web-session.js";

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

function webSessionKey(input: AgentAttentionEventV1): string {
  return sha256(
    `${input.machineId}\u001f${input.harness}\u001f${input.sessionId}`,
  ).slice(0, 24);
}

function webQuestionSetEvent(): AgentAttentionEventV1 {
  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: "request_web_http_question_set_12345678",
    createdAt: "2026-07-24T12:00:00.000Z",
    expiresAt: "2026-07-24T12:10:00.000Z",
    title: "Release decision",
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: "question_web_http_confirm_12345678",
        kind: "confirm" as const,
        prompt: "Proceed with release?",
        confirm: {
          optionId: "option_web_http_yes_1234567890",
          label: "Proceed",
        },
        decline: {
          optionId: "option_web_http_no_12345678901",
          label: "Stop",
        },
      },
      {
        questionId: "question_web_http_note_1234567890",
        kind: "free-text" as const,
        prompt: "Add a release note",
        minLength: 3,
        maxLength: 80,
        multiline: false,
      },
    ],
    fallback: {
      preferredMode: "web-handoff" as const,
      alternativeModes: [],
      whenUnavailable: "reject" as const,
    },
  };
  return {
    ...event(),
    eventId: "evt_web_http_question_set_12345678",
    turnId: "turn_web_http_question_set_12345678",
    type: "input.required",
    request: {
      correlationId: interaction.requestId,
      kind: "question-set",
      question: interaction.title,
      interaction,
      expiresAt: interaction.expiresAt,
    },
  };
}

async function setup(
  token?: string,
  telegramWebhookSecret?: string,
  credential?: WebCredential,
  telegramCanaryReady?: () => boolean,
  webSessionAuthority?: WebSessionAuthority,
) {
  const store = new RelayStore();
  const transport = new FakeNotificationTransport();
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
    ...(webSessionAuthority === undefined ? {} : { webSessionAuthority }),
    ...(telegramCanaryReady === undefined ? {} : { telegramCanaryReady }),
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

async function createBootstrapGrant(
  runtime: Awaited<ReturnType<typeof setup>>,
): Promise<string> {
  const response = await fetch(`${runtime.baseUrl}/v1/web/bootstrap-grants`, {
    method: "POST",
    headers: {
      ...webHeaders(runtime, { csrf: true }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema: "agent-relay-web-bootstrap-create.v1",
    }),
  });
  const body = (await response.json()) as { grant?: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  if (body.grant === undefined) throw new Error("synthetic grant is missing");
  return body.grant;
}

describe("relay HTTP daemon", () => {
  it("checks Telegram canary readiness after the complete bounded body arrives", async () => {
    let ready = true;
    const runtime = await setup(undefined, undefined, undefined, () => ready);
    const input = JSON.stringify(event());
    const request = httpRequest(`${runtime.baseUrl}/v1/canaries/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const response = once(request, "response");
    request.write(input.slice(0, Math.floor(input.length / 2)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    ready = false;
    request.end(input.slice(Math.floor(input.length / 2)));

    const [incoming] = await response;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.from(chunk));
    }
    expect(incoming.statusCode).toBe(409);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
      code: "telegram-intake-not-ready",
    });
    expect(runtime.store.getEvent(event().eventId)).toBeUndefined();
    expect(runtime.transport.deliveries).toHaveLength(0);
    await runtime.close();
  });

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
    expect(html).toContain("data-timeline-list");
    expect(html).toContain("data-export-diagnostics");
    expect(html).toContain("data-session-controls");
    expect(html).toContain("agent-relay dashboard --web");
    expect(html).toContain("Advanced recovery: connect manually");
    expect(html).toContain('name="csrfCredential"');
    expect(html).not.toContain(webCredential.token);
    expect(html).not.toContain(webCredential.csrfToken);

    const app = await fetch(`${runtime.baseUrl}/ui/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    const appText = await app.text();
    expect(appText).toContain("/v1/web/stream");
    expect(appText).toContain("/timeline?limit=200");
    expect(appText).toContain("/reveal");
    expect(appText).toContain("/diagnostics/export?limit=500");
    expect(appText).toContain("agent-relay-web-resolve.v1");
    expect(appText).toContain("agent-relay-web-session-action.v1");
    expect(appText).toContain("x-agent-relay-csrf");
    expect(appText).toContain("/v1/web/bootstrap/exchange");
    expect(appText).toContain("history.replaceState");
    expect(appText).not.toContain("localStorage");
    expect(appText).not.toContain("sessionStorage");
    const version = await fetch(`${runtime.baseUrl}/ui/version.js`);
    expect(version.status).toBe(200);
    expect(await version.text()).toContain('WEB_API_VERSION = "3"');
    const meta = await fetch(`${runtime.baseUrl}/v1/web/meta`, {
      headers: webHeaders(runtime),
    });
    expect(meta.status).toBe(200);
    await expect(meta.json()).resolves.toEqual({
      schema: "agent-relay-web-meta.v1",
      apiVersion: "3",
      assetVersion: "4",
      commandSchemas: [
        "agent-relay-web-resolve.v1",
        "agent-relay-web-session-action.v1",
      ],
    });
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
    const status = await runtime.client.status();
    expect(status).toMatchObject({
      healthy: true,
      pendingDeliveryCount: 0,
      events: { delivered: 1 },
      topics: { ready: 1 },
    });
    expect(status).not.toHaveProperty("sessionRecords");
    expect(status).not.toHaveProperty("topicRecords");
    expect(status).not.toHaveProperty("sessionControlRecords");
    expect(JSON.stringify(status)).not.toContain(input.sessionId);
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
          activity: {
            state: "needs_input",
            stateLabel: "Needs input",
            requestCount: 1,
          },
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

  it("correlates a bounded session timeline and reveals private content only explicitly", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const secret = "sk-syntheticRevealSecret123456789";
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_timeline_detail_12345678",
      turnId: "turn_web_timeline_detail_12345678",
      type: "input.required",
      summary: "A bounded timeline summary",
      lastAssistantMessage: `Explicit assistant detail with ${secret}`,
      request: {
        correlationId: "request_web_timeline_detail_12345678",
        kind: "input",
        question: "What should happen next?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    };
    runtime.service.ingest(input);
    await runtime.service.drain();
    const sessionResponse = await fetch(
      `${runtime.baseUrl}/v1/web/sessions?limit=1`,
      { headers: webHeaders(runtime) },
    );
    const sessionBody = (await sessionResponse.json()) as {
      sessions: Array<{ sessionKey: string }>;
    };
    const key = sessionBody.sessions[0]?.sessionKey ?? "";
    const timelineResponse = await fetch(
      `${runtime.baseUrl}/v1/web/sessions/${key}/timeline?limit=20`,
      { headers: webHeaders(runtime) },
    );
    expect(timelineResponse.status).toBe(200);
    const timelineText = await timelineResponse.text();
    const timeline = JSON.parse(timelineText) as {
      timeline: Array<{
        kind: string;
        eventId?: string;
        correlationId?: string;
      }>;
    };
    expect(timeline.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hook-event",
          eventId: input.eventId,
          correlationId: input.request!.correlationId,
        }),
        expect.objectContaining({
          kind: "delivery",
          eventId: input.eventId,
        }),
        expect.objectContaining({
          kind: "request",
          correlationId: input.request!.correlationId,
        }),
      ]),
    );
    expect(timelineText).not.toContain("Explicit assistant detail");
    expect(timelineText).not.toContain(secret);

    const defaultDetail = await fetch(
      `${runtime.baseUrl}/v1/web/events/${input.eventId}`,
      { headers: webHeaders(runtime) },
    );
    expect(await defaultDetail.text()).not.toContain(
      "Explicit assistant detail",
    );
    const reveal = await fetch(
      `${runtime.baseUrl}/v1/web/events/${input.eventId}/reveal`,
      { headers: webHeaders(runtime) },
    );
    expect(reveal.status).toBe(200);
    const revealText = await reveal.text();
    expect(revealText).toContain("explicit-private-content");
    expect(revealText).toContain("Explicit assistant detail");
    expect(revealText).not.toContain(secret);
    expect(revealText).toContain("[REDACTED_OPENAI_KEY]");
    await runtime.close();
  });

  it("exports bounded diagnostics with legacy secrets and paths re-sanitized", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const secret = "ghp_syntheticDiagnosticSecret123456";
    runtime.store.recordDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: "diag_web_export_12345678",
      recordedAt: "2026-07-24T12:00:00.000Z",
      source: "daemon",
      level: "error",
      code: "synthetic.export",
      message: `failed at /Users/operator/private/project with ${secret}`,
    });

    const response = await fetch(
      `${runtime.baseUrl}/v1/web/diagnostics/export?limit=20`,
      { headers: webHeaders(runtime) },
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "agent-relay-diagnostics.json",
    );
    expect(body).toContain('"sanitized":true');
    expect(body).toContain("[REDACTED_PATH]");
    expect(body).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(body).not.toContain("/Users/operator");
    expect(body).not.toContain(secret);
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

  it("exchanges one scoped grant for an HttpOnly session without browser persistence", async () => {
    const runtime = await setup(
      "synthetic-daemon-secret",
      undefined,
      webCredential,
    );
    const grant = await createBootstrapGrant(runtime);
    const exchange = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant,
        }),
      },
    );
    const session = (await exchange.json()) as {
      csrfToken: string;
      schema: string;
    };
    expect(exchange.status).toBe(200);
    expect(session).toMatchObject({
      schema: "agent-relay-web-browser-session.v1",
    });
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Max-Age");
    expect(JSON.stringify(session)).not.toContain(webCredential.token);
    expect(JSON.stringify(session)).not.toContain(webCredential.csrfToken);
    const cookie = setCookie.split(";", 1)[0] ?? "";

    const meta = await fetch(`${runtime.baseUrl}/v1/web/meta`, {
      headers: { cookie },
    });
    expect(meta.status).toBe(200);
    const restored = await fetch(`${runtime.baseUrl}/v1/web/session`, {
      headers: { cookie },
    });
    await expect(restored.json()).resolves.toMatchObject({
      schema: "agent-relay-web-browser-session.v1",
      csrfToken: session.csrfToken,
    });

    const actionUrl = `${runtime.baseUrl}/v1/web/sessions/${"a".repeat(24)}/actions`;
    const actionBody = JSON.stringify({
      schema: "agent-relay-web-session-action.v1",
      operationId: "operation_session_csrf_12345678",
      eventId: "event_session_csrf_12345678",
      action: "mute",
    });
    const missingCsrf = await fetch(actionUrl, {
      method: "POST",
      headers: {
        cookie,
        origin: runtime.baseUrl,
        "content-type": "application/json",
      },
      body: actionBody,
    });
    expect(missingCsrf.status).toBe(403);
    const validCsrf = await fetch(actionUrl, {
      method: "POST",
      headers: {
        cookie,
        origin: runtime.baseUrl,
        "content-type": "application/json",
        "x-agent-relay-csrf": session.csrfToken,
      },
      body: actionBody,
    });
    expect(validCsrf.status).toBe(404);

    const replay = await fetch(`${runtime.baseUrl}/v1/web/bootstrap/exchange`, {
      method: "POST",
      headers: {
        origin: runtime.baseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: "agent-relay-web-bootstrap-exchange.v1",
        grant,
      }),
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(grant);
    expect(JSON.stringify(runtime.logger.records)).not.toContain(grant);

    const malformedJson = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: `{"schema":"agent-relay-web-bootstrap-exchange.v1","grant":"${grant}",`,
      },
    );
    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.text()).not.toContain(grant);
    expect(JSON.stringify(runtime.logger.records)).not.toContain(grant);
    await runtime.close();
  });

  it("rejects stale, expired, malformed, wrong-origin, and wrong-host grants", async () => {
    let now = new Date("2026-08-13T21:00:00.000Z");
    const authority = new WebSessionAuthority({
      now: () => now,
      bootstrapTtlMs: 100,
    });
    const runtime = await setup(
      undefined,
      undefined,
      webCredential,
      undefined,
      authority,
    );

    const wrongOriginGrant = await createBootstrapGrant(runtime);
    const wrongOrigin = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: "https://attacker.invalid",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant: wrongOriginGrant,
        }),
      },
    );
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.text()).not.toContain(wrongOriginGrant);

    const wrongHostGrant = await createBootstrapGrant(runtime);
    const address = new URL(runtime.baseUrl);
    const wrongHostResponse = await new Promise<{
      status: number;
      body: string;
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: Number(address.port),
          path: "/v1/web/bootstrap/exchange",
          method: "POST",
          headers: {
            host: `localhost:${address.port}`,
            origin: `http://localhost:${address.port}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.once("error", reject);
      request.end(
        JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant: wrongHostGrant,
        }),
      );
    });
    expect(wrongHostResponse.status).toBe(403);
    expect(wrongHostResponse.body).not.toContain(wrongHostGrant);

    const expiredGrant = await createBootstrapGrant(runtime);
    now = new Date(now.getTime() + 101);
    const expired = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant: expiredGrant,
        }),
      },
    );
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      code: "web-bootstrap-expired",
    });

    const stale = await fetch(`${runtime.baseUrl}/v1/web/bootstrap/exchange`, {
      method: "POST",
      headers: {
        origin: runtime.baseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: "agent-relay-web-bootstrap-exchange.v1",
        grant: `webboot_${"A".repeat(43)}`,
      }),
    });
    expect(stale.status).toBe(401);
    const malformed = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant: "malformed",
        }),
      },
    );
    expect(malformed.status).toBe(400);
    await runtime.close();
  });

  it("supports concurrent launches while allowing only one exchange per grant", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const grants = await Promise.all(
      Array.from({ length: 8 }, () => createBootstrapGrant(runtime)),
    );
    expect(new Set(grants).size).toBe(grants.length);
    const selected = grants[0] ?? "";
    const exchange = () =>
      fetch(`${runtime.baseUrl}/v1/web/bootstrap/exchange`, {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant: selected,
        }),
      });
    const responses = await Promise.all([exchange(), exchange(), exchange()]);
    expect(responses.map(({ status }) => status).sort()).toEqual([
      200, 409, 409,
    ]);
    await runtime.close();
  });

  it("expires browser sessions without weakening the persistent recovery path", async () => {
    let now = new Date("2026-08-13T21:00:00.000Z");
    const authority = new WebSessionAuthority({
      now: () => now,
      sessionIdleTtlMs: 100,
    });
    const runtime = await setup(
      undefined,
      undefined,
      webCredential,
      undefined,
      authority,
    );
    const grant = await createBootstrapGrant(runtime);
    const exchange = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant,
        }),
      },
    );
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    now = new Date(now.getTime() + 101);
    const expired = await fetch(`${runtime.baseUrl}/v1/web/meta`, {
      headers: { cookie },
    });
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({
      code: "web-session-expired",
    });
    expect(
      (
        await fetch(`${runtime.baseUrl}/v1/web/meta`, {
          headers: webHeaders(runtime),
        })
      ).status,
    ).toBe(200);
    await runtime.close();
  });

  it("closes an open browser-session stream at its authenticated expiry", async () => {
    const authority = new WebSessionAuthority({ sessionIdleTtlMs: 150 });
    const runtime = await setup(
      undefined,
      undefined,
      webCredential,
      undefined,
      authority,
    );
    const grant = await createBootstrapGrant(runtime);
    const exchange = await fetch(
      `${runtime.baseUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: runtime.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant,
        }),
      },
    );
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const stream = await fetch(`${runtime.baseUrl}/v1/web/stream`, {
      headers: { cookie },
    });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    await expect(reader?.read()).resolves.toMatchObject({ done: true });

    const expired = await fetch(`${runtime.baseUrl}/v1/web/meta`, {
      headers: { cookie },
    });
    expect(expired.status).toBe(401);
    await runtime.close();
  });

  it("requires same-origin CSRF validation and bounds browser bodies", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input: AgentAttentionEventV1 = {
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
    };
    runtime.service.ingest(input);
    const url = `${runtime.baseUrl}/v1/web/requests/request_web_csrf_question_12345678/resolve`;
    const body = JSON.stringify({
      schema: "agent-relay-web-resolve.v1",
      operationId: "operation_web_csrf_12345678",
      sessionKey: webSessionKey(input),
      response: { kind: "text", text: "safe-answer" },
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
        sessionKey: webSessionKey(input),
        response: { kind: "text", text: "x".repeat(140_000) },
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
          sessionKey: webSessionKey(input),
          response: { kind: "text", text: answer },
        }),
      });

    const first = await request("release-42");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      outcome: "answered",
      replayed: false,
      resolvedBy: "web",
      requestState: "answered",
      surfaceSync: "transport-unavailable",
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
      surfaceSync: "not-applicable",
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

  it("serves and atomically resolves a bounded multi-select form", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_multi_form_12345678",
      turnId: "turn_web_multi_form_12345678",
      type: "input.required",
      request: {
        correlationId: "request_web_multi_form_12345678",
        kind: "multi-select",
        question: "Select release units",
        options: [
          { id: "option_web_multi_core_12345678", label: "Core" },
          { id: "option_web_multi_ui_1234567890", label: "UI" },
          { id: "option_web_multi_docs_12345678", label: "Docs" },
        ],
        minSelections: 1,
        maxSelections: 2,
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    };
    runtime.service.ingest(input);
    const attention = await fetch(
      `${runtime.baseUrl}/v1/web/attention?limit=20`,
      { headers: webHeaders(runtime) },
    );
    await expect(attention.json()).resolves.toMatchObject({
      attention: [
        {
          requestId: input.request!.correlationId,
          supportedActions: ["choose-multiple"],
          form: {
            kind: "multi-select",
            minSelections: 1,
            maxSelections: 2,
          },
        },
      ],
    });

    const url = `${runtime.baseUrl}/v1/web/requests/${input.request!.correlationId}/resolve`;
    const command = {
      schema: "agent-relay-web-resolve.v1",
      operationId: "operation_web_multi_form_12345678",
      sessionKey: webSessionKey(input),
      response: {
        kind: "multi-select",
        optionIds: [
          "option_web_multi_docs_12345678",
          "option_web_multi_core_12345678",
        ],
      },
    };
    const wrongSession = await fetch(url, {
      method: "POST",
      headers: {
        ...webHeaders(runtime, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...command,
        sessionKey: "000000000000000000000000",
      }),
    });
    expect(wrongSession.status).toBe(409);
    expect(
      runtime.store.getPendingRequest(input.request!.correlationId),
    ).toMatchObject({ state: "open" });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...webHeaders(runtime, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "answered",
      requestState: "answered",
      resolvedBy: "web",
    });
    expect(
      runtime.store.getPendingRequest(input.request!.correlationId),
    ).toMatchObject({
      answer:
        '["option_web_multi_core_12345678","option_web_multi_docs_12345678"]',
    });
    await runtime.close();
  });

  it("projects and validates the shared ordered question-set contract", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input = webQuestionSetEvent();
    runtime.service.ingest(input);
    const attention = await fetch(
      `${runtime.baseUrl}/v1/web/attention?limit=20`,
      { headers: webHeaders(runtime) },
    );
    await expect(attention.json()).resolves.toMatchObject({
      attention: [
        {
          requestId: input.request!.correlationId,
          supportedActions: ["answer-question-set"],
          form: {
            kind: "question-set",
            title: "Release decision",
            questions: [
              {
                questionId: "question_web_http_confirm_12345678",
                kind: "confirm",
              },
              {
                questionId: "question_web_http_note_1234567890",
                kind: "free-text",
              },
            ],
          },
        },
      ],
    });
    const url = `${runtime.baseUrl}/v1/web/requests/${input.request!.correlationId}/resolve`;
    const post = async (operationId: string, answers: unknown[]) =>
      await fetch(url, {
        method: "POST",
        headers: {
          ...webHeaders(runtime, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-resolve.v1",
          operationId,
          sessionKey: webSessionKey(input),
          response: { kind: "question-set", answers },
        }),
      });
    const answers = [
      {
        questionId: "question_web_http_confirm_12345678",
        kind: "confirm",
        optionId: "option_web_http_yes_1234567890",
      },
      {
        questionId: "question_web_http_note_1234567890",
        kind: "free-text",
        text: "Ship safely",
      },
    ];
    const invalid = await post(
      "operation_web_http_question_invalid_12345678",
      [...answers].reverse(),
    );
    expect(invalid.status).toBe(422);
    expect(
      runtime.store.getPendingRequest(input.request!.correlationId),
    ).toMatchObject({ state: "open" });

    const valid = await post(
      "operation_web_http_question_valid_1234567890",
      answers,
    );
    expect(valid.status).toBe(200);
    const body = await valid.text();
    expect(body).not.toContain("Ship safely");
    expect(
      JSON.parse(
        runtime.store.getPendingRequest(input.request!.correlationId)?.answer ??
          "",
      ),
    ).toMatchObject({
      schema: "agent-interaction-answer.v1",
      answers,
    });
    await runtime.close();
  });

  it("mirrors exact-event session actions and updates the notification surface", async () => {
    const runtime = await setup(undefined, undefined, webCredential);
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "evt_web_session_control_12345678",
      type: "session.started",
    };
    runtime.service.ingest(input);
    await runtime.service.drain();
    const sessions = await fetch(`${runtime.baseUrl}/v1/web/sessions?limit=1`, {
      headers: webHeaders(runtime),
    });
    const sessionBody = (await sessions.json()) as {
      sessions: Array<{
        sessionKey: string;
        latestEventId: string;
        supportedActions: string[];
      }>;
    };
    expect(sessionBody.sessions[0]).toMatchObject({
      latestEventId: input.eventId,
      supportedActions: expect.arrayContaining(["details", "mute", "end"]),
    });
    const key = sessionBody.sessions[0]?.sessionKey ?? "";
    const url = `${runtime.baseUrl}/v1/web/sessions/${key}/actions`;
    const command = {
      schema: "agent-relay-web-session-action.v1",
      operationId: "operation_web_session_control_12345678",
      eventId: input.eventId,
      action: "mute",
    };
    const submit = async (body: unknown) =>
      await fetch(url, {
        method: "POST",
        headers: {
          ...webHeaders(runtime, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const first = await submit(command);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      outcome: "succeeded",
      replayed: false,
      sessionActivity: {
        state: "idle",
        muted: true,
      },
      surfaceSync: "updated",
    });
    expect(runtime.transport.messageEdits.at(-1)?.text).toContain(
      "routine whooshbang muted",
    );
    const replay = await submit(command);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      outcome: "succeeded",
      replayed: true,
      surfaceSync: "not-applicable",
    });
    const conflict = await submit({ ...command, action: "end" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      outcome: "replay_conflict",
      replayed: true,
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
