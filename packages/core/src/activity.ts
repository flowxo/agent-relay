import { z } from "zod";

import type {
  AgentAttentionEventV1,
  Harness,
  Surface,
} from "@agent-relay/protocol";

export const SESSION_ACTIVITY_SCHEMA =
  "agent-relay-session-activity.v1" as const;
export const SESSION_ACTIVITY_POLICY_VERSION = "ar5.1.v1" as const;
export const SESSION_ACTIVITY_FIXTURE_SET_VERSION = "ar5.1-2026-08-13" as const;

export const SessionActivityStateSchema = z.enum([
  "working",
  "needs_input",
  "background_work",
  "idle",
  "done",
  "failed",
  "unknown",
  "ended",
]);

export const SessionActivityConfidenceSchema = z.enum([
  "confirmed",
  "inferred",
]);

export const SessionActivityReasonSchema = z.enum([
  "session_observed",
  "foreground_recent",
  "work_open",
  "request_open",
  "foreground_stopped",
  "background_work_open",
  "idle_grace_elapsed",
  "terminal_missing",
  "foreground_work_stale",
  "background_work_stale",
  "evidence_gap",
  "turn_failed",
  "owned_process_failed",
  "session_ended",
]);

export const SessionActivitySourceSchema = z.enum([
  "codex_cli",
  "claude_cli",
  "cursor_cli",
  "codex_app_server",
  "relay_interaction",
  "owned_process",
  "operator",
  "recovery",
]);

export const SessionActivityInputKindSchema = z.enum([
  "session_observed",
  "prompt_submitted",
  "activity_observed",
  "work_started",
  "work_finished",
  "work_failed",
  "background_snapshot",
  "request_opened",
  "request_resolved",
  "foreground_stopped",
  "turn_failed",
  "session_ended",
  "owned_process_failed",
  "evidence_gap",
]);

export type SessionActivityState = z.infer<typeof SessionActivityStateSchema>;
export type SessionActivityConfidence = z.infer<
  typeof SessionActivityConfidenceSchema
>;
export type SessionActivityReason = z.infer<typeof SessionActivityReasonSchema>;
export type SessionActivitySource = z.infer<typeof SessionActivitySourceSchema>;
export type SessionActivityInputKind = z.infer<
  typeof SessionActivityInputKindSchema
>;

export interface SessionActivityPolicy {
  idleToDoneMs: number;
  workingWithoutTerminalToUnknownMs: number;
  openForegroundWorkToUnknownMs: number;
  backgroundWorkToUnknownMs: number;
}

export const DEFAULT_SESSION_ACTIVITY_POLICY: Readonly<SessionActivityPolicy> =
  Object.freeze({
    idleToDoneMs: 90_000,
    workingWithoutTerminalToUnknownMs: 5 * 60_000,
    openForegroundWorkToUnknownMs: 2 * 60 * 60_000,
    backgroundWorkToUnknownMs: 24 * 60 * 60_000,
  });

const POLICY_BOUNDS = Object.freeze({
  idleToDoneMs: [30_000, 10 * 60_000],
  workingWithoutTerminalToUnknownMs: [60_000, 30 * 60_000],
  openForegroundWorkToUnknownMs: [5 * 60_000, 24 * 60 * 60_000],
  backgroundWorkToUnknownMs: [30 * 60_000, 7 * 24 * 60 * 60_000],
} satisfies Record<keyof SessionActivityPolicy, readonly [number, number]>);

