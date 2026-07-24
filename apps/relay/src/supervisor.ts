import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, homedir } from "node:os";
import { basename, join } from "node:path";

import {
  buildLateResumeInvocation,
  capabilityFor,
} from "@agent-relay/harnesses";
import type { ResumeInvocation } from "@agent-relay/harnesses";
import type { RelayLogger, SessionRecord } from "@agent-relay/core";
import { JsonLineLogger } from "@agent-relay/core";
import {
  AgentAttentionEventV1Schema,
  makeProjectRef,
  makeStableEventId,
  sha256,
} from "@agent-relay/protocol";
import type {
  AgentAttentionEventV1,
  Harness,
  ProcessExitEvidence,
} from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { appendFallbackRecord } from "./fallback-spool.js";

export interface ChildRunRequest extends ResumeInvocation {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface OwnedChildResult {
  startedAt: string;
  exitedAt: string;
  pid?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  requestedSignal?: boolean;
  spawnErrorCode?: string;
}

export type OwnedChildRunner = (
  request: ChildRunRequest,
) => Promise<OwnedChildResult>;

export interface SupervisorOptions {
  harness: Harness;
  harnessVersion: string;
  machineId: string;
  bridgeSessionId?: string;
  supervisorId?: string;
  cwd: string;
  initialInvocation: ResumeInvocation;
  daemonUrl?: string;
  daemonToken?: string;
  fallbackPath?: string;
  client?: RelayClient;
  logger?: RelayLogger;
  childRunner?: OwnedChildRunner;
  resumeWaitMs?: number;
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SupervisorRunResult {
  bridgeSessionId: string;
  supervisorId: string;
  exitCode: number;
  resumed: number;
  classification: ProcessExitEvidence["classification"];
  unexpectedExitEventId?: string;
  diagnostic?: {
    code: string;
    message: string;
    fallbackRecorded: boolean;
  };
}

interface ClassifiedExit {
  evidence: ProcessExitEvidence;
  unexpected: boolean;
  terminalExitCode: number;
  failure?: NonNullable<AgentAttentionEventV1["failure"]>;
  summary: string;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function terminalStatus(result: OwnedChildResult): number {
  if (result.exitCode !== undefined) {
    return result.exitCode;
  }
  if (result.signal !== undefined) {
    const signalNumber = constants.signals[result.signal];
    return signalNumber === undefined ? 1 : Math.min(255, 128 + signalNumber);
  }
  return result.spawnErrorCode === undefined ? 1 : 127;
}

export function classifyOwnedExit(
  result: OwnedChildResult,
  supervisorId: string,
): ClassifiedExit {
  let classification: ProcessExitEvidence["classification"];
  let expected = false;
  let failure: ClassifiedExit["failure"];
  let summary: string;

  if (result.spawnErrorCode !== undefined) {
    classification = "spawn-error";
    summary = `Supervised child could not be started (${result.spawnErrorCode})`;
    failure = {
      class: "spawn-error",
      message: summary,
    };
  } else if (result.signal !== undefined) {
    classification = "signal";
    expected = result.requestedSignal === true;
    summary = expected
      ? `Supervised child stopped after forwarded ${result.signal}`
      : `Supervised child received ${result.signal}`;
    if (!expected) {
      failure = {
        class: "signal",
        message: summary,
      };
    }
  } else if (result.exitCode === 0) {
    classification = "clean-exit";
    expected = true;
    summary = "Supervised child exited cleanly";
  } else if (result.exitCode !== undefined) {
    classification = "nonzero-exit";
    summary = `Supervised child exited with status ${result.exitCode}`;
    failure = {
      class: "exit-code",
      message: summary,
    };
  } else {
    classification = "unknown";
    summary = "Supervised child exited without a status";
    failure = {
      class: "unknown-exit",
      message: summary,
    };
  }

  const evidence: ProcessExitEvidence = {
    source: "owned-child",
    supervisorId,
    startedAt: result.startedAt,
    exitedAt: result.exitedAt,
    ...(result.pid === undefined ? {} : { pid: result.pid }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    classification,
    expected,
  };
  return {
    evidence,
    unexpected: !expected,
    terminalExitCode: terminalStatus(result),
    ...(failure === undefined ? {} : { failure }),
    summary,
  };
}

export const spawnOwnedChild: OwnedChildRunner = async (request) => {
  const startedAt = new Date().toISOString();
  return await new Promise<OwnedChildResult>((resolve) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    let requestedSignal: NodeJS.Signals | undefined;
    const handlers = new Map<NodeJS.Signals, () => void>();

    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };
    const finish = (result: OwnedChildResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        requestedSignal = signal;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        startedAt,
        exitedAt: new Date().toISOString(),
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        spawnErrorCode: error.code ?? "spawn-failed",
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        startedAt,
        exitedAt: new Date().toISOString(),
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
        ...(signal !== null && requestedSignal === signal
          ? { requestedSignal: true }
          : {}),
      });
    });
  });
};

