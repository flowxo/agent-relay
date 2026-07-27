import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { encodeInteractionAnswer, makeProjectRef } from "@agent-relay/protocol";

import { RelayStore } from "./store.js";

const createdAt = "2026-07-25T12:00:00.000Z";
const expiresAt = "2026-07-25T12:30:00.000Z";

const interactionRequest = {
  schema: "agent-interaction-request.v1",
  requestId: "request_durable_0001",
  createdAt,
  expiresAt,
  title: "Synthetic durable choice",
  lifecycle: "pending",
  questions: [
    {
      questionId: "question_durable_0001",
      kind: "single-select",
      prompt: "Choose one synthetic result.",
      options: [
        { optionId: "option_first_0001", label: "First" },
        { optionId: "option_second_0001", label: "Second" },
      ],
    },
  ],
  fallback: {
    preferredMode: "buttons",
    alternativeModes: [],
    whenUnavailable: "reject",
  },
} as const;

function interactionAnswer(
  answerId: string,
  optionId: string,
  submittedAt = "2026-07-25T12:05:00.000Z",
) {
  return {
    schema: "agent-interaction-answer.v1",
    answerId,
    requestId: interactionRequest.requestId,
    submittedAt,
    answers: [
      {
        questionId: "question_durable_0001",
        kind: "single-select",
        optionId,
      },
    ],
  } as const;
}

function event(): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_structured_durable_0001",
    occurredAt: createdAt,
    sequence: 1,
    machineId: "machine_durable_0001",
    bridgeSessionId: "bridge_durable_0001",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    sessionId: "session_durable_0001",
    turnId: "turn_durable_0001",
    project: makeProjectRef("/workspace/synthetic"),
    type: "input.required",
    request: {
      correlationId: interactionRequest.requestId,
      kind: "select",
      question: interactionRequest.questions[0].prompt,
      options: interactionRequest.questions[0].options.map((option) => ({
        id: option.optionId,
        label: option.label,
      })),
      expiresAt,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

describe("structured interaction durable authority", () => {
  it("stores only the first validated terminal answer across database reopen", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-structured-interaction-"),
    );
    const databasePath = join(directory, "relay.sqlite");
    try {
      const firstAnswer = encodeInteractionAnswer(
        interactionRequest,
        interactionAnswer("answer_durable_0001", "option_first_0001"),
      );
      const secondAnswer = encodeInteractionAnswer(
        interactionRequest,
        interactionAnswer("answer_durable_0002", "option_second_0001"),
      );
      expect(Buffer.byteLength(firstAnswer, "utf8")).toBeLessThanOrEqual(4_000);
      const firstStore = new RelayStore(databasePath);
      firstStore.ingestEvent(event());

      expect(
        firstStore.resolveRequest({
          correlationId: interactionRequest.requestId,
          answer: firstAnswer,
          resolvedBy: "telegram",
          now: "2026-07-25T12:05:01.000Z",
        }),
      ).toMatchObject({ outcome: "answered" });
      expect(
        firstStore.resolveRequest({
          correlationId: interactionRequest.requestId,
          answer: secondAnswer,
          resolvedBy: "terminal",
          now: "2026-07-25T12:05:02.000Z",
        }),
      ).toMatchObject({ outcome: "duplicate" });
      firstStore.close();

      const reopened = new RelayStore(databasePath);
      expect(
        reopened.getPendingRequest(interactionRequest.requestId),
      ).toMatchObject({
        state: "answered",
        answer: firstAnswer,
        resolvedBy: "telegram",
      });
      expect(
        reopened.getPendingRequest(interactionRequest.requestId)?.answer,
      ).not.toBe(secondAnswer);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
