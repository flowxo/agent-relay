import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

import { redactText } from "./redaction.js";
import type { DeliveryMessage } from "./transport.js";

const STATE_LABELS: Record<AgentAttentionEventV1["type"], string> = {
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

function harnessName(event: AgentAttentionEventV1): string {
  if (event.harness === "codex") {
    return "Codex";
  }
  if (event.harness === "claude") {
    return "Claude";
  }
  return "Cursor";
}

export function renderDeliveryMessage(
  event: AgentAttentionEventV1,
): DeliveryMessage {
  const shortSession = event.sessionId.slice(-8);
  const state = STATE_LABELS[event.type];
  const summary =
    event.summary ??
    event.failure?.message ??
    event.lastAssistantMessage ??
    "No bounded summary was supplied.";
  const text = [
    `${state}`,
    "",
    redactText(summary, 1_500),
    "",
    `${event.harness}/${event.surface} · session ${shortSession}`,
  ].join("\n");

  return {
    eventId: event.eventId,
    title: `${harnessName(event)} · ${event.project.displayName}`,
    text,
    ...(event.request === undefined
      ? {}
      : { correlationId: event.request.correlationId }),
  };
}
