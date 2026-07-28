const PREFIX = "relay-c:v1";
const OPERATION_PATTERN = /^cleanup_[a-f0-9]{32}$/u;

export type TopicCleanupCallbackAction = "confirm" | "cancel";

export interface ParsedTopicCleanupCallback {
  action: TopicCleanupCallbackAction;
  operationId: string;
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
