#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { JsonLineLogger } from "@agent-relay/core";
import { HARNESS_CAPABILITIES } from "@agent-relay/harnesses";
import {
  HarnessSchema,
  SurfaceSchema,
  makeProjectRef,
  makeStableEventId,
} from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { runHook } from "./hook-runner.js";
import { loadOrCreateMachineId } from "./machine-id.js";
import { runSupervisor } from "./supervisor.js";

const stateDir =
  process.env["AGENT_RELAY_STATE_DIR"] ?? join(homedir(), ".agent-relay");

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
      throw new Error(`hook stdin exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function numericFlag(args: string[], name: string, fallback: number): number {
  const value = Number(flag(args, name) ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "daemon") {
    const databasePath = flag(args, "--db") ?? join(stateDir, "relay.sqlite");
    const daemonToken = process.env["AGENT_RELAY_DAEMON_TOKEN"];
    const telegramToken = process.env["AGENT_RELAY_TELEGRAM_TOKEN"];
    const telegramChatId = process.env["AGENT_RELAY_TELEGRAM_CHAT_ID"];
    const telegramOperatorId = process.env["AGENT_RELAY_TELEGRAM_OPERATOR_ID"];
    const telegramWebhookSecret =
      process.env["AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET"];
    const daemon = await startDaemon({
      databasePath,
      host: flag(args, "--host") ?? "127.0.0.1",
      port: Number(flag(args, "--port") ?? "4317"),
      ...(daemonToken === undefined ? {} : { token: daemonToken }),
      ...(telegramToken === undefined ? {} : { telegramToken }),
      ...(telegramChatId === undefined ? {} : { telegramChatId }),
      ...(telegramOperatorId === undefined
        ? {}
        : { telegramOperatorUserId: Number(telegramOperatorId) }),
      ...(telegramChatId === undefined
        ? {}
        : { telegramReplyChatId: Number(telegramChatId) }),
      ...(telegramWebhookSecret === undefined ? {} : { telegramWebhookSecret }),
    });
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
    const surface = SurfaceSchema.parse(flag(args, "--surface") ?? "cli");
    const raw = await readStdin();
    const daemonToken = process.env["AGENT_RELAY_DAEMON_TOKEN"];
    const machineId =
      process.env["AGENT_RELAY_MACHINE_ID"] ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const result = await runHook({
      harness,
      surface,
      harnessVersion:
        flag(args, "--harness-version") ??
        process.env["AGENT_RELAY_HARNESS_VERSION"] ??
        "unknown",
      raw,
      machineId,
      bridgeSessionId:
        process.env["AGENT_RELAY_BRIDGE_SESSION_ID"] ?? "bridge_local_hooks",
      daemonUrl:
        process.env["AGENT_RELAY_DAEMON_URL"] ?? "http://127.0.0.1:4317",
      ...(daemonToken === undefined ? {} : { daemonToken }),
      fallbackPath: join(stateDir, "fallback-spool.ndjson"),
      waitMs: numericFlag(args, "--wait-ms", 0),
      lateResume: process.env["AGENT_RELAY_SUPERVISED"] === "1",
      lateResumeTtlMs: numericFlag(
        args,
        "--late-resume-ttl-ms",
        Number(
          process.env["AGENT_RELAY_LATE_RESUME_TTL_MS"] ??
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
    const daemonToken = process.env["AGENT_RELAY_DAEMON_TOKEN"];
    const machineId =
      process.env["AGENT_RELAY_MACHINE_ID"] ??
      (await loadOrCreateMachineId(join(stateDir, "machine-id")));
    const executable =
      flag(supervisorArgs, "--executable") ?? harnessExecutable(harness);
    const result = await runSupervisor({
      harness,
      harnessVersion:
        flag(supervisorArgs, "--harness-version") ??
        process.env["AGENT_RELAY_HARNESS_VERSION"] ??
        "unknown",
      machineId,
      ...(process.env["AGENT_RELAY_BRIDGE_SESSION_ID"] === undefined
        ? {}
        : {
            bridgeSessionId: process.env["AGENT_RELAY_BRIDGE_SESSION_ID"],
          }),
      cwd: resolve(flag(supervisorArgs, "--cwd") ?? process.cwd()),
      initialInvocation: {
        executable,
        args: childArgs,
      },
      daemonUrl:
        process.env["AGENT_RELAY_DAEMON_URL"] ?? "http://127.0.0.1:4317",
      ...(daemonToken === undefined ? {} : { daemonToken }),
      fallbackPath: join(stateDir, "fallback-spool.ndjson"),
      resumeWaitMs: numericFlag(
        supervisorArgs,
        "--resume-wait-ms",
        24 * 60 * 60_000,
      ),
      pollIntervalMs: numericFlag(supervisorArgs, "--poll-interval-ms", 250),
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
    const databasePath = flag(args, "--db") ?? ":memory:";
    const report = runDoctor(databasePath);
    output(report);
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  const daemonToken = process.env["AGENT_RELAY_DAEMON_TOKEN"];
  const client = new RelayClient({
    baseUrl: process.env["AGENT_RELAY_DAEMON_URL"] ?? "http://127.0.0.1:4317",
    ...(daemonToken === undefined ? {} : { token: daemonToken }),
  });
  if (command === "status") {
    output(await client.status());
    return;
  }
  if (command === "drain") {
    output(await client.drain(Number(flag(args, "--limit") ?? "50")));
    return;
  }
  if (command === "capabilities") {
    output(HARNESS_CAPABILITIES);
    return;
  }
  if (command === "canary") {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const machineId =
      process.env["AGENT_RELAY_MACHINE_ID"] ??
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
    const result = await client.ingest({
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
      summary: "Agent Relay local canary",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    output({ ingest: result, drain: await client.drain() });
    return;
  }

  await mkdir(dirname(join(stateDir, "placeholder")), {
    recursive: true,
    mode: 0o700,
  });
  process.stderr.write(
    "Usage: agent-relay daemon|hook|run|status|drain|doctor|capabilities|canary\n",
  );
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      code: "cli.failed",
      message: error instanceof Error ? error.message : "unknown CLI failure",
    })}\n`,
  );
  process.exitCode = 1;
});
