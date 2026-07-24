import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";

import {
  FakeTelegramTransport,
  JsonLineLogger,
  RelayService,
  RelayStore,
  TelegramReplyRouter,
  TelegramBotTransport,
} from "@agent-relay/core";
import type { NotificationTransport, RelayLogger } from "@agent-relay/core";

import { createRelayHttpServer } from "./http-server.js";
import { replayFallbackSpool } from "./fallback-spool.js";
import type { FallbackReplayResult } from "./fallback-spool.js";

export interface DaemonOptions {
  databasePath: string;
  host?: string;
  port?: number;
  token?: string;
  telegramToken?: string;
  telegramChatId?: string;
  telegramOperatorUserId?: number;
  telegramReplyChatId?: number;
  telegramWebhookSecret?: string;
  drainIntervalMs?: number;
  fallbackPath?: string;
  fallbackReplayIntervalMs?: number;
  logger?: RelayLogger;
}

export interface RunningDaemon {
  server: Server;
  service: RelayService;
  initialFallbackReplay?: FallbackReplayResult;
  close(): Promise<void>;
}

function selectTransport(options: DaemonOptions): NotificationTransport {
  const hasToken = options.telegramToken !== undefined;
  const hasChat = options.telegramChatId !== undefined;
  if (hasToken !== hasChat) {
    throw new Error(
      "both AGENT_RELAY_TELEGRAM_TOKEN and AGENT_RELAY_TELEGRAM_CHAT_ID are required",
    );
  }
  if (
    options.telegramToken !== undefined &&
    options.telegramChatId !== undefined
  ) {
    return new TelegramBotTransport({
      token: options.telegramToken,
      chatId: options.telegramChatId,
    });
  }
  return new FakeTelegramTransport();
}

export async function startDaemon(
  options: DaemonOptions,
): Promise<RunningDaemon> {
  await mkdir(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const logger = options.logger ?? new JsonLineLogger();
  const store = new RelayStore(options.databasePath);
  const transport = selectTransport(options);
  const service = new RelayService(store, transport, { logger });
  service.recover();
  const replyRouter =
    options.telegramOperatorUserId === undefined ||
    options.telegramReplyChatId === undefined
      ? undefined
      : new TelegramReplyRouter(store, transport, {
          operatorUserId: options.telegramOperatorUserId,
          chatId: options.telegramReplyChatId,
          logger,
        });
  const server = createRelayHttpServer(service, {
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(replyRouter === undefined ? {} : { replyRouter }),
    ...(options.telegramWebhookSecret === undefined
      ? {}
      : { telegramWebhookSecret: options.telegramWebhookSecret }),
    logger,
  });

  let draining = false;
  const interval = setInterval(() => {
    if (draining) {
      return;
    }
    draining = true;
    void service
      .drain()
      .catch((error: unknown) => {
        logger.log({
          level: "error",
          code: "delivery.drain-failed",
          message:
            error instanceof Error ? error.message : "delivery drain failed",
          at: new Date().toISOString(),
        });
      })
      .finally(() => {
        draining = false;
      });
  }, options.drainIntervalMs ?? 1_000);

  let replayingFallback = false;
  const replayFallback = async (): Promise<
    FallbackReplayResult | undefined
  > => {
    if (options.fallbackPath === undefined || replayingFallback) {
      return undefined;
    }
    replayingFallback = true;
    try {
      const result = await replayFallbackSpool(options.fallbackPath, {
        ingest: async (event) => service.ingest(event),
        reportDiagnostic: async (diagnostic) =>
          service.reportDiagnostic(diagnostic),
      });
      if (result.records > 0 || result.filesPending > 0) {
        logger.log({
          level: result.filesPending === 0 ? "info" : "error",
          code:
            result.filesPending === 0
              ? "fallback.replayed"
              : "fallback.replay-incomplete",
          message:
            result.filesPending === 0
              ? `replayed ${result.records} fallback records`
              : `${result.filesPending} fallback segments remain pending`,
          at: new Date().toISOString(),
          details: {
            records: result.records,
            events: result.events,
            diagnostics: result.diagnostics,
            malformed: result.malformed,
            filesPending: result.filesPending,
          },
        });
      }
      return result;
    } catch (error) {
      logger.log({
        level: "error",
        code: "fallback.replay-failed",
        message:
          error instanceof Error ? error.message : "fallback replay failed",
        at: new Date().toISOString(),
      });
      return undefined;
    } finally {
      replayingFallback = false;
    }
  };
  const initialFallbackReplay = await replayFallback();
  const fallbackInterval =
    options.fallbackPath === undefined
      ? undefined
      : setInterval(() => {
          void replayFallback();
        }, options.fallbackReplayIntervalMs ?? 5_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.log({
    level: "info",
    code: "daemon.started",
    message: "agent relay daemon started",
    at: new Date().toISOString(),
    details: {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4317,
      transport: service.transport.name,
    },
  });

  return {
    server,
    service,
    ...(initialFallbackReplay === undefined ? {} : { initialFallbackReplay }),
    close: async () => {
      clearInterval(interval);
      if (fallbackInterval !== undefined) {
        clearInterval(fallbackInterval);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      store.close();
    },
  };
}
