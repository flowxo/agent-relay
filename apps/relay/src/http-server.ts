import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  AgentAttentionEventV1Schema,
  HarnessSchema,
  RelayMcpAskV1Schema,
  RelayMcpCancelV1Schema,
  RelayMcpQuestionnaireV1Schema,
  RelayMcpStatusV1Schema,
  RelayDiagnosticV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
  sha256,
} from "@agent-relay/protocol";
import type {
  PendingRequestRecord,
  RelayLogger,
  RelayService,
  SessionActivityRecord,
  SessionRecord,
  WebChangeRecord,
} from "@agent-relay/core";
import type {
  AgentAttentionEventV1,
  InteractionQuestion,
} from "@agent-relay/protocol";
import {
  NOOP_LOGGER,
  PROJECT_CHANGE_MAX_BATCH_SIZE,
  PROJECT_HISTORY_MAX_PAGE_SIZE,
  ProjectKeySchema,
  ProjectReadError,
  SessionActivityStateSchema,
  redactDiagnosticText,
  redactText,
  renderDeliveryMessage,
  sessionPublicKey,
} from "@agent-relay/core";
import type { TelegramReplyRouter } from "@agent-relay/telegram-transport";
import { z } from "zod";

import {
  WEB_API_VERSION,
  WEB_ASSET_VERSION,
  WebAttentionItemV1Schema,
  WebChangeV1Schema,
  WebDiagnosticExportV1Schema,
  WebEventDetailV1Schema,
  WebEventRevealV1Schema,
  WebMetaV1Schema,
  WebResolveRequestV1Schema,
  WebSessionActionV1Schema,
  WebSessionSummaryV2Schema,
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
  WebSessionSummaryV2,
  WebSessionAction,
  WebSupportedAction,
  WebTimelineEntryV1,
} from "./web-contract.js";
import type { WebCredential } from "./web-credential.js";
import {
  WebBootstrapCreateSchema,
  WebBootstrapExchangeSchema,
  WebBootstrapRevokeSchema,
  WebSessionAuthority,
  WebSessionAuthorityError,
} from "./web-session.js";
import type { WebBrowserScope } from "./web-session.js";

const drainSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const diagnosticLimitSchema = z.coerce.number().int().min(1).max(500);
const webLimitSchema = z.coerce.number().int().min(1).max(500);
const webCursorSchema = z.coerce.number().int().nonnegative();
const projectHistoryLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(PROJECT_HISTORY_MAX_PAGE_SIZE);
const projectChangeLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(PROJECT_CHANGE_MAX_BATCH_SIZE);
const projectKeySchema = ProjectKeySchema;
const projectStateSchema = SessionActivityStateSchema;
const projectHarnessSchema = HarnessSchema;
const opaqueProjectCursorSchema = z.string().min(16).max(1_024);

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

const mcpBindingIdentitySchema = z
  .object({
    machineId: opaqueId,
    bridgeSessionId: opaqueId,
    harness: z.enum(["codex", "claude", "cursor"]),
  })
  .strict();

const mcpBindingClaimSchema = mcpBindingIdentitySchema
  .extend({ sessionId: opaqueId })
  .strict();

const mcpBindingEndSchema = mcpBindingIdentitySchema
  .extend({ sessionId: opaqueId.optional() })
  .strict();

const mcpInteractionSchema = z.union([
  RelayMcpAskV1Schema,
  RelayMcpQuestionnaireV1Schema,
]);

