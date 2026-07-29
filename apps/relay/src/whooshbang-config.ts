import { createHash, randomUUID } from "node:crypto";
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

import {
  isWhooshBangMachineCredential,
  normalizeWhooshBangBaseUrl,
  WHOOSHBANG_CONTRACT_VERSION,
  WHOOSHBANG_MACHINE_SCOPES,
} from "@agent-relay/whooshbang-transport";
import { z } from "zod";

const MAX_CONFIGURATION_BYTES = 64 * 1024;

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

const opaqueIdentifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !containsAsciiControl(value), {
    message: "must be a bounded opaque identifier",
  });
const credentialIdentifier = z
  .string()
  .regex(/^mcred_[A-Za-z0-9_-]{21}[AQgw]$/u);

const PendingRevocationSchema = z
  .object({
    machineClientId: opaqueIdentifier,
    credentialId: credentialIdentifier,
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const WhooshBangConnectionConfigurationSchema = z
  .object({
    schema: z.literal("agent-relay-whooshbang-config.v1"),
    status: z.enum(["active", "disconnected", "revoked"]),
    baseUrl: z
      .string()
      .max(2_048)
      .refine((value) => {
        try {
          return normalizeWhooshBangBaseUrl(value).toString() === value;
        } catch {
          return false;
        }
      }, "must be a canonical safe WhooshBang base URL"),
    contractVersion: z.literal(WHOOSHBANG_CONTRACT_VERSION),
    environment: z.enum(["test", "live"]),
    projectId: opaqueIdentifier,
    machineClientId: opaqueIdentifier,
    subscriberId: opaqueIdentifier,
    notifierId: opaqueIdentifier,
    bindingId: opaqueIdentifier,
    currentCredentialId: credentialIdentifier,
    scopeSummary: z.tuple([
      z.literal(WHOOSHBANG_MACHINE_SCOPES[0]),
      z.literal(WHOOSHBANG_MACHINE_SCOPES[1]),
      z.literal(WHOOSHBANG_MACHINE_SCOPES[2]),
      z.literal(WHOOSHBANG_MACHINE_SCOPES[3]),
    ]),
    connectedAt: z.iso.datetime({ offset: true }),
    disconnectedAt: z.iso.datetime({ offset: true }).optional(),
    canaryMessageId: opaqueIdentifier,
    canaryDiagnosticId: opaqueIdentifier,
    pendingRevocations: z.array(PendingRevocationSchema).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "active" && value.disconnectedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "active WhooshBang configuration cannot be disconnected",
        path: ["disconnectedAt"],
      });
    }
    if (value.status !== "active" && value.disconnectedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "inactive WhooshBang configuration requires a timestamp",
        path: ["disconnectedAt"],
      });
    }
  });

export const WhooshBangMachineCredentialSchema = z
  .object({
    schema: z.literal("agent-relay-whooshbang-credential.v1"),
    credentialId: credentialIdentifier,
    bearerToken: z.string().max(256).refine(isWhooshBangMachineCredential, {
      message: "must match the pinned narrow machine credential contract",
    }),
    createdAt: z.iso.datetime({ offset: true }),
    rotation: z
      .object({
        generation: z.number().int().positive(),
        replacesCredentialId: credentialIdentifier.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bearerToken.split(".")[1] !== value.credentialId) {
      context.addIssue({
        code: "custom",
        message: "credential ID does not match the narrow bearer",
        path: ["credentialId"],
      });
    }
  });

export type WhooshBangConnectionConfiguration = z.infer<
  typeof WhooshBangConnectionConfigurationSchema
>;
export type WhooshBangMachineCredential = z.infer<
  typeof WhooshBangMachineCredentialSchema
>;

export interface WhooshBangConnectionPaths {
  configurationPath: string;
  credentialPath: string;
}

export interface StoredWhooshBangConnection {
  configuration: WhooshBangConnectionConfiguration;
  credential?: WhooshBangMachineCredential;
}

export interface SafeWhooshBangConnectionSummary {
  apiOrigin: string;
  canaryRef: string;
  configured: true;
  contractVersion: typeof WHOOSHBANG_CONTRACT_VERSION;
  credentialPresent: boolean;
  environment: "test" | "live";
  machineClientRef: string;
  pendingRevocations: number;
  status: "active" | "disconnected" | "revoked";
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
    throw new Error(
      "WhooshBang configuration parent is not a private directory",
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "WhooshBang configuration parent must not be accessible by group or others",
    );
  }
}

