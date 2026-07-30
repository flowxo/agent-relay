import {
  redactText,
  sessionLanePresentation,
  type RelayStore,
  type SessionLaneState,
  type SessionTopicRecord,
} from "@agent-relay/core";
import type { OperatorControlMessage } from "@agent-relay/notification-contracts";

const STATUS_PRIORITY: Record<SessionLaneState, number> = {
  crashed: 0,
  waiting: 1,
  stale: 2,
  running: 3,
  muted: 4,
  ended: 5,
};

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function relativeAge(timestamp: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - Date.parse(timestamp));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) {
    return "now";
  }
  if (elapsed < 60 * 60_000) {
    return `${String(Math.floor(elapsed / 60_000))}m ago`;
  }
  if (elapsed < 24 * 60 * 60_000) {
    return `${String(Math.floor(elapsed / (60 * 60_000)))}h ago`;
  }
  const days = Math.floor(elapsed / (24 * 60 * 60_000));
  return `${String(days)}d ago`;
}

function boundedCell(value: string, width: number): string {
  const safe = redactText(value, width * 4)
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...safe];
  const bounded =
    characters.length <= width
      ? safe
      : `${characters.slice(0, Math.max(1, width - 1)).join("")}…`;
  return bounded.padEnd(width, " ");
}

function tableRow(
  values: readonly string[],
  widths: readonly number[],
): string {
  return values
    .map((value, index) => boundedCell(value, widths[index] ?? value.length))
    .join("  ")
    .trimEnd();
}

function openTopics(
  store: RelayStore,
  transportName: string,
  transportScope: string,
): SessionTopicRecord[] {
  return store
    .listSessionTopics()
    .filter(
      (topic) =>
        topic.transportName === transportName &&
        topic.transportScope === transportScope &&
        topic.provisioningStatus === "ready" &&
        topic.topicId !== undefined &&
        topic.laneState !== "ended",
    )
    .sort(
      (left, right) =>
        STATUS_PRIORITY[left.laneState] - STATUS_PRIORITY[right.laneState] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.shortSessionId.localeCompare(right.shortSessionId),
    );
}

export function renderSessionStatus(
  store: RelayStore,
  topic: SessionTopicRecord,
  now: Date,
): OperatorControlMessage {
  const session = store.getSession(topic);
  const presentation = sessionLanePresentation(topic.laneState);
  const openRequests = store.countOpenRequests(topic);
  const lines = [
    "Agent Relay status",
    "",
    `${presentation.emoji} ${presentation.label}`,
    `Project: ${topic.repository}`,
    `Branch: ${topic.branch ?? "unknown"}`,
    `Harness: ${titleCase(topic.provider)} / ${session?.surface ?? "unknown"}`,
    `Session: ${topic.shortSessionId}`,
    `Last event: ${session?.lastEventType ?? "none recorded"}`,
    `Last seen: ${
      session === undefined ? "unknown" : relativeAge(session.lastSeenAt, now)
    }`,
    `Open requests: ${String(openRequests)}`,
  ];
  return {
    text: redactText(lines.join("\n"), 4_000),
    buttons: [],
  };
}

export function renderOpenSessionStatus(
  store: RelayStore,
  transportName: string,
  transportScope: string,
  limit = 30,
): OperatorControlMessage {
  const topics = openTopics(store, transportName, transportScope);
  const visible = topics.slice(0, limit);
  const title =
    topics.length <= limit
      ? `Open Agent Relay sessions · ${String(topics.length)}`
      : `Open Agent Relay sessions · showing ${String(limit)} of ${String(
          topics.length,
        )}`;
  if (visible.length === 0) {
    return {
      text: `${title}\n\nNo open coding-session topics.`,
      buttons: [],
    };
  }
  const widths = [5, 6, 16, 14, 15] as const;
  const header = tableRow(
    ["STATE", "AGENT", "PROJECT", "BRANCH", "SESSION"],
    widths,
  );
  const divider = widths.map((width) => "─".repeat(width)).join("  ");
  const rows = visible.map((topic) =>
    tableRow(
      [
        sessionLanePresentation(topic.laneState).shortLabel,
        topic.provider,
        topic.repository,
        topic.branch ?? "unknown",
        topic.shortSessionId,
      ],
      widths,
    ),
  );
  return {
    text: redactText([title, "", header, divider, ...rows].join("\n"), 4_000),
    buttons: [],
  };
}
