import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import {
  DEFAULT_SESSION_ACTIVITY_POLICY,
  SESSION_ACTIVITY_STATE_LABELS,
  initialSessionActivityEvidence,
  projectSessionActivity,
  reduceSessionActivity,
  sessionActivityInputsForAttentionEvent,
  sessionActivityInputsForStructuredObservation,
  validateSessionActivityPolicy,
} from "./activity.js";
import type {
  SessionActivityEvidence,
  SessionActivityInput,
  SessionActivityState,
} from "./activity.js";

interface TrialEvent {
  atMs: number;
  kind: string;
  correlationId?: string;
  inFlightCount?: number;
  scheduledCount?: number;
}

interface TimingCorpus {
  policy: typeof DEFAULT_SESSION_ACTIVITY_POLICY;
  trials: Array<{
    name: string;
    events: TrialEvent[];
    checkpoints: Array<{
      atMs: number;
      state: SessionActivityState;
      confidence?: string;
      reason?: string;
      lastActivityAtMs?: number;
      inFlightCount?: number;
      requestCount?: number;
    }>;
  }>;
}

const corpus = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "harnesses",
      "fixtures",
      "activity-policy",
      "timing-trials.json",
    ),
    "utf8",
  ),
) as TimingCorpus;

function iso(atMs: number): string {
  return new Date(atMs).toISOString();
}

function inputs(event: TrialEvent): SessionActivityInput[] {
  const base = { observedAt: iso(event.atMs), source: "recovery" as const };
  switch (event.kind) {
    case "restart":
      return [];
    case "foreground_stopped":
      return [
        ...((event.inFlightCount ?? 0) + (event.scheduledCount ?? 0) > 0
          ? [
              {
                ...base,
                kind: "background_snapshot" as const,
                ...(event.inFlightCount === undefined
                  ? {}
                  : { inFlightCount: event.inFlightCount }),
                ...(event.scheduledCount === undefined
                  ? {}
                  : { scheduledCount: event.scheduledCount }),
              },
            ]
          : []),
        { ...base, kind: "foreground_stopped" },
      ];
    case "work_started":
    case "work_finished":
    case "work_failed":
    case "request_opened":
    case "request_resolved":
      return [
        {
          ...base,
          kind: event.kind,
          ...(event.correlationId === undefined
            ? {}
            : { correlationKey: event.correlationId }),
        },
      ];
    default:
      return [{ ...base, kind: event.kind as SessionActivityInput["kind"] }];
  }
}

function evidenceAt(
  events: TrialEvent[],
  atMs: number,
): SessionActivityEvidence {
  const evidence = initialSessionActivityEvidence();
  let receiveSequence = 0;
  for (const event of events) {
    if (event.atMs > atMs) break;
    for (const input of inputs(event)) {
      reduceSessionActivity(evidence, input, ++receiveSequence);
    }
  }
  return evidence;
}