function supervisedEnvironment(
  base: NodeJS.ProcessEnv,
  options: {
    machineId: string;
    bridgeSessionId: string;
    harnessVersion: string;
    daemonUrl: string;
    daemonToken?: string;
  },
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of [
    "AGENT_RELAY_TELEGRAM_TOKEN",
    "AGENT_RELAY_TELEGRAM_CHAT_ID",
    "AGENT_RELAY_TELEGRAM_OPERATOR_ID",
    "AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
  ]) {
    delete env[name];
  }
  return {
    ...env,
    AGENT_RELAY_SUPERVISED: "1",
    AGENT_RELAY_MACHINE_ID: options.machineId,
    AGENT_RELAY_BRIDGE_SESSION_ID: options.bridgeSessionId,
    AGENT_RELAY_HARNESS_VERSION: options.harnessVersion,
    AGENT_RELAY_DAEMON_URL: options.daemonUrl,
    ...(options.daemonToken === undefined
      ? {}
      : { AGENT_RELAY_DAEMON_TOKEN: options.daemonToken }),
  };
}

function syntheticSessionId(bridgeSessionId: string): string {
  return `session_supervised_${sha256(bridgeSessionId).slice(0, 24)}`;
}

async function recordFallback(
  path: string,
  kind: "event" | "diagnostic",
  payload: unknown,
  recordedAt: string,
): Promise<boolean> {
  try {
    await appendFallbackRecord(path, {
      schema: "agent-relay-fallback.v1",
      recordedAt,
      kind,
      payload,
    });
    return true;
  } catch {
    return false;
  }
}

async function latestSession(
  client: RelayClient,
  input: {
    machineId: string;
    bridgeSessionId: string;
    harness: Harness;
  },
): Promise<SessionRecord | undefined> {
  const sessions = await client.listSessionsByBridge(input);
  return sessions[0];
}

