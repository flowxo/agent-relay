import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  AgentAttentionEventV1Schema,
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
      assertAuthorized(request, options.token);
      const url = new URL(request.url ?? "/", "http://relay.local");

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