async function inspectPrivateFile(
  path: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} path is not a regular file`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `${label} must not be readable or writable by group or others`,
    );
  }
  if (metadata.size > MAX_CONFIGURATION_BYTES) {
    throw new Error(`${label} exceeds the private configuration size limit`);
  }
  return metadata;
}

async function readPrivateJson(
  path: string,
  label: string,
): Promise<unknown | undefined> {
  const metadata = await inspectPrivateFile(path, label);
  if (metadata === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function atomicWritePrivate(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await inspectPrivateFile(path, "WhooshBang private configuration");
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
          "WhooshBang atomic write and cleanup both failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  await inspectPrivateFile(path, "WhooshBang private configuration");
}

async function unlinkPrivate(path: string, label: string): Promise<boolean> {
  const metadata = await inspectPrivateFile(path, label);
  if (metadata === undefined) {
    return false;
  }
  await unlink(path);
  return true;
}

export function whooshbangConnectionPaths(
  stateDirectory: string,
): WhooshBangConnectionPaths {
  return {
    configurationPath: join(stateDirectory, "whooshbang.json"),
    credentialPath: join(stateDirectory, "whooshbang-credential.json"),
  };
}

export async function readWhooshBangConnection(
  paths: WhooshBangConnectionPaths,
): Promise<StoredWhooshBangConnection | undefined> {
  const configurationValue = await readPrivateJson(
    paths.configurationPath,
    "WhooshBang configuration",
  );
  const credentialValue = await readPrivateJson(
    paths.credentialPath,
    "WhooshBang credential",
  );
  if (configurationValue === undefined) {
    if (credentialValue !== undefined) {
      throw new Error(
        "WhooshBang credential exists without its non-secret configuration",
      );
    }
    return undefined;
  }
  const configuration =
    WhooshBangConnectionConfigurationSchema.parse(configurationValue);
  const credential =
    credentialValue === undefined
      ? undefined
      : WhooshBangMachineCredentialSchema.parse(credentialValue);
  if (
    credential !== undefined &&
    credential.credentialId !== configuration.currentCredentialId
  ) {
    throw new Error(
      "WhooshBang credential does not match the configured machine client",
    );
  }
  if (configuration.status === "active" && credential === undefined) {
    throw new Error(
      "Active WhooshBang configuration is missing its narrow credential",
    );
  }
  return {
    configuration,
    ...(credential === undefined ? {} : { credential }),
  };
}

export async function writeWhooshBangConnection(
  paths: WhooshBangConnectionPaths,
  configurationInput: WhooshBangConnectionConfiguration,
  credentialInput: WhooshBangMachineCredential,
): Promise<StoredWhooshBangConnection> {
  const configuration =
    WhooshBangConnectionConfigurationSchema.parse(configurationInput);
  const credential = WhooshBangMachineCredentialSchema.parse(credentialInput);
  if (configuration.status !== "active") {
    throw new Error("A new WhooshBang connection must be active");
  }
  if (configuration.currentCredentialId !== credential.credentialId) {
    throw new Error(
      "WhooshBang configuration and narrow credential do not match",
    );
  }

  await inspectPrivateFile(paths.configurationPath, "WhooshBang configuration");
  const previousCredentialValue = await readPrivateJson(
    paths.credentialPath,
    "WhooshBang credential",
  );
  const previousCredential =
    previousCredentialValue === undefined
      ? undefined
      : WhooshBangMachineCredentialSchema.parse(previousCredentialValue);

  // The credential lands first and the non-secret configuration is the final
  // commit marker. Readers never accept an active configuration without the
  // matching private credential.
  let credentialCommitted = false;
  try {
    await atomicWritePrivate(paths.credentialPath, credential);
    credentialCommitted = true;
    await atomicWritePrivate(paths.configurationPath, configuration);
  } catch (error) {
    if (!credentialCommitted) {
      throw error;
    }
    try {
      if (previousCredential === undefined) {
        await unlinkPrivate(paths.credentialPath, "WhooshBang credential");
      } else {
        await atomicWritePrivate(paths.credentialPath, previousCredential);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "WhooshBang connection write and credential rollback both failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return { configuration, credential };
}

export async function updateWhooshBangConfiguration(
  paths: WhooshBangConnectionPaths,
  configurationInput: WhooshBangConnectionConfiguration,
): Promise<WhooshBangConnectionConfiguration> {
  const configuration =
    WhooshBangConnectionConfigurationSchema.parse(configurationInput);
  const current = await readWhooshBangConnection(paths);
  if (current === undefined) {
    throw new Error("WhooshBang is not configured");
  }
  if (
    current.credential !== undefined &&
    current.credential.credentialId !== configuration.currentCredentialId
  ) {
    throw new Error(
      "Updated WhooshBang configuration does not match the stored credential",
    );
  }
  await atomicWritePrivate(paths.configurationPath, configuration);
  return configuration;
}

export async function markWhooshBangDisconnected(
  paths: WhooshBangConnectionPaths,
  input: {
    at: Date;
    revoked: boolean;
    eraseCredential?: boolean;
  },
): Promise<StoredWhooshBangConnection> {
  const current = await readWhooshBangConnection(paths);
  if (current === undefined) {
    throw new Error("WhooshBang is not configured");
  }
  const configuration = WhooshBangConnectionConfigurationSchema.parse({
    ...current.configuration,
    status: input.revoked ? "revoked" : "disconnected",
    disconnectedAt: input.at.toISOString(),
  });
  await atomicWritePrivate(paths.configurationPath, configuration);
  if (input.eraseCredential === true) {
    await unlinkPrivate(paths.credentialPath, "WhooshBang credential");
    return { configuration };
  }
  return {
    configuration,
    ...(current.credential === undefined
      ? {}
      : { credential: current.credential }),
  };
}

export async function eraseWhooshBangConnection(
  paths: WhooshBangConnectionPaths,
  input: { configuration: boolean; credential: boolean },
): Promise<{ configurationErased: boolean; credentialErased: boolean }> {
  if (input.credential) {
    await inspectPrivateFile(paths.credentialPath, "WhooshBang credential");
  }
  if (input.configuration) {
    await inspectPrivateFile(
      paths.configurationPath,
      "WhooshBang configuration",
    );
  }
  const credentialErased = input.credential
    ? await unlinkPrivate(paths.credentialPath, "WhooshBang credential")
    : false;
  const configurationErased = input.configuration
    ? await unlinkPrivate(paths.configurationPath, "WhooshBang configuration")
    : false;
  return { configurationErased, credentialErased };
}

function safeReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeWhooshBangConnectionSummary(
  connection: StoredWhooshBangConnection,
): SafeWhooshBangConnectionSummary {
  return {
    apiOrigin: new URL(connection.configuration.baseUrl).origin,
    canaryRef: safeReference(connection.configuration.canaryMessageId),
    configured: true,
    contractVersion: connection.configuration.contractVersion,
    credentialPresent: connection.credential !== undefined,
    environment: connection.configuration.environment,
    machineClientRef: safeReference(connection.configuration.machineClientId),
    pendingRevocations: connection.configuration.pendingRevocations.length,
    status: connection.configuration.status,
  };
}
