import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  AgentAttentionEventV1Schema,
  RelayDiagnosticV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
  sha256,
} from "@agent-relay/protocol";
import type {
  PendingRequestRecord,
  RelayLogger,
  RelayService,
  SessionLaneState,
  SessionRecord,
  WebChangeRecord,
} from "@agent-relay/core";
import type {
  AgentAttentionEventV1,
  InteractionQuestion,
} from "@agent-relay/protocol";
import {
  NOOP_LOGGER,
  redactDiagnosticText,
  redactText,
  renderDeliveryMessage,
} from "@agent-relay/core";
import type { TelegramReplyRouter } from "@agent-relay/core";
import { z } from "zod";

import {
  WebAttentionItemV1Schema,
  WebChangeV1Schema,
  WebDiagnosticExportV1Schema,
  WebEventDetailV1Schema,
  WebEventRevealV1Schema,
  WebResolveRequestV1Schema,
  WebSessionActionV1Schema,
  WebSessionSummaryV1Schema,
  WebTimelineEntryV1Schema,
} from "./web-contract.js";
import { loadWebAsset } from "./web-assets.js";
import type { WebAssetName } from "./web-assets.js";
import type {
  WebAttentionItemV1,
  WebChangeV1,
  WebDiagnosticExportV1,
  WebEventDetailV1,
  WebEventRevealV1,
  WebSessionSummaryV1,
  WebSessionAction,
  WebSupportedAction,
  WebTimelineEntryV1,
} from "./web-contract.js";
import type { WebCredential } from "./web-credential.js";

const drainSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const diagnosticLimitSchema = z.coerce.number().int().min(1).max(500);
const webLimitSchema = z.coerce.number().int().min(1).max(500);
const webCursorSchema = z.coerce.number().int().nonnegative();

const retentionSchema = z
  .object({
    deliveredDays: z.number().int().min(1).max(3_650).optional(),
    deadLetterDays: z.number().int().min(1).max(3_650).optional(),
    requestDays: z.number().int().min(1).max(3_650).optional(),
    diagnosticDays: z.number().int().min(1).max(3_650).optional(),
    telegramUpdateDays: z.number().int().min(1).max(3_650).optional(),
    sessionDays: z.number().int().min(1).max(3_650).optional(),
    limit: z.number().int().min(1).max(50_000).optional(),
  })
  .strict();

const terminalResolutionSchema = z
  .object({
    answer: z.string().min(1).max(4_000),
    expected: z
      .object({
        machineId: z.string().min(8).max(128),
        harness: z.enum(["codex", "claude", "cursor"]),
        sessionId: z.string().min(8).max(128),
        turnId: z.string().min(8).max(128).optional(),
      })
      .strict(),
  })
  .strict();

const opaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const resumeClaimSchema = z
  .object({
    machineId: opaqueId,
    bridgeSessionId: opaqueId,
    harness: z.enum(["codex", "claude", "cursor"]),
    ownerId: opaqueId,
  })
  .strict();

const bridgeSessionsSchema = resumeClaimSchema.omit({ ownerId: true }).strict();

const resumeOwnerSchema = z
  .object({
    ownerId: opaqueId,
  })
  .strict();

