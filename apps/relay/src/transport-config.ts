import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  notificationsConnectionPaths,
  readNotificationsConnection,
  safeNotificationsConnectionSummary,
} from "./notifications-config.js";

const MAX_TRANSPORT_CONFIGURATION_BYTES = 16 * 1024;

export const AgentRelayTransportSchema = z.enum([
  "fake",
  "telegram",
  "notifications",
]);
export type AgentRelayTransport = z.infer<typeof AgentRelayTransportSchema>;

export const TransportSelectionConfigurationSchema = z
  .object({
    schema: z.literal("agent-relay-transport-selection.v1"),
    selected: AgentRelayTransportSchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type TransportSelectionConfiguration = z.infer<
  typeof TransportSelectionConfigurationSchema
>;

export type TransportSelectionSource =
  "command-line" | "environment" | "durable" | "default";

export interface ResolvedTransportSelection {
  configured: boolean;
  selected: AgentRelayTransport;
  source: TransportSelectionSource;
  updatedAt?: string;
}

export interface TelegramReadiness {
  configured: "none" | "partial" | "delivery" | "interactive";
  deliveryReady: boolean;
  issueCodes: string[];
  replyReady: boolean;
  ready: boolean;
  updateMode: "poll" | "webhook" | "invalid";
  webhookReady: boolean;
}

export interface NotificationsReadiness {
  apiOrigin?: string;
  binding: "verified-at-connect" | "inactive" | "unavailable";
  canaryRef?: string;
  configured: boolean;
  credentialPermissions: "pinned-machine-scopes" | "inactive" | "unavailable";
  connectionStatus?: "active" | "disconnected" | "revoked" | "invalid";
  contractVersion?: string;
  credentialPresent: boolean;
  environment?: "test" | "live";
  issueCodes: string[];
  machineClientRef?: string;
  pendingRevocations: number;
  ready: boolean;
  resolutionPresentation: "unsupported-in-pinned-contract";
}

export interface TransportReadinessReport {
  schema: "agent-relay-transport-readiness.v1";
  selectedTransport: AgentRelayTransport;
  selection: ResolvedTransportSelection;
  transports: {
    fake: { ready: true };
    notifications: NotificationsReadiness;
    telegram: TelegramReadiness;
  };
}

export interface TelegramReadinessInput {
  chatId?: string;
  operatorId?: string;
  replyChatId?: string;
  token?: string;
  updateMode?: string;
  webhookSecret?: string;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error("Transport configuration parent is not a directory");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "Transport configuration parent must not be accessible by group or others",
    );
  }
}

async function inspectPrivateFile(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error("Transport configuration path is not a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        "Transport configuration must not be accessible by group or others",
      );
    }
    if (metadata.size > MAX_TRANSPORT_CONFIGURATION_BYTES) {
      throw new Error("Transport configuration exceeds its size limit");
    }
    return metadata;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function atomicWritePrivate(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await inspectPrivateFile(path);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The original write failure remains authoritative.
    }
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          "Transport configuration write and cleanup both failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  await inspectPrivateFile(path);
}

export function transportSelectionPath(stateDirectory: string): string {
  return join(stateDirectory, "transport.json");
}

export async function readTransportSelection(
  path: string,
): Promise<TransportSelectionConfiguration | undefined> {
  const metadata = await inspectPrivateFile(path);
  if (metadata === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Transport configuration is not valid JSON");
  }
  return TransportSelectionConfigurationSchema.parse(value);
}

export async function writeTransportSelection(
  path: string,
  selectedInput: AgentRelayTransport,
  now = new Date(),
): Promise<TransportSelectionConfiguration> {
  const selected = AgentRelayTransportSchema.parse(selectedInput);
  const configuration = TransportSelectionConfigurationSchema.parse({
    schema: "agent-relay-transport-selection.v1",
    selected,
    updatedAt: now.toISOString(),
  });
  await atomicWritePrivate(path, configuration);
  return configuration;
}

export async function resolveTransportSelection(input: {
  stateDirectory: string;
  commandLineOverride?: string;
  environmentOverride?: string;
}): Promise<ResolvedTransportSelection> {
  if (input.commandLineOverride !== undefined) {
    return {
      configured: true,
      selected: AgentRelayTransportSchema.parse(input.commandLineOverride),
      source: "command-line",
    };
  }
  if (input.environmentOverride !== undefined) {
    return {
      configured: true,
      selected: AgentRelayTransportSchema.parse(input.environmentOverride),
      source: "environment",
    };
  }
  const durable = await readTransportSelection(
    transportSelectionPath(input.stateDirectory),
  );
  return durable === undefined
    ? {
        configured: false,
        selected: "fake",
        source: "default",
      }
    : {
        configured: true,
        selected: durable.selected,
        source: "durable",
        updatedAt: durable.updatedAt,
      };
}

