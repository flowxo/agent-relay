import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ProcessExitEvidenceSchema } from "@agent-relay/protocol";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const correlatedEvent = z
  .object({
    atMs: z.number().int().nonnegative(),
    kind: z.enum([
      "work_started",
      "work_finished",
      "work_failed",
      "request_opened",
      "request_resolved",
    ]),
    correlationId: z.string().min(8).max(128),
  })
  .strict();

const uncorrelatedEvent = z
  .object({
    atMs: z.number().int().nonnegative(),
    kind: z.enum([
      "session_observed",
      "prompt_submitted",
      "turn_failed",
      "owned_process_failed",
      "evidence_gap",
      "session_ended",
      "restart",
    ]),
  })
  .strict();

const foregroundStoppedEvent = z
  .object({
    atMs: z.number().int().nonnegative(),
    kind: z.literal("foreground_stopped"),
    inFlightCount: z.number().int().nonnegative().max(1_000).optional(),
    scheduledCount: z.number().int().nonnegative().max(1_000).optional(),
  })
  .strict();

const OwnedProcessEvidenceSchema = z
  .object({
    schema: z.literal("agent-relay-owned-process-evidence.v1"),
    evidence: ProcessExitEvidenceSchema,
  })
  .strict();

const state = z.enum([
  "working",
  "needs_input",
  "background_work",
  "idle",
  "done",
  "failed",
  "unknown",
  "ended",
]);

const confidence = z.enum(["confirmed", "inferred"]);