const resumeFinishedSchema = resumeOwnerSchema
  .extend({
    succeeded: z.boolean(),
    exitCode: z.number().int().min(0).max(255).optional(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .optional(),
    errorCode: z.string().min(1).max(120).optional(),
    errorMessage: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export interface RelayHttpServerOptions {
  token?: string;
  maxBodyBytes?: number;
  logger?: RelayLogger;
  replyRouter?: TelegramReplyRouter;
  telegramWebhookSecret?: string;
  webCredential?: WebCredential;
  webStreamPollMs?: number;
}

class HttpRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new HttpRequestError(
        413,
        "body-too-large",
        `request body exceeds ${maxBodyBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new HttpRequestError(
      400,
      "invalid-json",
      error instanceof Error ? error.message : "request body is not valid JSON",
    );
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function sendWebAsset(
  request: IncomingMessage,
  response: ServerResponse,
  name: WebAssetName,
  contentType: string,
): Promise<void> {
  const payload = await loadWebAsset(name);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": payload.byteLength,
    "cache-control": "no-store",
    "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

function assertAuthorized(
  request: IncomingMessage,
  token: string | undefined,
): void {
  if (
    token !== undefined &&
    request.headers.authorization !== `Bearer ${token}`
  ) {
    throw new HttpRequestError(
      401,
      "unauthorized",
      "relay daemon authorization failed",
    );
  }
}

function secretsMatch(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "::ffff:127.0.0.1"
  );
}

function assertWebAuthorized(
  request: IncomingMessage,
  credential: WebCredential | undefined,
): WebCredential {
  if (credential === undefined) {
    throw new HttpRequestError(404, "not-found", "relay route not found");
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!secretsMatch(token, credential.token)) {
    throw new HttpRequestError(
      401,
      "web-unauthorized",
      "web control authorization failed",
    );
  }
  return credential;
}

function assertWebOrigin(
  request: IncomingMessage,
  credential: WebCredential,
  requireCsrf: boolean,
): void {
  if (
    request.headers["sec-fetch-site"] === "cross-site" ||
    !isLoopbackHostname(request.socket.localAddress ?? "")
  ) {
    throw new HttpRequestError(
      403,
      "web-origin-rejected",
      "web control requests must remain on the loopback interface",
    );
  }
  const rawOrigin = request.headers.origin;
  if (rawOrigin !== undefined) {
    let origin: URL;
    try {
      origin = new URL(rawOrigin);
    } catch {
      throw new HttpRequestError(
        403,
        "web-origin-rejected",
        "web control origin is malformed",
      );
    }
    const host = request.headers.host;
    if (
      origin.protocol !== "http:" ||
      !isLoopbackHostname(origin.hostname) ||
      host === undefined ||
      origin.host !== host
    ) {
      throw new HttpRequestError(
        403,
        "web-origin-rejected",
        "web control origin does not match the local daemon",
      );
    }
  }
  if (requireCsrf) {
    if (rawOrigin === undefined) {
      throw new HttpRequestError(
        403,
        "web-origin-required",
        "browser mutations require an explicit same-origin Origin header",
      );
    }
    const csrf = request.headers["x-agent-relay-csrf"];
    if (typeof csrf !== "string" || !secretsMatch(csrf, credential.csrfToken)) {
      throw new HttpRequestError(
        403,
        "web-csrf-rejected",
        "browser mutation CSRF validation failed",
      );
    }
  }
}

function sessionKey(input: {
  machineId: string;
  harness: string;
  sessionId: string;
}): string {
  return sha256(
    `${input.machineId}\u001f${input.harness}\u001f${input.sessionId}`,
  ).slice(0, 24);
}

function requestCanContinue(event: AgentAttentionEventV1): boolean {
  return event.capabilities.inlineContinue || event.capabilities.lateResume;
}

function supportedActions(
  request: PendingRequestRecord,
  event: AgentAttentionEventV1,
): WebSupportedAction[] {
  if (
    !requestCanContinue(event) ||
    (request.requestKind === "permission" &&
      !event.capabilities.permissionDecision)
  ) {
    return [];
  }
  switch (request.requestKind) {
    case "input":
      return ["respond-text"];
    case "continuation":
      return ["continue", "respond-text"];
    case "confirm":
    case "select":
    case "permission":
      return ["choose-option"];
    case "multi-select":
      return ["choose-multiple"];
    case "question-set":
      return ["answer-question-set"];
  }
}

function webOptions(request: PendingRequestRecord) {
  return request.options.map((option) => ({
    optionId: option.optionId,
    label: redactText(option.label, 120),
  }));
}

function webQuestion(question: InteractionQuestion): InteractionQuestion {
  const prompt = redactText(question.prompt, 1_000);
  if (question.kind === "confirm") {
    return {
      ...question,
      prompt,
      confirm: {
        ...question.confirm,
        label: redactText(question.confirm.label, 120),
      },
      decline: {
        ...question.decline,
        label: redactText(question.decline.label, 120),
      },
    };
  }
  if (question.kind === "single-select" || question.kind === "multi-select") {
    return {
      ...question,
      prompt,
      options: question.options.map((option) => ({
        ...option,
        label: redactText(option.label, 120),
      })),
    };
  }
  return { ...question, prompt };
}

function responseForm(
  request: PendingRequestRecord,
  event: AgentAttentionEventV1,
) {
  const actions = supportedActions(request, event);
  if (actions.length === 0) {
    return undefined;
  }
  if (
    request.requestKind === "input" ||
    request.requestKind === "continuation"
  ) {
    return {
      kind: "text" as const,
      minLength: 1,
      maxLength: 4_000,
      multiline: true,
    };
  }
  if (
    request.requestKind === "confirm" ||
    request.requestKind === "select" ||
    request.requestKind === "permission"
  ) {
    return { kind: "single-select" as const, options: webOptions(request) };
  }
  if (request.requestKind === "multi-select") {
    const source = event.request;
    if (
      source?.kind !== "multi-select" ||
      source.minSelections === undefined ||
      source.maxSelections === undefined
    ) {
      return undefined;
    }
    return {
      kind: "multi-select" as const,
      options: webOptions(request),
      minSelections: source.minSelections,
      maxSelections: source.maxSelections,
    };
  }
  const interaction =
    event.request?.kind === "question-set"
      ? event.request.interaction
      : undefined;
  return interaction === undefined
    ? undefined
    : {
        kind: "question-set" as const,
        title: redactText(interaction.title, 120),
        questions: interaction.questions.map(webQuestion),
      };
}

function sessionActions(
  service: RelayService,
  session: SessionRecord,
  laneState: SessionLaneState,
  attentionCount: number,
): { latestEventId?: string; supportedActions: WebSessionAction[] } {
  const latest = service.store.getLatestEventForSession(session)?.event;
  if (latest === undefined) {
    return { supportedActions: [] };
  }
  const cardActions =
    renderDeliveryMessage(latest, { forceDetails: true }).actions ?? [];
  const pending = service.store.getPendingForEvent(latest.eventId);
  const supported = new Set(cardActions.map(({ kind }) => kind));
  const supportedActions: WebSessionAction[] = ["details"];
  if (
    supported.has("continue") &&
    pending?.state === "open" &&
    pending.requestKind === "continuation"
  ) {
    supportedActions.push("continue");
  }
  if (supported.has("mute") && laneState !== "muted" && laneState !== "ended") {
    supportedActions.push("mute");
  }
  if (supported.has("end") && laneState !== "ended" && attentionCount === 0) {
    supportedActions.push("end");
  }
  return { latestEventId: latest.eventId, supportedActions };
}

function toWebSession(
  service: RelayService,
  session: SessionRecord,
  laneState: SessionLaneState,
  attentionCount: number,
): WebSessionSummaryV1 {
  const key = sessionKey(session);
  const readableSuffix = session.sessionId
    .slice(-8)
    .replace(/[^A-Za-z0-9]/g, "_");
  const actions = sessionActions(service, session, laneState, attentionCount);
  return WebSessionSummaryV1Schema.parse({
    schema: "agent-relay-web-session.v1",
    sessionKey: key,
    displayId: `${readableSuffix}-${key.slice(0, 6)}`,
    harness: session.harness,
    surface: session.surface,
    repository: redactText(session.project.displayName, 120),
    ...(session.project.branch === undefined
      ? {}
      : { branch: redactText(session.project.branch, 240) }),
    state: laneState,
    lifecycleState: session.state,
    ...(session.lastEventType === undefined
      ? {}
      : { lastEventType: session.lastEventType }),
    lastSeenAt: session.lastSeenAt,
    attentionCount,
    ...actions,
  });
}

function toWebAttention(
  service: RelayService,
  request: PendingRequestRecord,
): WebAttentionItemV1 {
  const event = service.store.getEvent(request.eventId)?.event;
  if (event === undefined) {
    throw new Error(`pending request ${request.correlationId} lost its event`);
  }
  return WebAttentionItemV1Schema.parse({
    schema: "agent-relay-web-attention.v1",
    requestId: request.correlationId,
    eventId: request.eventId,
    sessionKey: sessionKey(request),
    harness: request.harness,
    requestKind: request.requestKind,
    state: "open",
    promptPreview: redactText(request.question, 240),
    expiresAt: request.expiresAt,
    supportedActions: supportedActions(request, event),
    options: webOptions(request),
    ...(responseForm(request, event) === undefined
      ? {}
      : { form: responseForm(request, event) }),
  });
}

function parseWebCursor(
  url: URL,
  request: IncomingMessage,
  allowLastEventId: boolean,
): number {
  const queryCursor = url.searchParams.get("after");
  const lastEventId = allowLastEventId
    ? request.headers["last-event-id"]
    : undefined;
  const candidate =
    queryCursor ??
    (typeof lastEventId === "string" && lastEventId.length > 0
      ? lastEventId
      : "0");
  return webCursorSchema.parse(candidate);
}

function sendSseChange(response: ServerResponse, change: WebChangeV1): void {
  response.write(`id: ${change.cursor}\n`);
  response.write("event: change\n");
  response.write(`data: ${JSON.stringify(change)}\n\n`);
}

function toWebChange(change: WebChangeRecord): WebChangeV1 {
  const hidesMachineIdentity =
    change.kind === "session" || change.kind === "session-control";
  return WebChangeV1Schema.parse({
    cursor: change.cursor,
    kind: change.kind,
    action: change.action,
    entityId: hidesMachineIdentity
      ? `session_${sha256(change.entityId).slice(0, 24)}`
      : change.entityId,
    occurredAt: change.occurredAt,
    payload: change.payload,
  });
}

export function createRelayHttpServer(
  service: RelayService,
  options: RelayHttpServerOptions = {},
): Server {
  const logger = options.logger ?? NOOP_LOGGER;
  const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024;

  return createServer(async (request, response) => {
    const at = new Date().toISOString();
    try {
      const url = new URL(request.url ?? "/", "http://relay.local");
      const isWebRoute =
        url.pathname === "/v1/web" || url.pathname.startsWith("/v1/web/");
      const isWebUiRoute =
        url.pathname === "/" ||
        url.pathname === "/ui" ||
        url.pathname.startsWith("/ui/");
      const isTelegramWebhook =
        request.method === "POST" && url.pathname === "/v1/telegram/updates";
      if (isWebRoute) {
        const credential = assertWebAuthorized(request, options.webCredential);
        assertWebOrigin(request, credential, request.method === "POST");
      } else if (
        !isWebUiRoute &&
        (!isTelegramWebhook || options.telegramWebhookSecret === undefined)
      ) {
        assertAuthorized(request, options.token);
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/" ||
          url.pathname === "/ui" ||
          url.pathname === "/ui/")
      ) {
        await sendWebAsset(
          request,
          response,
          "index.html",
          "text/html; charset=utf-8",
        );
        return;
      }
      const webAsset: { name: WebAssetName; contentType: string } | undefined =
        url.pathname === "/ui/styles.css"
          ? { name: "styles.css", contentType: "text/css; charset=utf-8" }
          : url.pathname === "/ui/app.js"
            ? {
                name: "app.js",
                contentType: "text/javascript; charset=utf-8",
              }
            : url.pathname === "/ui/state.js"
              ? {
                  name: "state.js",
                  contentType: "text/javascript; charset=utf-8",
                }
              : undefined;
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        webAsset !== undefined
      ) {
        await sendWebAsset(
          request,
          response,
          webAsset.name,
          webAsset.contentType,
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/web/sessions") {
        const limit = webLimitSchema.parse(
          url.searchParams.get("limit") ?? "100",
        );
        sendJson(response, 200, {
          sessions: service
            .listSessionsWithAttention(limit)
            .map(({ session, laneState, attentionCount }) =>
              toWebSession(service, session, laneState, attentionCount),
            ),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/web/attention") {
        const limit = webLimitSchema.parse(
          url.searchParams.get("limit") ?? "100",
        );
        sendJson(response, 200, {
          attention: service
            .listPendingRequests(limit)
            .map((pending) => toWebAttention(service, pending)),
        });
        return;
      }
      const webSessionActionMatch = url.pathname.match(
        /^\/v1\/web\/sessions\/([^/]+)\/actions$/,
      );
      if (request.method === "POST" && webSessionActionMatch !== null) {
        const key = decodeURIComponent(webSessionActionMatch[1] ?? "");
        const command = WebSessionActionV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.executeBrowserSessionAction({
          sessionKey: key,
          operationId: command.operationId,
          eventId: command.eventId,
          action: command.action,
        });
        const surfaceSync =
          await service.synchronizeBrowserSessionAction(result);
        const status =
          result.outcome === "succeeded"
            ? 200
            : result.outcome === "session_not_found" ||
                result.outcome === "event_not_found" ||
                result.outcome === "not_found"
              ? 404
              : result.outcome === "kind_mismatch"
                ? 422
                : 409;
        const session = service.findSessionByWebKey(key);
        sendJson(response, status, {
          outcome: result.outcome,
          replayed: result.replayed,
          surfaceSync,
          ...(session === undefined
            ? {}
            : { sessionState: service.store.getSessionLaneState(session) }),
        });
        return;
      }
      const webTimelineMatch = url.pathname.match(
        /^\/v1\/web\/sessions\/([^/]+)\/timeline$/,
      );
      if (request.method === "GET" && webTimelineMatch !== null) {
        const key = decodeURIComponent(webTimelineMatch[1] ?? "");
        const limit = webLimitSchema.parse(
          url.searchParams.get("limit") ?? "100",
        );
        const records = service.listSessionTimeline(key, limit);
        if (records === undefined) {
          throw new HttpRequestError(
            404,
            "web-session-not-found",
            "web session was not found",
          );
        }
        const timeline: WebTimelineEntryV1[] = records.map((record) =>
          WebTimelineEntryV1Schema.parse({
            ...record,
            status: redactDiagnosticText(record.status, 120),
            label: redactDiagnosticText(record.label, 120),
            ...(record.detailCode === undefined
              ? {}
              : {
                  detailCode: redactDiagnosticText(record.detailCode, 120),
                }),
          }),
        );
        sendJson(response, 200, { sessionKey: key, timeline });
        return;
      }
      const webEventMatch = url.pathname.match(/^\/v1\/web\/events\/([^/]+)$/);
      if (request.method === "GET" && webEventMatch !== null) {
        const eventId = decodeURIComponent(webEventMatch[1] ?? "");
        const record = service.store.getEvent(eventId);
        if (record === undefined) {
          throw new HttpRequestError(
            404,
            "web-event-not-found",
            "web event was not found",
          );
        }
        const event = record.event;
        const pending = service.store.getPendingForEvent(event.eventId);
        const detail: WebEventDetailV1 = WebEventDetailV1Schema.parse({
          schema: "agent-relay-web-event.v1",
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          harness: event.harness,
          surface: event.surface,
          harnessVersion: event.harnessVersion,
          sessionKey: sessionKey(event),
          type: event.type,
          deliveryStatus: record.status,
          repository: redactText(event.project.displayName, 120),
          ...(event.project.branch === undefined
            ? {}
            : { branch: redactText(event.project.branch, 240) }),
          ...(event.summary === undefined
            ? {}
            : { summary: redactText(event.summary, 1_000) }),
          ...(event.failure === undefined
            ? {}
            : {
                failure: {
                  code: event.failure.class,
                  message: redactText(event.failure.message, 500),
                },
              }),
          ...(pending === undefined
            ? {}
            : {
                request: {
                  requestId: pending.correlationId,
                  kind: pending.requestKind,
                  state: pending.state,
                  promptPreview: redactText(pending.question, 240),
                  expiresAt: pending.expiresAt,
                  supportedActions:
                    pending.state === "open"
                      ? supportedActions(pending, event)
                      : [],
                  options: webOptions(pending),
                  ...(pending.state !== "open" ||
                  responseForm(pending, event) === undefined
                    ? {}
                    : { form: responseForm(pending, event) }),
                },
              }),
        });
        sendJson(response, 200, { event: detail });
        return;
      }
      const webRevealMatch = url.pathname.match(
        /^\/v1\/web\/events\/([^/]+)\/reveal$/,
      );
      if (request.method === "GET" && webRevealMatch !== null) {
        const eventId = decodeURIComponent(webRevealMatch[1] ?? "");
        const record = service.store.getEvent(eventId);
        if (record === undefined) {
          throw new HttpRequestError(
            404,
            "web-event-not-found",
            "web event was not found",
          );
        }
        const event = record.event;
        const reveal: WebEventRevealV1 = WebEventRevealV1Schema.parse({
          schema: "agent-relay-web-event-reveal.v1",
          eventId: event.eventId,
          notice: "explicit-private-content",
          ...(event.summary === undefined
            ? {}
            : { summary: redactText(event.summary, 2_000) }),
          ...(event.lastAssistantMessage === undefined
            ? {}
            : {
                assistantExcerpt: redactText(event.lastAssistantMessage, 2_000),
              }),
          ...(event.failure === undefined
            ? {}
            : {
                failure: {
                  code: event.failure.class,
                  message: redactText(event.failure.message, 1_000),
                },
              }),
        });
        sendJson(response, 200, { event: reveal });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/web/diagnostics/export"
      ) {
        const limit = webLimitSchema.parse(
          url.searchParams.get("limit") ?? "200",
        );
        const diagnosticExport: WebDiagnosticExportV1 =
          WebDiagnosticExportV1Schema.parse({
            schema: "agent-relay-web-diagnostics.v1",
            generatedAt: new Date().toISOString(),
            sanitized: true,
            retention: { defaultDays: 90, limit },
            diagnostics: service.store
              .listDiagnostics(limit)
              .map((diagnostic) => ({
                diagnosticId: diagnostic.diagnosticId,
                recordedAt: diagnostic.recordedAt,
                source: diagnostic.source,
                level: diagnostic.level,
                code: diagnostic.code,
                message: redactDiagnosticText(diagnostic.message, 500),
              })),
          });
        sendJson(response, 200, diagnosticExport, {
          "content-disposition":
            'attachment; filename="agent-relay-diagnostics.json"',
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/web/changes") {
        const after = parseWebCursor(url, request, false);
        const limit = webLimitSchema.parse(
          url.searchParams.get("limit") ?? "100",
        );
        sendJson(response, 200, {
          after,
          bounds: service.store.webChangeBounds(),
          changes: service.store
            .listWebChanges(after, limit)
            .map((change) => toWebChange(change)),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/web/stream") {
        let cursor = parseWebCursor(url, request, true);
        const bounds = service.store.webChangeBounds();
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        response.flushHeaders();
        const missingHistory =
          (bounds.firstCursor !== undefined &&
            cursor + 1 < bounds.firstCursor) ||
          (bounds.lastCursor !== undefined && cursor > bounds.lastCursor) ||
          (bounds.lastCursor === undefined && cursor > 0);
        if (missingHistory) {
          response.write("event: reset\n");
          response.write(`data: ${JSON.stringify(bounds)}\n\n`);
          cursor = bounds.lastCursor ?? 0;
        } else {
          for (const change of service.store.listWebChanges(cursor, 500)) {
            sendSseChange(response, toWebChange(change));
            cursor = change.cursor;
          }
        }
        response.write(": connected\n\n");
        let polling = false;
        const poll = setInterval(() => {
          if (polling || response.destroyed || response.writableEnded) {
            return;
          }
          polling = true;
          try {
            const changes = service.store.listWebChanges(cursor, 500);
            for (const change of changes) {
              sendSseChange(response, toWebChange(change));
              cursor = change.cursor;
            }
          } catch (error) {
            logger.log({
              level: "error",
              code: "web.stream-failed",
              message:
                error instanceof Error
                  ? error.message
                  : "web event stream failed",
              at: new Date().toISOString(),
            });
            response.destroy();
          } finally {
            polling = false;
          }
        }, options.webStreamPollMs ?? 250);
        const heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) {
            response.write(": heartbeat\n\n");
          }
        }, 15_000);
        const cleanUp = (): void => {
          clearInterval(poll);
          clearInterval(heartbeat);
        };
        response.once("close", cleanUp);
        return;
      }
      const webResolveMatch = url.pathname.match(
        /^\/v1\/web\/requests\/([^/]+)\/resolve$/,
      );
      if (request.method === "POST" && webResolveMatch !== null) {
        const correlationId = decodeURIComponent(webResolveMatch[1] ?? "");
        const command = WebResolveRequestV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const pending = service.getRequest(correlationId);
        if (
          pending !== undefined &&
          sessionKey(pending) !== command.sessionKey
        ) {
          throw new HttpRequestError(
            409,
            "web-request-session-mismatch",
            "browser response belongs to a different session",
          );
        }
        const result = service.resolveBrowser({
          correlationId,
          operationId: command.operationId,
          response: command.response,
        });
        const surfaceSync = await service.synchronizeBrowserResolution(result);
        const status =
          result.outcome === "answered"
            ? 200
            : result.outcome === "not_found"
              ? 404
              : result.outcome === "invalid_answer" ||
                  result.outcome === "unsupported_request"
                ? 422
                : 409;
        sendJson(response, status, {
          outcome: result.outcome,
          replayed: result.replayed,
          surfaceSync,
          ...(result.request === undefined
            ? {}
            : {
                requestState: result.request.state,
                ...(result.request.resolvedBy === undefined
                  ? {}
                  : { resolvedBy: result.request.resolvedBy }),
              }),
        });
        return;
      }
      if (isWebRoute) {
        throw new HttpRequestError(
          request.method === "OPTIONS" ? 405 : 404,
          request.method === "OPTIONS"
            ? "web-preflight-not-supported"
            : "not-found",
          request.method === "OPTIONS"
            ? "cross-origin web requests are not supported"
            : "relay route not found",
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, { healthy: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, {
          healthy: true,
          transport: service.transport.name,
          ...service.store.status(),
          sessionRecords: service.store.listSessions(),
          topicRecords: service.store.listSessionTopics(),
          sessionControlRecords: service.store.listSessionControls(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
        const limit = diagnosticLimitSchema.parse(
          url.searchParams.get("limit") ?? "100",
        );
        sendJson(response, 200, {
          diagnostics: service.store.listDiagnostics(limit),
        });
        return;
      }
      const requestMatch = url.pathname.match(/^\/v1\/requests\/([^/]+)$/);
      if (request.method === "GET" && requestMatch !== null) {
        const correlationId = decodeURIComponent(requestMatch[1] ?? "");
        const pending = service.getRequest(correlationId);
        sendJson(response, 200, {
          ...(pending === undefined ? {} : { request: pending }),
        });
        return;
      }
      const terminalMatch = url.pathname.match(
        /^\/v1\/requests\/([^/]+)\/resolve-terminal$/,
      );
      if (request.method === "POST" && terminalMatch !== null) {
        const correlationId = decodeURIComponent(terminalMatch[1] ?? "");
        const command = terminalResolutionSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(
          response,
          200,
          service.resolveTerminal({
            correlationId,
            answer: command.answer,
            expected: {
              machineId: command.expected.machineId,
              harness: command.expected.harness,
              sessionId: command.expected.sessionId,
              ...(command.expected.turnId === undefined
                ? {}
                : { turnId: command.expected.turnId }),
            },
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/resumes/claim") {
        const claim = resumeClaimSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(response, 200, service.claimNextResume(claim));
        return;
      }
      const resumeStartedMatch = url.pathname.match(
        /^\/v1\/resumes\/([^/]+)\/started$/,
      );
      if (request.method === "POST" && resumeStartedMatch !== null) {
        const correlationId = decodeURIComponent(resumeStartedMatch[1] ?? "");
        const command = resumeOwnerSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(
          response,
          200,
          service.markResumeStarted(correlationId, command.ownerId),
        );
        return;
      }
      const resumeFinishedMatch = url.pathname.match(
        /^\/v1\/resumes\/([^/]+)\/finished$/,
      );
      if (request.method === "POST" && resumeFinishedMatch !== null) {
        const correlationId = decodeURIComponent(resumeFinishedMatch[1] ?? "");
        const command = resumeFinishedSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(
          response,
          200,
          service.markResumeFinished({
            correlationId,
            ownerId: command.ownerId,
            succeeded: command.succeeded,
            ...(command.exitCode === undefined
              ? {}
              : { exitCode: command.exitCode }),
            ...(command.signal === undefined ? {} : { signal: command.signal }),
            ...(command.errorCode === undefined
              ? {}
              : { errorCode: command.errorCode }),
            ...(command.errorMessage === undefined
              ? {}
              : { errorMessage: command.errorMessage }),
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/telegram/updates"
      ) {
        if (
          options.telegramWebhookSecret !== undefined &&
          request.headers["x-telegram-bot-api-secret-token"] !==
            options.telegramWebhookSecret
        ) {
          throw new HttpRequestError(
            401,
            "telegram-webhook-unauthorized",
            "Telegram webhook secret validation failed",
          );
        }
        if (options.replyRouter === undefined) {
          throw new HttpRequestError(
            503,
            "reply-router-unavailable",
            "Telegram reply routing is not configured",
          );
        }
        sendJson(
          response,
          200,
          await options.replyRouter.handle(
            await readJson(request, maxBodyBytes),
          ),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const event = AgentAttentionEventV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.ingest(event);
        sendJson(response, result.inserted ? 202 : 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/diagnostics") {
        const diagnostic = RelayDiagnosticV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.reportDiagnostic(diagnostic);
        sendJson(response, result.inserted ? 201 : 200, result);
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sessions/register"
      ) {
        const session = SessionRegistrationV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        service.registerSession(session);
        sendJson(response, 201, { registered: true });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sessions/by-bridge"
      ) {
        const query = bridgeSessionsSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(response, 200, {
          sessions: service.store.listSessionsByBridge(query),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sessions/heartbeat"
      ) {
        const heartbeat = SessionHeartbeatV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const updated = service.heartbeat(heartbeat);
        sendJson(response, updated ? 200 : 404, {
          updated,
          ...(updated
            ? {}
            : {
                code: "unknown-session",
                message: "heartbeat session was not registered",
              }),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/deliveries/drain"
      ) {
        const command = drainSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(response, 200, await service.drain(command.limit));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/maintenance/retention"
      ) {
        const command = retentionSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        sendJson(
          response,
          200,
          service.maintainRetention({
            ...(command.deliveredDays === undefined
              ? {}
              : { deliveredDays: command.deliveredDays }),
            ...(command.deadLetterDays === undefined
              ? {}
              : { deadLetterDays: command.deadLetterDays }),
            ...(command.requestDays === undefined
              ? {}
              : { requestDays: command.requestDays }),
            ...(command.diagnosticDays === undefined
              ? {}
              : { diagnosticDays: command.diagnosticDays }),
            ...(command.telegramUpdateDays === undefined
              ? {}
              : { telegramUpdateDays: command.telegramUpdateDays }),
            ...(command.sessionDays === undefined
              ? {}
              : { sessionDays: command.sessionDays }),
            ...(command.limit === undefined ? {} : { limit: command.limit }),
          }),
        );
        return;
      }

      throw new HttpRequestError(404, "not-found", "relay route not found");
    } catch (error) {
      const zodError = error instanceof z.ZodError ? error : undefined;
      const requestError =
        error instanceof HttpRequestError ? error : undefined;
      const status =
        requestError?.status ?? (zodError === undefined ? 500 : 400);
      const code =
        requestError?.code ??
        (zodError === undefined ? "internal-error" : "invalid-payload");
      const message =
        requestError?.message ??
        (zodError === undefined
          ? "relay request failed"
          : "request payload failed validation");
      const issues =
        zodError?.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join(".") || "<root>",
          message: issue.message,
        })) ?? requestError?.details;
      logger.log({
        level: status >= 500 ? "error" : "warn",
        code: "http.request-failed",
        message,
        at,
        details: {
          method: request.method,
          path: request.url,
          status,
          errorCode: code,
          ...(issues === undefined ? {} : { issues }),
        },
      });
      sendJson(response, status, {
        code,
        message,
        ...(issues === undefined ? {} : { issues }),
      });
    }
  });
}