function exitEvent(
  options: {
    harness: Harness;
    harnessVersion: string;
    machineId: string;
    bridgeSessionId: string;
    supervisorId: string;
    cwd: string;
  },
  classified: ClassifiedExit,
  sessionId: string,
): AgentAttentionEventV1 {
  const capability = capabilityFor(options.harness, "cli");
  if (capability === undefined) {
    throw new Error(`no CLI capability exists for ${options.harness}`);
  }
  const sequence = Math.max(0, Date.parse(classified.evidence.exitedAt));
  const sourceFingerprint = sha256(
    [
      options.supervisorId,
      classified.evidence.startedAt,
      classified.evidence.exitedAt,
      classified.evidence.pid ?? "",
      classified.evidence.exitCode ?? "",
      classified.evidence.signal ?? "",
      classified.evidence.classification,
    ].join("\u001f"),
  );
  return AgentAttentionEventV1Schema.parse({
    schema: "agent-attention.v1",
    eventId: makeStableEventId({
      machineId: options.machineId,
      harness: options.harness,
      sessionId,
      type: "process.exited",
      sequence,
      sourceFingerprint,
    }),
    occurredAt: classified.evidence.exitedAt,
    sequence,
    machineId: options.machineId,
    bridgeSessionId: options.bridgeSessionId,
    harness: options.harness,
    surface: "cli",
    harnessVersion: options.harnessVersion,
    sessionId,
    ...(classified.evidence.pid === undefined
      ? {}
      : { pid: classified.evidence.pid }),
    project: makeProjectRef(options.cwd),
    type: "process.exited",
    summary: classified.summary,
    failure: classified.failure,
    processExit: classified.evidence,
    capabilities: capability.protocol,
  });
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function runSupervisor(
  options: SupervisorOptions,
): Promise<SupervisorRunResult> {
  const bridgeSessionId = options.bridgeSessionId ?? `bridge_${randomUUID()}`;
  const supervisorId = options.supervisorId ?? `supervisor_${randomUUID()}`;
  const daemonUrl = options.daemonUrl ?? "http://127.0.0.1:4317";
  const fallbackPath =
    options.fallbackPath ??
    join(homedir(), ".agent-relay", "fallback-spool.ndjson");
  const logger = options.logger ?? new JsonLineLogger();
  const client =
    options.client ??
    new RelayClient({
      baseUrl: daemonUrl,
      ...(options.daemonToken === undefined
        ? {}
        : { token: options.daemonToken }),
    });
  const runner = options.childRunner ?? spawnOwnedChild;
  const env = supervisedEnvironment(options.env ?? process.env, {
    machineId: options.machineId,
    bridgeSessionId,
    harnessVersion: options.harnessVersion,
    daemonUrl,
    ...(options.daemonToken === undefined
      ? {}
      : { daemonToken: options.daemonToken }),
  });
  const resumeWaitMs = options.resumeWaitMs ?? 24 * 60 * 60_000;
  if (
    !Number.isFinite(resumeWaitMs) ||
    resumeWaitMs < 0 ||
    resumeWaitMs > 7 * 24 * 60 * 60_000
  ) {
    throw new Error("resume wait must be between zero and 7 days");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 25 ||
    pollIntervalMs > 60_000
  ) {
    throw new Error("resume poll interval must be between 25ms and 60s");
  }
  let invocation = options.initialInvocation;
  let resumeCorrelationId: string | undefined;
  let resumed = 0;
  let lastSessionId: string | undefined;

  for (;;) {
    if (resumeCorrelationId !== undefined) {
      try {
        await client.markResumeStarted(resumeCorrelationId, supervisorId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "could not audit late resume start";
        const fallbackRecorded = await recordFallback(
          fallbackPath,
          "diagnostic",
          {
            code: "resume-start-audit-failed",
            message,
            correlationId: resumeCorrelationId,
          },
          new Date().toISOString(),
        );
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: 1,
          resumed,
          classification: "unknown",
          diagnostic: {
            code: "resume-start-audit-failed",
            message,
            fallbackRecorded,
          },
        };
      }
    }

    logger.log({
      level: "info",
      code: "supervisor.child-starting",
      message: "starting owned harness child",
      at: new Date().toISOString(),
      details: {
        supervisorId,
        bridgeSessionId,
        harness: options.harness,
        executable: basename(invocation.executable),
        resume: resumeCorrelationId !== undefined,
      },
    });
    const childResult = await runner({
      ...invocation,
      cwd: options.cwd,
      env,
    });
    const classified = classifyOwnedExit(childResult, supervisorId);
    logger.log({
      level: classified.unexpected ? "error" : "info",
      code: classified.unexpected
        ? "supervisor.child-exited-unexpectedly"
        : "supervisor.child-exited",
      message: classified.summary,
      at: childResult.exitedAt,
      details: {
        supervisorId,
        bridgeSessionId,
        harness: options.harness,
        classification: classified.evidence.classification,
        ...(classified.evidence.pid === undefined
          ? {}
          : { pid: classified.evidence.pid }),
        ...(classified.evidence.exitCode === undefined
          ? {}
          : { exitCode: classified.evidence.exitCode }),
        ...(classified.evidence.signal === undefined
          ? {}
          : { signal: classified.evidence.signal }),
      },
    });

    if (resumeCorrelationId !== undefined) {
      const resumeSucceeded =
        classified.evidence.classification === "clean-exit" &&
        !classified.unexpected;
      try {
        await client.markResumeFinished({
          correlationId: resumeCorrelationId,
          ownerId: supervisorId,
          succeeded: resumeSucceeded,
          ...(classified.evidence.exitCode === undefined
            ? {}
            : { exitCode: classified.evidence.exitCode }),
          ...(classified.evidence.signal === undefined
            ? {}
            : { signal: classified.evidence.signal }),
          ...(resumeSucceeded
            ? {}
            : {
                errorCode: classified.unexpected
                  ? `resume-${classified.evidence.classification}`
                  : "resume-interrupted",
                errorMessage: classified.summary,
              }),
        });
      } catch (error) {
        logger.log({
          level: "error",
          code: "resume-finish-audit-failed",
          message:
            error instanceof Error
              ? error.message
              : "could not audit late resume completion",
          at: new Date().toISOString(),
          details: { correlationId: resumeCorrelationId, supervisorId },
        });
      }
    }

    let knownSession: SessionRecord | undefined;
    try {
      knownSession = await latestSession(client, {
        machineId: options.machineId,
        bridgeSessionId,
        harness: options.harness,
      });
      lastSessionId = knownSession?.sessionId ?? lastSessionId;
    } catch (error) {
      logger.log({
        level: "warn",
        code: "supervisor.session-lookup-failed",
        message:
          error instanceof Error
            ? error.message
            : "could not look up the supervised harness session",
        at: new Date().toISOString(),
        details: { supervisorId, bridgeSessionId, harness: options.harness },
      });
      // A failed crash-event ingest below is durably recorded in the fallback
      // spool. Clean exits retain their terminal status and emit a diagnostic.
    }

    if (classified.unexpected) {
      const event = exitEvent(
        {
          harness: options.harness,
          harnessVersion: options.harnessVersion,
          machineId: options.machineId,
          bridgeSessionId,
          supervisorId,
          cwd: options.cwd,
        },
        classified,
        lastSessionId ?? syntheticSessionId(bridgeSessionId),
      );
      try {
        await client.ingest(event);
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
          unexpectedExitEventId: event.eventId,
        };
      } catch (error) {
        const fallbackRecorded = await recordFallback(
          fallbackPath,
          "event",
          event,
          event.occurredAt,
        );
        const message =
          error instanceof Error
            ? error.message
            : "could not persist supervised process exit";
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
          unexpectedExitEventId: event.eventId,
          diagnostic: {
            code: "process-exit-ingest-failed",
            message,
            fallbackRecorded,
          },
        };
      }
    }

    const waitDeadline = Date.now() + resumeWaitMs;
    for (;;) {
      let claim;
      try {
        claim = await client.claimNextResume({
          machineId: options.machineId,
          bridgeSessionId,
          harness: options.harness,
          ownerId: supervisorId,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "could not query late resume commands";
        const fallbackRecorded = await recordFallback(
          fallbackPath,
          "diagnostic",
          {
            code: "resume-claim-failed",
            message,
            bridgeSessionId,
          },
          new Date().toISOString(),
        );
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
          diagnostic: {
            code: "resume-claim-failed",
            message,
            fallbackRecorded,
          },
        };
      }

      if (claim.outcome === "claimed") {
        lastSessionId = claim.command.sessionId;
        try {
          invocation = buildLateResumeInvocation(
            claim.command.harness,
            claim.command.surface,
            claim.command.sessionId,
            claim.command.answer,
          );
        } catch (error) {
          await client.markResumeStarted(
            claim.command.correlationId,
            supervisorId,
          );
          await client.markResumeFinished({
            correlationId: claim.command.correlationId,
            ownerId: supervisorId,
            succeeded: false,
            errorCode: "resume-invocation-invalid",
            errorMessage:
              error instanceof Error
                ? error.message
                : "could not build late resume invocation",
          });
          return {
            bridgeSessionId,
            supervisorId,
            exitCode: 1,
            resumed,
            classification: "unknown",
            diagnostic: {
              code: "resume-invocation-invalid",
              message:
                error instanceof Error
                  ? error.message
                  : "could not build late resume invocation",
              fallbackRecorded: false,
            },
          };
        }
        resumeCorrelationId = claim.command.correlationId;
        resumed += 1;
        break;
      }
      if (claim.outcome === "unsupported") {
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
          diagnostic: {
            code: "late-resume-unsupported",
            message: `late resume is unsupported for ${claim.harness}/${claim.surface}`,
            fallbackRecorded: false,
          },
        };
      }
      if (claim.outcome === "none") {
        if (knownSession !== undefined) {
          try {
            await client.heartbeat({
              schema: "agent-heartbeat.v1",
              machineId: knownSession.machineId,
              harness: knownSession.harness,
              sessionId: knownSession.sessionId,
              observedAt: childResult.exitedAt,
              state: "exited",
              sequence: Math.max(
                knownSession.lastSequence + 1,
                Date.parse(childResult.exitedAt),
              ),
            });
          } catch (error) {
            logger.log({
              level: "warn",
              code: "supervisor.clean-exit-heartbeat-failed",
              message:
                error instanceof Error
                  ? error.message
                  : "could not record clean child exit state",
              at: new Date().toISOString(),
              details: {
                supervisorId,
                bridgeSessionId,
                sessionId: knownSession.sessionId,
              },
            });
            // The clean child status remains authoritative. Daemon diagnostics
            // are returned only when an actionable resume command was at risk.
          }
        }
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
        };
      }

      const remaining = Math.min(
        waitDeadline - Date.now(),
        Date.parse(claim.expiresAt) - Date.now(),
      );
      if (remaining <= 0) {
        return {
          bridgeSessionId,
          supervisorId,
          exitCode: classified.terminalExitCode,
          resumed,
          classification: classified.evidence.classification,
        };
      }
      await pause(Math.min(pollIntervalMs, remaining));
    }
  }
}
