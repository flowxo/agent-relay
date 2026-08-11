import { randomUUID } from "node:crypto";

import type {
  DrainResult,
  IngestResult,
  PendingRequestRecord,
} from "@agent-relay/core";
import { makeProjectRef, makeStableEventId } from "@agent-relay/protocol";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

import type { RelayDaemonStatus } from "./client.js";
import type { TelegramIntakeRuntimeStatus } from "./transport-status.js";

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

export interface InteractiveCanaryClient {
  ingest(event: AgentAttentionEventV1): Promise<IngestResult>;
  drain(limit?: number): Promise<DrainResult>;
  activateTelegramCanary?(event: AgentAttentionEventV1): Promise<{
    ingest: IngestResult;
    drain: DrainResult;
  }>;
  getRequest(correlationId: string): Promise<PendingRequestRecord | undefined>;
  waitForAnswer(
    correlationId: string,
    timeoutMs: number,
    pollIntervalMs?: number,
  ): Promise<PendingRequestRecord | undefined>;
  status(): Promise<
    Pick<RelayDaemonStatus, "events" | "eventActivity" | "pendingDeliveryCount">
  >;
}

export type InteractiveCanaryOutcome =
  | "answered"
  | "attribution-conflict"
  | "delivery-failed"
  | "request-missing"
  | "unexpected-answer"
  | "timeout"
  | "expired"
  | "cancelled"
  | "failed";

export interface InteractiveCanaryResult {
  eventId: string;
  correlationId: string;
  outcome: InteractiveCanaryOutcome;
  ingest: IngestResult;
  drain: DrainResult;
  resolvedBy?: PendingRequestRecord["resolvedBy"];
  diagnosticCode?: "canary-attribution-conflict";
  attribution?: {
    outcome: "exclusive" | "conflict";
    eventDelta: number;
    insertedDelta: number;
    deletedDelta: number;
    deliveredDelta: number;
    pendingDeliveryDelta: number;
  };
}

export interface InteractiveCanaryOptions {
  client: InteractiveCanaryClient;
  machineId: string;
  projectPath: string;
  expectedResolvedBy: "telegram" | "whooshbang";
  transportLabel: "Telegram" | "WhooshBang";
  waitMs?: number;
  requestTtlMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  randomId?: () => string;
}

export const TELEGRAM_CANARY_REPLY = "relay-canary-ok";
export const WHOOSHBANG_CANARY_REPLY = TELEGRAM_CANARY_REPLY;
export const INTERACTIVE_CANARY_DEFAULT_WAIT_MS = 2 * 60_000;
export const INTERACTIVE_CANARY_DEFAULT_REQUEST_TTL_MS = 5 * 60_000;
export const INTERACTIVE_CANARY_MIN_TTL_MARGIN_MS = 60_000;

type CanaryAggregateStatus = Pick<
  RelayDaemonStatus,
  "events" | "eventActivity" | "pendingDeliveryCount"
>;

function canaryAttribution(
  before: CanaryAggregateStatus,
  after: CanaryAggregateStatus,
): NonNullable<InteractiveCanaryResult["attribution"]> {
  const eventDelta =
    Object.values(after.events).reduce((sum, count) => sum + count, 0) -
    Object.values(before.events).reduce((sum, count) => sum + count, 0);
  const deliveredDelta = after.events.delivered - before.events.delivered;
  const insertedDelta =
    after.eventActivity.inserted - before.eventActivity.inserted;
  const deletedDelta =
    after.eventActivity.deleted - before.eventActivity.deleted;
  const pendingDeliveryDelta =
    after.pendingDeliveryCount - before.pendingDeliveryCount;
  const otherDeliveryStatesUnchanged = (
    ["queued", "retry", "delivering", "dead_letter"] as const
  ).every((state) => after.events[state] === before.events[state]);
  const outcome =
    eventDelta === 1 &&
    insertedDelta === 1 &&
    deletedDelta === 0 &&
    deliveredDelta === 1 &&
    pendingDeliveryDelta === 0 &&
    otherDeliveryStatesUnchanged
      ? "exclusive"
      : "conflict";
  return {
    outcome,
    eventDelta,
    insertedDelta,
    deletedDelta,
    deliveredDelta,
    pendingDeliveryDelta,
  };
}

export interface TelegramCanaryDaemonStatus {
  selectedTransport?: RelayDaemonStatus["selectedTransport"];
  transportRuntime?: {
    telegram?: {
      intake?: TelegramIntakeRuntimeStatus;
    };
  };
}

export interface TelegramCanaryReadinessClient {
  status(): Promise<TelegramCanaryDaemonStatus>;
}

export function assertTelegramCanaryReady(
  status: TelegramCanaryDaemonStatus,
): void {
  if (status.selectedTransport !== "telegram") {
    throw Object.assign(
      new Error(
        "telegram-canary requires a daemon using the real Telegram transport",
      ),
      { code: "telegram-transport-not-selected" },
    );
  }
  const intake = status.transportRuntime?.telegram?.intake;
  const validOwnership =
    (intake?.mode === "poll" && intake.localOwnership === "held") ||
    (intake?.mode === "webhook" && intake.localOwnership === "not-applicable");
  if (
    intake?.state !== "active" ||
    intake.replyReady !== true ||
    !validOwnership
  ) {
    throw Object.assign(
      new Error("telegram-canary requires active Telegram reply intake"),
      { code: "telegram-intake-not-ready" },
    );
  }
}

