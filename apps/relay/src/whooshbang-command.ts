import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import {
  asWhooshBangSetupError,
  connectWhooshBangMachine,
  disconnectWhooshBangMachine,
  normalizeWhooshBangBaseUrl,
  WhooshBangAdministrationClient,
  WhooshBangSetupError,
} from "@agent-relay/whooshbang-transport";

import { loadOrCreateMachineId } from "./machine-id.js";
import {
  eraseWhooshBangConnection,
  markWhooshBangDisconnected,
  whooshbangConnectionPaths,
  WhooshBangConnectionConfigurationSchema,
  WhooshBangMachineCredentialSchema,
  readWhooshBangConnection,
  safeWhooshBangConnectionSummary,
  updateWhooshBangConfiguration,
  writeWhooshBangConnection,
} from "./whooshbang-config.js";

import type {
  ConnectWhooshBangMachineOptions,
  MachineCredentialMaterial,
  WhooshBangConnectResult,
  WhooshBangFetch,
} from "@agent-relay/whooshbang-transport";
import type {
  WhooshBangConnectionConfiguration,
  WhooshBangMachineCredential,
  StoredWhooshBangConnection,
} from "./whooshbang-config.js";

export const WHOOSHBANG_COMMAND_USAGE = `Agent Relay WhooshBang

Usage:
  agent-relay whooshbang connect [options]
  agent-relay whooshbang status
  agent-relay whooshbang disconnect [options]

Connect options:
  --base-url <https-url>       WhooshBang API base URL (or explicit loopback)
  --subscriber-id <id>         Opaque subscriber configured in WhooshBang
  --notifier-id <id>           Opaque notifier (default: default)
  --display-name <name>        Optional bounded local machine label
  --wait-seconds <seconds>     Wait for Telegram authorization (default: 300)
  --poll-interval-ms <ms>      Authorization polling interval (default: 1000)
  --credential-stdin           Read the project bootstrap credential from stdin

Disconnect options:
  --revoke                     Revoke the hosted credential and machine client
  --erase-credential           Erase the retained local narrow credential
  --erase-configuration        Also erase non-secret hosted configuration
  --credential-stdin           Read the project bootstrap credential from stdin

Environment injection:
  AGENT_RELAY_WHOOSHBANG_BASE_URL
  AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID
  AGENT_RELAY_WHOOSHBANG_NOTIFIER_ID
  AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL

The broad project credential is never accepted positionally or written to disk.
`;

interface ParsedOptions {
  booleans: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
}

interface SecretInput {
  environmentValue?: string;
  prompt?: () => Promise<string>;
  readStdin: () => Promise<string>;
  useStdin: boolean;
}

export interface WhooshBangCommandRuntime {
  args: string[];
  createCredentialMaterial?: () => Promise<MachineCredentialMaterial>;
  createIdempotencyKey?: (operation: string) => string;
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: WhooshBangFetch;
  now?: () => Date;
  promptCredential?: () => Promise<string>;
  readCredentialStdin?: () => Promise<string>;
  stateDirectory: string;
  stdinIsTTY?: boolean;
  writeDiagnostic?: (diagnostic: unknown) => void;
}

function optionValue(parsed: ParsedOptions, name: string): string | undefined {
  return parsed.values.get(name);
}

function parseOptions(
  args: string[],
  valueOptions: readonly string[],
  booleanOptions: readonly string[],
): ParsedOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const valueNames = new Set(valueOptions);
  const booleanNames = new Set(booleanOptions);
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index];
    if (candidate === undefined) {
      continue;
    }
    if (booleanNames.has(candidate)) {
      if (booleans.has(candidate)) {
        throw new Error("A WhooshBang option was provided more than once");
      }
      booleans.add(candidate);
      continue;
    }
    if (valueNames.has(candidate)) {
      if (values.has(candidate)) {
        throw new Error("A WhooshBang option was provided more than once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("A WhooshBang option is missing its value");
      }
      values.set(candidate, value);
      index += 1;
      continue;
    }
    throw new Error(
      "Unsupported WhooshBang option; credentials must never be positional",
    );
  }
  return { booleans, values };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  bounds: { maximum: number; minimum: number },
  label: string,
): number {
  const parsed = Number(value ?? String(fallback));
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < bounds.minimum ||
    parsed > bounds.maximum
  ) {
    throw new Error(`${label} is outside its supported range`);
  }
  return parsed;
}

