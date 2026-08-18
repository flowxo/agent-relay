import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { makeProjectRef } from "@agent-relay/protocol";
import type { Harness } from "@agent-relay/protocol";

import { ProjectReadError } from "./project-read.js";
import { RelayStore } from "./store.js";

const READ_AT = "2026-08-13T12:10:00.000Z";

function expectProjectReadError(
  action: () => unknown,
  code: ProjectReadError["code"],
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectReadError);
  expect(caught).toMatchObject({ code });
}

function register(
  store: RelayStore,
  input: {
    suffix: string;
    projectPath: string;
    harness?: Harness;
    at?: string;
  },
) {
  const harness = input.harness ?? "codex";
  const identity = {
    machineId: `machine_project_read_${input.suffix}`,
    harness,
    sessionId: `session_project_read_${input.suffix}`,
  } as const;
  store.registerSession({
    schema: "agent-session.v1",
    ...identity,
    bridgeSessionId: `bridge_project_read_${input.suffix}`,
    surface: "cli",
    harnessVersion: "synthetic-test-version",
    project: makeProjectRef(input.projectPath),
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
    registeredAt: input.at ?? "2026-08-13T12:00:00.000Z",
  });
  return identity;
}

function applyState(
  store: RelayStore,
  identity: ReturnType<typeof register>,
  state:
    | "working"
    | "needs_input"
    | "background_work"
    | "done"
    | "failed"
    | "unknown"
    | "ended",
  at = "2026-08-13T12:00:00.000Z",
): void {
  const source = `${identity.harness}_cli` as const;
  if (state === "working" || state === "done" || state === "background_work") {
    store.applySessionActivityInput(identity, {
      kind: "prompt_submitted",
      observedAt: at,
      source,
    });
  }
  switch (state) {
    case "working":
      return;
    case "needs_input": {
      const session = store.getSession(identity, at);
      if (session === undefined)
        throw new Error("synthetic session is missing");
      store.ingestEvent({
        schema: "agent-attention.v1",
        eventId: `event_${identity.sessionId}`,
        occurredAt: at,
        sequence: session.lastSequence + 1,
        ...identity,
        bridgeSessionId: session.bridgeSessionId,
        surface: session.surface,
        harnessVersion: session.harnessVersion,
        project: session.project,
        type: "input.required",
        capabilities: session.capabilities,
        request: {
          correlationId: `request_${identity.sessionId}`,
          kind: "input",
          question:
            "Synthetic private prompt that must not enter project reads",
          expiresAt: "2026-08-13T12:30:00.000Z",
        },
      });
      return;
    }
    case "background_work":
      store.applySessionActivityInput(identity, {
        kind: "background_snapshot",
        observedAt: at,
        source,
        inFlightCount: 2,
        scheduledCount: 1,
      });
      store.applySessionActivityInput(identity, {
        kind: "foreground_stopped",
        observedAt: at,
        source,
      });
      return;
    case "done":
      store.applySessionActivityInput(identity, {
        kind: "foreground_stopped",
        observedAt: at,
        source,
      });
      return;
    case "failed":
      store.applySessionActivityInput(identity, {
        kind: "turn_failed",
        observedAt: at,
        source,
      });
      return;
    case "unknown":
      store.applySessionActivityInput(identity, {
        kind: "evidence_gap",
        observedAt: at,
        source,
      });
      return;
    case "ended":
      store.applySessionActivityInput(identity, {
        kind: "session_ended",
        observedAt: at,
        source: "operator",
      });
  }
}

