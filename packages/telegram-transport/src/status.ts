import {
  redactText,
  sessionActivityPresentation,
  type RelayStore,
  type SessionActivityState,
  type SessionTopicRecord,
} from "@agent-relay/core";
import type { OperatorControlMessage } from "@agent-relay/notification-contracts";

const STATUS_PRIORITY: Record<SessionActivityState, number> = {
  needs_input: 0,
  failed: 1,
  unknown: 2,
  working: 3,
  background_work: 4,
  idle: 5,
  done: 6,
  ended: 7,
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
        topic.activity.state !== "ended",
    )
    .sort(
      (left, right) =>
        STATUS_PRIORITY[left.activity.state] -
          STATUS_PRIORITY[right.activity.state] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.shortSessionId.localeCompare(right.shortSessionId),
    );
}

export function renderSessionStatus(
  store: RelayStore,
  topic: SessionTopicRecord,
  now: Date,
): OperatorControlMessage {
  const session = store.getSession(topic, now.toISOString());
  const activity =
    session?.activity ?? store.getSessionActivity(topic, now.toISOString());
  const presentation = sessionActivityPresentation(activity.state);
  const lines = [
    "Agent Relay status",
    "",
    `${presentation.emoji} ${presentation.label}`,
    `Project: ${topic.repository}`,
    `Branch: ${topic.branch ?? "unknown"}`,
    `Harness: ${titleCase(topic.provider)} / ${session?.surface ?? "unknown"}`,
    `Session: ${topic.shortSessionId}`,
    `Confidence: ${titleCase(activity.confidence)}`,
    `Reason: ${activity.reasonText}`,
    `Source: ${activity.source}`,
    `Last event: ${session?.lastEventType ?? "none recorded"}`,
    `Last activity: ${relativeAge(activity.lastObservedAt, now)}`,
    `In flight: ${String(activity.inFlightCount)}`,
    `Open requests: ${String(activity.requestCount)}`,
    `Delivery: ${activity.muted ? "Muted" : "Enabled"}`,
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
        sessionActivityPresentation(topic.activity.state).shortLabel,
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
