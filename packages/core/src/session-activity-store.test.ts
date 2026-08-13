import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { DEFAULT_SESSION_ACTIVITY_POLICY } from "./activity.js";
import { RelayStore } from "./store.js";

const baseAt = "2026-08-13T12:00:00.000Z";

function at(milliseconds: number): string {
  return new Date(Date.parse(baseAt) + milliseconds).toISOString();
}

function event(
  type: AgentAttentionEventV1["type"],
  sequence: number,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  const harness = overrides.harness ?? "codex";
  const sessionId =
    overrides.sessionId ?? `session_activity_${harness}_12345678`;
  return {
    schema: "agent-attention.v1",
    eventId:
      overrides.eventId ??
      `event_activity_${harness}_${String(sequence)}_12345678`,
    occurredAt: overrides.occurredAt ?? at(sequence * 100),
    sequence,
    machineId: overrides.machineId ?? "machine_activity_store_12345678",
    bridgeSessionId:
      overrides.bridgeSessionId ?? "bridge_activity_store_12345678",
    harness,
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "frozen-test-version",
    sessionId,
    project: overrides.project ?? makeProjectRef("/synthetic/activity-store"),
    type,
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
    ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.processExit === undefined
      ? {}
      : { processExit: overrides.processExit }),
    ...(overrides.backgroundWork === undefined
      ? {}
      : { backgroundWork: overrides.backgroundWork }),
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
  };
}

