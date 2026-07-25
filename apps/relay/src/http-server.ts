import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  AgentAttentionEventV1Schema,
  RelayDiagnosticV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
} from "@agent-relay/protocol";
import type { RelayLogger, RelayService } from "@agent-relay/core";
import { NOOP_LOGGER } from "@agent-relay/core";
import type { TelegramReplyRouter } from "@agent-relay/core";
import { z } from "zod";

const drainSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const diagnosticLimitSchema = z.coerce.number().int().min(1).max(500);

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
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
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
      const isTelegramWebhook =
        request.method === "POST" && url.pathname === "/v1/telegram/updates";
      if (!isTelegramWebhook || options.telegramWebhookSecret === undefined) {
        assertAuthorized(request, options.token);
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