describe("project-centric read model", () => {
  it("keeps exact checkout identities opaque, stable, and collision-free", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-project-read-"),
    );
    const databasePath = join(directory, "relay.sqlite");
    const store = new RelayStore(databasePath);
    register(store, {
      suffix: "same_checkout_one_12345678",
      projectPath: "/synthetic/checkouts/alpha",
    });
    register(store, {
      suffix: "same_checkout_two_12345678",
      projectPath: "/synthetic/checkouts/alpha",
      harness: "claude",
    });
    register(store, {
      suffix: "sibling_worktree_12345678",
      projectPath: "/synthetic/worktrees/alpha",
    });
    register(store, {
      suffix: "duplicate_basename_12345678",
      projectPath: "/synthetic/other-checkout/alpha",
    });
    register(store, {
      suffix: "second_checkout_12345678",
      projectPath: "/synthetic/checkouts/alpha-copy",
    });

    const first = store.readProjectSnapshot({ now: READ_AT });
    expect(first.projects.totalCount).toBe(4);
    expect(
      new Set(first.projects.items.map((item) => item.projectKey)).size,
    ).toBe(4);
    expect(
      first.currentByHarness
        .flatMap((group) => group.sessions)
        .filter((session) => session.projectLabel.startsWith("alpha · ")),
    ).toHaveLength(4);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("/synthetic/");
    expect(serialized).not.toContain("cwdHash");
    expect(serialized).not.toContain("branch");
    expect(serialized).not.toContain("same_checkout");
    const keys = first.projects.items.map((item) => item.projectKey).sort();
    store.close();

    const restarted = new RelayStore(databasePath);
    expect(
      restarted
        .readProjectSnapshot({ now: READ_AT })
        .projects.items.map((item) => item.projectKey)
        .sort(),
    ).toEqual(keys);
    restarted.close();
  });

  it("returns correct aggregates and complete independent current and attention sets", () => {
    const store = new RelayStore();
    const working = register(store, {
      suffix: "working_counts_12345678",
      projectPath: "/synthetic/counts/project-one",
      harness: "codex",
    });
    const input = register(store, {
      suffix: "input_counts_12345678",
      projectPath: "/synthetic/counts/project-one",
      harness: "codex",
    });
    const unknown = register(store, {
      suffix: "unknown_counts_12345678",
      projectPath: "/synthetic/counts/project-one",
      harness: "cursor",
    });
    const done = register(store, {
      suffix: "done_counts_12345678",
      projectPath: "/synthetic/counts/project-one",
    });
    const ended = register(store, {
      suffix: "ended_counts_12345678",
      projectPath: "/synthetic/counts/project-two",
    });
    applyState(store, working, "working", "2026-08-13T12:09:50.000Z");
    applyState(store, input, "needs_input", "2026-08-13T12:09:51.000Z");
    applyState(store, unknown, "unknown", "2026-08-13T12:09:52.000Z");
    applyState(store, done, "done");
    applyState(store, ended, "ended");
    const muteToken = "card_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    store.registerCardActions(
      `event_${input.sessionId}`,
      [{ token: muteToken, kind: "mute" }],
      "2026-08-13T12:09:53.000Z",
    );
    expect(
      store.executeCardAction({
        token: muteToken,
        kind: "mute",
        updateId: 1,
        now: "2026-08-13T12:09:54.000Z",
      }).outcome,
    ).toBe("succeeded");

    const snapshot = store.readProjectSnapshot({
      historyLimit: 1,
      now: READ_AT,
    });
    expect(snapshot.projects.all).toMatchObject({
      currentCount: 3,
      needsAttentionCount: 2,
      needsInputCount: 1,
      failedOrUnknownCount: 1,
      recentCount: 2,
      totalCount: 5,
    });
    expect(
      snapshot.currentByHarness.flatMap((group) => group.sessions),
    ).toHaveLength(3);
    expect(
      snapshot.needsAttention.map((session) => session.activity.state),
    ).toEqual(expect.arrayContaining(["needs_input", "unknown"]));
    expect(snapshot.recent.items).toHaveLength(1);
    expect(snapshot.recent.nextCursor).toBeDefined();
    expect(
      snapshot.needsAttention.find(
        (session) => session.activity.state === "needs_input",
      ),
    ).toMatchObject({
      activity: {
        state: "needs_input",
        confidence: "confirmed",
        reason: "request_open",
        requestCount: 1,
      },
      pendingInteraction: { state: "waiting", count: 1 },
      knownInFlightWork: { count: 0 },
      deliveryHealth: { muted: true },
    });
    const projectOne = snapshot.projects.items.find(
      (project) => project.totalCount === 4,
    )!;
    const filtered = store.readProjectSnapshot({
      projectKey: projectOne.projectKey,
      harness: "cursor",
      state: "unknown",
      now: READ_AT,
    });
    expect(filtered.projects.all.totalCount).toBe(5);
    expect(filtered.projects.items).toContainEqual(projectOne);
    expect(filtered.needsAttention).toHaveLength(1);
    expect(filtered.currentByHarness).toMatchObject([
      { harness: "cursor", sessions: [{ activity: { state: "unknown" } }] },
    ]);
    expect(filtered.recent.items).toEqual([]);
    expectProjectReadError(
      () =>
        store.readProjectSnapshot({
          projectKey: `prj_${"0".repeat(48)}`,
          now: READ_AT,
        }),
      "project_not_found",
    );
    store.close();
  });

  it("matches canonical clock-threshold projections without a second presentation inference", () => {
    const store = new RelayStore(":memory:", {
      activityPolicy: {
        idleToDoneMs: 30_000,
        workingWithoutTerminalToUnknownMs: 60_000,
        openForegroundWorkToUnknownMs: 5 * 60_000,
        backgroundWorkToUnknownMs: 30 * 60_000,
      },
    });
    const plainWorking = register(store, {
      suffix: "threshold_plain_working_12345678",
      projectPath: "/synthetic/thresholds/project",
    });
    const foregroundWork = register(store, {
      suffix: "threshold_foreground_work_12345678",
      projectPath: "/synthetic/thresholds/project",
    });
    const backgroundWork = register(store, {
      suffix: "threshold_background_work_12345678",
      projectPath: "/synthetic/thresholds/project",
    });
    const idle = register(store, {
      suffix: "threshold_idle_12345678",
      projectPath: "/synthetic/thresholds/project",
    });
    applyState(store, plainWorking, "working");
    applyState(store, backgroundWork, "background_work");
    applyState(store, idle, "done");
    store.applySessionActivityInput(foregroundWork, {
      kind: "prompt_submitted",
      observedAt: "2026-08-13T12:00:00.000Z",
      source: "codex_cli",
    });
    store.applySessionActivityInput(foregroundWork, {
      kind: "work_started",
      correlationKey: "synthetic_foreground_work_reference",
      observedAt: "2026-08-13T12:00:00.000Z",
      source: "codex_cli",
    });
    const projectedAt = "2026-08-13T12:30:00.000Z";
    const canonical = [plainWorking, foregroundWork, backgroundWork].map(
      (identity) => store.getSessionActivity(identity, projectedAt),
    );
    expect(canonical).toMatchObject([
      { state: "unknown", reason: "terminal_missing" },
      { state: "unknown", reason: "foreground_work_stale" },
      { state: "unknown", reason: "background_work_stale" },
    ]);
    const snapshot = store.readProjectSnapshot({ now: projectedAt });
    expect(
      snapshot.needsAttention.map((session) => session.activity.reason),
    ).toEqual(
      expect.arrayContaining([
        "terminal_missing",
        "foreground_work_stale",
        "background_work_stale",
      ]),
    );
    expect(snapshot.projects.all).toMatchObject({
      currentCount: 3,
      needsAttentionCount: 3,
      recentCount: 1,
    });
    expect(snapshot.recent.items[0]?.activity).toMatchObject({
      state: "done",
      reason: "idle_grace_elapsed",
    });
    store.close();
  });

  it("paginates only terminal history with stable timestamp ties and opaque cursors", () => {
    const store = new RelayStore();
    for (let index = 0; index < 137; index += 1) {
      const identity = register(store, {
        suffix: `history_tie_${String(index).padStart(2, "0")}_12345678`,
        projectPath: "/synthetic/deep-history/project",
        harness: (["codex", "claude", "cursor"] as const)[index % 3]!,
        at: "2026-08-13T12:00:00.000Z",
      });
      applyState(store, identity, index % 2 === 0 ? "done" : "ended");
    }
    const current = register(store, {
      suffix: "history_current_12345678",
      projectPath: "/synthetic/deep-history/project",
    });
    applyState(store, current, "working", "2026-08-13T12:09:59.000Z");

    let cursor: string | undefined;
    const collected: string[] = [];
    do {
      const page = store.readProjectSnapshot({
        historyLimit: 13,
        ...(cursor === undefined ? {} : { historyCursor: cursor }),
        now: READ_AT,
      });
      expect(
        page.currentByHarness.flatMap((group) => group.sessions),
      ).toHaveLength(1);
      collected.push(...page.recent.items.map((session) => session.sessionKey));
      cursor = page.recent.nextCursor;
    } while (cursor !== undefined);
    expect(collected).toHaveLength(137);
    expect(new Set(collected).size).toBe(137);

    const repeated = store.readProjectSnapshot({
      historyLimit: 100,
      now: READ_AT,
    });
    expect(repeated.recent.items.map((session) => session.sessionKey)).toEqual(
      collected.slice(0, 100),
    );
    const opaque = store.readProjectSnapshot({
      historyLimit: 13,
      now: READ_AT,
    }).recent.nextCursor!;
    expect(opaque).toMatch(/^arc1_[A-Za-z0-9_-]+$/u);
    expect(opaque).not.toContain("2026");
    expect(opaque).not.toContain("session_project_read");
    expect(() =>
      store.readProjectSnapshot({
        historyCursor: `${opaque.slice(0, -1)}x`,
        historyLimit: 13,
        now: READ_AT,
      }),
    ).toThrowError(ProjectReadError);
    expectProjectReadError(
      () =>
        store.readProjectSnapshot({
          harness: "codex",
          historyCursor: opaque,
          historyLimit: 13,
          now: READ_AT,
        }),
      "invalid_cursor",
    );
    expectProjectReadError(
      () =>
        store.readProjectSnapshot({
          historyCursor: opaque,
          historyLimit: 13,
          now: "2026-08-14T12:10:00.001Z",
        }),
      "stale_cursor",
    );
    store.close();
  });

  it("rejects stale history pages after concurrent changes without omission or duplication", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-project-read-"),
    );
    const databasePath = join(directory, "relay.sqlite");
    const store = new RelayStore(databasePath);
    for (let index = 0; index < 4; index += 1) {
      const identity = register(store, {
        suffix: `stale_history_${String(index)}_12345678`,
        projectPath: "/synthetic/stale-history/project",
      });
      applyState(store, identity, "done");
    }
    const first = store.readProjectSnapshot({ historyLimit: 2, now: READ_AT });
    const cursor = first.recent.nextCursor!;
    const concurrentStore = new RelayStore(databasePath);
    const concurrent = register(concurrentStore, {
      suffix: "stale_history_concurrent_12345678",
      projectPath: "/synthetic/stale-history/project",
    });
    applyState(concurrentStore, concurrent, "done");
    concurrentStore.close();
    expectProjectReadError(
      () =>
        store.readProjectSnapshot({
          historyLimit: 2,
          historyCursor: cursor,
          now: READ_AT,
        }),
      "stale_cursor",
    );
    store.close();
  });

  it("uses server receive order deterministically under clock skew and out-of-order native sequences", () => {
    const store = new RelayStore();
    const identity = register(store, {
      suffix: "clock_skew_ordering_12345678",
      projectPath: "/synthetic/clock-skew/project",
      at: "2026-08-13T12:00:00.000Z",
    });
    const session = store.getSession(identity, "2026-08-13T12:00:00.000Z")!;
    const ingest = (
      eventId: string,
      type: "turn.started" | "turn.stopped",
      sequence: number,
      occurredAt: string,
      receivedAt: string,
    ) =>
      store.ingestEvent(
        {
          schema: "agent-attention.v1",
          eventId,
          occurredAt,
          sequence,
          ...identity,
          bridgeSessionId: session.bridgeSessionId,
          surface: session.surface,
          harnessVersion: session.harnessVersion,
          project: session.project,
          type,
          capabilities: session.capabilities,
        },
        receivedAt,
      );
    ingest(
      "event_project_future_clock_12345678",
      "turn.started",
      5,
      "2030-01-01T00:00:00.000Z",
      "2026-08-13T12:01:00.000Z",
    );
    ingest(
      "event_project_late_sequence_12345678",
      "turn.stopped",
      4,
      "2020-01-01T00:00:00.000Z",
      "2026-08-13T12:02:00.000Z",
    );
    const snapshot = store.readProjectSnapshot({
      now: "2026-08-13T12:02:00.000Z",
    });
    expect(snapshot.currentByHarness[0]?.sessions[0]).toMatchObject({
      lastSeenAt: "2026-08-13T12:02:00.000Z",
      activity: {
        state: "idle",
        lastObservedAt: "2026-08-13T12:02:00.000Z",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("2030-01-01");
    expect(
      store.getSession(identity, "2026-08-13T12:02:00.000Z")?.lastSequence,
    ).toBe(5);
    store.close();
  });

  it("coalesces bounded pull notifications and resumes across daemon restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-project-read-"),
    );
    const databasePath = join(directory, "relay.sqlite");
    const store = new RelayStore(databasePath);
    const initial = store.readProjectSnapshot({ now: READ_AT });
    expect(initial).toMatchObject({
      empty: true,
      needsAttention: [],
      recent: { items: [] },
    });
    for (let index = 0; index < 8; index += 1) {
      const identity = register(store, {
        suffix: `changes_restart_${String(index)}_12345678`,
        projectPath: "/synthetic/change-stream/project",
      });
      applyState(
        store,
        identity,
        "working",
        new Date(Date.parse("2026-08-13T12:00:00.000Z") + index).toISOString(),
      );
    }
    const bounded = store.readProjectChanges({
      cursor: initial.changeCursor,
      limit: 10,
      now: READ_AT,
    });
    expect(bounded.invalidations).toHaveLength(1);
    expect(bounded.invalidations[0]).toMatchObject({
      coalescedCount: 10,
      kinds: expect.arrayContaining(["session", "activity"]),
    });
    expect(bounded.hasMore).toBe(true);
    expect(JSON.stringify(bounded)).not.toContain("session_project_read");
    const restartCursor = store.readProjectSnapshot({
      now: READ_AT,
    }).changeCursor;
    store.close();

    const restarted = new RelayStore(databasePath);
    expect(
      restarted.readProjectChanges({ cursor: restartCursor, now: READ_AT }),
    ).toMatchObject({ invalidations: [], hasMore: false });
    const fresh = restarted.readProjectSnapshot({ now: READ_AT });
    expect(fresh.empty).toBe(false);
    restarted.close();
  });

  it("rejects a change cursor whose retained invalidations were fully pruned", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-project-read-"),
    );
    const databasePath = join(directory, "relay.sqlite");
    const store = new RelayStore(databasePath);
    const cursor = store.readProjectSnapshot({ now: READ_AT }).changeCursor;
    register(store, {
      suffix: "fully_pruned_changes_12345678",
      projectPath: "/synthetic/pruned-change/project",
    });
    store.close();
    const database = new Database(databasePath);
    database.exec("DELETE FROM web_changes");
    database.close();

    const restarted = new RelayStore(databasePath);
    expectProjectReadError(
      () => restarted.readProjectChanges({ cursor, now: READ_AT }),
      "stale_cursor",
    );
    restarted.close();
  });

  it("fails closed instead of returning an incomplete current set", () => {
    const store = new RelayStore();
    for (let index = 0; index < 1_001; index += 1) {
      register(store, {
        suffix: `capacity_${String(index).padStart(4, "0")}_12345678`,
        projectPath: "/synthetic/capacity/project",
      });
    }
    expectProjectReadError(
      () => store.readProjectSnapshot({ now: READ_AT }),
      "complete_set_capacity_exceeded",
    );
    store.close();
  });

  it("bounds many-project load while preserving the All projects aggregate", () => {
    const store = new RelayStore();
    for (let index = 0; index < 240; index += 1) {
      const identity = register(store, {
        suffix: `load_${String(index).padStart(3, "0")}_12345678`,
        projectPath: `/synthetic/load/project-${String(index).padStart(3, "0")}`,
        harness: (["codex", "claude", "cursor"] as const)[index % 3]!,
        at: new Date(
          Date.parse("2026-08-13T12:00:00.000Z") + index,
        ).toISOString(),
      });
      applyState(store, identity, index % 4 === 0 ? "unknown" : "done");
    }
    const snapshot = store.readProjectSnapshot({
      historyLimit: 10,
      now: READ_AT,
    });
    expect(snapshot.projects).toMatchObject({
      totalCount: 240,
      truncated: true,
      all: { totalCount: 240, currentCount: 60, recentCount: 180 },
    });
    expect(snapshot.projects.items).toHaveLength(200);
    expect(snapshot.needsAttention).toHaveLength(60);
    expect(snapshot.recent.items).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(350_000);
    store.close();
  });

  it("filters current, attention, and history by bounded safe-field search", () => {
    const store = new RelayStore();
    const billing = register(store, {
      suffix: "search_billing_12345678",
      projectPath: "/synthetic/search/billing",
      harness: "claude",
    });
    const checkout = register(store, {
      suffix: "search_checkout_12345678",
      projectPath: "/synthetic/search/checkout",
      harness: "codex",
    });
    const finished = register(store, {
      suffix: "search_finished_12345678",
      projectPath: "/synthetic/search/billing",
      harness: "cursor",
    });
    const finishedTwo = register(store, {
      suffix: "search_finished_two_12345678",
      projectPath: "/synthetic/search/billing",
      harness: "cursor",
    });
    applyState(store, billing, "working", "2026-08-13T12:09:50.000Z");
    applyState(store, checkout, "working", "2026-08-13T12:09:51.000Z");
    applyState(store, finished, "ended", "2026-08-13T12:09:40.000Z");
    applyState(store, finishedTwo, "ended", "2026-08-13T12:09:39.000Z");

    const unfiltered = store.readProjectSnapshot({
      historyLimit: 10,
      now: READ_AT,
    });
    expect(
      unfiltered.currentByHarness.flatMap((group) => group.sessions),
    ).toHaveLength(2);
    expect(unfiltered.recent.items.length).toBeGreaterThanOrEqual(2);

    const byHarness = store.readProjectSnapshot({
      search: "claude",
      historyLimit: 10,
      now: READ_AT,
    });
    expect(byHarness.filters.search).toBe("claude");
    const current = byHarness.currentByHarness.flatMap(
      (group) => group.sessions,
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.harness).toBe("claude");
    expect(current[0]?.projectLabel).toBe("billing");
    expect(current[0]?.sessionName).toMatch(/^[a-z]+-[a-z]+-\d{2}$/u);
    expect(byHarness.recent.items).toHaveLength(0);

    const byLabel = store.readProjectSnapshot({
      search: "checkout",
      historyLimit: 10,
      now: READ_AT,
    });
    expect(
      byLabel.currentByHarness.flatMap((group) => group.sessions),
    ).toHaveLength(1);
    expect(
      byLabel.currentByHarness.flatMap((group) => group.sessions)[0]
        ?.projectLabel,
    ).toBe("checkout");

    const recentPage = store.readProjectSnapshot({
      search: unfiltered.recent.items[0]!.sessionName,
      historyLimit: 1,
      now: READ_AT,
    });
    expect(recentPage.filters.search).toBe(
      unfiltered.recent.items[0]!.sessionName,
    );
    expect(recentPage.recent.items).toHaveLength(1);
    expect(recentPage.recent.items[0]?.sessionKey).toBe(
      unfiltered.recent.items[0]?.sessionKey,
    );

    expect(() =>
      store.readProjectSnapshot({
        search: "a".repeat(65),
        now: READ_AT,
      }),
    ).toThrow(/project search query is invalid/u);

    const first = store.readProjectSnapshot({
      search: "cursor",
      historyLimit: 1,
      now: READ_AT,
    });
    expect(
      first.recent.items.length + first.currentByHarness.length,
    ).toBeGreaterThan(0);
    expect(first.filters.search).toBe("cursor");
    if (first.recent.nextCursor !== undefined) {
      const searchCursor = first.recent.nextCursor;
      expect(() =>
        store.readProjectSnapshot({
          historyLimit: 1,
          historyCursor: searchCursor,
          now: READ_AT,
        }),
      ).toThrow(/project cursor does not match/u);
      const second = store.readProjectSnapshot({
        search: "cursor",
        historyLimit: 1,
        historyCursor: searchCursor,
        now: READ_AT,
      });
      expect(second.recent.items[0]?.sessionKey).not.toBe(
        first.recent.items[0]?.sessionKey,
      );
    }
    store.close();
  });
});
