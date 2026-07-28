import { describe, expect, it } from "vitest";

import {
  AgentAttentionEventV1Schema,
  AgentCommandV1Schema,
  RelayDiagnosticV1Schema,
  makeProjectRef,
  makeStableEventId,
} from "./index.js";

const occurredAt = "2026-07-24T12:00:00.000Z";

function validEvent() {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_12345678",
    occurredAt,
    sequence: 3,
    machineId: "machine_12345678",
    bridgeSessionId: "bridge_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    sessionId: "session_12345678",
    turnId: "turn_12345678",
    project: makeProjectRef("/workspace/example"),
    type: "turn.stopped",
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  } as const;
}

describe("AgentAttentionEventV1Schema", () => {
  it("accepts a bounded normalized stop event", () => {
    expect(AgentAttentionEventV1Schema.parse(validEvent())).toEqual(
      validEvent(),
    );
  });

  it("requires a request for input.required", () => {
    const result = AgentAttentionEventV1Schema.safeParse({
      ...validEvent(),
      type: "input.required",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("require a request");
    }
  });

  it("rejects unbounded transcript-like content", () => {
    const result = AgentAttentionEventV1Schema.safeParse({
      ...validEvent(),
      lastAssistantMessage: "x".repeat(4_001),
    });

    expect(result.success).toBe(false);
  });

  it("accepts bounded background-work activity and rejects invalid placement or empty evidence", () => {
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "turn.activity",
        backgroundWork: {
          inFlightCount: 1,
          scheduledCount: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        backgroundWork: {
          inFlightCount: 1,
          scheduledCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "turn.activity",
        backgroundWork: {
          inFlightCount: 0,
          scheduledCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "turn.activity",
        backgroundWork: {
          inFlightCount: 1_001,
          scheduledCount: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("requires owned-child evidence before accepting a process crash", () => {
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "process.exited",
        failure: {
          class: "signal",
          message: "child received SIGKILL",
        },
      }).success,
    ).toBe(false);

    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "process.exited",
        failure: {
          class: "signal",
          message: "child received SIGKILL",
        },
        processExit: {
          source: "owned-child",
          supervisorId: "supervisor_12345678",
          startedAt: occurredAt,
          exitedAt: "2026-07-24T12:00:01.000Z",
          pid: 4321,
          signal: "SIGKILL",
          classification: "signal",
          expected: false,
        },
      }).success,
    ).toBe(true);
  });

  it("accepts twenty bounded select options and rejects a twenty-first", () => {
    const request = {
      correlationId: "correlation_select_12345678",
      kind: "select" as const,
      question: "Choose one",
      options: Array.from({ length: 20 }, (_, index) => ({
        id: `option_${String(index + 1).padStart(8, "0")}`,
        label: `Choice ${String(index + 1)}`,
      })),
      expiresAt: "2026-07-24T12:05:00.000Z",
    };
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request,
      }).success,
    ).toBe(true);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request: {
          ...request,
          options: [
            ...request.options,
            { id: "option_00000021", label: "Choice 21" },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("validates multi-select bounds and unique option IDs", () => {
    const request = {
      correlationId: "correlation_multi_12345678",
      kind: "multi-select" as const,
      question: "Choose several",
      options: [
        { id: "option_multi_0001", label: "One" },
        { id: "option_multi_0002", label: "Two" },
        { id: "option_multi_0003", label: "Three" },
      ],
      minSelections: 1,
      maxSelections: 2,
      expiresAt: "2026-07-24T12:05:00.000Z",
    };
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request,
      }).success,
    ).toBe(true);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request: { ...request, minSelections: 3 },
      }).success,
    ).toBe(false);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request: {
          ...request,
          options: [
            request.options[0]!,
            { ...request.options[1]!, id: request.options[0]!.id },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("embeds a bounded ordered interaction with matching identity and expiry", () => {
    const interaction = {
      schema: "agent-interaction-request.v1" as const,
      requestId: "correlation_question_set_0001",
      createdAt: occurredAt,
      expiresAt: "2026-07-24T12:05:00.000Z",
      title: "Release questions",
      lifecycle: "pending" as const,
      questions: [
        {
          questionId: "question_confirm_0001",
          kind: "confirm" as const,
          prompt: "Proceed?",
          confirm: { optionId: "confirm_yes_0000001", label: "Yes" },
          decline: { optionId: "confirm_no_00000001", label: "No" },
        },
        {
          questionId: "question_mode_0000001",
          kind: "single-select" as const,
          prompt: "Choose a mode",
          options: [
            { optionId: "mode_safe_00000001", label: "Safe" },
            { optionId: "mode_fast_00000001", label: "Fast" },
          ],
        },
      ],
      fallback: {
        preferredMode: "buttons" as const,
        alternativeModes: ["web-handoff" as const],
        whenUnavailable: "use-alternative" as const,
      },
    };
    const request = {
      correlationId: interaction.requestId,
      kind: "question-set" as const,
      question: interaction.title,
      interaction,
      expiresAt: interaction.expiresAt,
    };
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request,
      }).success,
    ).toBe(true);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request: {
          ...request,
          correlationId: "correlation_question_set_other",
        },
      }).success,
    ).toBe(false);
    expect(
      AgentAttentionEventV1Schema.safeParse({
        ...validEvent(),
        type: "input.required",
        request: {
          ...request,
          expiresAt: "2026-07-24T12:06:00.000Z",
        },
      }).success,
    ).toBe(false);
  });
});

describe("AgentCommandV1Schema", () => {
  it("rejects answer commands without an answer", () => {
    const result = AgentCommandV1Schema.safeParse({
      schema: "agent-command.v1",
      commandId: "command_12345678",
      issuedAt: occurredAt,
      expiresAt: "2026-07-24T12:05:00.000Z",
      machineId: "machine_12345678",
      harness: "claude",
      sessionId: "session_12345678",
      correlationId: "correlation_12345678",
      kind: "answer",
    });

    expect(result.success).toBe(false);
  });
});

describe("RelayDiagnosticV1Schema", () => {
  it("accepts bounded durable diagnostics and rejects arbitrary detail blobs", () => {
    const diagnostic = {
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: "diag_fallback_12345678",
      recordedAt: occurredAt,
      source: "fallback-spool",
      level: "error",
      code: "hook.invalid-payload",
      message: "Synthetic payload failed validation",
    };
    expect(RelayDiagnosticV1Schema.parse(diagnostic)).toEqual(diagnostic);
    expect(
      RelayDiagnosticV1Schema.safeParse({
        ...diagnostic,
        details: { transcript: "must not be accepted" },
      }).success,
    ).toBe(false);
  });
});

describe("stable local identity helpers", () => {
  it("does not expose the raw cwd", () => {
    const project = makeProjectRef("/Users/private/source/acme");
    expect(project.displayName).toBe("acme");
    expect(project.cwdHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(project)).not.toContain("/Users/private");
  });

  it("returns the same event id when a hook is retried", () => {
    const identity = {
      machineId: "machine_12345678",
      harness: "cursor" as const,
      sessionId: "session_12345678",
      turnId: "turn_12345678",
      type: "turn.stopped" as const,
      sequence: 7,
    };

    expect(makeStableEventId(identity)).toBe(makeStableEventId(identity));
  });
});
