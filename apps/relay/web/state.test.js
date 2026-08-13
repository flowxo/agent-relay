import { describe, expect, it } from "vitest";

import {
  buildResponse,
  escapeHtml,
  filterSessions,
  mergeCursor,
  parseSseBlock,
  reconcileSessions,
  sortAttention,
  summarizeSessions,
} from "./state.js";

const stateLabels = {
  working: "Working",
  needs_input: "Needs input",
  background_work: "Background work",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
  ended: "Ended",
};

function activity(state = "working", overrides = {}) {
  return {
    schema: "agent-relay-session-activity.v1",
    policyVersion: "ar5.1.v1",
    fixtureSetVersion: "ar5.1-2026-08-13",
    state,
    stateLabel: stateLabels[state],
    confidence: "confirmed",
    reason: state === "working" ? "foreground_recent" : "evidence_gap",
    reasonText: "Synthetic bounded reason.",
    source: "codex_cli",
    lastObservedAt: "2026-07-25T12:00:00.000Z",
    inFlightCount: 0,
    requestCount: state === "needs_input" ? 1 : 0,
    muted: false,
    epoch: 1,
    lastAppliedSequence: 1,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    schema: "agent-relay-web-session.v2",
    sessionKey: "session-key-000000000001",
    displayId: "00000001-123abc",
    harness: "codex",
    surface: "cli",
    repository: "agent-relay",
    branch: "codex/console",
    activity: activity(),
    lifecycleState: "active",
    lastSeenAt: "2026-07-25T12:00:00.000Z",
    attentionCount: 0,
    ...overrides,
  };
}

function attention(overrides = {}) {
  return {
    schema: "agent-relay-web-attention.v1",
    requestId: "request-attention-00000001",
    eventId: "event-attention-0000000001",
    sessionKey: "session-key-000000000001",
    harness: "codex",
    requestKind: "input",
    state: "open",
    promptPreview: "Which path?",
    expiresAt: "2026-07-25T12:10:00.000Z",
    supportedActions: ["respond-text"],
    options: [],
    ...overrides,
  };
}

describe("local session board state", () => {
  it("deduplicates snapshots and orders operational risk deterministically", () => {
    const result = reconcileSessions([
      session(),
      session({ attentionCount: 2 }),
      session({
        sessionKey: "session-key-000000000002",
        activity: activity("needs_input"),
      }),
      session({
        sessionKey: "session-key-000000000003",
        activity: activity("failed"),
      }),
    ]);

    expect(result.map(({ sessionKey }) => sessionKey)).toEqual([
      "session-key-000000000002",
      "session-key-000000000003",
      "session-key-000000000001",
    ]);
    expect(result.at(-1)?.attentionCount).toBe(2);
  });

  it("filters every required lane, repository, harness, and search identity", () => {
    const sessions = [
      session(),
      session({
        sessionKey: "session-key-000000000002",
        harness: "claude",
        repository: "console",
        branch: "feature/quiet-board",
        activity: activity("background_work", { muted: true }),
      }),
      session({
        sessionKey: "session-key-000000000003",
        harness: "cursor",
        repository: "console",
        activity: activity("ended"),
      }),
    ];

    expect(
      filterSessions(sessions, {
        state: "background_work",
        harness: "claude",
        repository: "console",
        query: "quiet",
      }),
    ).toHaveLength(1);
    expect(
      filterSessions(sessions, {
        state: "ended",
        harness: "all",
        repository: "all",
        query: "",
      }),
    ).toEqual([expect.objectContaining({ harness: "cursor" })]);
  });

  it("keeps the global attention queue unique and expiry ordered", () => {
    const result = sortAttention([
      attention(),
      attention({ promptPreview: "Latest copy wins" }),
      attention({
        requestId: "request-attention-00000002",
        sessionKey: "session-key-000000000002",
        expiresAt: "2026-07-25T12:05:00.000Z",
      }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.requestId).toBe("request-attention-00000002");
    expect(result[1]?.promptPreview).toBe("Latest copy wins");
  });

  it("remains stable with dozens of interleaved session updates", () => {
    const updates = Array.from({ length: 60 }, (_, index) =>
      session({
        sessionKey: `session-key-${String(index).padStart(12, "0")}`,
        harness: ["codex", "claude", "cursor"][index % 3],
        repository: `repository-${index % 8}`,
        activity: activity(
          [
            "working",
            "needs_input",
            "background_work",
            "idle",
            "done",
            "failed",
            "unknown",
            "ended",
          ][index % 8],
          {
            lastObservedAt: new Date(
              Date.parse("2026-07-25T12:00:00.000Z") - index * 1_000,
            ).toISOString(),
          },
        ),
        lastSeenAt: new Date(
          Date.parse("2026-07-25T12:00:00.000Z") - index * 1_000,
        ).toISOString(),
      }),
    );
    const first = reconcileSessions(updates);
    const second = reconcileSessions([...updates].reverse());

    expect(first).toHaveLength(60);
    expect(first.map(({ sessionKey }) => sessionKey)).toEqual(
      second.map(({ sessionKey }) => sessionKey),
    );
  });

  it("summarizes risk and ignores duplicate or regressive stream cursors", () => {
    const sessions = [
      session(),
      session({
        sessionKey: "session-key-000000000002",
        activity: activity("unknown"),
      }),
      session({
        sessionKey: "session-key-000000000003",
        activity: activity("failed"),
      }),
    ];
    expect(summarizeSessions(sessions, [attention()])).toEqual({
      attention: 1,
      running: 1,
      risk: 2,
    });
    expect(mergeCursor(41, 42)).toBe(42);
    expect(mergeCursor(42, 42)).toBe(42);
    expect(mergeCursor(42, 7)).toBe(42);
    expect(
      parseSseBlock('id: 43\r\nevent: change\r\ndata: {"kind":"session"}\r\n'),
    ).toEqual({
      id: 43,
      event: "change",
      data: '{"kind":"session"}',
    });
    expect(escapeHtml('<script data-secret="x">&</script>')).toBe(
      "&lt;script data-secret=&quot;x&quot;&gt;&amp;&lt;/script&gt;",
    );
  });

  it("builds provider-neutral multi-select and ordered question-set answers", () => {
    expect(
      buildResponse(
        attention({
          form: {
            kind: "multi-select",
            options: [],
            minSelections: 1,
            maxSelections: 2,
          },
        }),
        { value: ["option_two", "option_one"] },
      ),
    ).toEqual({
      kind: "multi-select",
      optionIds: ["option_two", "option_one"],
    });

    const questions = [
      {
        questionId: "question_confirm",
        kind: "confirm",
      },
      {
        questionId: "question_units",
        kind: "multi-select",
      },
      {
        questionId: "question_note",
        kind: "free-text",
      },
    ];
    expect(
      buildResponse(
        attention({
          form: {
            kind: "question-set",
            title: "Release",
            questions,
          },
        }),
        {
          question_confirm: "confirm_yes",
          question_units: ["unit_core", "unit_ui"],
          question_note: "Ship safely",
        },
      ),
    ).toEqual({
      kind: "question-set",
      answers: [
        {
          questionId: "question_confirm",
          kind: "confirm",
          optionId: "confirm_yes",
        },
        {
          questionId: "question_units",
          kind: "multi-select",
          optionIds: ["unit_core", "unit_ui"],
        },
        {
          questionId: "question_note",
          kind: "free-text",
          text: "Ship safely",
        },
      ],
    });
  });
});
