import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1, EventType } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";
import { CardActionTokenSchema } from "@agent-relay/notification-contracts";

import {
  DELIVERY_MESSAGE_LIMIT,
  renderDeliveryMessage,
  renderDeliveryText,
} from "./presentation.js";

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
  if (type === "turn.stopped") {
    event.request = {
      correlationId: "correlation_continuation_12345678",
      kind: "continuation",
      question: "Continue this stopped turn?",
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
              token: "<opaque-card-token>",
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

  it("does not render active interaction controls on a terminal card", () => {
    const input = {
      ...eventFor("input.required"),
      request: {
        correlationId: "correlation_resolved_select_12345678",
        kind: "select" as const,
        question: "Choose one",
        options: Array.from({ length: 12 }, (_, index) => ({
          id: `option_resolved_${String(index).padStart(8, "0")}`,
          label: `Resolved option ${String(index + 1)}`,
        })),
        expiresAt: "2026-07-25T12:05:00.000Z",
      },
    };

    const card = renderDeliveryMessage(input, {
      now,
      resolutionState: "answered",
    });

    expect(card.interaction).toBeUndefined();
    expect(renderDeliveryText(card)).not.toContain(
      "Reply with one option number:",
    );
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
    expect(rendered.length).toBeLessThanOrEqual(DELIVERY_MESSAGE_LIMIT);
    expect(card.actions?.map((action) => action.kind)).toContain("details");
    expect({
      title: card.title,
      text: card.text,
      actions: card.actions?.map((action) => ({
        kind: action.kind,
        token: "<opaque-card-token>",
      })),
    }).toMatchSnapshot();
    for (const action of card.actions ?? []) {
      expect(CardActionTokenSchema.safeParse(action.token).success).toBe(true);
      expect(action.token).not.toContain("forged");
      expect(action.token).not.toContain("fake bold");
    }
  });

  it("derives valid, deterministic, action-specific opaque tokens", () => {
    const first = renderDeliveryMessage(eventFor("turn.stopped"), {
      now,
    }).actions;
    const second = renderDeliveryMessage(eventFor("turn.stopped"), {
      now,
    }).actions;
    const firstTokens = (first ?? []).map((action) => action.token);
    const secondTokens = (second ?? []).map((action) => action.token);

    expect(firstTokens).toEqual(secondTokens);
    expect(new Set(firstTokens).size).toBe(firstTokens.length);
    for (const token of firstTokens) {
      expect(CardActionTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it("does not offer Continue without an eligible continuation contract", () => {
    const withoutRequest = {
      ...eventFor("turn.stopped"),
      request: undefined,
    } as AgentAttentionEventV1;
    const unsupported = {
      ...eventFor("turn.stopped"),
      capabilities: {
        inlineContinue: false,
        lateResume: false,
        activeSteer: false,
        permissionDecision: true,
      },
    };

    expect(
      renderDeliveryMessage(withoutRequest, { now }).actions?.map(
        (action) => action.kind,
      ),
    ).not.toContain("continue");
    expect(
      renderDeliveryMessage(unsupported, { now }).actions?.map(
        (action) => action.kind,
      ),
    ).not.toContain("continue");
  });
});