export function validateSessionActivityPolicy(
  policy: SessionActivityPolicy,
): SessionActivityPolicy {
  for (const key of Object.keys(POLICY_BOUNDS) as Array<
    keyof SessionActivityPolicy
  >) {
    const value = policy[key];
    const [minimum, maximum] = POLICY_BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${key} must be a safe integer between ${String(minimum)} and ${String(maximum)}`,
      );
    }
  }
  return { ...policy };
}

const REASON_TEXT: Readonly<Record<SessionActivityReason, string>> =
  Object.freeze({
    session_observed: "Session observed; no turn is running.",
    foreground_recent: "Recent foreground activity was observed.",
    work_open: "Correlated work is in progress.",
    request_open: "Waiting for your response.",
    foreground_stopped:
      "Foreground work stopped; the session remains available.",
    background_work_open: "Background work is still in progress.",
    idle_grace_elapsed:
      "No further work was observed after the completed turn.",
    terminal_missing: "Completion evidence did not arrive.",
    foreground_work_stale:
      "Tracked foreground work has not reported activity recently.",
    background_work_stale:
      "Tracked background work has not reported activity recently.",
    evidence_gap: "Recent activity evidence is incomplete or contradictory.",
    turn_failed: "The turn failed.",
    owned_process_failed: "The supervised agent process exited unexpectedly.",
    session_ended: "The session ended.",
  });

export const SESSION_ACTIVITY_STATE_LABELS: Readonly<
  Record<SessionActivityState, string>
> = Object.freeze({
  working: "Working",
  needs_input: "Needs input",
  background_work: "Background work",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
  ended: "Ended",
});

export function sessionActivityReasonText(
  reason: SessionActivityReason,
): string {
  return REASON_TEXT[reason];
}

export interface SessionActivityRecord {
  schema: typeof SESSION_ACTIVITY_SCHEMA;
  policyVersion: typeof SESSION_ACTIVITY_POLICY_VERSION;
  fixtureSetVersion: typeof SESSION_ACTIVITY_FIXTURE_SET_VERSION;
  state: SessionActivityState;
  stateLabel: string;
  confidence: SessionActivityConfidence;
  reason: SessionActivityReason;
  reasonText: string;
  source: SessionActivitySource;
  lastObservedAt: string;
  idleSince?: string;
  inFlightCount: number;
  requestCount: number;
  muted: boolean;
  epoch: number;
  lastAppliedSequence: number;
}

export const SessionActivityInputSchema = z
  .object({
    kind: SessionActivityInputKindSchema,
    observedAt: z.string().datetime({ offset: true }),
    source: SessionActivitySourceSchema,
    correlationKey: z.string().min(1).max(512).optional(),
    inFlightCount: z.number().int().min(0).max(1_000).optional(),
    scheduledCount: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();

export type SessionActivityInput = z.infer<typeof SessionActivityInputSchema>;

export interface SessionActivityEvidence {
  ended: boolean;
  gap: boolean;
  foreground: "not_started" | "working" | "stopped";
  lastObservedAt: string | null;
  idleSince: string | null;
  failure: "turn_failed" | "owned_process_failed" | null;
  lastSource: SessionActivitySource;
  backgroundSnapshotCount: number;
  openWork: Set<string>;
  openRequests: Set<string>;
  terminalWork: Map<string, "finished" | "failed">;
  unmatchedTerminalWork: Set<string>;
  resolvedRequests: Set<string>;
  unmatchedResolvedRequests: Set<string>;
  epoch: number;
  lastAppliedSequence: number;
}

export function initialSessionActivityEvidence(
  source: SessionActivitySource = "recovery",
): SessionActivityEvidence {
  return {
    ended: false,
    gap: false,
    foreground: "not_started",
    lastObservedAt: null,
    idleSince: null,
    failure: null,
    lastSource: source,
    backgroundSnapshotCount: 0,
    openWork: new Set(),
    openRequests: new Set(),
    terminalWork: new Map(),
    unmatchedTerminalWork: new Set(),
    resolvedRequests: new Set(),
    unmatchedResolvedRequests: new Set(),
    epoch: 0,
    lastAppliedSequence: 0,
  };
}

function requireCorrelation(input: SessionActivityInput): string {
  if (input.correlationKey === undefined) {
    throw new Error(`${input.kind} requires an exact correlation key`);
  }
  return input.correlationKey;
}

function boundedCount(value: number | undefined, name: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000) {
    throw new Error(`${name} must be an integer between 0 and 1000`);
  }
  return count;
}

function markObserved(
  evidence: SessionActivityEvidence,
  input: SessionActivityInput,
): void {
  evidence.lastObservedAt = input.observedAt;
  evidence.lastSource = input.source;
}

/**
 * The sole state-transition reducer. It mutates only the supplied in-memory
 * evidence value and performs no clock, persistence, logging, or I/O work.
 */
export function reduceSessionActivity(
  evidence: SessionActivityEvidence,
  input: SessionActivityInput,
  receiveSequence = evidence.lastAppliedSequence + 1,
): SessionActivityEvidence {
  if (!Number.isSafeInteger(receiveSequence) || receiveSequence < 1) {
    throw new Error(
      "activity receive sequence must be a positive safe integer",
    );
  }
  if (receiveSequence <= evidence.lastAppliedSequence) {
    return evidence;
  }
  if (evidence.ended) {
    evidence.lastAppliedSequence = receiveSequence;
    return evidence;
  }

  switch (input.kind) {
    case "session_observed":
      markObserved(evidence, input);
      break;
    case "prompt_submitted":
      evidence.epoch += 1;
      evidence.gap = false;
      evidence.failure = null;
      evidence.foreground = "working";
      evidence.idleSince = null;
      evidence.backgroundSnapshotCount = 0;
      evidence.openWork.clear();
      evidence.terminalWork.clear();
      evidence.unmatchedTerminalWork.clear();
      evidence.resolvedRequests.clear();
      evidence.unmatchedResolvedRequests.clear();
      markObserved(evidence, input);
      break;
    case "activity_observed":
      if (evidence.foreground === "working") {
        markObserved(evidence, input);
      }
      break;
    case "work_started": {
      const correlation = requireCorrelation(input);
      if (evidence.terminalWork.has(correlation)) {
        if (evidence.unmatchedTerminalWork.delete(correlation)) {
          markObserved(evidence, input);
        }
        break;
      }
      if (!evidence.openWork.has(correlation)) {
        evidence.openWork.add(correlation);
        evidence.foreground = "working";
        evidence.idleSince = null;
        markObserved(evidence, input);
      }
      break;
    }
    case "work_finished":
    case "work_failed": {
      const correlation = requireCorrelation(input);
      const outcome = input.kind === "work_finished" ? "finished" : "failed";
      const priorOutcome = evidence.terminalWork.get(correlation);
      if (priorOutcome === outcome) {
        break;
      }
      if (priorOutcome !== undefined && priorOutcome !== outcome) {
        evidence.gap = true;
        markObserved(evidence, input);
        break;
      }
      evidence.terminalWork.set(correlation, outcome);
      if (!evidence.openWork.delete(correlation)) {
        evidence.unmatchedTerminalWork.add(correlation);
      }
      markObserved(evidence, input);
      if (
        evidence.foreground === "stopped" &&
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
      ) {
        evidence.idleSince = input.observedAt;
      }
      break;
    }
    case "background_snapshot":
      evidence.backgroundSnapshotCount =
        boundedCount(input.inFlightCount, "background in-flight count") +
        boundedCount(input.scheduledCount, "background scheduled count");
      if (evidence.backgroundSnapshotCount > 1_000) {
        throw new Error("combined background count must not exceed 1000");
      }
      markObserved(evidence, input);
      break;
    case "request_opened": {
      const correlation = requireCorrelation(input);
      if (evidence.resolvedRequests.has(correlation)) {
        if (evidence.unmatchedResolvedRequests.delete(correlation)) {
          markObserved(evidence, input);
        }
        break;
      }
      if (!evidence.openRequests.has(correlation)) {
        evidence.openRequests.add(correlation);
        evidence.idleSince = null;
        markObserved(evidence, input);
      }
      break;
    }
    case "request_resolved": {
      const correlation = requireCorrelation(input);
      if (!evidence.openRequests.has(correlation)) {
        if (!evidence.resolvedRequests.has(correlation)) {
          evidence.resolvedRequests.add(correlation);
          evidence.unmatchedResolvedRequests.add(correlation);
          markObserved(evidence, input);
        }
        break;
      }
      evidence.openRequests.delete(correlation);
      evidence.resolvedRequests.add(correlation);
      markObserved(evidence, input);
      if (
        evidence.foreground === "stopped" &&
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
      ) {
        evidence.idleSince = input.observedAt;
      }
      break;
    }
    case "foreground_stopped":
      evidence.foreground = "stopped";
      markObserved(evidence, input);
      evidence.idleSince =
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
          ? input.observedAt
          : null;
      break;
    case "turn_failed":
    case "owned_process_failed":
      evidence.failure = input.kind;
      evidence.foreground = "stopped";
      evidence.openWork.clear();
      evidence.openRequests.clear();
      evidence.backgroundSnapshotCount = 0;
      evidence.idleSince = null;
      markObserved(evidence, input);
      break;
    case "evidence_gap":
      evidence.gap = true;
      markObserved(evidence, input);
      break;
    case "session_ended":
      evidence.ended = true;
      evidence.foreground = "stopped";
      evidence.openWork.clear();
      evidence.openRequests.clear();
      evidence.backgroundSnapshotCount = 0;
      evidence.idleSince = null;
      markObserved(evidence, input);
      break;
  }
  evidence.lastAppliedSequence = receiveSequence;
  return evidence;
}

function elapsed(now: string, then: string | null): number {
  if (then === null) {
    return 0;
  }
  return Math.max(0, Date.parse(now) - Date.parse(then));
}

export function projectSessionActivity(
  evidence: SessionActivityEvidence,
  now: string,
  muted: boolean,
  policyInput: SessionActivityPolicy = DEFAULT_SESSION_ACTIVITY_POLICY,
): SessionActivityRecord {
  const policy = validateSessionActivityPolicy(policyInput);
  if (evidence.lastObservedAt === null) {
    throw new Error("session activity cannot project without an observation");
  }
  const metadata = {
    schema: SESSION_ACTIVITY_SCHEMA,
    policyVersion: SESSION_ACTIVITY_POLICY_VERSION,
    fixtureSetVersion: SESSION_ACTIVITY_FIXTURE_SET_VERSION,
    source: evidence.lastSource,
    lastObservedAt: evidence.lastObservedAt,
    ...(evidence.idleSince === null ? {} : { idleSince: evidence.idleSince }),
    inFlightCount: evidence.openWork.size + evidence.backgroundSnapshotCount,
    requestCount: evidence.openRequests.size,
    muted,
    epoch: evidence.epoch,
    lastAppliedSequence: evidence.lastAppliedSequence,
  } as const;

  let state: SessionActivityState;
  let confidence: SessionActivityConfidence;
  let reason: SessionActivityReason;
  if (evidence.ended) {
    state = "ended";
    confidence = "confirmed";
    reason = "session_ended";
  } else if (evidence.openRequests.size > 0) {
    state = "needs_input";
    confidence = "confirmed";
    reason = "request_open";
  } else if (evidence.failure !== null) {
    state = "failed";
    confidence = "confirmed";
    reason = evidence.failure;
  } else if (
    evidence.gap ||
    evidence.unmatchedTerminalWork.size > 0 ||
    evidence.unmatchedResolvedRequests.size > 0
  ) {
    state = "unknown";
    confidence = "confirmed";
    reason = "evidence_gap";
  } else if (evidence.foreground === "stopped") {
    if (metadata.inFlightCount > 0) {
      if (
        elapsed(now, evidence.lastObservedAt) >=
        policy.backgroundWorkToUnknownMs
      ) {
        state = "unknown";
        confidence = "inferred";
        reason = "background_work_stale";
      } else {
        state = "background_work";
        confidence = "confirmed";
        reason = "background_work_open";
      }
    } else if (evidence.idleSince === null) {
      state = "unknown";
      confidence = "confirmed";
      reason = "evidence_gap";
    } else if (elapsed(now, evidence.idleSince) >= policy.idleToDoneMs) {
      state = "done";
      confidence = "inferred";
      reason = "idle_grace_elapsed";
    } else {
      state = "idle";
      confidence = "confirmed";
      reason = "foreground_stopped";
    }
  } else if (evidence.foreground === "working") {
    const workIsOpen = evidence.openWork.size > 0;
    const threshold = workIsOpen
      ? policy.openForegroundWorkToUnknownMs
      : policy.workingWithoutTerminalToUnknownMs;
    if (elapsed(now, evidence.lastObservedAt) >= threshold) {
      state = "unknown";
      confidence = "inferred";
      reason = workIsOpen ? "foreground_work_stale" : "terminal_missing";
    } else {
      state = "working";
      confidence = "confirmed";
      reason = workIsOpen ? "work_open" : "foreground_recent";
    }
  } else {
    state = "idle";
    confidence = "confirmed";
    reason = "session_observed";
  }

  return {
    ...metadata,
    state,
    stateLabel: SESSION_ACTIVITY_STATE_LABELS[state],
    confidence,
    reason,
    reasonText: sessionActivityReasonText(reason),
  };
}

function sourceForHarness(
  harness: Harness,
  surface: Surface,
): SessionActivitySource {
  if (surface === "app-server") {
    return "codex_app_server";
  }
  return `${harness}_cli` as SessionActivitySource;
}

function selectedCliLifecycleEvent(event: AgentAttentionEventV1): boolean {
  if (event.surface !== "cli") return false;
  if (event.type === "process.exited" || event.type === "process.stale") {
    return true;
  }
  switch (event.harness) {
    case "codex":
      return ["session.started", "turn.started", "turn.stopped"].includes(
        event.type,
      );
    case "claude":
      return (
        [
          "session.started",
          "turn.started",
          "turn.stopped",
          "turn.failed",
        ].includes(event.type) ||
        (event.type === "turn.activity" && event.backgroundWork !== undefined)
      );
    case "cursor":
      return ["turn.stopped", "turn.failed", "process.stale"].includes(
        event.type,
      );
  }
}

/**
 * Maps the already-sanitized attention contract into the frozen AR5.1 input
 * vocabulary. Deferred native hooks never reach this mapping as selected work
 * evidence; request-bearing attention records use Relay's durable request.
 */
export function sessionActivityInputsForAttentionEvent(
  event: AgentAttentionEventV1,
): SessionActivityInput[] {
  const source = sourceForHarness(event.harness, event.surface);
  const base = {
    observedAt: event.occurredAt,
    source,
  } as const;
  const selectedRequest = !(
    (event.type === "permission.required" && event.surface === "cli") ||
    (event.type === "input.required" &&
      event.harness === "claude" &&
      event.surface === "cli")
  );
  const requestInput =
    event.request === undefined || !selectedRequest
      ? []
      : [
          {
            ...base,
            kind: "request_opened" as const,
            source: "relay_interaction" as const,
            correlationKey: event.request.correlationId,
          },
        ];
  const selectedLifecycle =
    selectedCliLifecycleEvent(event) ||
    (event.surface === "app-server" && event.harness === "codex");
  if (!selectedLifecycle) {
    return requestInput;
  }
  switch (event.type) {
    case "session.started":
      return [{ ...base, kind: "session_observed" }, ...requestInput];
    case "turn.started":
      return [
        {
          ...base,
          kind: "prompt_submitted",
          ...(event.turnId === undefined
            ? {}
            : { correlationKey: event.turnId }),
        },
        ...requestInput,
      ];
    case "turn.activity":
      if (event.backgroundWork !== undefined) {
        return [
          {
            ...base,
            kind: "background_snapshot",
            ...event.backgroundWork,
            ...(event.turnId === undefined
              ? {}
              : { correlationKey: event.turnId }),
          },
          {
            ...base,
            kind: "foreground_stopped",
            ...(event.turnId === undefined
              ? {}
              : { correlationKey: event.turnId }),
          },
          ...requestInput,
        ];
      }
      return [
        {
          ...base,
          kind: "activity_observed",
          ...(event.turnId === undefined
            ? {}
            : { correlationKey: event.turnId }),
        },
        ...requestInput,
      ];
    case "turn.stopped":
      return [
        {
          ...base,
          kind: "foreground_stopped",
          ...(event.turnId === undefined
            ? {}
            : { correlationKey: event.turnId }),
        },
        ...requestInput,
      ];
    case "turn.failed":
      return [
        {
          ...base,
          kind: "turn_failed",
          ...(event.turnId === undefined
            ? {}
            : { correlationKey: event.turnId }),
        },
        ...requestInput,
      ];
    case "input.required":
    case "permission.required":
      return requestInput;
    case "process.exited":
      return event.processExit?.expected === false
        ? [
            {
              ...base,
              kind: "owned_process_failed",
              source: "owned_process",
              correlationKey: event.processExit.supervisorId,
            },
            ...requestInput,
          ]
        : requestInput;
    case "process.stale":
      return [{ ...base, kind: "evidence_gap" }, ...requestInput];
    case "session.ended":
      return [{ ...base, kind: "session_ended" }, ...requestInput];
  }
}

export interface StructuredActivityObservation {
  kind:
    | "session.started"
    | "session.resumed"
    | "turn.started"
    | "turn.completed"
    | "item.started"
    | "item.completed"
    | "approval.requested"
    | "attention.required"
    | "native.error"
    | "process.exited";
  observedAt: string;
  nativeTurnReference?: string;
  nativeItemReference?: string;
  nativeApprovalReference?: string;
  status?: string;
}

/** Maps the frozen Codex app-server observation subset without retaining IDs. */
export function sessionActivityInputsForStructuredObservation(
  observation: StructuredActivityObservation,
): SessionActivityInput[] {
  const base = {
    observedAt: observation.observedAt,
    source: "codex_app_server" as const,
  };
  switch (observation.kind) {
    case "session.started":
    case "session.resumed":
      return [{ ...base, kind: "session_observed" }];
    case "turn.started":
      return [
        {
          ...base,
          kind: "prompt_submitted",
          ...(observation.nativeTurnReference === undefined
            ? {}
            : { correlationKey: observation.nativeTurnReference }),
        },
      ];
    case "turn.completed":
      if (observation.status === "failed") {
        return [
          {
            ...base,
            kind: "turn_failed",
            ...(observation.nativeTurnReference === undefined
              ? {}
              : { correlationKey: observation.nativeTurnReference }),
          },
        ];
      }
      if (observation.status === "completed") {
        return [
          {
            ...base,
            kind: "foreground_stopped",
            ...(observation.nativeTurnReference === undefined
              ? {}
              : { correlationKey: observation.nativeTurnReference }),
          },
        ];
      }
      return [
        {
          ...base,
          kind: "evidence_gap",
          ...(observation.nativeTurnReference === undefined
            ? {}
            : { correlationKey: observation.nativeTurnReference }),
        },
      ];
    case "item.started":
      return observation.nativeItemReference === undefined
        ? [{ ...base, kind: "evidence_gap" }]
        : [
            {
              ...base,
              kind: "work_started",
              correlationKey: observation.nativeItemReference,
            },
          ];
    case "item.completed":
      return observation.nativeItemReference === undefined
        ? [{ ...base, kind: "evidence_gap" }]
        : [
            {
              ...base,
              kind:
                observation.status === "failed"
                  ? "work_failed"
                  : "work_finished",
              correlationKey: observation.nativeItemReference,
            },
          ];
    case "approval.requested":
      return observation.nativeApprovalReference === undefined
        ? [{ ...base, kind: "evidence_gap" }]
        : [
            {
              ...base,
              kind: "request_opened",
              source: "relay_interaction",
              correlationKey: observation.nativeApprovalReference,
            },
          ];
    case "native.error":
      return [
        {
          ...base,
          kind:
            observation.status === "retrying"
              ? "activity_observed"
              : "turn_failed",
          ...(observation.nativeTurnReference === undefined
            ? {}
            : { correlationKey: observation.nativeTurnReference }),
        },
      ];
    case "process.exited":
      if (observation.status === "intentional") {
        return [];
      }
      return observation.status === "unexpected"
        ? [
            {
              ...base,
              kind: "owned_process_failed",
              source: "owned_process",
            },
          ]
        : [{ ...base, kind: "evidence_gap" }];
    case "attention.required":
      return [];
  }
}