export async function waitForTelegramCanaryReady(options: {
  client: TelegramCanaryReadinessClient;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<TelegramCanaryDaemonStatus> {
  const waitMs = options.waitMs ?? 35_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (delayMs: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    });
  const deadline = now() + waitMs;

  while (true) {
    const status = await options.client.status();
    try {
      assertTelegramCanaryReady(status);
      return status;
    } catch (error) {
      const intake = status.transportRuntime?.telegram?.intake;
      const mayBecomeReady =
        status.selectedTransport === "telegram" &&
        intake?.mode === "poll" &&
        (intake.state === "not-started" ||
          intake.state === "starting" ||
          intake.state === "error");
      const remaining = deadline - now();
      if (!mayBecomeReady || remaining <= 0) {
        throw error;
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }
}

export function isWhooshBangCanaryAcknowledged(
  priorCursorRef: string | null,
  polling:
    | {
        committedCursorRef: string | null;
        unacknowledgedEventCount: number;
      }
    | undefined,
): boolean {
  return (
    polling?.committedCursorRef !== null &&
    polling?.committedCursorRef !== undefined &&
    polling.committedCursorRef !== priorCursorRef &&
    polling.unacknowledgedEventCount === 0
  );
}

export type TelegramCanaryClient = InteractiveCanaryClient;
export type TelegramCanaryOutcome = InteractiveCanaryOutcome;
export type TelegramCanaryResult = InteractiveCanaryResult;
export type TelegramCanaryOptions = Omit<
  InteractiveCanaryOptions,
  "expectedResolvedBy" | "transportLabel"
>;

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
  client: InteractiveCanaryClient,
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

export async function runInteractiveCanary(
  options: InteractiveCanaryOptions,
): Promise<InteractiveCanaryResult> {
  const waitMs = options.waitMs ?? INTERACTIVE_CANARY_DEFAULT_WAIT_MS;
  const requestTtlMs =
    options.requestTtlMs ?? INTERACTIVE_CANARY_DEFAULT_REQUEST_TTL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30 * 60_000) {
    throw new Error("Interactive canary waitMs must be between 1 and 1800000");
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 10_000
  ) {
    throw new Error(
      "Interactive canary pollIntervalMs must be between 50 and 10000",
    );
  }
  if (
    !Number.isSafeInteger(requestTtlMs) ||
    requestTtlMs < 1 ||
    requestTtlMs > 60 * 60_000
  ) {
    throw Object.assign(
      new Error(
        "Interactive canary requestTtlMs must be between 1 and 3600000",
      ),
      { code: "canary-request-ttl-invalid" },
    );
  }
  if (requestTtlMs < waitMs + INTERACTIVE_CANARY_MIN_TTL_MARGIN_MS) {
    throw Object.assign(
      new Error(
        "Interactive canary requestTtlMs must outlive waitMs by at least 60000",
      ),
      { code: "canary-request-ttl-too-short" },
    );
  }

  const initialStatus = await options.client.status();
  const now = (options.now ?? (() => new Date()))();
  const identity = (options.randomId ?? randomUUID)();
  const sequence = now.getTime();
  const sessionId = `session_${options.expectedResolvedBy}_canary_${identity}`;
  const correlationId = `correlation_${options.expectedResolvedBy}_canary_${identity}`;
  const eventId = makeStableEventId({
    machineId: options.machineId,
    harness: "codex",
    sessionId,
    type: "input.required",
    sequence,
    sourceFingerprint: identity,
  });
  const instruction = `Agent Relay ${options.transportLabel} round-trip canary: reply to this message with ${TELEGRAM_CANARY_REPLY}.`;
  const event: AgentAttentionEventV1 = {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: now.toISOString(),
    sequence,
    machineId: options.machineId,
    bridgeSessionId: `bridge_${options.expectedResolvedBy}_canary_${identity}`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "activation-canary",
    sessionId,
    turnId: `turn_${options.expectedResolvedBy}_canary_${identity}`,
    project: makeProjectRef(options.projectPath),
    type: "input.required",
    summary: instruction,
    request: {
      correlationId,
      kind: "input",
      question: instruction,
      expiresAt: new Date(now.getTime() + requestTtlMs).toISOString(),
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };

  const activation =
    options.expectedResolvedBy === "telegram" &&
    options.client.activateTelegramCanary !== undefined
      ? await options.client.activateTelegramCanary(event)
      : {
          ingest: await options.client.ingest(event),
          drain: await options.client.drain(),
        };
  const { ingest, drain } = activation;
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
  let outcome: InteractiveCanaryOutcome =
    request.state === "answered" &&
    (request.resolvedBy !== options.expectedResolvedBy ||
      request.answer?.trim() !== TELEGRAM_CANARY_REPLY)
      ? "unexpected-answer"
      : request.state === "open"
        ? "timeout"
        : request.state;
  const attribution =
    outcome === "answered"
      ? canaryAttribution(initialStatus, await options.client.status())
      : undefined;
  if (attribution?.outcome === "conflict") {
    outcome = "attribution-conflict";
  }
  return {
    eventId,
    correlationId,
    outcome,
    ingest,
    drain,
    ...(attribution === undefined ? {} : { attribution }),
    ...(attribution?.outcome === "conflict"
      ? { diagnosticCode: "canary-attribution-conflict" as const }
      : {}),
    ...(request.resolvedBy === undefined
      ? {}
      : { resolvedBy: request.resolvedBy }),
  };
}

export async function runTelegramCanary(
  options: TelegramCanaryOptions,
): Promise<TelegramCanaryResult> {
  return await runInteractiveCanary({
    ...options,
    expectedResolvedBy: "telegram",
    transportLabel: "Telegram",
  });
}

export async function runWhooshBangCanary(
  options: TelegramCanaryOptions,
): Promise<InteractiveCanaryResult> {
  return await runInteractiveCanary({
    ...options,
    expectedResolvedBy: "whooshbang",
    transportLabel: "WhooshBang",
  });
}
