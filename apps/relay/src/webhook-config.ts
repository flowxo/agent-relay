import { join } from "node:path";

import {
  parseWebhookEndpoint,
  parseWebhookSecret,
  parseWebhookTimeout,
  webhookEndpointOrigin,
  WEBHOOK_DEFAULT_TIMEOUT_MS,
  type WebhookTransportOptions,
} from "@agent-relay/webhook-transport";
import { z } from "zod";

import {
  atomicWritePrivateJson,
  readPrivateJson,
  removePrivateConfigurationFile,
} from "./private-config.js";

const MAX_WEBHOOK_CONFIGURATION_BYTES = 16 * 1_024;
const WEBHOOK_FILE_OPTIONS = {
  description: "Webhook configuration",
  maximumBytes: MAX_WEBHOOK_CONFIGURATION_BYTES,
} as const;

function endpointSchema() {
  return z.string().superRefine((value, context) => {
    try {
      parseWebhookEndpoint(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Webhook URL is invalid",
      });
    }
  });
}

function secretSchema() {
  return z.string().superRefine((value, context) => {
    try {
      parseWebhookSecret(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Webhook secret is invalid",
      });
    }
  });
}

function timeoutSchema() {
  return z.number().superRefine((value, context) => {
    try {
      parseWebhookTimeout(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Webhook timeout is invalid",
      });
    }
  });
}

export const WebhookConfigurationSchema = z
  .object({
    schema: z.literal("agent-relay-webhook-config.v1"),
    endpoint: endpointSchema(),
    secret: secretSchema(),
    timeoutMs: timeoutSchema(),
    configuredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type WebhookConfiguration = z.infer<typeof WebhookConfigurationSchema>;

export interface WebhookReadiness {
  configured: boolean;
  endpointOrigin?: string;
  issueCodes: string[];
  ready: boolean;
  secretPresent: boolean;
  source: "environment" | "file" | "none";
  timeoutMs?: number;
}

export interface ResolvedWebhookConfiguration {
  readiness: WebhookReadiness;
  runtime?: WebhookTransportOptions;
}

export function webhookConfigurationPath(stateDirectory: string): string {
  return join(stateDirectory, "webhook.json");
}

export async function readWebhookConfiguration(
  path: string,
): Promise<WebhookConfiguration | undefined> {
  const value = await readPrivateJson(path, WEBHOOK_FILE_OPTIONS);
  return value === undefined
    ? undefined
    : WebhookConfigurationSchema.parse(value);
}

export async function writeWebhookConfiguration(
  path: string,
  input: {
    endpoint: string;
    secret: string;
    timeoutMs?: number;
  },
  now = new Date(),
): Promise<WebhookConfiguration> {
  const configuration = WebhookConfigurationSchema.parse({
    schema: "agent-relay-webhook-config.v1",
    endpoint: input.endpoint,
    secret: input.secret,
    timeoutMs: input.timeoutMs ?? WEBHOOK_DEFAULT_TIMEOUT_MS,
    configuredAt: now.toISOString(),
  });
  await atomicWritePrivateJson(path, configuration, WEBHOOK_FILE_OPTIONS);
  return configuration;
}

export async function removeWebhookConfiguration(
  path: string,
): Promise<boolean> {
  return await removePrivateConfigurationFile(path, WEBHOOK_FILE_OPTIONS);
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function resolved(
  source: "environment" | "file",
  input: { endpoint: string; secret: string; timeoutMs: number },
): ResolvedWebhookConfiguration {
  const parsed = WebhookConfigurationSchema.safeParse({
    schema: "agent-relay-webhook-config.v1",
    ...input,
    configuredAt: new Date(0).toISOString(),
  });
  if (!parsed.success) {
    return {
      readiness: {
        configured: true,
        issueCodes: ["webhook-configuration-invalid"],
        ready: false,
        secretPresent: input.secret.length > 0,
        source,
      },
    };
  }
  return {
    readiness: {
      configured: true,
      endpointOrigin: webhookEndpointOrigin(parsed.data.endpoint),
      issueCodes: [],
      ready: true,
      secretPresent: true,
      source,
      timeoutMs: parsed.data.timeoutMs,
    },
    runtime: {
      endpoint: parsed.data.endpoint,
      secret: parsed.data.secret,
      timeoutMs: parsed.data.timeoutMs,
    },
  };
}

export async function resolveWebhookConfiguration(input: {
  stateDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ResolvedWebhookConfiguration> {
  const environment = input.environment ?? process.env;
  const endpoint = environmentValue(environment, "AGENT_RELAY_WEBHOOK_URL");
  const secret = environmentValue(environment, "AGENT_RELAY_WEBHOOK_SECRET");
  const timeout = environmentValue(
    environment,
    "AGENT_RELAY_WEBHOOK_TIMEOUT_MS",
  );
  if (endpoint !== undefined || secret !== undefined || timeout !== undefined) {
    const issueCodes = [
      ...(endpoint === undefined ? ["webhook-url-missing"] : []),
      ...(secret === undefined ? ["webhook-secret-missing"] : []),
    ];
    const parsedTimeout =
      timeout === undefined ? WEBHOOK_DEFAULT_TIMEOUT_MS : Number(timeout);
    if (
      timeout !== undefined &&
      (!Number.isSafeInteger(parsedTimeout) || parsedTimeout < 0)
    ) {
      issueCodes.push("webhook-timeout-invalid");
    }
    if (
      issueCodes.length > 0 ||
      endpoint === undefined ||
      secret === undefined
    ) {
      return {
        readiness: {
          configured: true,
          issueCodes,
          ready: false,
          secretPresent: secret !== undefined,
          source: "environment",
        },
      };
    }
    return resolved("environment", {
      endpoint,
      secret,
      timeoutMs: parsedTimeout,
    });
  }

  try {
    const configuration = await readWebhookConfiguration(
      webhookConfigurationPath(input.stateDirectory),
    );
    if (configuration === undefined) {
      return {
        readiness: {
          configured: false,
          issueCodes: ["webhook-not-configured"],
          ready: false,
          secretPresent: false,
          source: "none",
        },
      };
    }
    return resolved("file", configuration);
  } catch {
    return {
      readiness: {
        configured: true,
        issueCodes: ["webhook-configuration-invalid"],
        ready: false,
        secretPresent: false,
        source: "file",
      },
    };
  }
}