export interface RelayHttpServerOptions {
  token?: string;
  maxBodyBytes?: number;
  logger?: RelayLogger;
  statusDetails?: () => object;
  telegramCanaryReady?: () => boolean;
  replyRouter?: TelegramReplyRouter;
  telegramWebhookSecret?: string;
  webEnabled?: boolean;
  webCredential?: WebCredential;
  webSessionAuthority?: WebSessionAuthority;
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
  } catch {
    throw new HttpRequestError(
      400,
      "invalid-json",
      "request body is not valid JSON",
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

function safeRequestPath(value: string | undefined): string {
  try {
    return new URL(value ?? "/", "http://relay.local").pathname;
  } catch {
    return "/";
  }
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

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function mcpBindingAuthority(request: IncomingMessage):
  | string
  | {
      machineId: string;
      harness: "codex" | "claude" | "cursor";
      sessionId: string;
    } {
  const token = headerValue(request, "x-agent-relay-mcp-binding");
  if (token !== undefined && /^mcpbind_[A-Za-z0-9_-]{32,96}$/u.test(token)) {
    return token;
  }
  const sessionId = headerValue(request, "x-agent-relay-mcp-native-session");
  const machineId = headerValue(request, "x-agent-relay-machine-id");
  const harness = headerValue(request, "x-agent-relay-harness");
  const parsedHarness = z
    .enum(["codex", "claude", "cursor"])
    .safeParse(harness);
  if (
    sessionId !== undefined &&
    opaqueId.safeParse(sessionId).success &&
    machineId !== undefined &&
    opaqueId.safeParse(machineId).success &&
    parsedHarness.success
  ) {
    return {
      machineId,
      harness: parsedHarness.data,
      sessionId,
    };
  }
  throw new HttpRequestError(
    401,
    "mcp-binding-missing",
    "a valid local MCP session binding is required",
  );
}

function mcpBindingToken(request: IncomingMessage): string {
  const authority = mcpBindingAuthority(request);
  if (typeof authority !== "string") {
    throw new HttpRequestError(
      401,
      "mcp-binding-missing",
      "a valid local MCP session binding is required",
    );
  }
  return authority;
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

const WEB_SESSION_COOKIE = "agent_relay_web_session";

function requestHost(request: IncomingMessage): string {
  const rawHost = request.headers.host;
  if (rawHost === undefined || rawHost.includes(",")) {
    throw new HttpRequestError(
      403,
      "web-host-rejected",
      "web control requests require one exact loopback Host",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    throw new HttpRequestError(
      403,
      "web-host-rejected",
      "web control Host is malformed",
    );
  }
  if (
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new HttpRequestError(
      403,
      "web-host-rejected",
      "web control Host must remain on exact loopback",
    );
  }
  return parsed.host;
}

function browserScope(request: IncomingMessage): WebBrowserScope {
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
  const host = requestHost(request);
  const rawOrigin = request.headers.origin;
  if (rawOrigin === undefined) {
    throw new HttpRequestError(
      403,
      "web-origin-required",
      "local dashboard bootstrap requires an explicit same-origin Origin header",
    );
  }
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
  if (
    origin.protocol !== "http:" ||
    !isLoopbackHostname(origin.hostname) ||
    origin.host !== host ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new HttpRequestError(
      403,
      "web-origin-rejected",
      "web control origin does not match the local daemon",
    );
  }
  return { host, origin: origin.origin };
}

function sessionCookie(request: IncomingMessage): string | undefined {
  const raw = request.headers.cookie;
  if (raw === undefined) return undefined;
  const matches = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${WEB_SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  return matches[0]?.slice(`${WEB_SESSION_COOKIE}=`.length);
}

interface WebAuthorization {
  kind: "persistent" | "session";
  csrfToken: string;
  session?: {
    schema: "agent-relay-web-browser-session.v1";
    csrfToken: string;
    expiresAt: string;
  };
}

function assertWebAuthorized(
  request: IncomingMessage,
  credential: WebCredential | undefined,
  sessionAuthority: WebSessionAuthority,
): WebAuthorization {
  if (credential === undefined) {
    throw new HttpRequestError(404, "not-found", "relay route not found");
  }
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    if (!secretsMatch(token, credential.token)) {
      throw new HttpRequestError(
        401,
        "web-unauthorized",
        "web control authorization failed",
      );
    }
    return { kind: "persistent", csrfToken: credential.csrfToken };
  }
  const session = sessionAuthority.authorizeSession(
    sessionCookie(request),
    requestHost(request),
  );
  if (session.csrfToken.length === 0) {
    throw new HttpRequestError(
      401,
      "web-unauthorized",
      "web control authorization failed",
    );
  }
  return { kind: "session", csrfToken: session.csrfToken, session };
}

function assertWebOrigin(
  request: IncomingMessage,
  authorization: WebAuthorization,
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
  const host = requestHost(request);
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
    if (
      origin.protocol !== "http:" ||
      !isLoopbackHostname(origin.hostname) ||
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
    if (
      typeof csrf !== "string" ||
      !secretsMatch(csrf, authorization.csrfToken)
    ) {
      throw new HttpRequestError(
        403,
        "web-csrf-rejected",
        "browser mutation CSRF validation failed",
      );
    }
  }
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
  activity: SessionActivityRecord,
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
  if (supported.has("mute") && !activity.muted && activity.state !== "ended") {
    supportedActions.push("mute");
  }
  if (
    supported.has("end") &&
    activity.state !== "ended" &&
    attentionCount === 0
  ) {
    supportedActions.push("end");
  }
  return { latestEventId: latest.eventId, supportedActions };
}

function toWebSession(
  service: RelayService,
  session: SessionRecord,
  activity: SessionActivityRecord,
  attentionCount: number,
): WebSessionSummaryV2 {
  const key = sessionPublicKey(session);
  const readableSuffix = session.sessionId
    .slice(-8)
    .replace(/[^A-Za-z0-9]/g, "_");
  const actions = sessionActions(service, session, activity, attentionCount);
  return WebSessionSummaryV2Schema.parse({
    schema: "agent-relay-web-session.v2",
    sessionKey: key,
    displayId: `${readableSuffix}-${key.slice(0, 6)}`,
    harness: session.harness,
    surface: session.surface,
    repository: redactText(session.project.displayName, 120),
    ...(session.project.branch === undefined
      ? {}
      : { branch: redactText(session.project.branch, 240) }),
    activity,
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
    sessionKey: sessionPublicKey(request),
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
  const webEnabled = options.webEnabled ?? true;
  const webSessionAuthority =
    options.webSessionAuthority ?? new WebSessionAuthority();

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
      const isBootstrapExchange =
        request.method === "POST" &&
        url.pathname === "/v1/web/bootstrap/exchange";
      if (!webEnabled && (isWebRoute || isWebUiRoute)) {
        throw new HttpRequestError(
          404,
          "web-companion-disabled",
          "local web companion is disabled",
        );
      }
      let webAuthorization: WebAuthorization | undefined;
      if (isWebRoute && !isBootstrapExchange) {
        webAuthorization = assertWebAuthorized(
          request,
          options.webCredential,
          webSessionAuthority,
        );
        assertWebOrigin(request, webAuthorization, request.method === "POST");
      } else if (
        !isBootstrapExchange &&
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
              : url.pathname === "/ui/version.js"
                ? {
                    name: "version.js",
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

      if (isBootstrapExchange) {
        if (options.webCredential === undefined) {
          throw new HttpRequestError(404, "not-found", "relay route not found");
        }
        const scope = browserScope(request);
        const input = WebBootstrapExchangeSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        const exchanged = webSessionAuthority.exchangeGrant(input.grant, scope);
        sendJson(response, 200, exchanged.session, {
          "set-cookie": `${WEB_SESSION_COOKIE}=${exchanged.sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/web/bootstrap-grants"
      ) {
        if (webAuthorization?.kind !== "persistent") {
          throw new HttpRequestError(
            403,
            "web-bootstrap-authority-required",
            "local dashboard launch requires the protected Relay authority",
          );
        }
        WebBootstrapCreateSchema.parse(await readJson(request, maxBodyBytes));
        sendJson(
          response,
          201,
          webSessionAuthority.issueGrant(browserScope(request)),
        );
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/web/bootstrap/revoke"
      ) {
        if (webAuthorization?.kind !== "persistent") {
          throw new HttpRequestError(
            403,
            "web-bootstrap-authority-required",
            "local dashboard launch requires the protected Relay authority",
          );
        }
        const input = WebBootstrapRevokeSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        webSessionAuthority.revokeGrant(input.grant);
        sendJson(response, 200, { revoked: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/web/session") {
        if (webAuthorization?.kind !== "session") {
          throw new HttpRequestError(
            401,
            "web-session-missing",
            "the local browser session is missing; run agent-relay dashboard --web",
          );
        }
        sendJson(response, 200, webAuthorization.session);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/web/meta") {
        sendJson(
          response,
          200,
          WebMetaV1Schema.parse({
            schema: "agent-relay-web-meta.v1",
            apiVersion: WEB_API_VERSION,
            assetVersion: WEB_ASSET_VERSION,
            commandSchemas: [
              "agent-relay-web-resolve.v1",
              "agent-relay-web-session-action.v1",
            ],
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/web/projects") {
        const projectKey = projectKeySchema.parse(
          url.searchParams.get("project") ?? "all",
        );
        const harnessValue = url.searchParams.get("harness");
        const stateValue = url.searchParams.get("state");
        const cursorValue = url.searchParams.get("cursor");
        sendJson(
          response,
          200,
          service.store.readProjectSnapshot({
            projectKey,
            ...(harnessValue === null
              ? {}
              : { harness: projectHarnessSchema.parse(harnessValue) }),
            ...(stateValue === null
              ? {}
              : { state: projectStateSchema.parse(stateValue) }),
            historyLimit: projectHistoryLimitSchema.parse(
              url.searchParams.get("limit") ?? "50",
            ),
            ...(cursorValue === null
              ? {}
              : {
                  historyCursor: opaqueProjectCursorSchema.parse(cursorValue),
                }),
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/web/project-changes"
      ) {
        sendJson(
          response,
          200,
          service.store.readProjectChanges({
            cursor: opaqueProjectCursorSchema.parse(
              url.searchParams.get("cursor"),
            ),
            limit: projectChangeLimitSchema.parse(
              url.searchParams.get("limit") ?? "100",
            ),
          }),
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
            .map(({ session, activity, attentionCount }) =>
              toWebSession(service, session, activity, attentionCount),
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
            : {
                sessionActivity: session.activity,
              }),
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
          sessionKey: sessionPublicKey(event),
          type: event.type,
          deliveryStatus: record.status,
          repository: redactText(event.project.displayName, 120),
          ...(event.project.branch === undefined
            ? {}
            : { branch: redactText(event.project.branch, 240) }),
          ...(event.summary === undefined
            ? {}
            : { summary: redactDiagnosticText(event.summary, 1_000) }),
          ...(event.failure === undefined
            ? {}
            : {
                failure: {
                  code: event.failure.class,
                  message: redactDiagnosticText(event.failure.message, 500),
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
        const sessionExpiry =
          webAuthorization?.kind === "session"
            ? setTimeout(
                () => response.end(),
                Math.max(
                  0,
                  Date.parse(webAuthorization.session?.expiresAt ?? "") -
                    Date.now(),
                ),
              )
            : undefined;
        const cleanUp = (): void => {
          clearInterval(poll);
          clearInterval(heartbeat);
          if (sessionExpiry !== undefined) clearTimeout(sessionExpiry);
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
          sessionPublicKey(pending) !== command.sessionKey
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

      if (
        request.method === "POST" &&
        url.pathname === "/v1/mcp/bindings/register"
      ) {
        const identity = mcpBindingIdentitySchema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.registerMcpSessionBinding({
          token: mcpBindingToken(request),
          ...identity,
        });
        sendJson(response, 200, {
          outcome: result.outcome,
          ...(!("binding" in result) || result.binding === undefined
            ? {}
            : { bindingState: result.binding.state }),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/mcp/bindings/claim"
      ) {
        const identity = mcpBindingClaimSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.claimMcpSessionBinding({
          token: mcpBindingToken(request),
          ...identity,
        });
        sendJson(response, 200, {
          outcome: result.outcome,
          ...(result.binding === undefined
            ? {}
            : { bindingState: result.binding.state }),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/mcp/bindings/end"
      ) {
        const identity = mcpBindingEndSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.endMcpSessionBinding({
          token: mcpBindingToken(request),
          machineId: identity.machineId,
          bridgeSessionId: identity.bridgeSessionId,
          harness: identity.harness,
          ...(identity.sessionId === undefined
            ? {}
            : { sessionId: identity.sessionId }),
        });
        sendJson(response, 200, {
          outcome: result.outcome,
          ...(!("binding" in result) || result.binding === undefined
            ? {}
            : { bindingState: result.binding.state }),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/mcp/interactions"
      ) {
        const command = mcpInteractionSchema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.openMcpInteraction(
          mcpBindingAuthority(request),
          command,
        );
        sendJson(response, 200, {
          outcome: result.outcome,
          ...(!("binding" in result) || result.binding === undefined
            ? {}
            : { bindingState: result.binding.state }),
          ...(result.request === undefined
            ? {}
            : {
                requestId: result.request.correlationId,
                requestState: result.request.state,
              }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mcp/cancel") {
        const command = RelayMcpCancelV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.cancelMcpInteraction(
          mcpBindingAuthority(request),
          command.requestId,
        );
        sendJson(response, 200, {
          outcome: result.outcome,
          ...(result.request === undefined
            ? {}
            : {
                requestId: result.request.correlationId,
                requestState: result.request.state,
              }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mcp/status") {
        const command = RelayMcpStatusV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        const result = service.mcpInteractionStatus(
          mcpBindingAuthority(request),
          command.requestId,
        );
        sendJson(response, 200, {
          bindingState: result.binding?.state ?? "missing",
          ...(result.session === undefined
            ? {}
            : {
                harness: result.session.harness,
                activityState: result.session.activity.state,
              }),
          ...(result.openRequestCount === undefined
            ? {}
            : { openRequestCount: result.openRequestCount }),
          delivery: result.delivery,
          ...(result.request === undefined
            ? {}
            : {
                requestId: result.request.correlationId,
                requestState: result.request.state,
              }),
          ...(result.answer === undefined ? {} : { answer: result.answer }),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, { healthy: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, {
          healthy: true,
          transport: service.transport.name,
          webEnabled,
          ...service.store.status(),
          ...(options.statusDetails?.() ?? {}),
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
        url.pathname === "/v1/canaries/telegram"
      ) {
        const event = AgentAttentionEventV1Schema.parse(
          await readJson(request, maxBodyBytes),
        );
        if (options.telegramCanaryReady?.() !== true) {
          sendJson(response, 409, {
            code: "telegram-intake-not-ready",
            message: "Telegram reply intake is not ready for a canary",
          });
          return;
        }
        const ingest = service.ingest(event);
        sendJson(response, 200, {
          ingest,
          drain: await service.drain(),
        });
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
      const projectReadError =
        error instanceof ProjectReadError ? error : undefined;
      const webSessionError =
        error instanceof WebSessionAuthorityError ? error : undefined;
      const requestError =
        error instanceof HttpRequestError ? error : undefined;
      const status =
        requestError?.status ??
        webSessionError?.status ??
        (projectReadError?.code === "project_not_found"
          ? 404
          : projectReadError?.code === "stale_cursor"
            ? 409
            : projectReadError?.code === "complete_set_capacity_exceeded"
              ? 503
              : projectReadError === undefined
                ? undefined
                : 400) ??
        (zodError === undefined ? 500 : 400);
      const code =
        requestError?.code ??
        webSessionError?.code ??
        projectReadError?.code ??
        (zodError === undefined ? "internal-error" : "invalid-payload");
      const message =
        requestError?.message ??
        webSessionError?.message ??
        projectReadError?.message ??
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
          path: safeRequestPath(request.url),
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
