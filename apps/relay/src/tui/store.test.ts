import { describe, expect, it, vi } from "vitest";

import type { ProjectReadSnapshotV1 } from "@agent-relay/core";

import type { WebAttentionItemV1 } from "../web-contract.js";

import { DashboardClientError } from "./client.js";
import type { DashboardClient, DashboardSnapshotBundle } from "./client.js";
import { handleDashboardKey } from "./input.js";
import { DashboardStore, STALE_CONTACT_MS } from "./store.js";

const SESSION_KEY = "0123456789abcdef01234567";

function snapshot(): ProjectReadSnapshotV1 {
  const session = {
    schema: "agent-relay-project-session.v1" as const,
    sessionKey: SESSION_KEY,
    projectKey: `prj_${"a".repeat(48)}`,
    projectLabel: "checkout-service",
    harness: "codex" as const,
    surface: "cli" as const,
    lastSeenAt: "2026-08-14T11:59:30.000Z",
    knownInFlightWork: { count: 1 },
    pendingInteraction: { state: "waiting" as const, count: 1 },
    deliveryHealth: { muted: false },
    activity: {
      schema: "agent-relay-session-activity.v1" as const,
      policyVersion: "ar5.1.v1" as const,
      fixtureSetVersion: "ar5.1-2026-08-13" as const,
      state: "needs_input" as const,
      stateLabel: "Needs input" as const,
      confidence: "confirmed" as const,
      reason: "request_open" as const,
      reasonText: "An operator question is open",
      source: "relay_interaction" as const,
      lastObservedAt: "2026-08-14T11:59:30.000Z",
      inFlightCount: 1,
      requestCount: 1,
      muted: false,
      epoch: 1,
      lastAppliedSequence: 4,
    },
  };
  return {
    schema: "agent-relay-project-read.v1",
    generatedAt: "2026-08-14T12:00:00.000Z",
    selectedProjectKey: "all",
    filters: {},
    changeCursor: "cursor_tui_snapshot_0001",
    projects: {
      all: {
        schema: "agent-relay-project-summary.v1",
        projectKey: "all",
        label: "All projects",
        currentCount: 1,
        needsAttentionCount: 1,
        needsInputCount: 1,
        failedOrUnknownCount: 0,
        recentCount: 0,
        totalCount: 1,
      },
      items: [],
      totalCount: 1,
      truncated: false,
    },
    needsAttention: [session],
    currentByHarness: [{ harness: "codex", sessions: [session] }],
    recent: { items: [] },
    empty: false,
    limits: {
      historyPageSize: 25,
      historyPageSizeMax: 100,
      completeSetMax: 1_000,
      projectSummaryMax: 200,
      changeBatchMax: 200,
    },
  };
}

function request(): WebAttentionItemV1 {
  return {
    schema: "agent-relay-web-attention.v1",
    requestId: "request_tui_text_1",
    eventId: "evt_tui_text_1",
    sessionKey: SESSION_KEY,
    harness: "codex",
    requestKind: "input",
    state: "open",
    promptPreview: "Add a synthetic release note",
    expiresAt: "2026-08-14T13:00:00.000Z",
    supportedActions: ["respond-text"],
    options: [],
    form: { kind: "text", minLength: 1, maxLength: 120, multiline: false },
  };
}

function questionSetRequest(): WebAttentionItemV1 {
  return {
    schema: "agent-relay-web-attention.v1",
    requestId: "request_tui_set_01",
    eventId: "evt_tui_set_01",
    sessionKey: SESSION_KEY,
    harness: "codex",
    requestKind: "question-set",
    state: "open",
    promptPreview: "Synthetic release questionnaire",
    expiresAt: "2026-08-14T13:00:00.000Z",
    supportedActions: ["answer-question-set"],
    options: [],
    form: {
      kind: "question-set",
      title: "Synthetic release questionnaire",
      questions: [
        {
          questionId: "question_confirm_tui01",
          kind: "confirm",
          prompt: "Proceed with the synthetic release?",
          confirm: { optionId: "option_proceed_tui01", label: "Proceed" },
          decline: { optionId: "option_stop_tui01", label: "Stop" },
        },
        {
          questionId: "question_note_tui01",
          kind: "free-text",
          prompt: "Add a synthetic release note",
          minLength: 3,
          maxLength: 80,
          multiline: false,
        },
      ],
    },
  };
}