function numericIdentifier(value: string | undefined, allowNegative: boolean) {
  if (value === undefined) {
    return { present: false, valid: false };
  }
  const parsed = Number(value);
  return {
    present: true,
    valid:
      Number.isSafeInteger(parsed) &&
      parsed !== 0 &&
      (allowNegative || parsed > 0),
  };
}

function telegramReadiness(input: TelegramReadinessInput): TelegramReadiness {
  const tokenPresent = input.token !== undefined && input.token.length > 0;
  const chat = numericIdentifier(input.chatId, true);
  const operator = numericIdentifier(input.operatorId, false);
  const replyChat = numericIdentifier(input.replyChatId ?? input.chatId, true);
  const updateMode =
    input.updateMode === undefined || input.updateMode === "poll"
      ? "poll"
      : input.updateMode === "webhook"
        ? "webhook"
        : "invalid";
  const webhookReady =
    updateMode !== "webhook" ||
    (input.webhookSecret !== undefined && input.webhookSecret.length > 0);
  const deliveryReady = tokenPresent && chat.valid;
  const replyReady = deliveryReady && operator.valid && replyChat.valid;
  const presentCount = [
    tokenPresent,
    chat.present,
    operator.present,
    input.webhookSecret !== undefined,
  ].filter(Boolean).length;
  const issueCodes = [
    ...(presentCount === 0 ? ["telegram-not-configured"] : []),
    ...(!tokenPresent && presentCount > 0 ? ["telegram-token-missing"] : []),
    ...(tokenPresent && !chat.present ? ["telegram-chat-missing"] : []),
    ...(chat.present && !chat.valid ? ["telegram-chat-invalid"] : []),
    ...(deliveryReady && !operator.present
      ? ["telegram-operator-missing"]
      : []),
    ...(operator.present && !operator.valid
      ? ["telegram-operator-invalid"]
      : []),
    ...(updateMode === "invalid" ? ["telegram-update-mode-invalid"] : []),
    ...(!webhookReady ? ["telegram-webhook-secret-missing"] : []),
  ];
  return {
    configured:
      presentCount === 0
        ? "none"
        : deliveryReady
          ? replyReady
            ? "interactive"
            : "delivery"
          : "partial",
    deliveryReady,
    issueCodes,
    replyReady,
    ready: deliveryReady && updateMode !== "invalid" && webhookReady,
    updateMode,
    webhookReady,
  };
}

async function notificationsReadiness(
  stateDirectory: string,
): Promise<NotificationsReadiness> {
  try {
    const connection = await readNotificationsConnection(
      notificationsConnectionPaths(stateDirectory),
    );
    if (connection === undefined) {
      return {
        binding: "unavailable",
        configured: false,
        credentialPermissions: "unavailable",
        credentialPresent: false,
        issueCodes: ["notifications-not-configured"],
        pendingRevocations: 0,
        ready: false,
        resolutionPresentation: "unsupported-in-pinned-contract",
      };
    }
    const safe = safeNotificationsConnectionSummary(connection);
    const ready =
      connection.configuration.status === "active" &&
      connection.credential !== undefined;
    return {
      apiOrigin: safe.apiOrigin,
      binding: ready ? "verified-at-connect" : "inactive",
      canaryRef: safe.canaryRef,
      configured: true,
      credentialPermissions: ready ? "pinned-machine-scopes" : "inactive",
      connectionStatus: connection.configuration.status,
      contractVersion: safe.contractVersion,
      credentialPresent: safe.credentialPresent,
      environment: safe.environment,
      issueCodes: [
        ...(connection.configuration.status !== "active"
          ? [`notifications-${connection.configuration.status}`]
          : []),
        ...(connection.credential === undefined
          ? ["notifications-credential-missing"]
          : []),
      ],
      machineClientRef: safe.machineClientRef,
      pendingRevocations: safe.pendingRevocations,
      ready,
      resolutionPresentation: "unsupported-in-pinned-contract",
    };
  } catch {
    return {
      binding: "unavailable",
      configured: true,
      credentialPermissions: "unavailable",
      connectionStatus: "invalid",
      credentialPresent: false,
      issueCodes: ["notifications-configuration-invalid"],
      pendingRevocations: 0,
      ready: false,
      resolutionPresentation: "unsupported-in-pinned-contract",
    };
  }
}

export async function inspectTransportReadiness(input: {
  selection: ResolvedTransportSelection;
  stateDirectory: string;
  telegram?: TelegramReadinessInput;
}): Promise<TransportReadinessReport> {
  return {
    schema: "agent-relay-transport-readiness.v1",
    selectedTransport: input.selection.selected,
    selection: input.selection,
    transports: {
      fake: { ready: true },
      notifications: await notificationsReadiness(input.stateDirectory),
      telegram: telegramReadiness(input.telegram ?? {}),
    },
  };
}
