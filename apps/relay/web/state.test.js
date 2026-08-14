import { describe, expect, it } from "vitest";

import {
  HISTORY_VIEW_MAX,
  appendHistoryPage,
  attentionAnnouncement,
  buildAttention,
  buildCurrentGroups,
  buildRail,
  buildResponse,
  describeHoldReason,
  describeTerminalRequest,
  escapeHtml,
  expiryHint,
  filterLoadedSessions,
  historySummary,
  indexSnapshotSessions,
  relativeTime,
  renderAttentionHtml,
  renderCurrentGroupsHtml,
  renderEventDetailHtml,
  renderHistoryRowsHtml,
  renderRailHtml,
  renderRequestHtml,
  renderSessionActionsHtml,
  renderTimelineHtml,
  sessionName,
  sessionReference,
  sessionTitle,
  shouldHoldUpdates,
  stateLabel,
} from "./state.js";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const HOSTILE = '<img src=x onerror="alert(1)">';

function activity(overrides = {}) {
  return {
    schema: "agent-relay-session-activity.v1",
    policyVersion: 1,
    fixtureSetVersion: 1,
    state: "working",
    stateLabel: "Working",
    confidence: "confirmed",
    reason: "prompt_submitted",
    reasonText: "A prompt was submitted",
    source: "harness_hook",
    lastObservedAt: "2026-08-14T11:59:30.000Z",
    inFlightCount: 0,
    requestCount: 0,
    muted: false,
    epoch: 1,
    lastAppliedSequence: 4,
    ...overrides,
  };
}

function session(overrides = {}) {
  const merged = {
    schema: "agent-relay-project-session.v1",
    sessionKey: "0123456789abcdef01234567",
    projectKey: `prj_${"a".repeat(48)}`,
    projectLabel: "checkout-service",
    harness: "codex",
    surface: "cli",
    lastSeenAt: "2026-08-14T11:59:30.000Z",
    knownInFlightWork: { count: 0 },
    pendingInteraction: { state: "none", count: 0 },
    deliveryHealth: { muted: false },
    ...overrides,
  };
  return { ...merged, activity: activity(overrides.activity ?? {}) };
}

function summary(overrides = {}) {
  return {
    schema: "agent-relay-project-summary.v1",
    projectKey: `prj_${"a".repeat(48)}`,
    label: "checkout-service",
    currentCount: 2,
    needsAttentionCount: 1,
    needsInputCount: 1,
    failedOrUnknownCount: 0,
    recentCount: 3,
    totalCount: 5,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schema: "agent-relay-project-read.v1",
    generatedAt: "2026-08-14T12:00:00.000Z",
    selectedProjectKey: "all",
    filters: {},
    changeCursor: "arc1_cursorvaluecursorvalue",
    projects: {
      all: summary({
        projectKey: "all",
        label: "All projects",
        currentCount: 2,
        needsAttentionCount: 1,
      }),
      items: [summary()],
      totalCount: 1,
      truncated: false,
    },
    needsAttention: [],
    currentByHarness: [],
    recent: { items: [] },
    empty: false,
    limits: {
      historyPageSize: 25,
      historyPageSizeMax: 100,
      completeSetMax: 1_000,
      projectSummaryMax: 200,
      changeBatchMax: 200,
    },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schema: "agent-relay-web-attention.v1",
    requestId: "request-one",
    eventId: "event-one",
    sessionKey: "0123456789abcdef01234567",
    harness: "codex",
    requestKind: "input",
    state: "open",
    promptPreview: "Which lane should this run take?",
    expiresAt: "2026-08-14T12:30:00.000Z",
    supportedActions: ["respond-text"],
    options: [],
    form: { kind: "text", minLength: 1, maxLength: 400, multiline: true },
    ...overrides,
  };
}

