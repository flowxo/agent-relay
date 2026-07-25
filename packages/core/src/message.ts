import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

import { cardActionToken, type CardActionKind } from "./card-action.js";
import { redactText } from "./redaction.js";
import { sessionTopicMetadata } from "./topic.js";
import type { DeliveryAction, DeliveryMessage } from "./transport.js";

export const TELEGRAM_MESSAGE_LIMIT = 4_096;
const CARD_SUMMARY_LIMIT = 480;
const TRUNCATION_MARKER = " …[truncated]";

export type AttentionCardResolutionState =
  "answered" | "expired" | "superseded" | "failed";

export interface AttentionCardOptions {
  now?: Date;
  resolutionState?: AttentionCardResolutionState;
}

const EVENT_STATE_LABELS: Record<AgentAttentionEventV1["type"], string> = {
  "session.started": "Session started",
  "turn.started": "Working",
  "turn.activity": "Activity",
  "turn.stopped": "Waiting for your next instruction",
  "turn.failed": "Turn failed",
  "input.required": "Input required",
  "permission.required": "Approval required",
  "process.exited": "Process exited",
  "process.stale": "Process may be stale",
  "session.ended": "Session ended",
};

const RESOLUTION_STATE_LABELS: Record<AttentionCardResolutionState, string> = {
  answered: "Answered",
  expired: "Expired",
  superseded: "Superseded",
  failed: "Failed",
};

const ACTION_LABELS: Record<CardActionKind, string> = {
  continue: "Continue",
  details: "Details",
  mute: "Mute",
  end: "End",
};

function harnessName(event: AgentAttentionEventV1): string {
  if (event.harness === "codex") {
    return "Codex";
  }
  if (event.harness === "claude") {
    return "Claude";
  }
  return "Cursor";
}

function ageLabel(occurredAt: string, now: Date): string {
  const occurred = Date.parse(occurredAt);
  if (!Number.isFinite(occurred)) {
    return "time unknown";
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - occurred) / 1_000));
  if (seconds < 5) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function oneLineUntrusted(value: string): string {
  return [...redactText(value, 8_000)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSummary(value: string): {
  summary: string;
  truncated: boolean;
} {
  const characters = [...value];
  if (characters.length <= CARD_SUMMARY_LIMIT) {
    return { summary: value, truncated: false };
  }
  const markerLength = [...TRUNCATION_MARKER].length;
  return {
    summary: `${characters
      .slice(0, CARD_SUMMARY_LIMIT - markerLength)
      .join("")
      .trimEnd()}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function eventContent(event: AgentAttentionEventV1): string {
  const summary =
    (event.type === "turn.stopped" ? event.lastAssistantMessage : undefined) ??
    event.summary ??
    event.failure?.message ??
    event.lastAssistantMessage ??
    "No bounded summary was supplied.";
  return event.request === undefined || event.request.question === summary
    ? summary
    : `${summary} Question: ${event.request.question}`;
}

function actionKinds(
  event: AgentAttentionEventV1,
  detailsAvailable: boolean,
): CardActionKind[] {
  const kinds: CardActionKind[] = [];
  if (
    event.type === "turn.stopped" &&
    event.request?.kind === "continuation" &&
    (event.capabilities.inlineContinue || event.capabilities.lateResume)
  ) {
    kinds.push("continue");
  }
  if (detailsAvailable) {
    kinds.push("details");
  }
  if (event.type !== "session.ended" && event.type !== "process.exited") {
    kinds.push("mute", "end");
  }
  return kinds;
}

function actionsFor(
  event: AgentAttentionEventV1,
  detailsAvailable: boolean,
): DeliveryAction[] {
  return actionKinds(event, detailsAvailable).map((kind) => ({
    kind,
    label: ACTION_LABELS[kind],
    token: cardActionToken(event.eventId, kind),
  }));
}

export function renderDeliveryMessage(
  event: AgentAttentionEventV1,
  options: AttentionCardOptions = {},
): DeliveryMessage {
  const metadata = sessionTopicMetadata(event);
  const content = oneLineUntrusted(eventContent(event));
  const { summary, truncated } = truncateSummary(
    content.length === 0 ? "No bounded summary was supplied." : content,
  );
  const state =
    options.resolutionState === undefined
      ? EVENT_STATE_LABELS[event.type]
      : RESOLUTION_STATE_LABELS[options.resolutionState];
  const now = options.now ?? new Date();
  const text = [
    `${state} · ${ageLabel(event.occurredAt, now)}`,
    `${
      metadata.branch === undefined ? "branch unknown" : metadata.branch
    } · session ${metadata.shortSessionId}`,
    `${event.harness}/${event.surface} · ${event.type}`,
    "",
    `Summary: ${summary}`,
  ].join("\n");
  const actions = actionsFor(event, truncated);

  return {
    eventId: event.eventId,
    title: `${harnessName(event)} · ${metadata.repository}`,
    text,
    ...(event.request === undefined
      ? {}
      : { correlationId: event.request.correlationId }),
    ...(actions.length === 0 ? {} : { actions }),
  };
}

export function renderDeliveryText(message: DeliveryMessage): string {
  return redactText(
    `${message.title}\n\n${message.text}`,
    TELEGRAM_MESSAGE_LIMIT,
  );
}

export function renderDetailsMessage(
  event: AgentAttentionEventV1,
): DeliveryMessage {
  const metadata = sessionTopicMetadata(event);
  const details = [...redactText(eventContent(event), 3_500)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || (code >= 11 && code <= 31) || code === 127
        ? " "
        : character;
    })
    .join("")
    .trim();
  return {
    eventId: event.eventId,
    title: `Details · ${harnessName(event)} · ${metadata.repository}`,
    text:
      details.length === 0 ? "No additional details are available." : details,
  };
}
