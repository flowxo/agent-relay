import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseHarnessJson,
  renderSafeNoop,
  renderStopContinuation,
} from "@agent-relay/harnesses";
import type { AdapterContext, ParseDiagnostic } from "@agent-relay/harnesses";
import { AgentAttentionEventV1Schema, sha256 } from "@agent-relay/protocol";
import type { Harness, Surface } from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { appendFallbackRecord } from "./fallback-spool.js";

export interface HookRunOptions {
  harness: Harness;
  surface: Surface;
  harnessVersion: string;
  raw: string;
  machineId: string;
  bridgeSessionId: string;
  sequence?: number;
  occurredAt?: string;
  daemonUrl?: string;
  daemonToken?: string;
  fallbackPath?: string;
  client?: RelayClient;
  waitMs?: number;
  pollIntervalMs?: number;
  lateResume?: boolean;
  lateResumeTtlMs?: number;
}

export interface HookRunDiagnostic {
  code: string;
  message: string;
  fallbackRecorded: boolean;
  parser?: ParseDiagnostic;
}

export interface HookRunResult {
  stdout: string;
  exitCode: 0;
  eventId?: string;
  daemonAccepted: boolean;
  requestState?: "open" | "answered" | "expired" | "cancelled" | "failed";
  diagnostic?: HookRunDiagnostic;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function sourceFingerprint(raw: string): Promise<string> {
  let transcriptEvidence = "";
  let fingerprintInput = raw;
  try {
    const payload = JSON.parse(raw) as unknown;
    fingerprintInput = JSON.stringify(canonicalize(payload));
    if (
      typeof payload === "object" &&
      payload !== null &&
      "transcript_path" in payload &&
      typeof payload.transcript_path === "string"
    ) {
      const metadata = await stat(payload.transcript_path);
      transcriptEvidence = `${metadata.size}:${metadata.mtimeMs}`;
    }
  } catch {
    // The parser below returns the actionable invalid-JSON diagnostic.
  }
  return sha256(`${fingerprintInput}\u001f${transcriptEvidence}`);
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

export async function runHook(options: HookRunOptions): Promise<HookRunResult> {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const fallbackPath =
    options.fallbackPath ??
    join(homedir(), ".agent-relay", "fallback-spool.ndjson");
  const fingerprint = await sourceFingerprint(options.raw);
  const context: AdapterContext = {
    machineId: options.machineId,
    bridgeSessionId: options.bridgeSessionId,
    harnessVersion: options.harnessVersion,
    surface: options.surface,
    sequence: options.sequence ?? Number.parseInt(fingerprint.slice(0, 12), 16),
    occurredAt,
    sourceFingerprint: fingerprint,
  };
  const parsed = parseHarnessJson(options.harness, options.raw, context);
  const safeStdout = `${JSON.stringify(renderSafeNoop().stdout)}\n`;

  if (!parsed.ok) {
    const fallbackRecorded = await recordFallback(
      fallbackPath,
      "diagnostic",
      parsed.diagnostic,
      occurredAt,
    );
    return {
      stdout: safeStdout,
      exitCode: 0,
      daemonAccepted: false,
      diagnostic: {
        code: parsed.diagnostic.code,
        message: parsed.diagnostic.message,
        fallbackRecorded,
        parser: parsed.diagnostic,
      },
    };
  }

  const shouldWait =
    (options.waitMs ?? 0) > 0 &&
    parsed.event.type === "turn.stopped" &&
    !parsed.stopHookActive;
  const shouldOfferLateResume =
    options.lateResume === true &&
    parsed.event.type === "turn.stopped" &&
    !parsed.stopHookActive &&
    parsed.event.surface === "cli" &&
    parsed.event.capabilities.lateResume;
  const shouldRequestContinuation = shouldWait || shouldOfferLateResume;
  const continuationTtlMs = shouldWait
    ? (options.waitMs ?? 0)
    : (options.lateResumeTtlMs ?? 24 * 60 * 60_000);
  if (
    shouldRequestContinuation &&
    (!Number.isFinite(continuationTtlMs) ||
      continuationTtlMs <= 0 ||
      continuationTtlMs > 7 * 24 * 60 * 60_000)
  ) {
    throw new Error(
      "continuation lifetime must be greater than zero and at most 7 days",
    );
  }
  const event = shouldRequestContinuation
    ? AgentAttentionEventV1Schema.parse({
        ...parsed.event,
        request: {
          correlationId: `req_${parsed.event.eventId}`,
          kind: "continuation",
          question: "Reply to continue this stopped turn.",
          expiresAt: new Date(
            Date.parse(occurredAt) + continuationTtlMs,
          ).toISOString(),
        },
      })
    : parsed.event;
  const client =
    options.client ??
    new RelayClient({
      ...(options.daemonUrl === undefined
        ? {}
        : { baseUrl: options.daemonUrl }),
      ...(options.daemonToken === undefined
        ? {}
        : { token: options.daemonToken }),
    });
  try {
    await client.ingest(event);
    if (event.request !== undefined && shouldWait) {
      const request = await client.waitForAnswer(
        event.request.correlationId,
        options.waitMs ?? 0,
        options.pollIntervalMs,
      );
      if (request?.state === "answered" && request.answer !== undefined) {
        return {
          stdout: `${JSON.stringify(
            renderStopContinuation(options.harness, request.answer).stdout,
          )}\n`,
          exitCode: 0,
          eventId: event.eventId,
          daemonAccepted: true,
          requestState: "answered",
        };
      }
      return {
        stdout: safeStdout,
        exitCode: 0,
        eventId: event.eventId,
        daemonAccepted: true,
        ...(request === undefined ? {} : { requestState: request.state }),
      };
    }
    return {
      stdout: safeStdout,
      exitCode: 0,
      eventId: event.eventId,
      daemonAccepted: true,
    };
  } catch (error) {
    const fallbackRecorded = await recordFallback(
      fallbackPath,
      "event",
      event,
      occurredAt,
    );
    return {
      stdout: safeStdout,
      exitCode: 0,
      eventId: event.eventId,
      daemonAccepted: false,
      diagnostic: {
        code: "daemon-ingest-failed",
        message:
          error instanceof Error
            ? error.message
            : "relay daemon ingestion failed",
        fallbackRecorded,
      },
    };
  }
}
