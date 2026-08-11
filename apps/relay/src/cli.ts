#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CompositeLogger,
  JsonLineLogger,
  RotatingFileLogger,
} from "@agent-relay/core";
import { PUBLIC_COMPATIBILITY_RECORD } from "@agent-relay/harnesses";
import {
  HarnessSchema,
  SurfaceSchema,
  makeProjectRef,
  makeStableEventId,
} from "@agent-relay/protocol";
import { WhooshBangContractTransport } from "@agent-relay/whooshbang-transport";

import { RelayClient } from "./client.js";
import {
  isWhooshBangCanaryAcknowledged,
  runFakeCanary,
  runTelegramCanary,
  waitForTelegramCanaryReady,
  runWhooshBangCanary,
} from "./canary.js";
import {
  isInertCanaryHelpRequest,
  resolveHookHarnessVersion,
  resolveSupervisorExecutable,
  resolveWebEnabled,
} from "./cli-options.js";
import { startDaemon } from "./daemon.js";
import { observeHarnessVersions, runDoctor } from "./doctor.js";
import { replayFallbackSpool } from "./fallback-spool.js";
import { runHook } from "./hook-runner.js";
import { installAgentRelay, uninstallAgentRelay } from "./installer.js";
import { loadOrCreateMachineId } from "./machine-id.js";
import {
  WHOOSHBANG_COMMAND_USAGE,
  runWhooshBangCommand,
} from "./whooshbang-command.js";
import {
  recordWhooshBangCanary,
  whooshbangConnectionPaths,
  readWhooshBangConnection,
} from "./whooshbang-config.js";
import { AGENT_RELAY_VERSION } from "./release.js";
import {
  RUNNER_BRIDGE_COMMAND_USAGE,
  runRunnerBridgeCommand,
} from "./runner-bridge-command.js";
import {
  readRunnerBridgeConfiguration,
  runnerBridgePaths,
} from "./runner-bridge-config.js";
import { runSupervisor } from "./supervisor.js";
import {
  TRANSPORT_COMMAND_USAGE,
  runTransportCommand,
  telegramReadinessInputFromEnvironment,
} from "./transport-command.js";
import {
  inspectTransportReadiness,
  resolveTransportSelection,
} from "./transport-config.js";
import { WEBHOOK_COMMAND_USAGE, runWebhookCommand } from "./webhook-command.js";
import { resolveWebhookConfiguration } from "./webhook-config.js";
import { seedWebDemo } from "./web-demo.js";

const USAGE = `Agent Relay

Usage:
  agent-relay <command> [options]
  agent-relay --version

Commands:
  daemon             Start the local relay daemon
  web-demo           Start a sanitized local web demo
  hook <harness>     Accept one native harness hook payload on stdin
  run <harness>      Supervise a harness CLI process
  status             Show daemon and delivery status
  drain              Deliver queued events
  replay-fallback    Replay the hook fallback spool
  maintain           Apply retention policy
  install            Install or reconcile user-level harness hooks
  uninstall          Remove only Agent Relay-owned hooks and launcher
  doctor             Diagnose local installation; --live checks the daemon
  capabilities       Print the generated harness capability registry
  canary             Prove the local fake-transport delivery loop
  telegram-canary    Prove a configured direct-Telegram reply loop
  whooshbang-canary  Prove one hosted WhooshBang send/answer/ack loop
  webhook-canary     Prove a configured outbound webhook delivery
  webhook            Configure or inspect the outbound webhook
  whooshbang      Connect, inspect, or disconnect hosted WhooshBang
  runner-bridge      Inspect or select the experimental runner bridge
  transport          Select a notification transport

Canary command --help and -h requests are inert: they print this usage without
checking a daemon, creating an event, or contacting a provider. Agent Relay
currently supports macOS on Apple silicon with Node.js 22 or newer.
`;

