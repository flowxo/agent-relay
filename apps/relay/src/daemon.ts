import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";

import {
  FakeTelegramTransport,
  JsonLineLogger,
  RelayService,
  RelayStore,
  TelegramReplyRouter,
  TelegramBotTransport,
} from "@agent-relay/core";
import type { NotificationTransport, RelayLogger } from "@agent-relay/core";
import type { RetentionOptions, RetentionResult } from "@agent-relay/core";
import {
  NotificationsContractTransport,
  NotificationsMachineInteractionSource,
  PinnedNotificationsResolutionPresenter,
  type NotificationsContractTransportOptions,
  type NotificationsResolutionPresenter,
} from "@agent-relay/notifications-transport";

import { createRelayHttpServer } from "./http-server.js";
import { replayFallbackSpool } from "./fallback-spool.js";
import type { FallbackReplayResult } from "./fallback-spool.js";
import { TelegramUpdatePoller } from "./telegram-poller.js";
import type {
  AgentRelayTransport,
  ResolvedTransportSelection,
  TransportReadinessReport,
} from "./transport-config.js";
import { buildDaemonTransportStatus } from "./transport-status.js";
import { loadOrCreateWebCredential } from "./web-credential.js";
import {
  notificationsStreamKey,
  NotificationsInteractionPoller,
} from "./notifications-poller.js";

export interface DaemonNotificationsOptions extends NotificationsContractTransportOptions {
  bindingId: string;
  machineId: string;
  presenter?: NotificationsResolutionPresenter;
}

export interface DaemonOptions {
  databasePath: string;
  webEnabled?: boolean;
  webCredentialPath?: string;
  host?: string;
  port?: number;
  token?: string;
  selectedTransport?: AgentRelayTransport;
  transportSelection?: ResolvedTransportSelection;
  transportReadiness?: TransportReadinessReport;
  telegramToken?: string;
  telegramChatId?: string;
  telegramOperatorUserId?: number;
  telegramReplyChatId?: number;
  telegramWebhookSecret?: string;
  telegramUpdateMode?: "poll" | "webhook";
  telegramFetch?: typeof fetch;
  notifications?: DaemonNotificationsOptions;
  coalescingWindowMs?: number;
  drainIntervalMs?: number;
  fallbackPath?: string;
  fallbackReplayIntervalMs?: number;
  retention?: RetentionOptions;
  retentionIntervalMs?: number;
  logger?: RelayLogger;
}

export interface RunningDaemon {
  server: Server;
  service: RelayService;
  webCredentialPath?: string;
  initialFallbackReplay?: FallbackReplayResult;
  initialRetention: RetentionResult;
  close(): Promise<void>;
}

function selectTransport(options: DaemonOptions): NotificationTransport {
  const selected = options.selectedTransport ?? "fake";
  switch (selected) {
    case "fake":
      return new FakeTelegramTransport();
    case "telegram": {
      if (
        options.telegramToken === undefined ||
        options.telegramChatId === undefined
      ) {
        throw new Error(
          "selected Telegram transport requires AGENT_RELAY_TELEGRAM_TOKEN and AGENT_RELAY_TELEGRAM_CHAT_ID",
        );
      }
      return new TelegramBotTransport({
        token: options.telegramToken,
        chatId: options.telegramChatId,
        ...(options.telegramFetch === undefined
          ? {}
          : { fetch: options.telegramFetch }),
      });
    }
    case "notifications":
      if (options.notifications === undefined) {
        throw new Error(
          "selected Notifications transport requires an active narrow machine connection",
        );
      }
      return new NotificationsContractTransport(options.notifications);
  }
}