describe("AR5.1 production activity reducer", () => {
  it.each(corpus.trials)("matches $name", (trial) => {
    for (const checkpoint of trial.checkpoints) {
      const activity = projectSessionActivity(
        evidenceAt(trial.events, checkpoint.atMs),
        iso(checkpoint.atMs),
        false,
        corpus.policy,
      );
      expect(activity.state).toBe(checkpoint.state);
      if (checkpoint.confidence !== undefined) {
        expect(activity.confidence).toBe(checkpoint.confidence);
      }
      if (checkpoint.reason !== undefined) {
        expect(activity.reason).toBe(checkpoint.reason);
      }
      if (checkpoint.lastActivityAtMs !== undefined) {
        expect(Date.parse(activity.lastObservedAt)).toBe(
          checkpoint.lastActivityAtMs,
        );
      }
      if (checkpoint.inFlightCount !== undefined) {
        expect(activity.inFlightCount).toBe(checkpoint.inFlightCount);
      }
      if (checkpoint.requestCount !== undefined) {
        expect(activity.requestCount).toBe(checkpoint.requestCount);
      }
    }
  });

  it("exposes exactly the frozen user-visible state labels", () => {
    expect(new Set(Object.values(SESSION_ACTIVITY_STATE_LABELS))).toEqual(
      new Set([
        "Working",
        "Needs input",
        "Background work",
        "Idle",
        "Done",
        "Failed",
        "Unknown",
        "Ended",
      ]),
    );
  });

  it("accepts only the frozen timing bounds", () => {
    expect(
      validateSessionActivityPolicy(DEFAULT_SESSION_ACTIVITY_POLICY),
    ).toEqual(DEFAULT_SESSION_ACTIVITY_POLICY);
    for (const [key, value] of Object.entries(
      DEFAULT_SESSION_ACTIVITY_POLICY,
    )) {
      expect(() =>
        validateSessionActivityPolicy({
          ...DEFAULT_SESSION_ACTIVITY_POLICY,
          [key]: value === 90_000 ? 10_000 : 1,
        }),
      ).toThrow();
    }
  });

  it("does not let ambiguous activity revive an idle, failed, or ended lane", () => {
    const scenarios: Array<
      [SessionActivityInput["kind"], SessionActivityState]
    > = [
      ["foreground_stopped", "idle"],
      ["turn_failed", "failed"],
      ["session_ended", "ended"],
    ];
    for (const [terminal, expected] of scenarios) {
      const evidence = initialSessionActivityEvidence();
      reduceSessionActivity(evidence, {
        kind: "prompt_submitted",
        observedAt: iso(0),
        source: "codex_cli",
      });
      reduceSessionActivity(evidence, {
        kind: terminal,
        observedAt: iso(1),
        source: "codex_cli",
      });
      reduceSessionActivity(evidence, {
        kind: "activity_observed",
        observedAt: iso(2),
        source: "codex_cli",
      });
      expect(projectSessionActivity(evidence, iso(2), false).state).toBe(
        expected,
      );
    }
  });

  it("keeps an exact unresolved request above a newer prompt", () => {
    const evidence = initialSessionActivityEvidence();
    reduceSessionActivity(evidence, {
      kind: "request_opened",
      observedAt: iso(0),
      source: "relay_interaction",
      correlationKey: "request_activity_precedence_12345678",
    });
    reduceSessionActivity(evidence, {
      kind: "prompt_submitted",
      observedAt: iso(1),
      source: "codex_cli",
      correlationKey: "turn_activity_precedence_12345678",
    });
    expect(projectSessionActivity(evidence, iso(1), false)).toMatchObject({
      state: "needs_input",
      requestCount: 1,
      reason: "request_open",
    });
  });

  it("maps only selected structured app-server evidence", () => {
    expect(
      sessionActivityInputsForStructuredObservation({
        kind: "item.started",
        observedAt: iso(0),
        nativeItemReference: "native-private-item-id",
      }),
    ).toEqual([
      {
        kind: "work_started",
        observedAt: iso(0),
        source: "codex_app_server",
        correlationKey: "native-private-item-id",
      },
    ]);
    expect(
      sessionActivityInputsForStructuredObservation({
        kind: "process.exited",
        observedAt: iso(1),
        status: "intentional",
      }),
    ).toEqual([]);
    expect(
      sessionActivityInputsForStructuredObservation({
        kind: "process.exited",
        observedAt: iso(1),
        status: "future-value",
      }),
    ).toEqual([
      {
        kind: "evidence_gap",
        observedAt: iso(1),
        source: "codex_app_server",
      },
    ]);
    expect(
      sessionActivityInputsForStructuredObservation({
        kind: "attention.required",
        observedAt: iso(2),
      }),
    ).toEqual([]);
  });

  it("keeps the frozen CLI selection closed", () => {
    const base: AgentAttentionEventV1 = {
      schema: "agent-attention.v1",
      eventId: "event_activity_selection_12345678",
      occurredAt: iso(0),
      sequence: 1,
      machineId: "machine_activity_selection_12345678",
      bridgeSessionId: "bridge_activity_selection_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "frozen",
      sessionId: "session_activity_selection_12345678",
      project: makeProjectRef("/synthetic/activity-selection"),
      type: "turn.activity",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    };
    expect(sessionActivityInputsForAttentionEvent(base)).toEqual([]);
    expect(
      sessionActivityInputsForAttentionEvent({
        ...base,
        harness: "claude",
      }),
    ).toEqual([]);
    expect(
      sessionActivityInputsForAttentionEvent({
        ...base,
        harness: "cursor",
        type: "turn.started",
      }),
    ).toEqual([]);
    expect(
      sessionActivityInputsForAttentionEvent({
        ...base,
        type: "session.ended",
      }),
    ).toEqual([]);
    expect(
      sessionActivityInputsForAttentionEvent({
        ...base,
        harness: "cursor",
        type: "process.stale",
      }),
    ).toEqual([
      {
        kind: "evidence_gap",
        observedAt: iso(0),
        source: "cursor_cli",
      },
    ]);
    expect(
      sessionActivityInputsForAttentionEvent({
        ...base,
        type: "session.ended",
        processExit: {
          source: "owned-child",
          expected: true,
          supervisorId: "supervisor_activity_selection_12345678",
          startedAt: iso(0),
          exitedAt: iso(1),
          exitCode: 0,
          classification: "clean-exit",
        },
      }),
    ).toEqual([]);
  });

  it("remains deterministic through duplicate-heavy bounded sequences", () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const correlation = `work_property_${String(seed).padStart(4, "0")}`;
      const sequence: SessionActivityInput[] = [
        {
          kind: "prompt_submitted",
          observedAt: iso(seed * 10),
          source: "codex_app_server",
        },
        {
          kind: "work_started",
          observedAt: iso(seed * 10 + 1),
          source: "codex_app_server",
          correlationKey: correlation,
        },
        {
          kind: seed % 2 === 0 ? "work_finished" : "work_failed",
          observedAt: iso(seed * 10 + 2),
          source: "codex_app_server",
          correlationKey: correlation,
        },
        {
          kind: "foreground_stopped",
          observedAt: iso(seed * 10 + 3),
          source: "codex_app_server",
        },
      ];
      const apply = () => {
        const evidence = initialSessionActivityEvidence();
        let receiveSequence = 0;
        for (const input of sequence) {
          reduceSessionActivity(evidence, input, ++receiveSequence);
          reduceSessionActivity(evidence, input, receiveSequence);
        }
        return projectSessionActivity(
          evidence,
          iso(seed * 10 + 3),
          seed % 3 === 0,
        );
      };
      expect(apply()).toEqual(apply());
      expect(apply().inFlightCount).toBe(0);
      expect(apply().state).toBe("idle");
    }
  });
});
