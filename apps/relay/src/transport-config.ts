import { join } from "node:path";

import { z } from "zod";

import {
  whooshbangConnectionPaths,
  readWhooshBangConnection,
  safeWhooshBangConnectionSummary,
} from "./whooshbang-config.js";
import { atomicWritePrivateJson, readPrivateJson } from "./private-config.js";
import {
  resolveWebhookConfiguration,
  type WebhookReadiness,
} from "./webhook-config.js";

const MAX_TRANSPORT_CONFIGURATION_BYTES = 16 * 1024;
const TRANSPORT_FILE_OPTIONS = {
  description: "Transport configuration",
  maximumBytes: MAX_TRANSPORT_CONFIGURATION_BYTES,
} as const;

export const AgentRelayTransportSchema = z.enum([
  "fake",
  "telegram",
  "whooshbang",
  "webhook",
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

export interface WhooshBangReadiness {
  apiOrigin?: string;
  binding: "verified-at-connect" | "inactive" | "unavailable";
  canaryEvidence?: {
    committedCursorRef: string;
    completedAt: string;
    connectedAt: string;
    credentialGeneration: number;
    lastSuccessfulPollAt: string;
    lastSuccessfulSendAt: string;
  };
  canaryRef?: string;
  configured: boolean;
  credentialPermissions: "pinned-machine-scopes" | "inactive" | "unavailable";
  connectionStatus?: "active" | "disconnected" | "revoked" | "invalid";
  contractVersion?: string;
  credentialGeneration?: number;
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
    whooshbang: WhooshBangReadiness;
    telegram: TelegramReadiness;
    webhook: WebhookReadiness;
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

export function transportSelectionPath(stateDirectory: string): string {
  return join(stateDirectory, "transport.json");
}

export async function readTransportSelection(
  path: string,
): Promise<TransportSelectionConfiguration | undefined> {
  const value = await readPrivateJson(path, TRANSPORT_FILE_OPTIONS);
  if (value === undefined) {
    return undefined;
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
  await atomicWritePrivateJson(path, configuration, TRANSPORT_FILE_OPTIONS);
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

async function whooshbangReadiness(
  stateDirectory: string,
): Promise<WhooshBangReadiness> {
  try {
    const connection = await readWhooshBangConnection(
      whooshbangConnectionPaths(stateDirectory),
    );
    if (connection === undefined) {
      return {
        binding: "unavailable",
        configured: false,
        credentialPermissions: "unavailable",
        credentialPresent: false,
        issueCodes: ["whooshbang-not-configured"],
        pendingRevocations: 0,
        ready: false,
        resolutionPresentation: "unsupported-in-pinned-contract",
      };
    }
    const safe = safeWhooshBangConnectionSummary(connection);
    const ready =
      connection.configuration.status === "active" &&
      connection.credential !== undefined;
    return {
      apiOrigin: safe.apiOrigin,
      binding: ready ? "verified-at-connect" : "inactive",
      ...(safe.canaryEvidence === null
        ? {}
        : { canaryEvidence: safe.canaryEvidence }),
      ...(safe.canaryRef === null ? {} : { canaryRef: safe.canaryRef }),
      configured: true,
      credentialPermissions: ready ? "pinned-machine-scopes" : "inactive",
      connectionStatus: connection.configuration.status,
      contractVersion: safe.contractVersion,
      ...(safe.credentialGeneration === null
        ? {}
        : { credentialGeneration: safe.credentialGeneration }),
      credentialPresent: safe.credentialPresent,
      environment: safe.environment,
      issueCodes: [
        ...(connection.configuration.status !== "active"
          ? [`whooshbang-${connection.configuration.status}`]
          : []),
        ...(connection.credential === undefined
          ? ["whooshbang-credential-missing"]
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
      issueCodes: ["whooshbang-configuration-invalid"],
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
  webhookEnvironment?: Readonly<Record<string, string | undefined>>;
}): Promise<TransportReadinessReport> {
  const webhook = await resolveWebhookConfiguration({
    stateDirectory: input.stateDirectory,
    environment: input.webhookEnvironment ?? {},
  });
  return {
    schema: "agent-relay-transport-readiness.v1",
    selectedTransport: input.selection.selected,
    selection: input.selection,
    transports: {
      fake: { ready: true },
      whooshbang: await whooshbangReadiness(input.stateDirectory),
      telegram: telegramReadiness(input.telegram ?? {}),
      webhook: webhook.readiness,
    },
  };
}