export async function startDaemon(
  options: DaemonOptions,
): Promise<RunningDaemon> {
  const telegramUpdateMode = options.telegramUpdateMode ?? "poll";
  if (telegramUpdateMode !== "poll" && telegramUpdateMode !== "webhook") {
    throw new Error("Telegram update mode must be poll or webhook");
  }
  await mkdir(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const webEnabled = options.webEnabled ?? true;
  const webCredentialPath = webEnabled
    ? (options.webCredentialPath ??
      join(dirname(options.databasePath), "web-credential.json"))
    : undefined;
  const webCredential =
    webCredentialPath === undefined
      ? undefined
      : await loadOrCreateWebCredential(webCredentialPath);
  const logger = options.logger ?? new JsonLineLogger();
  const transport = selectTransport(options);
  const selectedTransport = options.selectedTransport ?? "fake";
  const transportSelection =
    options.transportSelection ??
    ({
      configured: options.selectedTransport !== undefined,
      selected: selectedTransport,
      source:
        options.selectedTransport === undefined ? "default" : "command-line",
    } satisfies ResolvedTransportSelection);
  if (transportSelection.selected !== selectedTransport) {
    throw new Error(
      "resolved transport selection does not match the daemon transport",
    );
  }
  if (
    options.transportReadiness !== undefined &&
    options.transportReadiness.selectedTransport !== selectedTransport
  ) {
    throw new Error(
      "transport readiness does not match the daemon transport selection",
    );
  }
  const notificationsRuntime =
    transport instanceof NotificationsContractTransport
      ? options.notifications
      : undefined;
  if (
    transport instanceof NotificationsContractTransport &&
    notificationsRuntime === undefined
  ) {
    throw new Error(
      "selected Notifications transport requires machine interaction configuration",
    );
  }
  const hostedStreamKey =
    notificationsRuntime === undefined
      ? undefined
      : notificationsStreamKey(
          notificationsRuntime.baseUrl,
          notificationsRuntime.machineClientId,
        );
  const notificationsPresenter =
    notificationsRuntime === undefined
      ? undefined
      : (notificationsRuntime.presenter ??
        new PinnedNotificationsResolutionPresenter());
  if (
    telegramUpdateMode === "webhook" &&
    transport instanceof TelegramBotTransport &&
    options.telegramWebhookSecret === undefined
  ) {
    throw new Error(
      "Telegram webhook mode requires AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
    );
  }
  if (transport instanceof TelegramBotTransport) {
    const report = await transport.verifySetup(telegramUpdateMode);
    logger.log({
      level: "info",
      code: "telegram.preflight-succeeded",
      message: "Telegram private-topic setup verified",
      at: new Date().toISOString(),
      details: { ...report },
    });
  }
  const store = new RelayStore(options.databasePath);
  const service = new RelayService(store, transport, {
    logger,
    ...(options.coalescingWindowMs === undefined
      ? {}
      : { coalescingWindowMs: options.coalescingWindowMs }),
  });
  service.recover();
  const replyRouter =
    transport instanceof NotificationsContractTransport ||
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
    ...(options.telegramWebhookSecret === undefined ||
    transport instanceof NotificationsContractTransport
      ? {}
      : { telegramWebhookSecret: options.telegramWebhookSecret }),
    webEnabled,
    ...(webCredential === undefined ? {} : { webCredential }),
    statusDetails: () =>
      buildDaemonTransportStatus({
        service,
        selection: transportSelection,
        ...(hostedStreamKey === undefined ? {} : { hostedStreamKey }),
        ...(notificationsPresenter === undefined
          ? {}
          : {
              hostedPresentationCapability: notificationsPresenter.capability,
            }),
        ...(options.transportReadiness === undefined
          ? {}
          : { readiness: options.transportReadiness }),
      }),
    logger,
  });

  let activeFallbackReplay:
    Promise<FallbackReplayResult | undefined> | undefined;
  const performFallbackReplay = async (): Promise<
    FallbackReplayResult | undefined
  > => {
    if (options.fallbackPath === undefined) {
      return undefined;
    }
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
    }
  };
  const replayFallback = (): Promise<FallbackReplayResult | undefined> => {
    if (activeFallbackReplay !== undefined) {
      return activeFallbackReplay;
    }
    activeFallbackReplay = performFallbackReplay().finally(() => {
      activeFallbackReplay = undefined;
    });
    return activeFallbackReplay;
  };
  const initialFallbackReplay = await replayFallback();
  let initialRetention: RetentionResult;
  try {
    initialRetention = service.maintainRetention(options.retention);
  } catch (error) {
    store.close();
    throw error;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4317, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }

  let telegramPollingAbort: AbortController | undefined;
  let telegramPolling: Promise<void> | undefined;
  if (
    telegramUpdateMode === "poll" &&
    transport instanceof TelegramBotTransport &&
    replyRouter !== undefined
  ) {
    telegramPollingAbort = new AbortController();
    telegramPolling = new TelegramUpdatePoller({
      source: transport,
      handler: replyRouter,
      logger,
    })
      .run(telegramPollingAbort.signal)
      .catch((error: unknown) => {
        logger.log({
          level: "error",
          code: "telegram.poll-crashed",
          message:
            error instanceof Error
              ? error.message
              : "Telegram polling stopped unexpectedly",
          at: new Date().toISOString(),
        });
      });
  } else if (
    transport instanceof TelegramBotTransport &&
    replyRouter === undefined
  ) {
    logger.log({
      level: "warn",
      code: "telegram.replies-disabled",
      message: "Telegram replies require operator and reply chat identifiers",
      at: new Date().toISOString(),
    });
  }

  let notificationsPollingAbort: AbortController | undefined;
  let notificationsPolling: Promise<void> | undefined;
  if (
    transport instanceof NotificationsContractTransport &&
    notificationsRuntime !== undefined &&
    hostedStreamKey !== undefined
  ) {
    notificationsPollingAbort = new AbortController();
    notificationsPolling = new NotificationsInteractionPoller({
      store,
      source: new NotificationsMachineInteractionSource({
        baseUrl: notificationsRuntime.baseUrl,
        credential: notificationsRuntime.credential,
        ...(notificationsRuntime.connectionGuard === undefined
          ? {}
          : { connectionGuard: notificationsRuntime.connectionGuard }),
        ...(notificationsRuntime.fetch === undefined
          ? {}
          : { fetch: notificationsRuntime.fetch }),
      }),
      streamKey: hostedStreamKey,
      ...(notificationsPresenter === undefined
        ? {}
        : { presenter: notificationsPresenter }),
      machineId: notificationsRuntime.machineId,
      bindingId: notificationsRuntime.bindingId,
      logger,
    })
      .run(notificationsPollingAbort.signal)
      .catch((error: unknown) => {
        logger.log({
          level: "error",
          code: "notifications.poll-crashed",
          message:
            error instanceof Error
              ? error.message
              : "Notifications polling stopped unexpectedly",
          at: new Date().toISOString(),
        });
      });
  }

  let activeDrain: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (activeDrain !== undefined) {
      return;
    }
    activeDrain = service
      .drain()
      .then(() => undefined)
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
        activeDrain = undefined;
      });
  }, options.drainIntervalMs ?? 1_000);
  const fallbackInterval =
    options.fallbackPath === undefined
      ? undefined
      : setInterval(() => {
          void replayFallback();
        }, options.fallbackReplayIntervalMs ?? 5_000);
  const retentionInterval = setInterval(
    () => {
      try {
        service.maintainRetention(options.retention);
      } catch (error) {
        logger.log({
          level: "error",
          code: "retention.failed",
          message:
            error instanceof Error
              ? error.message
              : "retention maintenance failed",
          at: new Date().toISOString(),
        });
      }
    },
    options.retentionIntervalMs ?? 60 * 60_000,
  );

  logger.log({
    level: "info",
    code: "daemon.started",
    message: "agent relay daemon started",
    at: new Date().toISOString(),
    details: {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4317,
      transport: service.transport.name,
      selectedTransport,
      telegramUpdateMode:
        transport instanceof TelegramBotTransport
          ? telegramUpdateMode
          : "disabled",
      webEnabled,
    },
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) {
      return closePromise;
    }
    telegramPollingAbort?.abort();
    notificationsPollingAbort?.abort();
    clearInterval(interval);
    clearInterval(retentionInterval);
    if (fallbackInterval !== undefined) {
      clearInterval(fallbackInterval);
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
      server.closeAllConnections();
    });
    closePromise = Promise.all([
      serverClosed,
      activeDrain ?? Promise.resolve(),
      activeFallbackReplay ?? Promise.resolve(),
      telegramPolling ?? Promise.resolve(),
      notificationsPolling ?? Promise.resolve(),
    ]).then(() => {
      store.close();
    });
    return closePromise;
  };

  return {
    server,
    service,
    ...(webCredentialPath === undefined ? {} : { webCredentialPath }),
    ...(initialFallbackReplay === undefined ? {} : { initialFallbackReplay }),
    initialRetention,
    close,
  };
}
