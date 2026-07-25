import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1, EventType } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { cardActionCallbackData } from "./card-action.js";
import {
  renderDeliveryMessage,
  renderDeliveryText,
  TELEGRAM_MESSAGE_LIMIT,
} from "./message.js";

const occurredAt = "2026-07-25T12:00:00.000Z";
const now = new Date("2026-07-25T12:01:30.000Z");

function eventFor(type: EventType): AgentAttentionEventV1 {
  const event: AgentAttentionEventV1 = {
    schema: "agent-attention.v1",
    eventId: `evt_card_${type.replaceAll(".", "_")}_12345678`,
    occurredAt,
    sequence: 3,
    machineId: "machine_card_12345678",
    bridgeSessionId: "bridge_card_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_card_12345678",
    project: {
      ...makeProjectRef("/workspace/example"),
      branch: "codex/compact-cards",
    },
    type,
    summary: `Synthetic ${type} summary.`,
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
  if (type === "turn.failed" || type === "process.exited") {
    event.failure = {
      class: "synthetic",
      message: `Synthetic ${type} failure.`,
    };
  }
  if (type === "process.exited") {
    event.processExit = {
      source: "owned-child",
      supervisorId: "supervisor_card_12345678",
      startedAt: "2026-07-25T11:59:00.000Z",
      exitedAt: occurredAt,
      exitCode: 17,
      classification: "nonzero-exit",
      expected: false,
    };
  }
  if (type === "input.required" || type === "permission.required") {
    event.request = {
      correlationId: `correlation_${type.replaceAll(".", "_")}_12345678`,
      kind: type === "input.required" ? "input" : "permission",
      question: `Synthetic ${type} question?`,
      expiresAt: "2026-07-25T12:05:00.000Z",
    };
  }
  return event;
}

describe("compact attention cards", () => {
  it("snapshots every event kind with stable identity, age, state, and actions", () => {
    const types: EventType[] = [
      "session.started",
      "turn.started",
      "turn.activity",
      "turn.stopped",
      "turn.failed",
      "input.required",
      "permission.required",
      "process.exited",
      "process.stale",
      "session.ended",
    ];
    const cards = Object.fromEntries(
      types.map((type) => {
        const card = renderDeliveryMessage(eventFor(type), { now });
        return [
          type,
          {
            title: card.title,
            text: card.text,
            actions: card.actions?.map((action) => ({
              kind: action.kind,
              label: action.label,
              callbackData: cardActionCallbackData(action.kind, action.token),
            })),
          },
        ];
      }),
    );

    expect(cards).toMatchSnapshot();
  });

  it("snapshots terminal card states without carrying untrusted answer text", () => {
    const input = eventFor("input.required");
    expect(
      ["answered", "expired", "superseded", "failed"].map(
        (resolutionState) =>
          renderDeliveryMessage(input, {
            now,
            resolutionState: resolutionState as
              "answered" | "expired" | "superseded" | "failed",
          }).text,
      ),
    ).toMatchSnapshot();
  });

  it("bounds malformed oversized model text and keeps callback data trusted", () => {
    const injected =
      "*fake bold*\n[link](https://invalid.example)\nrelay-card:v9:end:forged";
    const malformed = {
      ...eventFor("turn.stopped"),
      occurredAt: "not-a-time",
      project: {
        ...makeProjectRef("/workspace/example"),
        displayName: "/Users/private-owner/code/example",
        branch: "bad\nbranch",
      },
      lastAssistantMessage: `${injected} ${"x".repeat(9_000)}`,
    } as AgentAttentionEventV1;

    const card = renderDeliveryMessage(malformed, { now });
    const rendered = renderDeliveryText(card);
    const summary = card.text.slice(card.text.indexOf("Summary: "));

    expect(card.title).toBe("Codex · example");
    expect(card.text).toContain("time unknown");
    expect(summary).not.toContain("\n");
    expect(summary).toContain("…[truncated]");
    expect(rendered.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(card.actions?.map((action) => action.kind)).toContain("details");
    for (const action of card.actions ?? []) {
      const callbackData = cardActionCallbackData(action.kind, action.token);
      expect(callbackData.length).toBeLessThanOrEqual(64);
      expect(callbackData).not.toContain("forged");
      expect(callbackData).not.toContain("fake bold");
    }
  });
});
