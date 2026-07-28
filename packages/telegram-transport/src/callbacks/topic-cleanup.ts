const PREFIX = "relay-c:v1";
const PRUNE_PREFIX = "relay-p:v1";
const OPERATION_PATTERN = /^cleanup_[a-f0-9]{32}$/u;
const MAX_PRUNE_HOURS = 30 * 24;

export type TopicCleanupCallbackAction = "confirm" | "cancel";

export interface ParsedTopicCleanupCallback {
  action: TopicCleanupCallbackAction;
  operationId: string;
}

export interface ParsedTopicPruneStartCallback {
  inactiveForMs: number;
}

export function topicCleanupCallbackData(
  action: TopicCleanupCallbackAction,
  operationId: string,
): string {
  if (!OPERATION_PATTERN.test(operationId)) {
    throw new Error("topic cleanup operation id is invalid");
  }
  return `${PREFIX}:${action === "confirm" ? "y" : "n"}:${operationId}`;
}

export function parseTopicCleanupCallbackData(
  value: string,
): ParsedTopicCleanupCallback | undefined {
  const match = /^relay-c:v1:([yn]):(cleanup_[a-f0-9]{32})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  return {
    action: match[1] === "y" ? "confirm" : "cancel",
    operationId: match[2]!,
  };
}

export function topicPruneStartCallbackData(inactiveHours: number): string {
  if (
    !Number.isSafeInteger(inactiveHours) ||
    inactiveHours < 1 ||
    inactiveHours > MAX_PRUNE_HOURS
  ) {
    throw new Error("topic prune callback hours are invalid");
  }
  return `${PRUNE_PREFIX}:${String(inactiveHours)}h`;
}

export function parseTopicPruneStartCallbackData(
  value: string,
): ParsedTopicPruneStartCallback | undefined {
  const match = /^relay-p:v1:([1-9][0-9]{0,2})h$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const inactiveHours = Number(match[1]);
  if (inactiveHours > MAX_PRUNE_HOURS) {
    return undefined;
  }
  return { inactiveForMs: inactiveHours * 60 * 60_000 };
}
