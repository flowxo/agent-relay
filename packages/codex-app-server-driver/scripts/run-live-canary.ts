import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  isoTimestamp,
  qualifiedId,
  sha256Digest,
  type IsoTimestamp,
} from "@session/contracts";
import type { RunnerCommandFrame } from "@session/protocol-runner";
import {
  canonicalJson,
  sha256,
  type StructuredHarnessCommandContext,
  type StructuredHarnessObservation,
} from "@agent-relay/runner-bridge";

import {
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_VERSION,
  CodexAppServerDriver,
  OwnedCodexAppServerRpc,
  type CodexCommandMaterialPort,
} from "../src/index.js";

const execFile = promisify(execFileCallback);
const instructionDigest = "f".repeat(64);
const generatedAt = new Date().toISOString() as IsoTimestamp;

function command(
  name: "session.start" | "turn.start",
  nativeSessionReference?: string,
): StructuredHarnessCommandContext {
  const suffix = name.replace(".", "_");
  return {
    idempotencyKey: `cmd_canary_${suffix}`,
    effectFingerprint: sha256(`canary:${name}`),
    ...(nativeSessionReference === undefined ? {} : { nativeSessionReference }),
    command: {
      schema: "runner.protocol/command",
      schema_version: 1,
      message_id: qualifiedId("message", `msg_canary_${suffix}`),
      idempotency_key: qualifiedId("command", `cmd_canary_${suffix}`),
      workspace_id: qualifiedId("workspace", "wsp_canary_workspace"),
      runner_id: qualifiedId("runner", "run_canary_runner"),
      project_id: qualifiedId("project", "prj_canary_project"),
      session_id: qualifiedId("session", "ses_canary_session"),
      ...(name === "turn.start"
        ? { turn_id: qualifiedId("turn", "trn_canary_turn") }
        : {}),
      aggregate_revision: 0,
      capability_snapshot_digest: sha256Digest("a".repeat(64)),
      sequence: name === "session.start" ? 0 : 1,
      lane: "control",
      sent_at: generatedAt,
      expires_at: isoTimestamp(new Date(Date.now() + 180_000).toISOString()),
      trace_id: qualifiedId("trace", `trc_canary_${suffix}`),
      payload: {
        command: name,
        required_capability:
          name === "session.start" ? "session.lifecycle" : "turn.start",
        body: {
          schema: `runner.command/${name}`,
          schema_version: 1,
          ...(name === "turn.start"
            ? { instruction_digest: instructionDigest }
            : {}),
        },
      },
    } as RunnerCommandFrame,
  };
}

async function canonicalSchemaDigest(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function waitForCompleted(
  observations: readonly StructuredHarnessObservation[],
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (
    !observations.some(
      ({ kind, status }) =>
        kind === "turn.completed" &&
        ["completed", "failed", "interrupted"].includes(status ?? ""),
    )
  ) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("live_canary_turn_timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "agent-relay-codex-app-server-canary-"),
);
const schemaDirectory = join(temporaryRoot, "schema");
const observations: StructuredHarnessObservation[] = [];
const material: CodexCommandMaterialPort = {
  resolveSession: () =>
    Promise.resolve({
      cwd: temporaryRoot,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    }),
  resolveTurn: () =>
    Promise.resolve({
      instructionDigest,
      input: [
        {
          type: "text",
          text: "Reply with exactly LIVE_CANARY_OK. Do not use tools.",
          text_elements: [],
        },
      ],
    }),
};
const rpc = new OwnedCodexAppServerRpc({
  requestTimeoutMs: 60_000,
  shutdownTimeoutMs: 3_000,
});
const driver = new CodexAppServerDriver({ rpc, material });
driver.subscribe((observation) => {
  observations.push(observation);
});

try {
  const { stdout: versionOutput } = await execFile("codex", ["--version"], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (versionOutput.trim() !== CODEX_APP_SERVER_VERSION) {
    throw new Error("live_canary_version_mismatch");
  }
  await execFile(
    "codex",
    [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schemaDirectory,
    ],
    { timeout: 30_000, maxBuffer: 64 * 1024 },
  );
  const schemaDigest = await canonicalSchemaDigest(
    join(schemaDirectory, "codex_app_server_protocol.v2.schemas.json"),
  );
  if (schemaDigest !== CODEX_APP_SERVER_SCHEMA_SHA256) {
    throw new Error("live_canary_schema_mismatch");
  }

  await driver.start();
  const sessionResult = await driver.startSession(command("session.start"));
  if (
    sessionResult.status !== "completed" ||
    sessionResult.nativeSessionReference === undefined
  ) {
    throw new Error(
      `live_canary_session_failed:${
        sessionResult.status === "outcome_unknown"
          ? sessionResult.safeCode
          : "native_session_reference_missing"
      }:${rpc.status().lastSafeCode ?? "no_rpc_code"}`,
    );
  }
  const turnResult = await driver.startTurn(
    command("turn.start", sessionResult.nativeSessionReference),
  );
  if (turnResult.status !== "completed") {
    throw new Error(`live_canary_turn_start_failed:${turnResult.safeCode}`);
  }
  await waitForCompleted(observations, 90_000);
  const completed = observations.find(({ kind }) => kind === "turn.completed");
  if (completed?.status !== "completed") {
    throw new Error("live_canary_turn_not_completed");
  }
  const initialized = rpc.status().state === "ready";
  await driver.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = rpc.status().state === "stopped";
  const evidence = {
    schema: "agent-relay-codex-app-server-live-canary.v1",
    codexVersion: CODEX_APP_SERVER_VERSION,
    schemaSha256: schemaDigest,
    transport: "stdio-jsonl",
    initialized,
    sessionStarted: sessionResult.status === "completed",
    turnStarted: turnResult.status === "completed",
    turnCompleted: completed.status === "completed",
    observationKinds: [...new Set(observations.map(({ kind }) => kind))].sort(),
    itemKinds: [
      ...new Set(
        observations.flatMap(({ itemKind }) =>
          itemKind === undefined ? [] : [itemKind],
        ),
      ),
    ].sort(),
    processExitObserved: observations.some(
      ({ kind, status }) =>
        kind === "process.exited" && status === "intentional",
    ),
    stopped,
    generatedAt: generatedAt.slice(0, 10),
    content: "sanitized-counts-and-enums-only",
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await driver.stop().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