describe("safe rendering", () => {
  it("escapes markup metacharacters", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;",
    );
  });

  it("never emits raw operator-supplied markup in the rail", () => {
    const html = renderRailHtml(
      buildRail(
        snapshot({
          projects: {
            all: summary({ projectKey: "all", label: "All projects" }),
            items: [summary({ label: HOSTILE })],
            totalCount: 1,
            truncated: false,
          },
        }),
      ),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("never emits raw operator-supplied markup in attention cards", () => {
    const hostile = session({ projectLabel: HOSTILE });
    const view = buildAttention(snapshot({ needsAttention: [hostile] }), [
      request({
        promptPreview: HOSTILE,
        form: {
          kind: "single-select",
          options: [
            { optionId: "one", label: HOSTILE },
            { optionId: "two", label: "Safe" },
          ],
        },
      }),
    ]);
    const html = renderAttentionHtml(view, {
      now: NOW,
      capabilities: new Map(),
    });
    expect(html).not.toContain("<img");
    expect(html.match(/&lt;img/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("never emits raw operator-supplied markup in question sets", () => {
    const html = renderRequestHtml(
      request({
        requestKind: "question-set",
        form: {
          kind: "question-set",
          title: HOSTILE,
          questions: [
            {
              questionId: "q1",
              kind: "free-text",
              prompt: HOSTILE,
              minLength: 1,
              maxLength: 200,
              multiline: false,
            },
            {
              questionId: "q2",
              kind: "confirm",
              prompt: "Proceed?",
              confirm: { optionId: "yes", label: HOSTILE },
              decline: { optionId: "no", label: "No" },
            },
          ],
        },
      }),
      NOW,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("labels every free-text question control", () => {
    const html = renderRequestHtml(
      request({
        requestId: "request-labelled",
        requestKind: "question-set",
        form: {
          kind: "question-set",
          title: "Release questions",
          questions: [
            {
              questionId: "note",
              kind: "free-text",
              prompt: "Add a release note",
              minLength: 1,
              maxLength: 200,
              multiline: false,
            },
          ],
        },
      }),
      NOW,
    );
    expect(html).toContain('<label for="q-request-labelled-note">');
    expect(html).toContain('id="q-request-labelled-note"');
  });

  it("never emits raw operator-supplied markup in history rows", () => {
    const html = renderHistoryRowsHtml(
      [session({ projectLabel: HOSTILE, activity: { state: "done" } })],
      { now: NOW, capabilities: new Map() },
    );
    expect(html).not.toContain("<img");
  });

  it("never emits raw operator-supplied markup in timeline rows", () => {
    const html = renderTimelineHtml(
      [
        {
          id: "timeline-1",
          kind: "hook-event",
          at: "2026-08-14T11:00:00.000Z",
          status: HOSTILE,
          label: HOSTILE,
        },
      ],
      { now: NOW },
    );
    expect(html).not.toContain("<img");
  });
});

describe("session identity", () => {
  it("renders a readable name derived only from the opaque key", () => {
    const title = sessionTitle(session());
    expect(title).toMatch(/^[a-z]+-[a-z]+-\d{2}$/u);
    expect(title).not.toContain("0123456789abcdef");
  });

  it("keeps a name stable across snapshots and distinct across sessions", () => {
    expect(sessionTitle(session({ activity: { state: "idle" } }))).toBe(
      sessionTitle(session()),
    );
    expect(sessionName("0123456789abcdef01234567")).toBe(
      sessionTitle(session()),
    );
    expect(sessionName("fedcba9876543210fedcba98")).not.toBe(
      sessionTitle(session()),
    );
  });

  it("keeps the exact opaque key available for precise correlation", () => {
    expect(sessionReference(session())).toBe("0123456789abcdef01234567");
  });

  it("never fails on a malformed key", () => {
    expect(sessionName("")).toMatch(/^[a-z]+-[a-z]+-\d{2}$/u);
  });
});

describe("clock formatting", () => {
  it("clamps a skewed future timestamp instead of inventing state", () => {
    expect(relativeTime("2026-08-14T12:05:00.000Z", NOW)).toBe("just now");
  });

  it("formats elapsed activity", () => {
    expect(relativeTime("2026-08-14T11:58:00.000Z", NOW)).toBe("2m ago");
    expect(relativeTime("2026-08-13T12:00:00.000Z", NOW)).toBe("1d ago");
    expect(relativeTime("not-a-time", NOW)).toBe("unknown");
  });

  it("marks an elapsed expiry as a browser-clock hint only", () => {
    expect(expiryHint("2026-08-14T11:59:00.000Z", NOW)).toEqual({
      text: "past its expiry on this clock",
      elapsed: true,
    });
    expect(expiryHint("2026-08-14T12:20:00.000Z", NOW).elapsed).toBe(false);
  });

  it("keeps the answer control usable when the browser clock says expired", () => {
    const html = renderRequestHtml(
      request({ expiresAt: "2026-08-14T11:00:00.000Z" }),
      NOW,
    );
    expect(html).toContain("past its expiry on this clock");
    expect(html).toContain("Submit response");
    expect(html).not.toContain('<button type="submit" disabled');
  });
});

describe("project rail", () => {
  it("puts the All projects aggregate first and marks the selection", () => {
    const rail = buildRail(
      snapshot({ selectedProjectKey: `prj_${"a".repeat(48)}` }),
    );
    expect(rail.items[0].projectKey).toBe("all");
    expect(rail.items[0].selected).toBe(false);
    expect(rail.items[1].selected).toBe(true);
    expect(rail.selectedMissing).toBe(false);
  });

  it("reports a truncated project window and a missing selection", () => {
    const rail = buildRail(
      snapshot({
        selectedProjectKey: `prj_${"b".repeat(48)}`,
        projects: {
          all: summary({ projectKey: "all", label: "All projects" }),
          items: [summary()],
          totalCount: 640,
          truncated: true,
        },
      }),
    );
    expect(rail.truncated).toBe(true);
    expect(rail.totalCount).toBe(640);
    expect(rail.selectedMissing).toBe(true);
  });

  it("marks the selected rail item with aria-current", () => {
    const html = renderRailHtml(buildRail(snapshot()));
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("needing attention");
  });
});

describe("needs attention", () => {
  const attentionSession = session({
    sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
    activity: { state: "needs_input", stateLabel: "Needs input" },
  });

  it("correlates requests to the exact session key", () => {
    const view = buildAttention(
      snapshot({ needsAttention: [attentionSession] }),
      [
        request({ sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa" }),
        request({ requestId: "other", sessionKey: "ffffffffffffffffffffffff" }),
      ],
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0].requests.map((item) => item.requestId)).toEqual([
      "request-one",
    ]);
    expect(view.outOfScopeRequestCount).toBe(1);
  });

  it("keeps a canonical attention session without an open request", () => {
    const failed = session({
      sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
      activity: { state: "failed", stateLabel: "Failed" },
    });
    const view = buildAttention(snapshot({ needsAttention: [failed] }), []);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].requests).toEqual([]);
    const html = renderAttentionHtml(view, {
      now: NOW,
      capabilities: new Map(),
    });
    expect(html).toContain("This session needs a look: Failed.");
  });

  it("surfaces a request whose session has not yet moved to needs input", () => {
    const working = session({ sessionKey: "cccccccccccccccccccccccc" });
    const view = buildAttention(
      snapshot({
        currentByHarness: [{ harness: "codex", sessions: [working] }],
      }),
      [request({ sessionKey: "cccccccccccccccccccccccc" })],
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0].session.sessionKey).toBe("cccccccccccccccccccccccc");
  });

  it("orders several requests for one session by expiry then id", () => {
    const view = buildAttention(
      snapshot({ needsAttention: [attentionSession] }),
      [
        request({
          requestId: "late",
          sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
          expiresAt: "2026-08-14T13:00:00.000Z",
        }),
        request({
          requestId: "early",
          sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
          expiresAt: "2026-08-14T12:10:00.000Z",
        }),
      ],
    );
    expect(view.items[0].requests.map((item) => item.requestId)).toEqual([
      "early",
      "late",
    ]);
  });

  it("keeps a request answerable when its session is only on a loaded history page", () => {
    const historic = session({
      sessionKey: "999999999999999999999999",
      activity: { state: "done", stateLabel: "Done" },
    });
    const scoped = buildAttention(
      snapshot(),
      [request({ sessionKey: "999999999999999999999999" })],
      new Map([[historic.sessionKey, historic]]),
    );
    expect(scoped.items).toHaveLength(1);
    expect(scoped.outOfScopeRequestCount).toBe(0);
    const unscoped = buildAttention(snapshot(), [
      request({ sessionKey: "999999999999999999999999" }),
    ]);
    expect(unscoped.items).toHaveLength(0);
    expect(unscoped.outOfScopeRequestCount).toBe(1);
  });

  it("preserves the server order of attention sessions", () => {
    const first = session({ sessionKey: "111111111111111111111111" });
    const second = session({ sessionKey: "222222222222222222222222" });
    const view = buildAttention(
      snapshot({ needsAttention: [first, second] }),
      [],
    );
    expect(view.items.map(({ session: item }) => item.sessionKey)).toEqual([
      "111111111111111111111111",
      "222222222222222222222222",
    ]);
  });
});

describe("current sessions", () => {
  it("groups by harness in server order and flags attention members", () => {
    const attentionSession = session({
      sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
      activity: { state: "needs_input", stateLabel: "Needs input" },
    });
    const plain = session({ sessionKey: "dddddddddddddddddddddddd" });
    const groups = buildCurrentGroups(
      snapshot({
        needsAttention: [attentionSession],
        currentByHarness: [
          { harness: "codex", sessions: [attentionSession, plain] },
          {
            harness: "claude",
            sessions: [
              session({
                sessionKey: "eeeeeeeeeeeeeeeeeeeeeeee",
                harness: "claude",
              }),
            ],
          },
        ],
      }),
    );
    expect(groups.map((group) => group.harness)).toEqual(["codex", "claude"]);
    expect(groups[0].sessions[0].needsAttention).toBe(true);
    expect(groups[0].sessions[1].needsAttention).toBe(false);
  });

  it("never renders a second answer form for an attention session", () => {
    const attentionSession = session({
      sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
      activity: { state: "needs_input", stateLabel: "Needs input" },
    });
    const html = renderCurrentGroupsHtml(
      buildCurrentGroups(
        snapshot({
          needsAttention: [attentionSession],
          currentByHarness: [
            { harness: "codex", sessions: [attentionSession] },
          ],
        }),
      ),
      { now: NOW, capabilities: new Map() },
    );
    expect(html).not.toContain("data-response-form");
    expect(html).toContain("data-goto-attention");
  });

  it("shows canonical state, in-flight work, pending interaction, and mute", () => {
    const busy = session({
      knownInFlightWork: { count: 2 },
      pendingInteraction: { state: "waiting", count: 1 },
      deliveryHealth: { muted: true },
      activity: {
        state: "background_work",
        stateLabel: "Background work",
        confidence: "inferred",
        inFlightCount: 2,
        requestCount: 1,
        muted: true,
      },
    });
    const html = renderCurrentGroupsHtml(
      buildCurrentGroups(
        snapshot({
          currentByHarness: [{ harness: "codex", sessions: [busy] }],
        }),
      ),
      { now: NOW, capabilities: new Map() },
    );
    expect(html).toContain("Background work");
    expect(html).toContain("2 items");
    expect(html).toContain("1 waiting");
    expect(html).toContain("Muted delivery");
    expect(html).toContain("Why this state");
    expect(html).toContain("Inferred");
  });
});

describe("capability gating", () => {
  it("disables controls that the API does not advertise", () => {
    const html = renderSessionActionsHtml(session(), {
      supportedActions: ["details", "mute"],
      latestEventId: "event-one",
    });
    expect(html).toContain('data-session-action="details"');
    expect(html.match(/disabled/gu)).toHaveLength(2);
  });

  it("disables every control when no retained event is known", () => {
    const html = renderSessionActionsHtml(session(), {
      supportedActions: ["details", "continue", "mute", "end"],
      latestEventId: undefined,
    });
    expect(html.match(/disabled/gu)).toHaveLength(4);
  });

  it("explains a session outside the capability window", () => {
    const html = renderSessionActionsHtml(session(), undefined);
    expect(html).toContain("outside that window");
  });

  it("disables history details without retained evidence", () => {
    const html = renderHistoryRowsHtml(
      [session({ activity: { state: "ended", stateLabel: "Ended" } })],
      { now: NOW, capabilities: new Map() },
    );
    expect(html).toContain("disabled");
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("outside the loaded window");
  });

  it("exposes the disabled reason to assistive technology, not only a tooltip", () => {
    const html = renderSessionActionsHtml(session(), {
      supportedActions: ["details"],
      latestEventId: "event-one",
    });
    expect(html).toContain('aria-describedby="reason-current-');
    expect(html).toContain('<span class="sr-only" id="reason-current-');
  });

  it("scopes controls so duplicate sessions stay addressable", () => {
    const attention = renderSessionActionsHtml(session(), undefined, {
      scope: "attention",
    });
    const current = renderSessionActionsHtml(session(), undefined);
    expect(attention).toContain('data-session-scope="attention"');
    expect(current).toContain('data-session-scope="current"');
  });

  it("explains a timeline row that has no retained event", () => {
    const html = renderTimelineHtml(
      [
        {
          id: "timeline-1",
          kind: "delivery",
          at: "2026-08-14T11:00:00.000Z",
          status: "delivered",
          label: "attempt",
        },
      ],
      { now: NOW },
    );
    expect(html).toContain("disabled");
    expect(html).toContain("No retained event to open.");
  });
});

describe("history pagination", () => {
  it("appends without duplicating an already loaded session", () => {
    const first = [session({ sessionKey: "111111111111111111111111" })];
    const merged = appendHistoryPage(first, [
      session({ sessionKey: "111111111111111111111111" }),
      session({ sessionKey: "222222222222222222222222" }),
    ]);
    expect(merged.items).toHaveLength(2);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(1);
    expect(merged.capped).toBe(false);
  });

  it("preserves the order of earlier pages", () => {
    const first = [
      session({ sessionKey: "111111111111111111111111" }),
      session({ sessionKey: "222222222222222222222222" }),
    ];
    const merged = appendHistoryPage(first, [
      session({ sessionKey: "333333333333333333333333" }),
    ]);
    expect(merged.items.map((item) => item.sessionKey)).toEqual([
      "111111111111111111111111",
      "222222222222222222222222",
      "333333333333333333333333",
    ]);
  });

  it("caps an unbounded history view", () => {
    const existing = Array.from({ length: HISTORY_VIEW_MAX }, (_, index) =>
      session({ sessionKey: String(index).padStart(24, "0") }),
    );
    const merged = appendHistoryPage(existing, [
      session({ sessionKey: "ffffffffffffffffffffffff" }),
    ]);
    expect(merged.capped).toBe(true);
    expect(merged.items).toHaveLength(HISTORY_VIEW_MAX);
  });

  it("describes the loaded history bound", () => {
    expect(historySummary(0, true, false)).toBe("No recent sessions loaded.");
    expect(historySummary(25, false, false, 25)).toContain(
      "more history is available",
    );
    expect(historySummary(25, true, false, 25)).toContain(
      "end of retained history",
    );
    expect(historySummary(25, false, false, 3)).toContain("3 of 25 loaded");
    expect(historySummary(1_000, false, true, 1_000)).toContain(
      "stops at 1000 rows",
    );
  });
});

describe("loaded-session filter", () => {
  const sessions = [
    session({
      sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
      projectLabel: "billing",
    }),
    session({
      sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
      projectLabel: "checkout",
      harness: "claude",
      activity: { state: "idle", stateLabel: "Idle" },
    }),
  ];

  it("matches safe fields only", () => {
    expect(filterLoadedSessions(sessions, "billing")).toHaveLength(1);
    expect(filterLoadedSessions(sessions, "Claude")).toHaveLength(1);
    expect(filterLoadedSessions(sessions, "bbbbbbbb")).toHaveLength(1);
    expect(filterLoadedSessions(sessions, "   ")).toHaveLength(2);
  });

  it("requires every term to match, in any order", () => {
    expect(filterLoadedSessions(sessions, "checkout idle")).toHaveLength(1);
    expect(filterLoadedSessions(sessions, "idle checkout")).toHaveLength(1);
    expect(filterLoadedSessions(sessions, "checkout working")).toHaveLength(0);
  });

  it("matches the readable session name", () => {
    const [first] = sessions;
    expect(filterLoadedSessions(sessions, sessionTitle(first))).toHaveLength(1);
  });
});

describe("update hold policy", () => {
  it("holds while focus, pointer, an unsent draft, or the drawer is in play", () => {
    expect(shouldHoldUpdates({ focusInLiveRegion: true })).toBe(true);
    expect(shouldHoldUpdates({ pointerOnInteractive: true })).toBe(true);
    expect(shouldHoldUpdates({ hasUnsentDraft: true })).toBe(true);
    expect(shouldHoldUpdates({ drawerOpen: true })).toBe(true);
    expect(shouldHoldUpdates({})).toBe(false);
  });

  it("explains the most protective reason first", () => {
    expect(
      describeHoldReason({ hasUnsentDraft: true, focusInLiveRegion: true }),
    ).toContain("unsent answer");
    expect(describeHoldReason({ drawerOpen: true })).toContain("evidence view");
    expect(describeHoldReason({ focusInLiveRegion: true })).toContain(
      "keyboard focus",
    );
    expect(describeHoldReason({ pointerOnInteractive: true })).toContain(
      "pointer",
    );
  });
});

describe("announcements", () => {
  it("announces only a change in the attention count", () => {
    expect(attentionAnnouncement(1, 1)).toBeUndefined();
    expect(attentionAnnouncement(0, 1)).toBe("1 session needs attention.");
    expect(attentionAnnouncement(1, 3)).toBe("3 sessions need attention.");
    expect(attentionAnnouncement(2, 0)).toBe("Nothing needs attention.");
  });

  it("describes each terminal request outcome", () => {
    const subject = session();
    expect(describeTerminalRequest(subject, "answered", "telegram")).toContain(
      "answered in telegram",
    );
    expect(describeTerminalRequest(subject, "answered", "web")).toContain(
      "answered in this browser",
    );
    expect(describeTerminalRequest(subject, "expired")).toContain("expired");
    expect(describeTerminalRequest(undefined, "cancelled")).toContain(
      "cancelled by the agent",
    );
  });

  it("never claims an answer the daemon did not report", () => {
    const notice = describeTerminalRequest(session(), "unverified");
    expect(notice).toContain("did not report how it ended");
    expect(notice).not.toContain("answered");
  });
});

describe("typed responses", () => {
  it("builds every supported response shape", () => {
    expect(
      buildResponse({ form: { kind: "text" } }, { value: "hello" }),
    ).toEqual({ kind: "text", text: "hello" });
    expect(
      buildResponse({ form: { kind: "single-select" } }, { value: "one" }),
    ).toEqual({ kind: "option", optionId: "one" });
    expect(
      buildResponse({ form: { kind: "multi-select" } }, { value: ["a", "b"] }),
    ).toEqual({ kind: "multi-select", optionIds: ["a", "b"] });
    expect(buildResponse({}, {})).toBeUndefined();
  });

  it("builds an ordered question-set answer", () => {
    const item = {
      form: {
        kind: "question-set",
        questions: [
          { questionId: "q1", kind: "free-text" },
          { questionId: "q2", kind: "multi-select" },
          { questionId: "q3", kind: "confirm" },
        ],
      },
    };
    expect(buildResponse(item, { q1: "text", q2: ["x"], q3: "yes" })).toEqual({
      kind: "question-set",
      answers: [
        { questionId: "q1", kind: "free-text", text: "text" },
        { questionId: "q2", kind: "multi-select", optionIds: ["x"] },
        { questionId: "q3", kind: "confirm", optionId: "yes" },
      ],
    });
  });
});

describe("bounded event detail", () => {
  it("omits repository, branch, and any transcript field", () => {
    const html = renderEventDetailHtml({
      schema: "agent-relay-web-event.v1",
      eventId: "event-one",
      occurredAt: "2026-08-14T11:00:00.000Z",
      harness: "codex",
      surface: "cli",
      harnessVersion: "0.1.0",
      sessionKey: "0123456789abcdef01234567",
      type: "turn.started",
      deliveryStatus: "delivered",
      repository: "secret-repository-name",
      branch: "feature/secret-branch",
      summary: "Bounded safe summary",
      request: { kind: "input", state: "answered" },
    });
    expect(html).not.toContain("secret-repository-name");
    expect(html).not.toContain("feature/secret-branch");
    expect(html).toContain("Bounded safe summary");
    expect(html).toContain("input · answered");
  });
});

describe("snapshot indexing", () => {
  it("indexes every complete and recent session exactly once", () => {
    const shared = session({ sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa" });
    const index = indexSnapshotSessions(
      snapshot({
        needsAttention: [shared],
        currentByHarness: [{ harness: "codex", sessions: [shared] }],
        recent: {
          items: [
            session({
              sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
              activity: { state: "done", stateLabel: "Done" },
            }),
          ],
        },
      }),
    );
    expect([...index.keys()]).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("uses the canonical state label from the API", () => {
    expect(stateLabel(session({ activity: { stateLabel: "Ended" } }))).toBe(
      "Ended",
    );
  });
});
