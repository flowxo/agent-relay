import type { AgentAttentionEventV1, Harness } from "@agent-relay/protocol";
import { sha256 } from "@agent-relay/protocol";

import { redactText } from "./redaction.js";
import { sessionName } from "./session-name.js";
import type { SessionActivityState } from "./activity.js";

export type SessionLifecycleState =
  "active" | "waiting" | "stopped" | "suspected_stalled" | "exited";

export type SessionLanePresentationState =
  "running" | "waiting" | "muted" | "crashed" | "ended" | "stale";

export interface SessionLanePresentation {
  emoji: string;
  label: string;
  shortLabel: string;
}

export type SessionActivityPresentation = SessionLanePresentation;

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

const SESSION_LANE_PRESENTATIONS: Record<
  SessionLanePresentationState,
  SessionLanePresentation
> = {
  running: { emoji: "🟢", label: "Running", shortLabel: "RUN" },
  waiting: { emoji: "🟡", label: "Waiting", shortLabel: "WAIT" },
  muted: { emoji: "🔕", label: "Muted", shortLabel: "MUTE" },
  crashed: { emoji: "🔴", label: "Crashed", shortLabel: "CRASH" },
  stale: { emoji: "🟠", label: "Possibly stalled", shortLabel: "STALE" },
  ended: { emoji: "⚫", label: "Ended", shortLabel: "END" },
};

const SESSION_ACTIVITY_PRESENTATIONS: Record<
  SessionActivityState,
  SessionActivityPresentation
> = {
  working: { emoji: "🟢", label: "Working", shortLabel: "WORK" },
  needs_input: { emoji: "🟡", label: "Needs input", shortLabel: "INPUT" },
  background_work: {
    emoji: "🔵",
    label: "Background work",
    shortLabel: "BG",
  },
  idle: { emoji: "⚪", label: "Idle", shortLabel: "IDLE" },
  done: { emoji: "✅", label: "Done", shortLabel: "DONE" },
  failed: { emoji: "🔴", label: "Failed", shortLabel: "FAIL" },
  unknown: { emoji: "🟠", label: "Unknown", shortLabel: "UNK" },
  ended: { emoji: "⚫", label: "Ended", shortLabel: "END" },
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

function boundDisplayedTopicName(
  statePrefix: string,
  stableTopicName: string,
): string {
  const maximumCharacters = 128;
  const full = `${statePrefix} ${stableTopicName}`;
  if ([...full].length <= maximumCharacters) {
    return full;
  }
  const separator = " · ";
  const suffixIndex = stableTopicName.lastIndexOf(separator);
  if (suffixIndex < 0) {
    return [...full].slice(0, maximumCharacters).join("").trimEnd();
  }
  const suffix = stableTopicName.slice(suffixIndex);
  const available = maximumCharacters - [...`${statePrefix} …${suffix}`].length;
  const prefix = [...stableTopicName.slice(0, suffixIndex)]
    .slice(0, Math.max(1, available))
    .join("")
    .trimEnd();
  return `${statePrefix} ${prefix}…${suffix}`;
}

export function sessionPublicKey(input: {
  machineId: string;
  harness: string;
  sessionId: string;
}): string {
  return sha256(
    `${input.machineId}\u001f${input.harness}\u001f${input.sessionId}`,
  ).slice(0, 24);
}

/**
 * Operator-facing session identity for Telegram topic titles and status.
 * Replaces the former native-session-id suffix with the shared readable name
 * derived only from the opaque public session key, so Telegram matches web
 * and TUI by eye. Existing topics are retitled on the next reconcile drain.
 */
function shortSessionIdentity(event: AgentAttentionEventV1): string {
  return sessionName(
    sessionPublicKey({
      machineId: event.machineId,
      harness: event.harness,
      sessionId: event.sessionId,
    }),
  );
}

export function sessionLanePresentation(
  state: SessionLanePresentationState,
): SessionLanePresentation {
  return SESSION_LANE_PRESENTATIONS[state];
}

export function sessionActivityPresentation(
  state: SessionActivityState,
): SessionActivityPresentation {
  return SESSION_ACTIVITY_PRESENTATIONS[state];
}

/**
 * Adds a visual state prefix while preserving the stable session suffix.
 * `stableTopicName` remains the durable identity stored by the registry.
 */
export function sessionTopicDisplayName(
  stableTopicName: string,
  state: SessionActivityState,
): string {
  return boundDisplayedTopicName(
    sessionActivityPresentation(state).emoji,
    stableTopicName,
  );
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