const reason = z.enum([
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

const TimingTrialsSchema = z
  .object({
    schema: z.literal("agent-relay-activity-policy-trials.v1"),
    policy: z
      .object({
        idleToDoneMs: z.number().int().positive(),
        workingWithoutTerminalToUnknownMs: z.number().int().positive(),
        openForegroundWorkToUnknownMs: z.number().int().positive(),
        backgroundWorkToUnknownMs: z.number().int().positive(),
      })
      .strict(),
    decisions: z
      .array(
        z
          .object({
            state,
            confidence,
            reason,
            userFacingReason: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(8),
    trials: z
      .array(
        z
          .object({
            name: z.string().min(1).max(160),
            events: z.array(
              z.union([
                correlatedEvent,
                foregroundStoppedEvent,
                uncorrelatedEvent,
              ]),
            ),
            checkpoints: z.array(
              z
                .object({
                  atMs: z.number().int().nonnegative(),
                  state,
                  confidence: confidence.optional(),
                  reason: reason.optional(),
                  lastActivityAtMs: z.number().int().nonnegative().optional(),
                  inFlightCount: z.number().int().nonnegative().optional(),
                  requestCount: z.number().int().nonnegative().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

type TrialEvent =
  | z.infer<typeof correlatedEvent>
  | z.infer<typeof foregroundStoppedEvent>
  | z.infer<typeof uncorrelatedEvent>;
type Policy = z.infer<typeof TimingTrialsSchema>["policy"];
type ActivityState = z.infer<typeof state>;
type ActivityConfidence = z.infer<typeof confidence>;
type ActivityReason = z.infer<typeof reason>;

interface ActivityProjection {
  state: ActivityState;
  confidence: ActivityConfidence;
  reason: ActivityReason;
  lastActivityAtMs: number | null;
  inFlightCount: number;
  requestCount: number;
}

interface EvidenceState {
  ended: boolean;
  gap: boolean;
  foreground: "not_started" | "working" | "stopped";
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  failure: "turn_failed" | "owned_process_failed" | null;
  backgroundSnapshotCount: number;
  openWork: Set<string>;
  openRequests: Set<string>;
  terminalWork: Map<string, "finished" | "failed">;
  unmatchedTerminalWork: Set<string>;
  resolvedRequests: Set<string>;
  unmatchedResolvedRequests: Set<string>;
}

function initialEvidence(): EvidenceState {
  return {
    ended: false,
    gap: false,
    foreground: "not_started",
    lastActivityAtMs: null,
    idleSinceMs: null,
    failure: null,
    backgroundSnapshotCount: 0,
    openWork: new Set(),
    openRequests: new Set(),
    terminalWork: new Map(),
    unmatchedTerminalWork: new Set(),
    resolvedRequests: new Set(),
    unmatchedResolvedRequests: new Set(),
  };
}

function applyEvent(evidence: EvidenceState, event: TrialEvent): void {
  if (evidence.ended) {
    return;
  }

  switch (event.kind) {
    case "session_observed":
      evidence.lastActivityAtMs = event.atMs;
      return;
    case "prompt_submitted":
      evidence.gap = false;
      evidence.unmatchedTerminalWork.clear();
      evidence.unmatchedResolvedRequests.clear();
      evidence.foreground = "working";
      evidence.lastActivityAtMs = event.atMs;
      evidence.idleSinceMs = null;
      evidence.failure = null;
      return;
    case "work_started":
      if (evidence.terminalWork.has(event.correlationId)) {
        if (evidence.unmatchedTerminalWork.delete(event.correlationId)) {
          evidence.lastActivityAtMs = event.atMs;
        }
        return;
      }
      if (evidence.openWork.has(event.correlationId)) {
        return;
      }
      evidence.openWork.add(event.correlationId);
      evidence.lastActivityAtMs = event.atMs;
      return;
    case "work_finished":
    case "work_failed": {
      const outcome = event.kind === "work_finished" ? "finished" : "failed";
      const priorOutcome = evidence.terminalWork.get(event.correlationId);
      if (priorOutcome === outcome) {
        return;
      }
      if (priorOutcome !== undefined && priorOutcome !== outcome) {
        evidence.gap = true;
        evidence.lastActivityAtMs = event.atMs;
        return;
      }
      evidence.terminalWork.set(event.correlationId, outcome);
      if (!evidence.openWork.delete(event.correlationId)) {
        evidence.unmatchedTerminalWork.add(event.correlationId);
      }
      evidence.lastActivityAtMs = event.atMs;
      if (
        evidence.foreground === "stopped" &&
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
      ) {
        evidence.idleSinceMs = event.atMs;
      }
      return;
    }
    case "request_opened":
      if (evidence.resolvedRequests.has(event.correlationId)) {
        if (evidence.unmatchedResolvedRequests.delete(event.correlationId)) {
          evidence.lastActivityAtMs = event.atMs;
        }
        return;
      }
      if (evidence.openRequests.has(event.correlationId)) {
        return;
      }
      evidence.openRequests.add(event.correlationId);
      evidence.lastActivityAtMs = event.atMs;
      return;
    case "request_resolved":
      if (!evidence.openRequests.has(event.correlationId)) {
        if (!evidence.resolvedRequests.has(event.correlationId)) {
          evidence.resolvedRequests.add(event.correlationId);
          evidence.unmatchedResolvedRequests.add(event.correlationId);
          evidence.lastActivityAtMs = event.atMs;
        }
        return;
      }
      evidence.openRequests.delete(event.correlationId);
      evidence.resolvedRequests.add(event.correlationId);
      evidence.lastActivityAtMs = event.atMs;
      if (
        evidence.foreground === "stopped" &&
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
      ) {
        evidence.idleSinceMs = event.atMs;
      }
      return;
    case "foreground_stopped":
      evidence.foreground = "stopped";
      evidence.backgroundSnapshotCount =
        (event.inFlightCount ?? 0) + (event.scheduledCount ?? 0);
      evidence.lastActivityAtMs = event.atMs;
      evidence.idleSinceMs =
        evidence.openWork.size + evidence.backgroundSnapshotCount === 0 &&
        evidence.openRequests.size === 0
          ? event.atMs
          : null;
      return;
    case "turn_failed":
      evidence.failure = "turn_failed";
      evidence.foreground = "stopped";
      evidence.openWork.clear();
      evidence.openRequests.clear();
      evidence.backgroundSnapshotCount = 0;
      evidence.lastActivityAtMs = event.atMs;
      evidence.idleSinceMs = null;
      return;
    case "owned_process_failed":
      evidence.failure = "owned_process_failed";
      evidence.foreground = "stopped";
      evidence.openWork.clear();
      evidence.openRequests.clear();
      evidence.backgroundSnapshotCount = 0;
      evidence.lastActivityAtMs = event.atMs;
      evidence.idleSinceMs = null;
      return;
    case "evidence_gap":
      evidence.gap = true;
      evidence.lastActivityAtMs = event.atMs;
      return;
    case "session_ended":
      evidence.ended = true;
      evidence.openWork.clear();
      evidence.openRequests.clear();
      evidence.backgroundSnapshotCount = 0;
      evidence.lastActivityAtMs = event.atMs;
      return;
    case "restart":
      return;
  }
}

function project(
  evidence: EvidenceState,
  policy: Policy,
  nowMs: number,
): ActivityProjection {
  const metadata = {
    lastActivityAtMs: evidence.lastActivityAtMs,
    inFlightCount: evidence.openWork.size + evidence.backgroundSnapshotCount,
    requestCount: evidence.openRequests.size,
  };
  if (evidence.ended) {
    return {
      state: "ended",
      confidence: "confirmed",
      reason: "session_ended",
      ...metadata,
    };
  }
  if (evidence.openRequests.size > 0) {
    return {
      state: "needs_input",
      confidence: "confirmed",
      reason: "request_open",
      ...metadata,
    };
  }
  if (evidence.failure !== null) {
    return {
      state: "failed",
      confidence: "confirmed",
      reason: evidence.failure,
      ...metadata,
    };
  }
  if (
    evidence.gap ||
    evidence.unmatchedTerminalWork.size > 0 ||
    evidence.unmatchedResolvedRequests.size > 0
  ) {
    return {
      state: "unknown",
      confidence: "confirmed",
      reason: "evidence_gap",
      ...metadata,
    };
  }

  const activityAge =
    evidence.lastActivityAtMs === null ? 0 : nowMs - evidence.lastActivityAtMs;

  if (evidence.foreground === "stopped") {
    if (metadata.inFlightCount > 0) {
      return activityAge >= policy.backgroundWorkToUnknownMs
        ? {
            state: "unknown",
            confidence: "inferred",
            reason: "background_work_stale",
            ...metadata,
          }
        : {
            state: "background_work",
            confidence: "confirmed",
            reason: "background_work_open",
            ...metadata,
          };
    }
    if (evidence.idleSinceMs === null) {
      return {
        state: "unknown",
        confidence: "confirmed",
        reason: "evidence_gap",
        ...metadata,
      };
    }
    return nowMs - evidence.idleSinceMs >= policy.idleToDoneMs
      ? {
          state: "done",
          confidence: "inferred",
          reason: "idle_grace_elapsed",
          ...metadata,
        }
      : {
          state: "idle",
          confidence: "confirmed",
          reason: "foreground_stopped",
          ...metadata,
        };
  }

  if (evidence.foreground === "working") {
    const threshold =
      evidence.openWork.size > 0
        ? policy.openForegroundWorkToUnknownMs
        : policy.workingWithoutTerminalToUnknownMs;
    return activityAge >= threshold
      ? {
          state: "unknown",
          confidence: "inferred",
          reason:
            evidence.openWork.size > 0
              ? "foreground_work_stale"
              : "terminal_missing",
          ...metadata,
        }
      : {
          state: "working",
          confidence: "confirmed",
          reason:
            evidence.openWork.size > 0 ? "work_open" : "foreground_recent",
          ...metadata,
        };
  }

  return {
    state: "idle",
    confidence: "confirmed",
    reason: "session_observed",
    ...metadata,
  };
}

const trials = TimingTrialsSchema.parse(
  JSON.parse(
    readFileSync(
      join(fixtures, "activity-policy", "timing-trials.json"),
      "utf8",
    ),
  ),
);

const ownedProcessEvidence = OwnedProcessEvidenceSchema.parse(
  JSON.parse(
    readFileSync(
      join(fixtures, "activity-policy", "owned-process-exit.json"),
      "utf8",
    ),
  ),
);

describe("AR5.1 fake-clock timing trials", () => {
  it("retains only bounded owned-process failure evidence", () => {
    expect(ownedProcessEvidence.evidence).toMatchObject({
      source: "owned-child",
      classification: "nonzero-exit",
      expected: false,
      exitCode: 17,
    });
    expect(ownedProcessEvidence.evidence).not.toHaveProperty("argv");
    expect(ownedProcessEvidence.evidence).not.toHaveProperty("output");
    expect(ownedProcessEvidence.evidence).not.toHaveProperty("cwd");
    expect(ownedProcessEvidence.evidence).not.toHaveProperty("environment");
  });

  it("freezes bounded confidence and user-facing reasons for every state", () => {
    expect(new Set(trials.decisions.map((entry) => entry.state))).toEqual(
      new Set(state.options),
    );
    expect(new Set(trials.decisions.map((entry) => entry.reason)).size).toBe(
      trials.decisions.length,
    );
    for (const decision of trials.decisions) {
      expect(decision.userFacingReason).not.toMatch(/[{}<>]/u);
    }
  });

  it("keeps every proposed default inside the reviewed safe bounds", () => {
    expect(trials.policy.idleToDoneMs).toBeGreaterThanOrEqual(30_000);
    expect(trials.policy.idleToDoneMs).toBeLessThanOrEqual(10 * 60_000);
    expect(
      trials.policy.workingWithoutTerminalToUnknownMs,
    ).toBeGreaterThanOrEqual(60_000);
    expect(trials.policy.workingWithoutTerminalToUnknownMs).toBeLessThanOrEqual(
      30 * 60_000,
    );
    expect(trials.policy.openForegroundWorkToUnknownMs).toBeGreaterThanOrEqual(
      5 * 60_000,
    );
    expect(trials.policy.openForegroundWorkToUnknownMs).toBeLessThanOrEqual(
      24 * 60 * 60_000,
    );
    expect(trials.policy.backgroundWorkToUnknownMs).toBeGreaterThanOrEqual(
      30 * 60_000,
    );
    expect(trials.policy.backgroundWorkToUnknownMs).toBeLessThanOrEqual(
      7 * 24 * 60 * 60_000,
    );
  });

  it.each(trials.trials)("projects $name", (trial) => {
    expect(trial.events.map(({ atMs }) => atMs)).toEqual(
      [...trial.events.map(({ atMs }) => atMs)].sort(
        (left, right) => left - right,
      ),
    );
    expect(trial.checkpoints.map(({ atMs }) => atMs)).toEqual(
      [...trial.checkpoints.map(({ atMs }) => atMs)].sort(
        (left, right) => left - right,
      ),
    );

    for (const checkpoint of trial.checkpoints) {
      const evidence = initialEvidence();
      for (const event of trial.events) {
        if (event.atMs <= checkpoint.atMs) {
          applyEvent(evidence, event);
        }
      }
      const { atMs, ...expected } = checkpoint;
      expect(
        project(evidence, trials.policy, atMs),
        `${trial.name} at ${String(atMs)}ms`,
      ).toMatchObject(expected);
    }
  });
});
