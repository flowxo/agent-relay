import { randomUUID } from "node:crypto";

import type {
  DrainResult,
  IngestResult,
  PendingRequestRecord,
} from "@agent-relay/core";
import { makeProjectRef, makeStableEventId } from "@agent-relay/protocol";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

export interface FakeCanaryClient {
  ingest(event: AgentAttentionEventV1): Promise<IngestResult>;
  drain(limit?: number): Promise<DrainResult>;
}

export interface FakeCanaryResult {
  outcome: "delivered" | "retrying" | "dead-lettered" | "timeout";
  ingest: IngestResult;
  drain: DrainResult;
  verification: IngestResult;
}

export interface FakeCanaryOptions {
  client: FakeCanaryClient;
  event: AgentAttentionEventV1;
  waitMs?: number;
  pollIntervalMs?: number;
}

export interface TelegramCanaryClient {
  ingest(event: AgentAttentionEventV1): Promise<IngestResult>;
  drain(limit?: number): Promise<DrainResult>;
  getRequest(correlationId: string): Promise<PendingRequestRecord | undefined>;
  waitForAnswer(
    correlationId: string,
    timeoutMs: number,
    pollIntervalMs?: number,
  ): Promise<PendingRequestRecord | undefined>;
}

export type TelegramCanaryOutcome =
  | "answered"
  | "delivery-failed"
  | "request-missing"
  | "unexpected-answer"
  | "timeout"
  | "expired"
  | "cancelled"
  | "failed";

export interface TelegramCanaryResult {
  eventId: string;
  correlationId: string;
  outcome: TelegramCanaryOutcome;
  ingest: IngestResult;
  drain: DrainResult;
  resolvedBy?: PendingRequestRecord["resolvedBy"];
}

export interface TelegramCanaryOptions {
  client: TelegramCanaryClient;
  machineId: string;
  projectPath: string;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  randomId?: () => string;
}

export const TELEGRAM_CANARY_REPLY = "relay-canary-ok";

export async function runFakeCanary(
  options: FakeCanaryOptions,
): Promise<FakeCanaryResult> {
  const waitMs = options.waitMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 10_000) {
    throw new Error("Fake canary waitMs must be between 1 and 10000");
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 10 ||
    pollIntervalMs > 1_000
  ) {
    throw new Error("Fake canary pollIntervalMs must be between 10 and 1000");
  }

  const ingest = await options.client.ingest(options.event);
  const drain = await options.client.drain();
  const deadline = Date.now() + waitMs;
  let verification = await options.client.ingest(options.event);
  while (
    (verification.status === "queued" ||
      verification.status === "delivering") &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now()));
    });
    verification = await options.client.ingest(options.event);
  }

  return {
    outcome:
      verification.status === "delivered"
        ? "delivered"
        : verification.status === "retry"
          ? "retrying"
          : verification.status === "dead_letter"
            ? "dead-lettered"
            : "timeout",
    ingest,
    drain,
    verification,
  };
}

async function waitForDeliveryReceipt(
  client: TelegramCanaryClient,
  correlationId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<PendingRequestRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const request = await client.getRequest(correlationId);
    if (
      request === undefined ||
      request.transportMessageId !== undefined ||
      request.state !== "open"
    ) {
      return request;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return request;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, remaining));
    });
  } while (Date.now() <= deadline);
  return await client.getRequest(correlationId);
}

export async function runTelegramCanary(
  options: TelegramCanaryOptions,
): Promise<TelegramCanaryResult> {
  const waitMs = options.waitMs ?? 2 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30 * 60_000) {
    throw new Error("Telegram canary waitMs must be between 1 and 1800000");
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 10_000
  ) {
    throw new Error(
      "Telegram canary pollIntervalMs must be between 50 and 10000",
    );
  }

  const now = (options.now ?? (() => new Date()))();
  const identity = (options.randomId ?? randomUUID)();
  const sequence = now.getTime();
  const sessionId = `session_telegram_canary_${identity}`;
  const correlationId = `correlation_telegram_canary_${identity}`;
  const eventId = makeStableEventId({
    machineId: options.machineId,
    harness: "codex",
    sessionId,
    type: "input.required",
    sequence,
    sourceFingerprint: identity,
  });
  const instruction = `Agent Relay Telegram round-trip canary: reply to this message with ${TELEGRAM_CANARY_REPLY}.`;
  const event: AgentAttentionEventV1 = {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: now.toISOString(),
    sequence,
    machineId: options.machineId,
    bridgeSessionId: `bridge_telegram_canary_${identity}`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "activation-canary",
    sessionId,
    turnId: `turn_telegram_canary_${identity}`,
    project: makeProjectRef(options.projectPath),
    type: "input.required",
    summary: instruction,
    request: {
      correlationId,
      kind: "input",
      question: instruction,
      expiresAt: new Date(
        now.getTime() + Math.max(waitMs + 60_000, 5 * 60_000),
      ).toISOString(),
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };

  const ingest = await options.client.ingest(event);
  const drain = await options.client.drain();
  const deliveryWaitMs = Math.min(waitMs, 10_000);
  const deliveredRequest =
    drain.retrying > 0 || drain.deadLettered > 0
      ? await options.client.getRequest(correlationId)
      : await waitForDeliveryReceipt(
          options.client,
          correlationId,
          deliveryWaitMs,
          pollIntervalMs,
        );
  if (deliveredRequest === undefined) {
    return {
      eventId,
      correlationId,
      outcome: "request-missing",
      ingest,
      drain,
    };
  }
  if (deliveredRequest.transportMessageId === undefined) {
    return {
      eventId,
      correlationId,
      outcome: "delivery-failed",
      ingest,
      drain,
    };
  }
  const request = await options.client.waitForAnswer(
    correlationId,
    waitMs,
    pollIntervalMs,
  );
  if (request === undefined) {
    return {
      eventId,
      correlationId,
      outcome: "request-missing",
      ingest,
      drain,
    };
  }
  const outcome: TelegramCanaryOutcome =
    request.state === "answered" &&
    request.resolvedBy === "telegram" &&
    request.answer?.trim() !== TELEGRAM_CANARY_REPLY
      ? "unexpected-answer"
      : request.state === "open"
        ? "timeout"
        : request.state;
  return {
    eventId,
    correlationId,
    outcome,
    ingest,
    drain,
    ...(request.resolvedBy === undefined
      ? {}
      : { resolvedBy: request.resolvedBy }),
  };
}