describe("durable shared session activity", () => {
  it("projects the frozen CLI evidence for Codex, Claude, and Cursor", () => {
    const store = new RelayStore();
    for (const harness of ["codex", "claude", "cursor"] as const) {
      const sessionId = `session_activity_${harness}_12345678`;
      store.ingestEvent(event("session.started", 1, { harness, sessionId }));
      expect(
        store.getSessionActivity(
          {
            machineId: "machine_activity_store_12345678",
            harness,
            sessionId,
          },
          at(100),
        ),
      ).toMatchObject({
        state: "idle",
        stateLabel: "Idle",
        confidence: "confirmed",
        reason: "session_observed",
        inFlightCount: 0,
        requestCount: 0,
      });
    }

    store.ingestEvent(
      event("turn.started", 2, {
        harness: "codex",
        turnId: "turn_activity_codex_12345678",
      }),
    );
    expect(
      store.getSessionActivity(
        {
          machineId: "machine_activity_store_12345678",
          harness: "codex",
          sessionId: "session_activity_codex_12345678",
        },
        at(200),
      ),
    ).toMatchObject({ state: "working", reason: "foreground_recent" });

    store.ingestEvent(
      event("turn.activity", 2, {
        harness: "claude",
        backgroundWork: { inFlightCount: 2, scheduledCount: 1 },
      }),
    );
    expect(
      store.getSessionActivity(
        {
          machineId: "machine_activity_store_12345678",
          harness: "claude",
          sessionId: "session_activity_claude_12345678",
        },
        at(200),
      ),
    ).toMatchObject({
      state: "background_work",
      reason: "background_work_open",
      inFlightCount: 3,
    });

    store.ingestEvent(event("turn.stopped", 2, { harness: "cursor" }));
    expect(
      store.getSessionActivity(
        {
          machineId: "machine_activity_store_12345678",
          harness: "cursor",
          sessionId: "session_activity_cursor_12345678",
        },
        at(200),
      ),
    ).toMatchObject({ state: "idle", reason: "foreground_stopped" });
    store.close();
  });

  it("advances Idle to inferred Done only at the server policy boundary", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_store_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_codex_12345678",
    };
    store.ingestEvent(event("turn.started", 1));
    store.ingestEvent(event("turn.stopped", 2));
    expect(store.getSessionActivity(identity, at(90_199)).state).toBe("idle");
    expect(store.getSessionActivity(identity, at(90_200))).toMatchObject({
      state: "done",
      confidence: "inferred",
      reason: "idle_grace_elapsed",
    });
    store.close();
  });

  it("uses server receive time instead of a remote event timestamp", () => {
    const store = new RelayStore();
    const oldEvent = event("turn.started", 1, {
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    store.ingestEvent(oldEvent, at(1_000));
    expect(
      store.getSessionActivity(
        {
          machineId: oldEvent.machineId,
          harness: oldEvent.harness,
          sessionId: oldEvent.sessionId,
        },
        at(1_000),
      ),
    ).toMatchObject({
      state: "working",
      lastObservedAt: at(1_000),
    });
    const unselected = event("session.started", 2, {
      harness: "cursor",
      sessionId: "session_activity_cursor_receive_12345678",
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    store.ingestEvent(unselected, at(2_000));
    expect(
      store.getSessionActivity(
        {
          machineId: unselected.machineId,
          harness: unselected.harness,
          sessionId: unselected.sessionId,
        },
        at(2_000),
      ),
    ).toMatchObject({ state: "idle", lastObservedAt: at(2_000) });
    store.close();
  });

  it("treats distinct correlated Cursor stops as new evidence", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_store_12345678",
      harness: "cursor" as const,
      sessionId: "session_activity_cursor_12345678",
    };
    store.ingestEvent(
      event("turn.stopped", 1, {
        harness: "cursor",
        turnId: "cursor_loop_1",
      }),
      at(1_000),
    );
    expect(store.getSessionActivity(identity, at(90_999)).state).toBe("idle");
    store.ingestEvent(
      event("turn.stopped", 2, {
        harness: "cursor",
        turnId: "cursor_loop_2",
      }),
      at(91_000),
    );
    expect(store.getSessionActivity(identity, at(91_000))).toMatchObject({
      state: "idle",
      lastObservedAt: at(91_000),
      idleSince: at(91_000),
    });
    store.close();
  });

  it("applies a custom threshold only inside the frozen safe bounds", () => {
    const store = new RelayStore(":memory:", {
      activityPolicy: {
        ...DEFAULT_SESSION_ACTIVITY_POLICY,
        idleToDoneMs: 30_000,
      },
    });
    const identity = {
      machineId: "machine_activity_store_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_codex_12345678",
    };
    store.ingestEvent(event("turn.started", 1));
    store.ingestEvent(event("turn.stopped", 2));
    expect(store.getSessionActivity(identity, at(30_199)).state).toBe("idle");
    expect(store.getSessionActivity(identity, at(30_200)).state).toBe("done");
    store.close();

    expect(
      () =>
        new RelayStore(":memory:", {
          activityPolicy: {
            ...DEFAULT_SESSION_ACTIVITY_POLICY,
            idleToDoneMs: 29_999,
          },
        }),
    ).toThrow("idleToDoneMs");
  });

  it("keeps a durable request above stop and starts grace on exact resolution", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_store_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_codex_12345678",
    };
    store.ingestEvent(event("turn.started", 1));
    store.ingestEvent(
      event("input.required", 2, {
        request: {
          correlationId: "request_activity_store_12345678",
          kind: "input",
          question: "Synthetic bounded question",
          expiresAt: at(10 * 60_000),
        },
      }),
    );
    store.ingestEvent(event("turn.stopped", 3));
    expect(store.getSessionActivity(identity, at(300))).toMatchObject({
      state: "needs_input",
      requestCount: 1,
    });
    expect(
      store.resolveRequest({
        correlationId: "request_activity_store_12345678",
        answer: "Synthetic answer",
        resolvedBy: "terminal",
        now: at(1_000),
      }).outcome,
    ).toBe("answered");
    expect(store.getSessionActivity(identity, at(1_000))).toMatchObject({
      state: "idle",
      requestCount: 0,
      idleSince: at(1_000),
      lastObservedAt: at(1_000),
    });
    expect(store.getSessionActivity(identity, at(90_999)).state).toBe("idle");
    expect(store.getSessionActivity(identity, at(91_000)).state).toBe("done");
    store.close();
  });

  it("preserves exact requests across prompts and closes impossible waits on failure", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_store_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_codex_12345678",
    };
    store.ingestEvent(
      event("input.required", 1, {
        surface: "app-server",
        request: {
          correlationId: "request_activity_failure_12345678",
          kind: "input",
          question: "Synthetic bounded question",
          expiresAt: at(10 * 60_000),
        },
      }),
    );
    store.ingestEvent(
      event("turn.started", 2, {
        surface: "app-server",
        turnId: "turn_activity_failure_12345678",
      }),
    );
    expect(store.getSessionActivity(identity, at(200))).toMatchObject({
      state: "needs_input",
      requestCount: 1,
    });
    store.ingestEvent(
      event("turn.failed", 3, {
        surface: "app-server",
        turnId: "turn_activity_failure_12345678",
        failure: { class: "bounded", message: "Bounded failure" },
      }),
    );
    expect(store.getSessionActivity(identity, at(300))).toMatchObject({
      state: "failed",
      requestCount: 0,
      reason: "turn_failed",
    });
    expect(
      store.getPendingRequest("request_activity_failure_12345678")?.state,
    ).toBe("cancelled");
    store.close();
  });

  it("keeps muted delivery orthogonal to failure and exact requests", () => {
    const store = new RelayStore();
    const input = event("turn.started", 1, { harness: "claude" });
    store.ingestEvent(input);
    const [claimed] = store.claimDueEvents(at(200));
    store.markDeliveryFailed(
      input.eventId,
      claimed?.attemptNumber ?? 1,
      "synthetic-delivery",
      "PRIVATE DELIVERY ERROR MUST NOT AFFECT EXECUTION",
      false,
      at(200),
    );
    const identity = {
      machineId: input.machineId,
      harness: input.harness,
      sessionId: input.sessionId,
    };
    expect(store.getSessionActivity(identity, at(200))).toMatchObject({
      state: "working",
      muted: false,
    });

    const token = "card_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    store.registerCardActions(
      input.eventId,
      [{ token, kind: "mute" }],
      at(200),
    );
    expect(
      store.executeCardAction({
        token,
        kind: "mute",
        updateId: 1,
        now: at(201),
      }).outcome,
    ).toBe("succeeded");
    expect(store.getSessionActivity(identity, at(201))).toMatchObject({
      state: "working",
      muted: true,
    });

    store.ingestEvent(
      event("turn.failed", 2, {
        harness: "claude",
        failure: { class: "bounded", message: "Bounded failure" },
      }),
    );
    expect(store.getSessionActivity(identity, at(300))).toMatchObject({
      state: "failed",
      muted: true,
      reason: "turn_failed",
    });
    store.close();
  });

  it("persists restart-safe work, tombstones, and keyed redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activity-store-"));
    const databasePath = join(directory, "relay.sqlite");
    const identity = {
      machineId: "machine_activity_restart_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_restart_12345678",
    };
    const privateCorrelation = "PRIVATE_NATIVE_ITEM_IDENTIFIER_12345678";
    const first = new RelayStore(databasePath);
    first.registerSession({
      schema: "agent-session.v1",
      ...identity,
      bridgeSessionId: "bridge_activity_restart_12345678",
      surface: "app-server",
      harnessVersion: "0.145.0",
      project: makeProjectRef("/private/path/must-not-enter-activity"),
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: true,
        permissionDecision: true,
      },
      registeredAt: at(0),
    });
    first.applySessionActivityInput(identity, {
      kind: "prompt_submitted",
      observedAt: at(10),
      source: "codex_app_server",
      correlationKey: "PRIVATE_NATIVE_TURN_IDENTIFIER_12345678",
    });
    first.applySessionActivityInput(identity, {
      kind: "work_started",
      observedAt: at(20),
      source: "codex_app_server",
      correlationKey: privateCorrelation,
    });
    expect(first.getSessionActivity(identity, at(30))).toMatchObject({
      state: "working",
      inFlightCount: 1,
    });
    first.close();

    const restarted = new RelayStore(databasePath);
    expect(restarted.getSessionActivity(identity, at(40))).toMatchObject({
      state: "working",
      inFlightCount: 1,
    });
    restarted.applySessionActivityInput(identity, {
      kind: "work_finished",
      observedAt: at(50),
      source: "codex_app_server",
      correlationKey: privateCorrelation,
    });
    restarted.applySessionActivityInput(identity, {
      kind: "foreground_stopped",
      observedAt: at(60),
      source: "codex_app_server",
    });
    expect(restarted.getSessionActivity(identity, at(60))).toMatchObject({
      state: "idle",
      inFlightCount: 0,
    });
    restarted.close();

    const inspected = new Database(databasePath, { readonly: true });
    const activityPersistence = JSON.stringify({
      activity: inspected.prepare("SELECT * FROM session_activity").all(),
      correlations: inspected
        .prepare("SELECT * FROM session_activity_correlations")
        .all(),
      events: inspected.prepare("SELECT * FROM session_activity_events").all(),
    });
    inspected.close();
    expect(activityPersistence).not.toContain(privateCorrelation);
    expect(activityPersistence).not.toContain("PRIVATE_NATIVE_TURN_IDENTIFIER");
    expect(activityPersistence).not.toContain("/private/path");
    expect(activityPersistence).not.toContain("cwdHash");
  });

  it("makes duplicates and terminal-before-start delivery deterministic", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_order_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_order_12345678",
    };
    store.registerSession({
      schema: "agent-session.v1",
      ...identity,
      bridgeSessionId: "bridge_activity_order_12345678",
      surface: "app-server",
      harnessVersion: "0.145.0",
      project: makeProjectRef("/synthetic/order"),
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: true,
        permissionDecision: true,
      },
      registeredAt: at(0),
    });
    const prompt = {
      kind: "prompt_submitted" as const,
      observedAt: at(1),
      source: "codex_app_server" as const,
      correlationKey: "private-native-turn",
    };
    expect(store.applySessionActivityInput(identity, prompt).inserted).toBe(
      true,
    );
    expect(store.applySessionActivityInput(identity, prompt).inserted).toBe(
      false,
    );
    expect(store.getSessionActivity(identity, at(1)).epoch).toBe(1);
    const terminal = {
      kind: "work_finished" as const,
      observedAt: at(2),
      source: "codex_app_server" as const,
      correlationKey: "item_activity_order_12345678",
    };
    expect(store.applySessionActivityInput(identity, terminal).inserted).toBe(
      true,
    );
    expect(store.applySessionActivityInput(identity, terminal).inserted).toBe(
      false,
    );
    expect(store.getSessionActivity(identity, at(2))).toMatchObject({
      state: "unknown",
      reason: "evidence_gap",
      inFlightCount: 0,
    });
    store.applySessionActivityInput(identity, {
      kind: "work_started",
      observedAt: at(3),
      source: "codex_app_server",
      correlationKey: terminal.correlationKey,
    });
    expect(store.getSessionActivity(identity, at(3))).toMatchObject({
      state: "working",
      reason: "foreground_recent",
      inFlightCount: 0,
    });
    store.close();
  });

  it("rejects non-allowlisted activity metadata before persistence", () => {
    const store = new RelayStore();
    const identity = {
      machineId: "machine_activity_allowlist_12345678",
      harness: "codex" as const,
      sessionId: "session_activity_allowlist_12345678",
    };
    store.registerSession({
      schema: "agent-session.v1",
      ...identity,
      bridgeSessionId: "bridge_activity_allowlist_12345678",
      surface: "app-server",
      harnessVersion: "0.145.0",
      project: makeProjectRef("/synthetic/allowlist"),
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: true,
        permissionDecision: true,
      },
      registeredAt: at(0),
    });
    expect(() =>
      store.applySessionActivityInput(identity, {
        kind: "activity_observed",
        observedAt: at(1),
        source: "PRIVATE_UNBOUNDED_SOURCE" as "codex_cli",
      }),
    ).toThrow();
    expect(() =>
      store.applySessionActivityInput(identity, {
        kind: "activity_observed",
        observedAt: at(1),
        source: "codex_cli",
        privatePayload: "MUST_NOT_PERSIST",
      } as never),
    ).toThrow();
    const inspected = JSON.stringify(
      (store as unknown as { database: Database.Database }).database
        .prepare("SELECT * FROM session_activity_events")
        .all(),
    );
    expect(inspected).not.toContain("PRIVATE_UNBOUNDED_SOURCE");
    expect(inspected).not.toContain("MUST_NOT_PERSIST");
    store.close();
  });
});
