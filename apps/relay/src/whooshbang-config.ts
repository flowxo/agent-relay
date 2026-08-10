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

const WhooshBangCanaryEvidenceSchema = z
  .object({
    committedCursorRef: z.string().regex(/^cursor_[a-f0-9]{12}$/u),
    completedAt: z.iso.datetime({ offset: true }),
    connectedAt: z.iso.datetime({ offset: true }),
    credentialGeneration: z.number().int().positive(),
    credentialId: credentialIdentifier,
    lastSuccessfulPollAt: z.iso.datetime({ offset: true }),
    lastSuccessfulSendAt: z.iso.datetime({ offset: true }),
  })
  .strict();

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
    canaryMessageId: opaqueIdentifier.optional(),
    canaryDiagnosticId: opaqueIdentifier.optional(),
    canaryEvidence: WhooshBangCanaryEvidenceSchema.optional(),
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
    if (
      (value.canaryMessageId === undefined) !==
      (value.canaryDiagnosticId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "WhooshBang canary message and diagnostic IDs must be recorded together",
        path: ["canaryMessageId"],
      });
    }
    if (
      value.canaryEvidence !== undefined &&
      (value.canaryMessageId === undefined ||
        value.canaryEvidence.credentialId !== value.currentCredentialId ||
        value.canaryEvidence.connectedAt !== value.connectedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "WhooshBang canary evidence must match the active connection",
        path: ["canaryEvidence"],
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

export const WhooshBangOAuthProvisioningJournalSchema = z
  .object({
    schema: z.literal("agent-relay-whooshbang-oauth-provisioning.v1"),
    recordedAt: z.iso.datetime({ offset: true }),
    credentialGeneration: z.number().int().positive(),
    target: z
      .object({
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
        displayName: z.string().min(1).max(120).optional(),
        environment: z.enum(["test", "live"]),
        environmentId: opaqueIdentifier,
        machineId: opaqueIdentifier,
        notifierId: opaqueIdentifier,
        projectId: opaqueIdentifier,
        projectSelector: opaqueIdentifier.optional(),
        subscriberId: opaqueIdentifier,
      })
      .strict(),
    material: z
      .object({
        bearerToken: z.string().max(256).refine(isWhooshBangMachineCredential),
        credentialId: credentialIdentifier,
        registration: z
          .object({
            credential_id: credentialIdentifier,
            secret_sha256: z.custom<`sha256:${string}`>(
              (value) =>
                typeof value === "string" &&
                /^sha256:[a-f0-9]{64}$/u.test(value),
              "must be a SHA-256 machine secret digest",
            ),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.material.credentialId !==
        value.material.registration.credential_id ||
      value.material.bearerToken.split(".")[1] !== value.material.credentialId
    ) {
      context.addIssue({
        code: "custom",
        message: "OAuth provisioning credential material must agree",
        path: ["material"],
      });
    }
  });

export type WhooshBangOAuthProvisioningJournal = z.infer<
  typeof WhooshBangOAuthProvisioningJournalSchema
>;

export interface WhooshBangConnectionPaths {
  configurationPath: string;
  credentialPath: string;
  oauthProvisioningPath: string;
}

export interface StoredWhooshBangConnection {
  configuration: WhooshBangConnectionConfiguration;
  credential?: WhooshBangMachineCredential;
}

export interface WhooshBangConfigurationExpectation {
  connectedAt: string;
  credentialGeneration: number | null;
  credentialId: string;
  status: "active" | "disconnected" | "revoked";
}

export interface SafeWhooshBangConnectionSummary {
  apiOrigin: string;
  canaryEvidence: {
    committedCursorRef: string;
    completedAt: string;
    connectedAt: string;
    credentialGeneration: number;
    lastSuccessfulPollAt: string;
    lastSuccessfulSendAt: string;
  } | null;
  canaryRef: string | null;
  configured: true;
  contractVersion: typeof WHOOSHBANG_CONTRACT_VERSION;
  credentialGeneration: number | null;
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

async function withConfigurationMutationLock<T>(
  paths: WhooshBangConnectionPaths,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${paths.configurationPath}.lock`;
  await ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + 5_000;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      try {
        const metadata = await lstat(lockPath);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (!isErrorCode(lockError, "ENOENT")) {
          throw lockError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("WhooshBang configuration is being changed elsewhere", {
          cause: error,
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  const release = async (): Promise<void> => {
    await handle?.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  };
  try {
    const result = await action();
    await release();
    return result;
  } catch (actionError) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [actionError, releaseError],
        "WhooshBang configuration mutation and lock cleanup both failed",
        { cause: releaseError },
      );
    }
    throw actionError;
  }
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
    oauthProvisioningPath: join(
      stateDirectory,
      "whooshbang-oauth-provisioning.json",
    ),
  };
}

export async function readWhooshBangOAuthProvisioningJournal(
  paths: WhooshBangConnectionPaths,
): Promise<WhooshBangOAuthProvisioningJournal | undefined> {
  const value = await readPrivateJson(
    paths.oauthProvisioningPath,
    "WhooshBang OAuth provisioning journal",
  );
  return value === undefined
    ? undefined
    : WhooshBangOAuthProvisioningJournalSchema.parse(value);
}

export async function writeWhooshBangOAuthProvisioningJournal(
  paths: WhooshBangConnectionPaths,
  input: WhooshBangOAuthProvisioningJournal,
): Promise<WhooshBangOAuthProvisioningJournal> {
  const journal = WhooshBangOAuthProvisioningJournalSchema.parse(input);
  await atomicWritePrivate(paths.oauthProvisioningPath, journal);
  return journal;
}

export async function eraseWhooshBangOAuthProvisioningJournal(
  paths: WhooshBangConnectionPaths,
): Promise<boolean> {
  return await unlinkPrivate(
    paths.oauthProvisioningPath,
    "WhooshBang OAuth provisioning journal",
  );
}

export async function reconcileWhooshBangOAuthCredentialOnly(
  paths: WhooshBangConnectionPaths,
): Promise<boolean> {
  return await withConfigurationMutationLock(paths, async () => {
    const configurationValue = await readPrivateJson(
      paths.configurationPath,
      "WhooshBang configuration",
    );
    const credentialValue = await readPrivateJson(
      paths.credentialPath,
      "WhooshBang credential",
    );
    const journalValue = await readPrivateJson(
      paths.oauthProvisioningPath,
      "WhooshBang OAuth provisioning journal",
    );
    if (credentialValue === undefined || journalValue === undefined) {
      return false;
    }
    const credential = WhooshBangMachineCredentialSchema.parse(credentialValue);
    const journal =
      WhooshBangOAuthProvisioningJournalSchema.parse(journalValue);
    if (
      credential.credentialId !== journal.material.credentialId ||
      credential.bearerToken !== journal.material.bearerToken ||
      credential.rotation.generation !== journal.credentialGeneration
    ) {
      throw new Error(
        "WhooshBang credential-only state does not match its OAuth recovery journal",
      );
    }
    if (configurationValue !== undefined) {
      const configuration =
        WhooshBangConnectionConfigurationSchema.parse(configurationValue);
      if (
        configuration.status !== "revoked" ||
        configuration.pendingRevocations.length !== 0 ||
        configuration.currentCredentialId === credential.credentialId
      ) {
        return false;
      }
    }
    await unlinkPrivate(paths.credentialPath, "WhooshBang credential");
    return true;
  });
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

  return await withConfigurationMutationLock(paths, async () => {
    await inspectPrivateFile(
      paths.configurationPath,
      "WhooshBang configuration",
    );
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
  });
}

export async function updateWhooshBangConfiguration(
  paths: WhooshBangConnectionPaths,
  configurationInput: WhooshBangConnectionConfiguration,
  expected: WhooshBangConfigurationExpectation,
): Promise<WhooshBangConnectionConfiguration> {
  const configuration =
    WhooshBangConnectionConfigurationSchema.parse(configurationInput);
  return await withConfigurationMutationLock(paths, async () => {
    const current = await readWhooshBangConnection(paths);
    if (current === undefined) {
      throw new Error("WhooshBang is not configured");
    }
    if (
      current.configuration.connectedAt !== expected.connectedAt ||
      current.configuration.currentCredentialId !== expected.credentialId ||
      current.configuration.status !== expected.status ||
      (current.credential?.rotation.generation ?? null) !==
        expected.credentialGeneration
    ) {
      throw new Error(
        "The WhooshBang connection changed before its configuration update",
      );
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
  });
}

export async function recordWhooshBangCanary(
  paths: WhooshBangConnectionPaths,
  input: {
    committedCursorRef: string;
    completedAt: Date;
    connectedAt: string;
    credentialGeneration: number;
    credentialId: string;
    diagnosticId: string;
    lastSuccessfulPollAt: string;
    lastSuccessfulSendAt: string;
    messageId: string;
  },
): Promise<WhooshBangConnectionConfiguration> {
  return await withConfigurationMutationLock(paths, async () => {
    const current = await readWhooshBangConnection(paths);
    if (
      current === undefined ||
      current.configuration.status !== "active" ||
      current.configuration.connectedAt !== input.connectedAt ||
      current.configuration.currentCredentialId !== input.credentialId ||
      current.credential?.rotation.generation !== input.credentialGeneration
    ) {
      throw new Error(
        "The WhooshBang connection changed before canary proof was recorded",
      );
    }
    const configuration = WhooshBangConnectionConfigurationSchema.parse({
      ...current.configuration,
      canaryMessageId: input.messageId,
      canaryDiagnosticId: input.diagnosticId,
      canaryEvidence: {
        committedCursorRef: input.committedCursorRef,
        completedAt: input.completedAt.toISOString(),
        connectedAt: input.connectedAt,
        credentialGeneration: input.credentialGeneration,
        credentialId: input.credentialId,
        lastSuccessfulPollAt: input.lastSuccessfulPollAt,
        lastSuccessfulSendAt: input.lastSuccessfulSendAt,
      },
    });
    await atomicWritePrivate(paths.configurationPath, configuration);
    return configuration;
  });
}

export async function markWhooshBangDisconnected(
  paths: WhooshBangConnectionPaths,
  input: {
    at: Date;
    revoked: boolean;
    eraseCredential?: boolean;
  },
): Promise<StoredWhooshBangConnection> {
  return await withConfigurationMutationLock(paths, async () => {
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
  });
}

export async function eraseWhooshBangConnection(
  paths: WhooshBangConnectionPaths,
  input: { configuration: boolean; credential: boolean },
): Promise<{ configurationErased: boolean; credentialErased: boolean }> {
  return await withConfigurationMutationLock(paths, async () => {
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
  });
}

function safeReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeWhooshBangConnectionSummary(
  connection: StoredWhooshBangConnection,
): SafeWhooshBangConnectionSummary {
  return {
    apiOrigin: new URL(connection.configuration.baseUrl).origin,
    canaryEvidence:
      connection.configuration.canaryEvidence === undefined
        ? null
        : {
            committedCursorRef:
              connection.configuration.canaryEvidence.committedCursorRef,
            completedAt: connection.configuration.canaryEvidence.completedAt,
            connectedAt: connection.configuration.canaryEvidence.connectedAt,
            credentialGeneration:
              connection.configuration.canaryEvidence.credentialGeneration,
            lastSuccessfulPollAt:
              connection.configuration.canaryEvidence.lastSuccessfulPollAt,
            lastSuccessfulSendAt:
              connection.configuration.canaryEvidence.lastSuccessfulSendAt,
          },
    canaryRef:
      connection.configuration.canaryMessageId === undefined
        ? null
        : safeReference(connection.configuration.canaryMessageId),
    configured: true,
    contractVersion: connection.configuration.contractVersion,
    credentialGeneration: connection.credential?.rotation.generation ?? null,
    credentialPresent: connection.credential !== undefined,
    environment: connection.configuration.environment,
    machineClientRef: safeReference(connection.configuration.machineClientId),
    pendingRevocations: connection.configuration.pendingRevocations.length,
    status: connection.configuration.status,
  };
}