function bundle(item: WebAttentionItemV1 = request()): DashboardSnapshotBundle {
  return {
    snapshot: snapshot(),
    requests: [item],
    capabilities: new Map([
      [
        SESSION_KEY,
        {
          supportedActions: ["details", "continue", "mute"],
          latestEventId: "evt_tui_text_1",
        },
      ],
    ]),
  };
}

function client(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    origin: "http://127.0.0.1:4317",
    loadSnapshot: async () => bundle(),
    pollChanges: async () => ({
      schema: "agent-relay-project-changes.v1",
      cursor: "cursor_tui_snapshot_0001",
      invalidations: [],
      hasMore: false,
    }),
    loadEvent: async () => {
      throw new Error("unused");
    },
    resolveRequest: async () => ({
      ok: true,
      status: 200,
      requestState: "answered",
      resolvedBy: "tui",
    }),
    runSessionAction: async () => ({ ok: true, status: 200 }),
    ...overrides,
  };
}

describe("terminal dashboard store", () => {
  it("loads the shared project read model without inventing state", async () => {
    const store = new DashboardStore({
      client: client(),
      pollIntervalMs: 60_000,
    });
    await store.start();
    expect(store.state.connection).toBe("online");
    expect(store.state.rail[0]?.label).toBe("All projects");
    expect(store.state.selectedSession?.activity.state).toBe("needs_input");
    expect(store.state.selectedRequest?.requestId).toBe("request_tui_text_1");
    await store.close();
  });

  it("filters attention and current rows, not only recent history", async () => {
    const store = new DashboardStore({
      client: client(),
      pollIntervalMs: 60_000,
    });
    await store.start();
    expect(store.state.list.length).toBeGreaterThan(0);
    store.setQuery("zzz-no-match");
    expect(store.state.list).toEqual([]);
    store.setQuery("checkout");
    expect(store.state.list.length).toBeGreaterThan(0);
    await store.close();
  });

  it("opens detail without taking the list cursor", async () => {
    const store = new DashboardStore({
      client: client(),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.state.selectedRequest = undefined;
    store.state.pane = "list";
    store.activateSelection();
    expect(store.state.detailOpen).toBe(true);
    expect(store.state.pane).toBe("list");
    await store.close();
  });

  it("bumps revision when navigation mutates the same state object", async () => {
    const store = new DashboardStore({
      client: client(),
      pollIntervalMs: 60_000,
    });
    await store.start();
    const before = store.revision;
    const snapshot = store.state;
    store.moveList(1);
    expect(store.state).toBe(snapshot);
    expect(store.revision).toBeGreaterThan(before);
    await store.close();
  });

  it("binds a submit to the exact request and session and ignores a second submit", async () => {
    const calls: Array<{ requestId: string; sessionKey: string }> = [];
    let resolveFirst:
      | ((value: {
          ok: boolean;
          status: number;
          requestState: string;
          resolvedBy: string;
        }) => void)
      | undefined;
    const store = new DashboardStore({
      client: client({
        resolveRequest: async (requestId, sessionKey) => {
          calls.push({ requestId, sessionKey });
          return await new Promise((resolve) => {
            resolveFirst = resolve;
          });
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.openForm(store.state.selectedRequest!);
    store.updateDraft({ value: "Ship the synthetic note" });
    const first = store.submitForm();
    const second = store.submitForm();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      requestId: "request_tui_text_1",
      sessionKey: SESSION_KEY,
    });
    resolveFirst?.({
      ok: true,
      status: 200,
      requestState: "answered",
      resolvedBy: "tui",
    });
    await first;
    await second;
    expect(calls).toHaveLength(1);
    expect(store.state.status).toBe("Answer committed.");
    await store.close();
  });

  it("holds live updates while an unsent answer is open", async () => {
    let loads = 0;
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => {
          loads += 1;
          return bundle();
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.openForm(store.state.selectedRequest!);
    store.updateDraft({ value: "draft" });
    await store.refresh();
    expect(store.state.pendingUpdates).toBe(1);
    expect(store.state.draft?.values["value"]).toBe("draft");
    expect(loads).toBe(2);
    await store.close();
  });

  it("types q into an open answer and still quits on the dedicated quit key", async () => {
    const store = new DashboardStore({
      client: client(),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.openForm(store.state.selectedRequest!);
    expect(await handleDashboardKey(store, { name: "char", value: "q" })).toBe(
      "continue",
    );
    expect(store.state.draft?.values["value"]).toBe("q");
    expect(await handleDashboardKey(store, { name: "quit" })).toBe("quit");
    await store.close();
  });

  it("makes cancel, stale, and delivery failure explicit", async () => {
    const store = new DashboardStore({
      client: client({
        resolveRequest: async () => ({ ok: false, status: 409 }),
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.openForm(store.state.selectedRequest!);
    store.updateDraft({ value: "late" });
    await store.submitForm();
    expect(store.state.draft?.status).toContain("stale");
    store.cancelForm();
    expect(store.state.draft).toBeUndefined();
    expect(store.state.pane).toBe("list");
    await store.close();
  });

  it("answers a questionnaire by keyboard on the exact request", async () => {
    const calls: Array<{
      requestId: string;
      sessionKey: string;
      response: unknown;
    }> = [];
    const item = questionSetRequest();
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => bundle(item),
        resolveRequest: async (requestId, sessionKey, response) => {
          calls.push({ requestId, sessionKey, response });
          return {
            ok: true,
            status: 200,
            requestState: "answered",
            resolvedBy: "tui",
          };
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    expect(await handleDashboardKey(store, { name: "char", value: "a" })).toBe(
      "continue",
    );
    expect(store.state.pane).toBe("form");
    expect(await handleDashboardKey(store, { name: "char", value: "j" })).toBe(
      "continue",
    );
    expect(store.state.draft?.values["question_confirm_tui01"]).toBeUndefined();
    expect(await handleDashboardKey(store, { name: "space" })).toBe("continue");
    expect(store.state.draft?.values["question_confirm_tui01"]).toBe(
      "option_proceed_tui01",
    );
    expect(await handleDashboardKey(store, { name: "down" })).toBe("continue");
    expect(await handleDashboardKey(store, { name: "down" })).toBe("continue");
    for (const value of ["s", "h", "i", "p"]) {
      expect(await handleDashboardKey(store, { name: "char", value })).toBe(
        "continue",
      );
    }
    expect(store.state.draft?.values["question_note_tui01"]).toBe("ship");
    expect(await handleDashboardKey(store, { name: "enter" })).toBe("continue");
    expect(calls).toEqual([
      {
        requestId: "request_tui_set_01",
        sessionKey: SESSION_KEY,
        response: {
          kind: "question-set",
          answers: [
            {
              questionId: "question_confirm_tui01",
              kind: "confirm",
              optionId: "option_proceed_tui01",
            },
            {
              questionId: "question_note_tui01",
              kind: "free-text",
              text: "ship",
            },
          ],
        },
      },
    ]);
    await store.close();
  });

  it("keeps an incomplete questionnaire local until every field is answered", async () => {
    const calls: unknown[] = [];
    const item = questionSetRequest();
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => bundle(item),
        resolveRequest: async (...args) => {
          calls.push(args);
          return { ok: true, status: 200, requestState: "answered" };
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    store.openForm(item);
    expect(await handleDashboardKey(store, { name: "space" })).toBe("continue");
    expect(await handleDashboardKey(store, { name: "enter" })).toBe("continue");
    expect(calls).toEqual([]);
    expect(store.state.pane).toBe("form");
    expect(store.state.draft?.status).toContain("still needs an answer");
    expect(store.state.draft?.fieldIndex).toBe(2);
    await store.close();
  });

  it("stays disconnected without a trusted snapshot when the daemon is down", async () => {
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => {
          throw new DashboardClientError(
            0,
            "dashboard-daemon-unavailable",
            "down",
          );
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    expect(store.state.connection).toBe("disconnected");
    expect(store.state.snapshot).toBeUndefined();
    expect(store.state.status).toContain("could not be reached");
    await store.close();
  });

  it("reconnects from a failed first load when r fetches a fresh snapshot", async () => {
    let attempts = 0;
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new DashboardClientError(
              0,
              "dashboard-daemon-unavailable",
              "down",
            );
          }
          return bundle();
        },
      }),
      pollIntervalMs: 60_000,
    });
    await store.start();
    expect(store.state.connection).toBe("disconnected");
    expect(await handleDashboardKey(store, { name: "char", value: "r" })).toBe(
      "continue",
    );
    expect(store.state.connection).toBe("online");
    expect(store.state.selectedSession?.sessionKey).toBe(SESSION_KEY);
    await store.close();
  });

  it("keeps the last snapshot while reconnecting after a change-stream failure", async () => {
    const store = new DashboardStore({
      client: client({
        pollChanges: async () => {
          throw new DashboardClientError(
            0,
            "dashboard-daemon-unavailable",
            "down",
          );
        },
      }),
      pollIntervalMs: 15,
    });
    await store.start();
    expect(store.state.connection).toBe("online");
    await waitUntil(() => store.state.connection === "reconnecting");
    expect(store.state.selectedSession?.sessionKey).toBe(SESSION_KEY);
    await store.close();
  });

  it("recovers to online after a later poll succeeds", async () => {
    let polls = 0;
    const store = new DashboardStore({
      client: client({
        pollChanges: async () => {
          polls += 1;
          if (polls === 1) {
            throw new DashboardClientError(
              0,
              "dashboard-daemon-unavailable",
              "down",
            );
          }
          return {
            schema: "agent-relay-project-changes.v1",
            cursor: "cursor_tui_snapshot_0002",
            invalidations: [],
            hasMore: false,
          };
        },
      }),
      pollIntervalMs: 15,
    });
    await store.start();
    await waitUntil(() => store.state.connection === "reconnecting");
    await waitUntil(() => store.state.connection === "online");
    expect(store.state.selectedSession?.sessionKey).toBe(SESSION_KEY);
    await store.close();
  });

  it("marks a quiet online stream stale after 30 seconds without dropping the snapshot", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-08-14T12:00:00.000Z");
    const store = new DashboardStore({
      client: client(),
      now: () => now,
      pollIntervalMs: 60_000,
    });
    try {
      await store.start();
      expect(store.state.connection).toBe("online");
      const sessionKey = store.state.selectedSession?.sessionKey;
      now += STALE_CONTACT_MS;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.state.connection).toBe("stale");
      expect(store.state.selectedSession?.sessionKey).toBe(sessionKey);
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  it("does not let a late failed poll overwrite a successful reconnect", async () => {
    let rejectPoll: ((error: DashboardClientError) => void) | undefined;
    const store = new DashboardStore({
      client: client({
        pollChanges: async () =>
          await new Promise((_, reject) => {
            rejectPoll = reject;
          }),
      }),
      pollIntervalMs: 15,
    });
    await store.start();
    await waitUntil(() => rejectPoll !== undefined);
    expect(await handleDashboardKey(store, { name: "char", value: "r" })).toBe(
      "continue",
    );
    expect(store.state.connection).toBe("online");
    rejectPoll?.(
      new DashboardClientError(0, "dashboard-daemon-unavailable", "late"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.state.connection).toBe("online");
    expect(store.state.snapshot).toBeDefined();
    await store.close();
  });

  it("discards the snapshot when the protected credential is rejected", async () => {
    let polls = 0;
    const store = new DashboardStore({
      client: client({
        pollChanges: async () => {
          polls += 1;
          throw new DashboardClientError(401, "unauthorized", "rejected");
        },
      }),
      pollIntervalMs: 15,
    });
    await store.start();
    expect(store.state.connection).toBe("online");
    await waitUntil(() => store.state.connection === "disconnected");
    expect(store.state.snapshot).toBeUndefined();
    expect(store.state.selectedSession).toBeUndefined();
    expect(store.state.status).toContain(
      "rejected the private local credential",
    );
    expect(polls).toBeGreaterThan(0);
    await store.close();
  });

  it("refetches a fresh snapshot instead of guessing across a stale cursor", async () => {
    let loads = 0;
    const store = new DashboardStore({
      client: client({
        loadSnapshot: async () => {
          loads += 1;
          return bundle();
        },
        pollChanges: async () => {
          throw new DashboardClientError(409, "stale_cursor", "stale");
        },
      }),
      pollIntervalMs: 15,
    });
    await store.start();
    expect(loads).toBe(1);
    await waitUntil(() => loads >= 2);
    expect(store.state.connection).toBe("online");
    await store.close();
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for dashboard store condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
