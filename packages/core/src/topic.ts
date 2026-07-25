import type { AgentAttentionEventV1, Harness } from "@agent-relay/protocol";
import { sha256 } from "@agent-relay/protocol";

import { redactText } from "./redaction.js";

export type SessionLifecycleState =
  "active" | "waiting" | "stopped" | "suspected_stalled" | "exited";

export interface SessionTopicMetadata {
  provider: Harness;
  repository: string;
  branch?: string;
  shortSessionId: string;
  lifecycleState: SessionLifecycleState;
  topicName: string;
}

const HARNESS_NAMES: Record<Harness, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

function lifecycleStateForEvent(
  type: AgentAttentionEventV1["type"],
): SessionLifecycleState {
  switch (type) {
    case "session.started":
    case "turn.started":
    case "turn.activity":
      return "active";
    case "turn.stopped":
    case "input.required":
    case "permission.required":
      return "waiting";
    case "turn.failed":
      return "stopped";
    case "process.stale":
      return "suspected_stalled";
    case "process.exited":
    case "session.ended":
      return "exited";
  }
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("~\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function lastPathComponent(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
}

function sanitizeComponent(
  value: string,
  fallback: string,
  maxCharacters: number,
): string {
  const redacted = replaceControlCharacters(
    redactText(value, maxCharacters * 4),
  )
    .replace(/\s+/g, " ")
    .trim();
  const withoutPath = isAbsolutePath(redacted)
    ? lastPathComponent(redacted)
    : redacted;
  const bounded = [...withoutPath].slice(0, maxCharacters).join("").trim();
  return bounded.length === 0 ? fallback : bounded;
}

function boundTopicName(prefix: string, identity: string): string {
  const separator = " · ";
  const suffix = `${separator}${identity}`;
  const availablePrefixCharacters = 128 - [...suffix].length;
  const prefixCharacters = [...prefix];
  if (prefixCharacters.length <= availablePrefixCharacters) {
    return `${prefix}${suffix}`;
  }
  return `${prefixCharacters
    .slice(0, Math.max(1, availablePrefixCharacters - 1))
    .join("")
    .trimEnd()}…${suffix}`;
}

function shortSessionIdentity(event: AgentAttentionEventV1): string {
  const readableSuffix = event.sessionId
    .slice(-8)
    .replace(/[^A-Za-z0-9]/g, "_");
  const collisionSuffix = sha256(
    [event.machineId, event.harness, event.sessionId].join("\u001f"),
  ).slice(0, 6);
  return `${readableSuffix}-${collisionSuffix}`;
}

export function sessionTopicMetadata(
  event: AgentAttentionEventV1,
): SessionTopicMetadata {
  const repository = sanitizeComponent(
    event.project.displayName,
    "workspace",
    56,
  );
  const branch =
    event.project.branch === undefined
      ? undefined
      : sanitizeComponent(event.project.branch, "branch", 48);
  const shortSessionId = shortSessionIdentity(event);
  const topicName = boundTopicName(
    [
      HARNESS_NAMES[event.harness],
      repository,
      ...(branch === undefined ? [] : [branch]),
    ].join(" · "),
    shortSessionId,
  );
  return {
    provider: event.harness,
    repository,
    ...(branch === undefined ? {} : { branch }),
    shortSessionId,
    lifecycleState: lifecycleStateForEvent(event.type),
    topicName,
  };
}
