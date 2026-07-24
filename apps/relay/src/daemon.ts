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
  logger?: RelayLogger;
}

export interface RunningDaemon {
  server: Server;
  service: RelayService;
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
    close: async () => {
      clearInterval(interval);
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
