import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  filterSessions,
  mergeCursor,
  parseSseBlock,
  reconcileSessions,
  sortAttention,
  summarizeSessions,
} from "./state.js";

function session(overrides = {}) {
  return {
    schema: "agent-relay-web-session.v1",
    sessionKey: "session-key-000000000001",
    displayId: "00000001-123abc",
    harness: "codex",
    surface: "cli",
    repository: "agent-relay",
    branch: "codex/console",
    state: "running",
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
        state: "waiting",
      }),
      session({
        sessionKey: "session-key-000000000003",
        state: "crashed",
      }),
    ]);

    expect(result.map(({ sessionKey }) => sessionKey)).toEqual([
      "session-key-000000000003",
      "session-key-000000000002",
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
        state: "muted",
      }),
      session({
        sessionKey: "session-key-000000000003",
        harness: "cursor",
        repository: "console",
        state: "ended",
      }),
    ];

    expect(
      filterSessions(sessions, {
        state: "muted",
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
        state: ["running", "waiting", "crashed", "muted", "ended"][index % 5],
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
      session({ sessionKey: "session-key-000000000002", state: "stale" }),
      session({ sessionKey: "session-key-000000000003", state: "crashed" }),
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
});
