import { describe, expect, it } from "vitest";

import { containsSecret, displayWidth, renderDashboardFrame } from "./frame.js";
import type { DashboardViewState } from "./store.js";

function state(
  overrides: Partial<DashboardViewState> = {},
): DashboardViewState {
  return {
    connection: "online",
    renderer: "node-host",
    selectedProjectKey: "all",
    filters: { harness: "all", state: "all" },
    query: "",
    pane: "list",
    railIndex: 0,
    listIndex: 0,
    helpOpen: false,
    detailOpen: false,
    pendingEndSessionKey: "",
    status: "1 loaded; that is the end of retained history.",
    notice: "",
    pendingUpdates: 0,
    pendingReason: "",
    lastSync: 0,
    lastContact: 0,
    historyStale: false,
    historyCapped: false,
    requests: [],
    capabilities: new Map(),
    history: [],
    rail: [
      {
        projectKey: "all",
        label: "All projects",
        attentionCount: 1,
        currentCount: 1,
        recentCount: 0,
        totalCount: 1,
        selected: true,
      },
    ],
    list: [],
    ...overrides,
  };
}

describe("terminal dashboard frames", () => {
  it("renders a boxed layout with obvious focus and connection state", () => {
    const frame = renderDashboardFrame(
      state(),
      80,
      24,
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(frame).toContain("All projects");
    expect(frame).toContain("Projects");
    expect(frame).toContain("Sessions");
    expect(frame).toContain("online");
    expect(frame).toContain("Needs attention");
    expect(frame).toContain("Current");
    expect(frame).toContain("Recent");
    expect(frame).toContain("? help");
    expect(frame).toContain("┌");
    expect(frame.endsWith("\n")).toBe(false);
    expect(frame.split("\n")).toHaveLength(24);
  });

  it("stays legible on a narrow terminal and measures Unicode width", () => {
    const frame = renderDashboardFrame(
      state({
        rail: [
          {
            projectKey: "all",
            label: " conspectus 测",
            attentionCount: 0,
            currentCount: 1,
            recentCount: 0,
            totalCount: 1,
            selected: true,
          },
        ],
      }),
      40,
      12,
    );
    for (const line of frame.trimEnd().split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(displayWidth("测")).toBe(2);
  });

  it("never writes credentials or private identifiers into the frame", () => {
    const frame = renderDashboardFrame(
      state({
        status: "Answer committed.",
        notice: "A session: the open question was answered in this terminal.",
      }),
      80,
      24,
    );
    expect(
      containsSecret(frame, [
        "synthetic-local-web-token-1234567890",
        "synthetic-local-csrf-token-123456789",
        "webboot_",
        "oauth",
        "/synthetic-home/synthetic-operator",
      ]),
    ).toBe(false);
  });

  it("documents screen-reader limits in help", () => {
    const frame = renderDashboardFrame(
      state({ pane: "help", helpOpen: true }),
      80,
      24,
    );
    expect(frame).toContain(
      "Screen readers are an explicit current limitation",
    );
    expect(frame).toContain(
      "Ctrl-C       Always quit and restore the terminal",
    );
  });

  it("shows a filter field and a cursor on the focused unselected project", () => {
    const frame = renderDashboardFrame(
      state({
        pane: "filter",
        query: "check",
        railIndex: 1,
        rail: [
          {
            projectKey: "all",
            label: "All projects",
            attentionCount: 1,
            currentCount: 1,
            recentCount: 0,
            totalCount: 2,
            selected: true,
          },
          {
            projectKey: `prj_${"b".repeat(48)}`,
            label: "checkout-service",
            attentionCount: 0,
            currentCount: 1,
            recentCount: 0,
            totalCount: 1,
            selected: false,
          },
        ],
      }),
      80,
      24,
    );
    expect(frame).toContain("Filter  check_");
    expect(frame).toContain("Esc leave");
    const rail = renderDashboardFrame(
      state({
        pane: "rail",
        railIndex: 1,
        rail: [
          {
            projectKey: "all",
            label: "All projects",
            attentionCount: 1,
            currentCount: 1,
            recentCount: 0,
            totalCount: 2,
            selected: true,
          },
          {
            projectKey: `prj_${"b".repeat(48)}`,
            label: "checkout-service",
            attentionCount: 0,
            currentCount: 1,
            recentCount: 0,
            totalCount: 1,
            selected: false,
          },
        ],
      }),
      80,
      24,
    );
    expect(rail).toMatch(/> checkout-service/);
    expect(rail).toMatch(/\* All projects/);
  });

  it("keeps a list cursor after opening detail and marks the detail pane when focused", () => {
    const session = {
      schema: "agent-relay-project-session.v1" as const,
      sessionKey: "0123456789abcdef01234567",
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
    const open = renderDashboardFrame(
      state({
        pane: "list",
        detailOpen: true,
        list: [{ section: "attention", sessionKey: session.sessionKey }],
        selectedSession: session,
      }),
      80,
      24,
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(open).toMatch(/> /);
    expect(open).toContain("Detail");
    const focused = renderDashboardFrame(
      state({
        pane: "detail",
        detailOpen: true,
        list: [{ section: "attention", sessionKey: session.sessionKey }],
        selectedSession: session,
      }),
      80,
      24,
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(focused).toContain("[Detail]");
  });

  it("renders questionnaire options and the text field", () => {
    const frame = renderDashboardFrame(
      state({
        pane: "form",
        selectedRequest: {
          schema: "agent-relay-web-attention.v1",
          requestId: "request_tui_set_01",
          eventId: "evt_tui_set_01",
          sessionKey: "0123456789abcdef01234567",
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
                confirm: {
                  optionId: "option_proceed_tui01",
                  label: "Proceed",
                },
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
        },
        draft: {
          requestId: "request_tui_set_01",
          sessionKey: "0123456789abcdef01234567",
          values: { question_note_tui01: "ship" },
          fieldIndex: 2,
          submitting: false,
          status: "",
        },
      }),
      80,
      24,
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(frame).toContain("Proceed");
    expect(frame).toContain("Stop");
    expect(frame).toContain("ship_");
    expect(frame).toContain("Add a synthetic release note");
  });

  it("keeps the focused session visible when the list is taller than the pane", () => {
    const sessions = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `s${String(index).padStart(23, "0")}`;
      return {
        schema: "agent-relay-project-session.v1" as const,
        sessionKey,
        projectKey: `prj_${"a".repeat(48)}`,
        projectLabel: "checkout-service",
        harness: "codex" as const,
        surface: "cli" as const,
        lastSeenAt: "2026-08-14T11:59:30.000Z",
        knownInFlightWork: { count: 0 },
        pendingInteraction: { state: "none" as const, count: 0 },
        deliveryHealth: { muted: false },
        activity: {
          schema: "agent-relay-session-activity.v1" as const,
          policyVersion: "ar5.1.v1" as const,
          fixtureSetVersion: "ar5.1-2026-08-13" as const,
          state: "working" as const,
          stateLabel: "Working" as const,
          confidence: "confirmed" as const,
          reason: "foreground_recent" as const,
          reasonText: "A prompt was submitted",
          source: "codex_cli" as const,
          lastObservedAt: "2026-08-14T11:59:30.000Z",
          inFlightCount: 0,
          requestCount: 0,
          muted: false,
          epoch: 1,
          lastAppliedSequence: 4,
        },
      };
    });
    const last = sessions[19]!;
    const requests = sessions.map((session, index) => ({
      schema: "agent-relay-web-attention.v1" as const,
      requestId: `request_tui_row_${String(index).padStart(2, "0")}_xx`,
      eventId: `evt_tui_row_${String(index).padStart(2, "0")}_xxxx`,
      sessionKey: session.sessionKey,
      harness: "codex" as const,
      requestKind: "input" as const,
      state: "open" as const,
      promptPreview: `synthetic-row-${String(index).padStart(2, "0")}`,
      expiresAt: "2026-08-14T13:00:00.000Z",
      supportedActions: ["respond-text" as const],
      options: [],
    }));
    const frame = renderDashboardFrame(
      state({
        pane: "list",
        listIndex: 19,
        list: sessions.map((session, index) => ({
          section: "attention" as const,
          sessionKey: session.sessionKey,
          requestId: requests[index]!.requestId,
        })),
        history: sessions,
        requests,
        selectedSession: last,
        selectedRequest: requests[19],
      }),
      80,
      16,
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(frame).toMatch(/> /);
    expect(frame).toContain("synthetic-row-19");
    expect(frame).not.toContain("synthetic-row-00");
    expect(frame.split("\n")).toHaveLength(16);
  });

  it("asks for a wider terminal instead of overflowing a tiny window", () => {
    const frame = renderDashboardFrame(state(), 20, 8);
    expect(frame).toContain("Need 40x12");
    expect(frame).toContain("q quit");
    for (const line of frame.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(20);
    }
    expect(frame.split("\n")).toHaveLength(8);
  });

  it("renders reconnecting, stale, and disconnected without inventing session state", () => {
    const reconnecting = renderDashboardFrame(
      state({ connection: "reconnecting" }),
      80,
      24,
    );
    expect(reconnecting).toContain("reconnecting");
    expect(reconnecting).toContain("last safe snapshot");
    expect(reconnecting).toContain("All projects");
    const stale = renderDashboardFrame(state({ connection: "stale" }), 80, 24);
    expect(stale).toContain("stale");
    expect(stale).toContain("30 seconds");
    expect(stale).toContain("All projects");
    const disconnected = renderDashboardFrame(
      state({
        connection: "disconnected",
        rail: [],
        status: "The local daemon could not be reached.",
      }),
      80,
      24,
    );
    expect(disconnected).toContain("disconnected");
    expect(disconnected).toContain("could not be reached");
    expect(disconnected).toContain("No projects");
  });
});