function environment(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

const stateDir =
  environment("AGENT_RELAY_STATE_DIR") ?? join(homedir(), ".agent-relay");

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readStdin(limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error(`stdin exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function numericFlag(args: string[], name: string, fallback: number): number {
  const value = Number(flag(args, name) ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function integerFlag(args: string[], name: string, fallback: number): number {
  const value = numericFlag(args, name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

function optionalInteger(
  value: string | undefined,
  name: string,
  allowNegative: boolean,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed === 0 ||
    (!allowNegative && parsed < 0)
  ) {
    throw new Error(
      `${name} must be a ${allowNegative ? "non-zero" : "positive"} safe integer`,
    );
  }
  return parsed;
}

function harnessExecutable(harness: "codex" | "claude" | "cursor"): string {
  switch (harness) {
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    case "cursor":
      return "cursor-agent";
  }
}

function installEntryPath(args: string[]): string {
  const explicit = flag(args, "--entry");
  if (explicit !== undefined) {
    return realpathSync(resolve(explicit));
  }
  const invokedEntry = process.argv[1];
  if (invokedEntry === undefined) {
    throw new Error("cannot determine the Agent Relay executable path");
  }
  const currentEntry = realpathSync(resolve(invokedEntry));
  if (currentEntry.endsWith(".ts")) {
    return resolve(dirname(currentEntry), "..", "dist", "cli.js");
  }
  return currentEntry;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${AGENT_RELAY_VERSION}\n`);
    return;
  }
  if (isInertCanaryHelpRequest(command, args)) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "daemon" || command === "web-demo") {
    const demo = command === "web-demo";
    const commandStateDir = demo ? join(stateDir, "web-demo") : stateDir;
    const transportFlagCount = args.filter(
      (argument) => argument === "--transport",
    ).length;
    if (transportFlagCount > 1) {
      throw new Error("--transport may be provided only once");
    }
    const transportFlag = flag(args, "--transport");
    if (
      transportFlagCount === 1 &&
      (transportFlag === undefined || transportFlag.startsWith("--"))
    ) {
      throw new Error(
        "--transport requires fake, telegram, whooshbang, or webhook",
      );
    }
    const transportEnvironment = environment("AGENT_RELAY_TRANSPORT");
    if (demo && transportFlag !== undefined) {
      throw new Error("web-demo always uses the fake transport");
    }
    const transportSelection = demo
      ? {
          configured: true as const,
          selected: "fake" as const,
          source: "command-line" as const,
        }
      : await resolveTransportSelection({
          stateDirectory: commandStateDir,
          ...(transportFlag === undefined
            ? {}
            : { commandLineOverride: transportFlag }),
          ...(transportEnvironment === undefined
            ? {}
            : { environmentOverride: transportEnvironment }),
        });
    const transportReadiness = await inspectTransportReadiness({
      selection: transportSelection,
      stateDirectory: commandStateDir,
      telegram: telegramReadinessInputFromEnvironment(process.env),
      webhookEnvironment: process.env,
    });
    const databasePath =
      flag(args, "--db") ?? join(commandStateDir, "relay.sqlite");
    const runnerBridgeConfiguration = demo
      ? undefined
      : await readRunnerBridgeConfiguration(
          runnerBridgePaths(commandStateDir).configuration,
        );
    const daemonToken = demo
      ? undefined
      : environment("AGENT_RELAY_DAEMON_TOKEN");
    const telegramToken = demo
      ? undefined
      : environment("AGENT_RELAY_TELEGRAM_TOKEN");
    const telegramChatId = demo
      ? undefined
      : environment("AGENT_RELAY_TELEGRAM_CHAT_ID");
    const telegramOperatorId = demo
      ? undefined
      : environment("AGENT_RELAY_TELEGRAM_OPERATOR_ID");
    const telegramWebhookSecret = demo
      ? undefined
      : environment("AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET");
    const configuredTelegramUpdateMode = demo
      ? "poll"
      : (environment("AGENT_RELAY_TELEGRAM_UPDATE_MODE") ?? "poll");
    if (
      transportSelection.selected === "telegram" &&
      configuredTelegramUpdateMode !== "poll" &&
      configuredTelegramUpdateMode !== "webhook"
    ) {
      throw new Error(
        "AGENT_RELAY_TELEGRAM_UPDATE_MODE must be poll or webhook",
      );
    }
    const telegramOperatorUserId =
      transportSelection.selected === "telegram"
        ? optionalInteger(
            telegramOperatorId,
            "AGENT_RELAY_TELEGRAM_OPERATOR_ID",
            false,
          )
        : undefined;
    const telegramReplyChatId =
      transportSelection.selected === "telegram"
        ? optionalInteger(telegramChatId, "AGENT_RELAY_TELEGRAM_CHAT_ID", true)
        : undefined;
    let whooshbangConnection:
      Awaited<ReturnType<typeof readWhooshBangConnection>> | undefined;
    if (transportSelection.selected === "whooshbang") {
      try {
        whooshbangConnection = await readWhooshBangConnection(
          whooshbangConnectionPaths(commandStateDir),
        );
      } catch {
        throw new Error(
          "selected WhooshBang transport configuration is invalid; reconnect it before startup",
        );
      }
    }
    if (
      transportSelection.selected === "whooshbang" &&
      (whooshbangConnection === undefined ||
        whooshbangConnection.configuration.status !== "active" ||
        whooshbangConnection.credential === undefined)
    ) {
      throw new Error(
        "selected WhooshBang transport is not ready; run agent-relay whooshbang connect",
      );
    }
    const webhookConfiguration =
      transportSelection.selected === "webhook"
        ? await resolveWebhookConfiguration({
            stateDirectory: commandStateDir,
            environment: process.env,
          })
        : undefined;
    if (
      transportSelection.selected === "webhook" &&
      (webhookConfiguration?.readiness.ready !== true ||
        webhookConfiguration.runtime === undefined)
    ) {
      throw new Error(
        "selected webhook transport is not ready; run agent-relay webhook configure",
      );
    }
    const stderrLogger = new JsonLineLogger();
    const daemonLogger = new CompositeLogger([
      stderrLogger,
      new RotatingFileLogger(
        flag(args, "--log") ??
          environment("AGENT_RELAY_LOG_PATH") ??
          join(commandStateDir, "relay.ndjson"),
        {
          maxBytes: integerFlag(
            args,
            "--log-max-bytes",
            Number(
              environment("AGENT_RELAY_LOG_MAX_BYTES") ??
                String(4 * 1024 * 1024),
            ),
          ),
          maxFiles: integerFlag(
            args,
            "--log-files",
            Number(environment("AGENT_RELAY_LOG_FILES") ?? "5"),
          ),
          fallbackLogger: stderrLogger,
        },
      ),
    ]);
    const webEnabled = demo
      ? true
      : resolveWebEnabled({
          environmentValue: environment("AGENT_RELAY_WEB_ENABLED"),
          disabledByFlag: args.includes("--no-web"),
        });
    const whooshbangMachineId =
      transportSelection.selected === "whooshbang"
        ? await loadOrCreateMachineId(join(commandStateDir, "machine-id"))
        : undefined;
    const whooshbangCredentialId =
      whooshbangConnection?.credential?.credentialId;
    const internalTelegramPollingLeasePort =
      environment("AGENT_RELAY_INTERNAL_TEST_MODE") === "1"
        ? Number(
            environment(
              "AGENT_RELAY_INTERNAL_TEST_TELEGRAM_POLLING_LEASE_PORT",
            ),
          )
        : undefined;
    const daemon = await startDaemon({
      databasePath,
      webEnabled,
      selectedTransport: transportSelection.selected,
      transportSelection,
      transportReadiness,
      host: flag(args, "--host") ?? "127.0.0.1",
      port: Number(flag(args, "--port") ?? (demo ? "4318" : "4317")),
      ...(daemonToken === undefined ? {} : { token: daemonToken }),
      ...(telegramToken === undefined ? {} : { telegramToken }),
      ...(telegramChatId === undefined ? {} : { telegramChatId }),
      ...(telegramOperatorUserId === undefined
        ? {}
        : { telegramOperatorUserId }),
      ...(telegramReplyChatId === undefined ? {} : { telegramReplyChatId }),
      ...(telegramWebhookSecret === undefined ? {} : { telegramWebhookSecret }),
      ...(internalTelegramPollingLeasePort === undefined
        ? {}
        : { telegramPollingLeasePort: internalTelegramPollingLeasePort }),
      ...(transportSelection.selected !== "whooshbang" ||
      whooshbangConnection?.credential === undefined ||
      whooshbangMachineId === undefined
        ? {}
        : {
            whooshbang: {
              baseUrl: whooshbangConnection.configuration.baseUrl,
              credential: whooshbangConnection.credential.bearerToken,
              subscriberId: whooshbangConnection.configuration.subscriberId,
              notifierId: whooshbangConnection.configuration.notifierId,
              bindingId: whooshbangConnection.configuration.bindingId,
              machineClientId:
                whooshbangConnection.configuration.machineClientId,
              machineId: whooshbangMachineId,
              connectionGuard: async () => {
                try {
                  const current = await readWhooshBangConnection(
                    whooshbangConnectionPaths(commandStateDir),
                  );
                  return (
                    current?.configuration.status === "active" &&
                    current.configuration.machineClientId ===
                      whooshbangConnection.configuration.machineClientId &&
                    current.configuration.currentCredentialId ===
                      whooshbangConnection.configuration.currentCredentialId &&
                    current.credential?.credentialId === whooshbangCredentialId
                  );
                } catch {
                  return false;
                }
              },
            },
          }),
      ...(webhookConfiguration?.runtime === undefined
        ? {}
        : { webhook: webhookConfiguration.runtime }),
      telegramUpdateMode:
        configuredTelegramUpdateMode === "webhook" ? "webhook" : "poll",
      coalescingWindowMs: integerFlag(
        args,
        "--coalesce-window-ms",
        Number(environment("AGENT_RELAY_COALESCE_WINDOW_MS") ?? "60000"),
      ),
      fallbackPath: join(commandStateDir, "fallback-spool.ndjson"),
      startupBacklogMaxAgeMs: demo
        ? 0
        : integerFlag(
            args,
            "--startup-backlog-max-age-ms",
            Number(
              environment("AGENT_RELAY_STARTUP_BACKLOG_MAX_AGE_MS") ??
                (transportSelection.selected === "fake" ? "0" : "3600000"),
            ),
          ),
      retention: {
        deliveredDays: integerFlag(
          args,
          "--retention-days",
          Number(environment("AGENT_RELAY_RETENTION_DAYS") ?? "30"),
        ),
        deadLetterDays: integerFlag(
          args,
          "--dead-letter-retention-days",
          Number(environment("AGENT_RELAY_DEAD_LETTER_RETENTION_DAYS") ?? "90"),
        ),
        diagnosticDays: integerFlag(
          args,
          "--diagnostic-retention-days",
          Number(environment("AGENT_RELAY_DIAGNOSTIC_RETENTION_DAYS") ?? "90"),
        ),
      },
      logger: daemonLogger,
      runnerBridgeEnabled: runnerBridgeConfiguration?.enabled ?? false,
    });
    if (demo) {
      try {
        const seed = await seedWebDemo(daemon.service);
        daemonLogger.log({
          level: "info",
          code: "web.demo-started",
          message: "sanitized local web demo started",
          at: new Date().toISOString(),
          details: {
            url: `http://127.0.0.1:${flag(args, "--port") ?? "4318"}/ui/`,
            credentialFile: "web-credential.json beside the demo database",
            sessions: seed.sessionIds.length,
            externalCredentials: false,
          },
        });
      } catch (error) {
        await daemon.close();
        throw error;
      }
    }
    const stop = async () => {
      await daemon.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }

  if (command === "hook") {
    const harness = HarnessSchema.parse(args[0]);
    const supervised = process.env["AGENT_RELAY_SUPERVISED"] === "1";
    const configuredSurface = SurfaceSchema.parse(
      flag(args, "--surface") ?? "cli",
    );
    const surface =
      harness === "cursor" && supervised ? "cli" : configuredSurface;
    const raw = await readStdin();
    const daemonToken = environment("AGENT_RELAY_DAEMON_TOKEN");
    const machineId =
      environment("AGENT_RELAY_MACHINE_ID") ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const configuredBridgeSessionId = environment(
      "AGENT_RELAY_BRIDGE_SESSION_ID",
    );
    const result = await runHook({
      harness,
      surface,
      harnessVersion: resolveHookHarnessVersion({
        flagVersion: flag(args, "--harness-version"),
        environmentVersion: environment("AGENT_RELAY_HARNESS_VERSION"),
        supervised,
      }),
      raw,
      machineId,
      bridgeSessionId: configuredBridgeSessionId ?? "bridge_local_hooks",
      daemonUrl:
        environment("AGENT_RELAY_DAEMON_URL") ?? "http://127.0.0.1:4317",
      ...(daemonToken === undefined ? {} : { daemonToken }),
      fallbackPath: join(stateDir, "fallback-spool.ndjson"),
      waitMs: numericFlag(args, "--wait-ms", 0),
      lateResume: supervised,
      lateResumeTtlMs: numericFlag(
        args,
        "--late-resume-ttl-ms",
        Number(
          environment("AGENT_RELAY_LATE_RESUME_TTL_MS") ??
            String(24 * 60 * 60_000),
        ),
      ),
    });
    process.stdout.write(result.stdout);
    if (result.diagnostic !== undefined) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          code: result.diagnostic.code,
          message: result.diagnostic.message,
          fallbackRecorded: result.diagnostic.fallbackRecorded,
        })}\n`,
      );
    }
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "run") {
    const harness = HarnessSchema.parse(args[0]);
    const separator = args.indexOf("--");
    const supervisorArgs =
      separator === -1 ? args.slice(1) : args.slice(1, separator);
    const childArgs = separator === -1 ? [] : args.slice(separator + 1);
    const daemonToken = environment("AGENT_RELAY_DAEMON_TOKEN");
    const machineId =
      environment("AGENT_RELAY_MACHINE_ID") ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const configuredBridgeSessionId = environment(
      "AGENT_RELAY_BRIDGE_SESSION_ID",
    );
    const executable = resolveSupervisorExecutable(
      supervisorArgs,
      harnessExecutable(harness),
    );
    const result = await runSupervisor({
      harness,
      harnessVersion:
        flag(supervisorArgs, "--harness-version") ??
        environment("AGENT_RELAY_HARNESS_VERSION") ??
        "unknown",
      machineId,
      ...(configuredBridgeSessionId === undefined
        ? {}
        : { bridgeSessionId: configuredBridgeSessionId }),
      cwd: resolve(flag(supervisorArgs, "--cwd") ?? process.cwd()),
      initialInvocation: {
        executable,
        args: childArgs,
      },
      daemonUrl:
        environment("AGENT_RELAY_DAEMON_URL") ?? "http://127.0.0.1:4317",
      ...(daemonToken === undefined ? {} : { daemonToken }),
      fallbackPath: join(stateDir, "fallback-spool.ndjson"),
      resumeWaitMs: numericFlag(
        supervisorArgs,
        "--resume-wait-ms",
        24 * 60 * 60_000,
      ),
      pollIntervalMs: numericFlag(supervisorArgs, "--poll-interval-ms", 250),
      maxResumes: integerFlag(supervisorArgs, "--max-resumes", 100),
      logger: new JsonLineLogger(),
    });
    if (result.diagnostic !== undefined) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          code: result.diagnostic.code,
          message: result.diagnostic.message,
          fallbackRecorded: result.diagnostic.fallbackRecorded,
        })}\n`,
      );
    }
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "doctor") {
    const transportEnvironment = environment("AGENT_RELAY_TRANSPORT");
    const transportSelection = await resolveTransportSelection({
      stateDirectory: stateDir,
      ...(transportEnvironment === undefined
        ? {}
        : { environmentOverride: transportEnvironment }),
    });
    const transportReadiness = await inspectTransportReadiness({
      selection: transportSelection,
      stateDirectory: stateDir,
      telegram: telegramReadinessInputFromEnvironment(process.env),
      webhookEnvironment: process.env,
    });
    const runnerBridgeConfiguration = await readRunnerBridgeConfiguration(
      runnerBridgePaths(stateDir).configuration,
    );
    const liveDaemonToken = environment("AGENT_RELAY_DAEMON_TOKEN");
    const liveRequested = args.includes("--live");
    const liveStatus = liveRequested
      ? await new RelayClient({
          baseUrl:
            environment("AGENT_RELAY_DAEMON_URL") ?? "http://127.0.0.1:4317",
          ...(liveDaemonToken === undefined ? {} : { token: liveDaemonToken }),
        })
          .status()
          .catch(() => null)
      : undefined;
    const report = await runDoctor({
      databasePath: flag(args, "--db") ?? ":memory:",
      rootDir: resolve(flag(args, "--root") ?? homedir()),
      packageVersion: AGENT_RELAY_VERSION,
      runtimeEntryPath: installEntryPath(args),
      runtimeNodePath: process.execPath,
      transportReadiness,
      ...(!liveRequested
        ? {}
        : {
            liveWhooshBang: {
              ...(liveStatus?.selectedTransport === undefined
                ? {}
                : { selectedTransport: liveStatus.selectedTransport }),
              ...(liveStatus?.transportRuntime === undefined
                ? {}
                : { runtime: liveStatus.transportRuntime.whooshbang }),
            },
          }),
      runnerBridge: {
        configured: runnerBridgeConfiguration !== undefined,
        enabled: runnerBridgeConfiguration?.enabled ?? false,
        adapterAvailable: false,
      },
    });
    output(report);
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  if (command === "install") {
    const cursorSurface = flag(args, "--cursor-surface") ?? "ide";
    if (cursorSurface !== "cli" && cursorSurface !== "ide") {
      throw new Error("--cursor-surface must be cli or ide");
    }
    const observed = observeHarnessVersions();
    const versions = Object.fromEntries(
      observed.map((item) => [
        item.harness,
        item.version ?? `unavailable (verified ${item.verifiedVersion})`,
      ]),
    );
    output(
      await installAgentRelay({
        rootDir: resolve(flag(args, "--root") ?? homedir()),
        entryPath: installEntryPath(args),
        packageVersion: AGENT_RELAY_VERSION,
        ...(flag(args, "--node") === undefined
          ? {}
          : { nodePath: resolve(flag(args, "--node") ?? "") }),
        cursorSurface,
        harnessVersions: versions,
        dryRun: args.includes("--dry-run"),
      }),
    );
    return;
  }

  if (command === "uninstall") {
    output(
      await uninstallAgentRelay({
        rootDir: resolve(flag(args, "--root") ?? homedir()),
        dryRun: args.includes("--dry-run"),
      }),
    );
    return;
  }

  if (command === "whooshbang") {
    const result = await runWhooshBangCommand({
      args,
      environment: process.env,
      stateDirectory: stateDir,
      stdinIsTTY: process.stdin.isTTY,
      writeDiagnostic: (diagnostic) => {
        process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
      },
    });
    if (
      typeof result === "object" &&
      result !== null &&
      "help" in result &&
      result.help === WHOOSHBANG_COMMAND_USAGE
    ) {
      process.stdout.write(WHOOSHBANG_COMMAND_USAGE);
    } else {
      output(result);
    }
    return;
  }
  if (command === "webhook") {
    const result = await runWebhookCommand({
      args,
      environment: process.env,
      stateDirectory: stateDir,
      readStdin: async () => await readStdin(1_024),
    });
    if (
      typeof result === "object" &&
      result !== null &&
      "help" in result &&
      result.help === WEBHOOK_COMMAND_USAGE
    ) {
      process.stdout.write(WEBHOOK_COMMAND_USAGE);
    } else {
      output(result);
    }
    return;
  }
  if (command === "runner-bridge") {
    const result = await runRunnerBridgeCommand({
      args,
      stateDirectory: stateDir,
      input: process.stdin,
      write: (value) => {
        process.stdout.write(value);
      },
    });
    if (result === undefined) {
      return;
    }
    if (
      typeof result === "object" &&
      result !== null &&
      "help" in result &&
      result.help === RUNNER_BRIDGE_COMMAND_USAGE
    ) {
      process.stdout.write(RUNNER_BRIDGE_COMMAND_USAGE);
    } else {
      output(result);
    }
    return;
  }
  if (command === "transport") {
    const result = await runTransportCommand({
      args,
      environment: process.env,
      stateDirectory: stateDir,
    });
    if (
      typeof result === "object" &&
      result !== null &&
      "help" in result &&
      result.help === TRANSPORT_COMMAND_USAGE
    ) {
      process.stdout.write(TRANSPORT_COMMAND_USAGE);
    } else {
      output(result);
    }
    return;
  }

  const daemonToken = environment("AGENT_RELAY_DAEMON_TOKEN");
  const client = new RelayClient({
    baseUrl: environment("AGENT_RELAY_DAEMON_URL") ?? "http://127.0.0.1:4317",
    ...(daemonToken === undefined ? {} : { token: daemonToken }),
  });
  if (command === "status") {
    output(await client.status());
    return;
  }
  if (command === "replay-fallback") {
    const result = await replayFallbackSpool(
      flag(args, "--path") ?? join(stateDir, "fallback-spool.ndjson"),
      client,
    );
    output(result);
    process.exitCode = result.filesPending === 0 ? 0 : 1;
    return;
  }
  if (command === "maintain") {
    output(
      await client.maintainRetention({
        deliveredDays: integerFlag(args, "--retention-days", 30),
        deadLetterDays: integerFlag(args, "--dead-letter-retention-days", 90),
        diagnosticDays: integerFlag(args, "--diagnostic-retention-days", 90),
      }),
    );
    return;
  }
  if (command === "drain") {
    output(await client.drain(Number(flag(args, "--limit") ?? "50")));
    return;
  }
  if (command === "capabilities") {
    output(PUBLIC_COMPATIBILITY_RECORD);
    return;
  }
  if (command === "canary" || command === "webhook-canary") {
    if (command === "webhook-canary") {
      const daemonStatus = await client.status();
      if (daemonStatus.selectedTransport !== "webhook") {
        throw new Error(
          "webhook-canary requires a daemon using the webhook transport",
        );
      }
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const machineId =
      environment("AGENT_RELAY_MACHINE_ID") ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const sequence = Date.now();
    const eventId = makeStableEventId({
      machineId,
      harness: "codex",
      sessionId: "session_canary",
      type: "turn.stopped",
      sequence,
      sourceFingerprint: randomUUID(),
    });
    const event = {
      schema: "agent-attention.v1",
      eventId,
      occurredAt: new Date().toISOString(),
      sequence,
      machineId,
      bridgeSessionId: "bridge_canary",
      harness: "codex",
      surface: "cli",
      harnessVersion: "canary",
      sessionId: "session_canary",
      project: makeProjectRef(process.cwd()),
      type: "turn.stopped",
      summary:
        command === "webhook-canary"
          ? "Agent Relay outbound webhook canary"
          : "Agent Relay local canary",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    } as const;
    const result = await runFakeCanary({ client, event });
    output(result);
    if (command === "webhook-canary" && result.outcome !== "delivered") {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "telegram-canary") {
    await waitForTelegramCanaryReady({ client });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const machineId =
      environment("AGENT_RELAY_MACHINE_ID") ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const result = await runTelegramCanary({
      client,
      machineId,
      projectPath: process.cwd(),
      waitMs: integerFlag(args, "--wait-ms", 2 * 60_000),
      pollIntervalMs: integerFlag(args, "--poll-interval-ms", 500),
    });
    output(result);
    process.exitCode =
      result.outcome === "answered" && result.resolvedBy === "telegram" ? 0 : 1;
    return;
  }
  if (command === "whooshbang-canary") {
    const daemonStatus = await client.status();
    if (daemonStatus.selectedTransport !== "whooshbang") {
      throw new Error(
        "whooshbang-canary requires a daemon using the WhooshBang transport",
      );
    }
    const paths = whooshbangConnectionPaths(stateDir);
    const connection = await readWhooshBangConnection(paths);
    if (
      connection?.configuration.status !== "active" ||
      connection.credential === undefined
    ) {
      throw new Error("whooshbang-canary requires an active narrow connection");
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const machineId =
      environment("AGENT_RELAY_MACHINE_ID") ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const result = await runWhooshBangCanary({
      client,
      machineId,
      projectPath: process.cwd(),
      waitMs: integerFlag(args, "--wait-ms", 2 * 60_000),
      pollIntervalMs: integerFlag(args, "--poll-interval-ms", 500),
    });
    if (result.outcome !== "answered" || result.resolvedBy !== "whooshbang") {
      output({
        outcome: result.outcome,
        resolvedBy: result.resolvedBy ?? null,
      });
      process.exitCode = 1;
      return;
    }
    const request = await client.getRequest(result.correlationId);
    if (request?.transportMessageId === undefined) {
      throw new Error("WhooshBang canary delivery receipt is missing");
    }
    const transport = new WhooshBangContractTransport({
      baseUrl: connection.configuration.baseUrl,
      credential: connection.credential.bearerToken,
      machineClientId: connection.configuration.machineClientId,
      subscriberId: connection.configuration.subscriberId,
      notifierId: connection.configuration.notifierId,
    });
    const diagnostic = await transport.diagnoseMessage(
      request.transportMessageId,
      { timeoutMs: 10_000 },
    );

    const statusDeadline = Date.now() + 10_000;
    const priorCursorRef =
      daemonStatus.transportRuntime?.whooshbang.polling.committedCursorRef ??
      null;
    let completedStatus = await client.status();
    while (
      Date.now() < statusDeadline &&
      !isWhooshBangCanaryAcknowledged(
        priorCursorRef,
        completedStatus.transportRuntime?.whooshbang.polling,
      )
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      completedStatus = await client.status();
    }
    const runtime = completedStatus.transportRuntime?.whooshbang;
    const acknowledged = isWhooshBangCanaryAcknowledged(
      priorCursorRef,
      runtime?.polling,
    );
    if (
      !acknowledged ||
      runtime === undefined ||
      runtime.delivery.lastSuccessfulSendAt === null ||
      runtime.polling.lastSuccessfulPollAt === null ||
      runtime.polling.committedCursorRef === null
    ) {
      throw new Error("WhooshBang canary was answered but not acknowledged");
    }

    await recordWhooshBangCanary(paths, {
      committedCursorRef: runtime.polling.committedCursorRef,
      completedAt: new Date(),
      connectedAt: connection.configuration.connectedAt,
      credentialGeneration: connection.credential.rotation.generation,
      credentialId: connection.credential.credentialId,
      diagnosticId: diagnostic.diagnosticId,
      lastSuccessfulPollAt: runtime.polling.lastSuccessfulPollAt,
      lastSuccessfulSendAt: runtime.delivery.lastSuccessfulSendAt,
      messageId: diagnostic.messageId,
    });
    output({
      outcome: "answered",
      resolvedBy: "whooshbang",
      messageRef: safeReference(diagnostic.messageId),
      diagnosticRef: safeReference(diagnostic.diagnosticId),
      providerState: diagnostic.state,
      lastSuccessfulSendAt: runtime.delivery.lastSuccessfulSendAt,
      lastSuccessfulPollAt: runtime.polling.lastSuccessfulPollAt,
      committedCursorRef: runtime.polling.committedCursorRef,
      unacknowledgedEventCount: runtime.polling.unacknowledgedEventCount,
      presentationCapability: runtime.presentation.capability,
    });
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      code: "cli.failed",
      message: error instanceof Error ? error.message : "unknown CLI failure",
      ...(errorCode === undefined ? {} : { errorCode }),
    })}\n`,
  );
  process.exitCode = 1;
});