async function readHiddenCredential(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "WhooshBang project credential requires environment injection or --credential-stdin outside a TTY",
    );
  }
  process.stderr.write("WhooshBang project credential (input hidden): ");
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  try {
    const value = await prompt.question("");
    process.stderr.write("\n");
    return value;
  } finally {
    prompt.close();
  }
}

async function readBoundedCredentialStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 8 * 1024) {
      throw new Error("WhooshBang project credential stdin exceeds 8192 bytes");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function resolveWhooshBangProjectCredential(
  input: SecretInput,
): Promise<string> {
  const environmentValue = input.environmentValue?.trim();
  if (environmentValue !== undefined && environmentValue.length > 0) {
    return environmentValue;
  }
  const value = input.useStdin
    ? await input.readStdin()
    : await (input.prompt ?? readHiddenCredential)();
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("WhooshBang project credential was empty");
  }
  return normalized;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function projectCredentialInput(
  parsed: ParsedOptions,
  runtime: WhooshBangCommandRuntime,
  environment: Readonly<Record<string, string | undefined>>,
): SecretInput {
  const injected = environmentValue(
    environment,
    "AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL",
  );
  return {
    ...(injected === undefined ? {} : { environmentValue: injected }),
    ...(runtime.promptCredential === undefined
      ? {}
      : { prompt: runtime.promptCredential }),
    readStdin: runtime.readCredentialStdin ?? readBoundedCredentialStdin,
    useStdin:
      parsed.booleans.has("--credential-stdin") ||
      (runtime.stdinIsTTY ?? process.stdin.isTTY) === false,
  };
}

function safeOperationKey(
  operation: string,
  machineClientId: string,
  credentialId: string,
): string {
  const digest = createHash("sha256")
    .update(`${operation}\0${machineClientId}\0${credentialId}`)
    .digest("hex");
  return `agent-relay-${operation}-${digest}`;
}

function newConfiguration(
  result: Extract<WhooshBangConnectResult, { status: "connected" }>,
  previous: StoredWhooshBangConnection | undefined,
): {
  configuration: WhooshBangConnectionConfiguration;
  credential: WhooshBangMachineCredential;
} {
  const previousCredentialId = previous?.configuration.currentCredentialId;
  const pendingRevocations = [
    ...(previous?.configuration.pendingRevocations ?? []),
    ...(previous !== undefined &&
    previous.configuration.status !== "revoked" &&
    (previous.configuration.machineClientId !==
      result.configuration.machineClientId ||
      previousCredentialId !== result.credential.credentialId)
      ? [
          {
            machineClientId: previous.configuration.machineClientId,
            credentialId: previous.configuration.currentCredentialId,
            recordedAt: result.configuration.connectedAt,
          },
        ]
      : []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.machineClientId === candidate.machineClientId &&
          other.credentialId === candidate.credentialId,
      ) === index,
  );
  const generation = (previous?.credential?.rotation.generation ?? 0) + 1;
  return {
    configuration: WhooshBangConnectionConfigurationSchema.parse({
      schema: "agent-relay-whooshbang-config.v1",
      status: "active",
      baseUrl: result.configuration.baseUrl,
      contractVersion: result.configuration.contractVersion,
      environment: result.configuration.environment,
      projectId: result.configuration.projectId,
      machineClientId: result.configuration.machineClientId,
      subscriberId: result.configuration.subscriberId,
      notifierId: result.configuration.notifierId,
      bindingId: result.configuration.bindingId,
      currentCredentialId: result.credential.credentialId,
      scopeSummary: [...result.configuration.scopeSummary],
      connectedAt: result.configuration.connectedAt,
      canaryMessageId: result.configuration.canaryMessageId,
      canaryDiagnosticId: result.configuration.canaryDiagnosticId,
      pendingRevocations,
    }),
    credential: WhooshBangMachineCredentialSchema.parse({
      schema: "agent-relay-whooshbang-credential.v1",
      credentialId: result.credential.credentialId,
      bearerToken: result.credential.bearerToken,
      createdAt: result.credential.createdAt,
      rotation: {
        generation,
        ...(previousCredentialId === undefined
          ? {}
          : { replacesCredentialId: previousCredentialId }),
      },
    }),
  };
}

async function revokePendingConnections(
  configuration: WhooshBangConnectionConfiguration,
  input: {
    fetch?: WhooshBangFetch;
    projectCredential: string;
    signalForOperation: () => AbortSignal;
  },
): Promise<{
  failures: { code: string; machineClientRef: string }[];
  remaining: WhooshBangConnectionConfiguration["pendingRevocations"];
}> {
  const failures: { code: string; machineClientRef: string }[] = [];
  const remaining: WhooshBangConnectionConfiguration["pendingRevocations"] = [];
  for (const pending of configuration.pendingRevocations) {
    try {
      const signal = input.signalForOperation();
      if (pending.machineClientId === configuration.machineClientId) {
        const administration = new WhooshBangAdministrationClient({
          baseUrl: configuration.baseUrl,
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          projectCredential: input.projectCredential,
        });
        const credential = await administration.revokeMachineCredential(
          pending.machineClientId,
          pending.credentialId,
          {
            idempotencyKey: safeOperationKey(
              "revoke-credential",
              pending.machineClientId,
              pending.credentialId,
            ),
            signal,
          },
        );
        if (credential.status !== "revoked") {
          throw new WhooshBangSetupError(
            "WhooshBang did not prove retired credential revocation.",
            "whooshbang-setup-invalid",
            false,
          );
        }
      } else {
        await disconnectWhooshBangMachine({
          baseUrl: configuration.baseUrl,
          credentialId: pending.credentialId,
          createIdempotencyKey: (operation) =>
            safeOperationKey(
              operation,
              pending.machineClientId,
              pending.credentialId,
            ),
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          machineClientId: pending.machineClientId,
          projectCredential: input.projectCredential,
          signal,
        });
      }
    } catch (error) {
      remaining.push(pending);
      failures.push({
        code:
          error instanceof WhooshBangSetupError
            ? error.code
            : "whooshbang-revocation-unclassified",
        machineClientRef: createHash("sha256")
          .update(pending.machineClientId)
          .digest("hex")
          .slice(0, 12),
      });
    }
  }
  return { failures, remaining };
}

function safeAuthorization(
  result: Exclude<WhooshBangConnectResult, { status: "connected" }>,
): unknown {
  return {
    status: result.status,
    contractVersion: result.contractVersion,
    authorization: {
      status: result.authorization.status,
      expiresAt: result.authorization.expiresAt,
      ...(result.authorization.url === undefined
        ? {}
        : { url: result.authorization.url }),
    },
    credentialStored: false,
  };
}

function hostedStateMayRemain(connection: StoredWhooshBangConnection): boolean {
  return (
    connection.configuration.status !== "revoked" ||
    connection.configuration.pendingRevocations.length > 0
  );
}

async function cleanupConnectedMachine(
  result: Extract<WhooshBangConnectResult, { status: "connected" }>,
  input: {
    fetch?: WhooshBangFetch;
    projectCredential: string;
  },
): Promise<boolean> {
  try {
    await disconnectWhooshBangMachine({
      baseUrl: result.configuration.baseUrl,
      credentialId: result.credential.credentialId,
      createIdempotencyKey: (operation) =>
        safeOperationKey(
          operation,
          result.configuration.machineClientId,
          result.credential.credentialId,
        ),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      machineClientId: result.configuration.machineClientId,
      projectCredential: input.projectCredential,
      signal: AbortSignal.timeout(30_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function connectCommand(
  parsed: ParsedOptions,
  runtime: WhooshBangCommandRuntime,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const baseUrl =
    optionValue(parsed, "--base-url") ??
    environmentValue(environment, "AGENT_RELAY_WHOOSHBANG_BASE_URL");
  const subscriberId =
    optionValue(parsed, "--subscriber-id") ??
    environmentValue(environment, "AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID");
  if (baseUrl === undefined || subscriberId === undefined) {
    throw new Error("WhooshBang connect requires a base URL and subscriber ID");
  }
  const notifierId =
    optionValue(parsed, "--notifier-id") ??
    environmentValue(environment, "AGENT_RELAY_WHOOSHBANG_NOTIFIER_ID") ??
    "default";
  const waitSeconds = boundedInteger(
    optionValue(parsed, "--wait-seconds"),
    300,
    { minimum: 0, maximum: 900 },
    "WhooshBang authorization wait",
  );
  const pollIntervalMs = boundedInteger(
    optionValue(parsed, "--poll-interval-ms"),
    1_000,
    { minimum: 10, maximum: 30_000 },
    "WhooshBang authorization polling interval",
  );
  const projectCredential = await resolveWhooshBangProjectCredential(
    projectCredentialInput(parsed, runtime, environment),
  );
  const paths = whooshbangConnectionPaths(runtime.stateDirectory);
  const previous = await readWhooshBangConnection(paths);
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeWhooshBangBaseUrl(baseUrl).toString();
  } catch (error) {
    throw asWhooshBangSetupError(error);
  }
  if (
    previous !== undefined &&
    hostedStateMayRemain(previous) &&
    previous.configuration.baseUrl !== normalizedBaseUrl
  ) {
    throw new WhooshBangSetupError(
      "Revoke the retained WhooshBang connection before changing API origins.",
      "whooshbang-setup-invalid",
      false,
    );
  }
  const machineId = await loadOrCreateMachineId(
    `${runtime.stateDirectory}/machine-id`,
  );
  const signal = AbortSignal.timeout((waitSeconds + 60) * 1_000);
  const displayName = optionValue(parsed, "--display-name");
  const connectOptions: ConnectWhooshBangMachineOptions = {
    authorizationPollIntervalMs: pollIntervalMs,
    authorizationWaitMs: waitSeconds * 1_000,
    baseUrl: normalizedBaseUrl,
    machineId,
    notifierId,
    onAuthorization: (authorization) => {
      runtime.writeDiagnostic?.({
        code: "whooshbang.authorization-required",
        status: authorization.status,
        expiresAt: authorization.expiresAt,
        ...(authorization.url === undefined
          ? {}
          : { authorizationUrl: authorization.url }),
      });
    },
    projectCredential,
    signal,
    subscriberId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(runtime.createCredentialMaterial === undefined
      ? {}
      : { createCredentialMaterial: runtime.createCredentialMaterial }),
    ...(runtime.createIdempotencyKey === undefined
      ? {}
      : { createIdempotencyKey: runtime.createIdempotencyKey }),
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  };
  const result = await connectWhooshBangMachine(connectOptions);
  if (result.status !== "connected") {
    return safeAuthorization(result);
  }

  if (
    previous !== undefined &&
    hostedStateMayRemain(previous) &&
    (previous.configuration.projectId !== result.configuration.projectId ||
      previous.configuration.environment !== result.configuration.environment)
  ) {
    const cleanupComplete = await cleanupConnectedMachine(result, {
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      projectCredential,
    });
    throw new WhooshBangSetupError(
      "Revoke the retained WhooshBang connection before changing project or environment.",
      "whooshbang-setup-invalid",
      false,
      { cleanupIncomplete: !cleanupComplete },
    );
  }

  let stored: StoredWhooshBangConnection;
  try {
    const next = newConfiguration(result, previous);
    stored = await writeWhooshBangConnection(
      paths,
      next.configuration,
      next.credential,
    );
  } catch {
    const cleanupComplete = await cleanupConnectedMachine(result, {
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      projectCredential,
    });
    throw new WhooshBangSetupError(
      cleanupComplete
        ? "WhooshBang connected but private storage failed; remote setup was revoked."
        : "WhooshBang connected but private storage and remote cleanup failed.",
      "whooshbang-setup-failed",
      false,
      { cleanupIncomplete: !cleanupComplete },
    );
  }

  const retired = await revokePendingConnections(stored.configuration, {
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    projectCredential,
    signalForOperation: () => AbortSignal.timeout(30_000),
  });
  if (
    retired.remaining.length !== stored.configuration.pendingRevocations.length
  ) {
    const configuration = WhooshBangConnectionConfigurationSchema.parse({
      ...stored.configuration,
      pendingRevocations: retired.remaining,
    });
    await updateWhooshBangConfiguration(paths, configuration);
    stored = {
      configuration,
      ...(stored.credential === undefined
        ? {}
        : { credential: stored.credential }),
    };
  }
  const summary = safeWhooshBangConnectionSummary(stored);
  return {
    ...summary,
    status:
      retired.failures.length === 0
        ? "connected"
        : "connected_with_pending_revocation",
    authorization: {
      status: result.authorization.status,
      expiresAt: result.authorization.expiresAt,
    },
    canary: "accepted",
    ...(retired.failures.length === 0
      ? {}
      : { revocationFailures: retired.failures }),
  };
}

async function statusCommand(
  runtime: WhooshBangCommandRuntime,
): Promise<unknown> {
  const connection = await readWhooshBangConnection(
    whooshbangConnectionPaths(runtime.stateDirectory),
  );
  return connection === undefined
    ? { configured: false, status: "not_configured" }
    : safeWhooshBangConnectionSummary(connection);
}

async function disconnectCommand(
  parsed: ParsedOptions,
  runtime: WhooshBangCommandRuntime,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const paths = whooshbangConnectionPaths(runtime.stateDirectory);
  const current = await readWhooshBangConnection(paths);
  if (current === undefined) {
    return { configured: false, status: "not_configured" };
  }
  const revoke = parsed.booleans.has("--revoke");
  const eraseCredential = parsed.booleans.has("--erase-credential");
  const eraseConfiguration = parsed.booleans.has("--erase-configuration");
  if (eraseConfiguration && !eraseCredential) {
    throw new Error(
      "--erase-configuration requires --erase-credential to avoid an orphaned secret",
    );
  }
  if (
    eraseConfiguration &&
    !revoke &&
    (current.configuration.status !== "revoked" ||
      current.configuration.pendingRevocations.length > 0)
  ) {
    throw new Error(
      "--erase-configuration requires --revoke while hosted credentials may remain active",
    );
  }

  let remoteRevocationProven = false;
  if (revoke) {
    const projectCredential = await resolveWhooshBangProjectCredential(
      projectCredentialInput(parsed, runtime, environment),
    );
    const retired = await revokePendingConnections(current.configuration, {
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      projectCredential,
      signalForOperation: () => AbortSignal.timeout(30_000),
    });
    if (retired.failures.length > 0) {
      throw new WhooshBangSetupError(
        "WhooshBang could not revoke every retained machine client.",
        "whooshbang-setup-failed",
        true,
        { cleanupIncomplete: true },
      );
    }
    if (current.configuration.pendingRevocations.length > 0) {
      await updateWhooshBangConfiguration(
        paths,
        WhooshBangConnectionConfigurationSchema.parse({
          ...current.configuration,
          pendingRevocations: [],
        }),
      );
    }
    await disconnectWhooshBangMachine({
      baseUrl: current.configuration.baseUrl,
      credentialId: current.configuration.currentCredentialId,
      createIdempotencyKey: (operation) =>
        safeOperationKey(
          operation,
          current.configuration.machineClientId,
          current.configuration.currentCredentialId,
        ),
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      machineClientId: current.configuration.machineClientId,
      projectCredential,
      signal: AbortSignal.timeout(30_000),
    });
    remoteRevocationProven = true;
  }

  const disconnected = await markWhooshBangDisconnected(paths, {
    at: runtime.now?.() ?? new Date(),
    eraseCredential,
    revoked:
      remoteRevocationProven || current.configuration.status === "revoked",
  });
  if (eraseConfiguration) {
    await eraseWhooshBangConnection(paths, {
      configuration: true,
      credential: false,
    });
    return {
      configured: false,
      localConfigurationErased: true,
      localCredentialErased: true,
      remoteRevocationProven,
      status: remoteRevocationProven ? "revoked" : "disconnected",
    };
  }
  return {
    ...safeWhooshBangConnectionSummary(disconnected),
    localCredentialErased: eraseCredential,
    remoteRevocationProven,
  };
}

export async function runWhooshBangCommand(
  runtime: WhooshBangCommandRuntime,
): Promise<unknown> {
  const [subcommand, ...args] = runtime.args;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    return { help: WHOOSHBANG_COMMAND_USAGE };
  }
  const environment = runtime.environment ?? process.env;
  if (subcommand === "connect") {
    const parsed = parseOptions(
      args,
      [
        "--base-url",
        "--subscriber-id",
        "--notifier-id",
        "--display-name",
        "--wait-seconds",
        "--poll-interval-ms",
      ],
      ["--credential-stdin"],
    );
    return await connectCommand(parsed, runtime, environment);
  }
  if (subcommand === "status") {
    parseOptions(args, [], []);
    return await statusCommand(runtime);
  }
  if (subcommand === "disconnect") {
    const parsed = parseOptions(
      args,
      [],
      [
        "--revoke",
        "--erase-credential",
        "--erase-configuration",
        "--credential-stdin",
      ],
    );
    return await disconnectCommand(parsed, runtime, environment);
  }
  throw new Error("Unknown WhooshBang subcommand");
}
