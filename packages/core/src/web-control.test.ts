import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";

import { FakeNotificationTransport } from "./notifications/adapters/fake.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { TransportError } from "@agent-relay/notification-contracts";

const now = "2026-07-25T12:00:00.000Z";
const temporaryDirectories: string[] = [];

function event(
  requestKind: "input" | "select" | "multi-select" = "input",
): AgentAttentionEventV1 {
  const request =
    requestKind === "input"
      ? {
          correlationId: "request_web_control_12345678",
          kind: "input" as const,
          question: "Provide the deployment label",
          expiresAt: "2026-07-25T12:10:00.000Z",
        }
      : {
          correlationId: "request_web_control_12345678",
          kind: requestKind,
          question: "Choose the deployment target",
          options: [
            { id: "option_staging_12345678", label: "Staging" },
            { id: "option_prod_1234567890", label: "Production" },
          ],
          ...(requestKind === "multi-select"
            ? { minSelections: 1, maxSelections: 2 }
            : {}),
          expiresAt: "2026-07-25T12:10:00.000Z",
        };
  return {
    schema: "agent-attention.v1",
    eventId: "event_web_control_12345678",
    occurredAt: now,
    sequence: 1,
    machineId: "machine_web_control_12345678",
    bridgeSessionId: "bridge_web_control_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_web_control_12345678",
    turnId: "turn_web_control_12345678",
    project: {
      ...makeProjectRef("/private/workspace/project"),
      branch: "codex/web-control",
    },
    type: "input.required",
    summary: "Agent requires attention",
    lastAssistantMessage: "private transcript text",
    request,
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function questionSetEvent(): AgentAttentionEventV1 {
  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: "request_web_question_set_12345678",
    createdAt: now,
    expiresAt: "2026-07-25T12:10:00.000Z",
    title: "Release controls",
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: "question_web_confirm_12345678",
        kind: "confirm" as const,
        prompt: "Proceed?",
        confirm: {
          optionId: "option_web_proceed_12345678",
          label: "Proceed",
        },
        decline: {
          optionId: "option_web_stop_1234567890",
          label: "Stop",
        },
      },
      {
        questionId: "question_web_units_1234567890",
        kind: "multi-select" as const,
        prompt: "Choose units",
        options: [
          { optionId: "option_web_core_1234567890", label: "Core" },
          { optionId: "option_web_ui_123456789012", label: "UI" },
        ],
        minSelections: 1,
        maxSelections: 2,
      },
      {
        questionId: "question_web_note_1234567890",
        kind: "free-text" as const,
        prompt: "Release note",
        minLength: 3,
        maxLength: 80,
        multiline: false,
      },
    ],
    fallback: {
      preferredMode: "web-handoff" as const,
      alternativeModes: [],
      whenUnavailable: "reject" as const,
    },
  };
  return {
    ...event(),
    eventId: "event_web_question_set_12345678",
    request: {
      correlationId: interaction.requestId,
      kind: "question-set",
      question: interaction.title,
      interaction,
      expiresAt: interaction.expiresAt,
    },
  };
}

function runtime(store = new RelayStore()) {
  return {
    store,
    service: new RelayService(store, new FakeNotificationTransport(), {
      now: () => new Date(now),
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("durable web control", () => {
  it("lists bounded open attention and emits ordered transcript-free changes", () => {
    const { store, service } = runtime();
    service.ingest(event());

    expect(service.listPendingRequests(1)).toEqual([
      expect.objectContaining({
        correlationId: "request_web_control_12345678",
        state: "open",
      }),
    ]);
    expect(store.listSessions(1)).toEqual([
      expect.objectContaining({
        project: expect.objectContaining({
          displayName: "project",
          branch: "codex/web-control",
        }),
      }),
    ]);
    expect(service.listSessionsWithAttention(1)).toEqual([
      expect.objectContaining({
        laneState: "waiting",
        attentionCount: 1,
      }),
    ]);
    const changes = store.listWebChanges(0, 100);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.map(({ cursor }) => cursor)).toEqual(
      [...changes.map(({ cursor }) => cursor)].sort(
        (left, right) => left - right,
      ),
    );
    expect(JSON.stringify(changes)).not.toContain("private transcript text");
    expect(JSON.stringify(changes)).not.toContain(
      "Provide the deployment label",
    );
    expect(store.webChangeBounds()).toMatchObject({
      firstCursor: changes[0]?.cursor,
      lastCursor: changes.at(-1)?.cursor,
    });

    store.close();
  });

  it("makes browser resolution idempotent without weakening first-writer wins", () => {
    const { store, service } = runtime();
    service.ingest(event());
    const input = {
      operationId: "operation_web_control_12345678",
      correlationId: "request_web_control_12345678",
      response: { kind: "text" as const, text: "release-candidate" },
    };

    expect(service.resolveBrowser(input)).toMatchObject({
      outcome: "answered",
      replayed: false,
    });
    const afterFirst = store.webChangeBounds().lastCursor;
    expect(service.resolveBrowser(input)).toMatchObject({
      outcome: "answered",
      replayed: true,
    });
    expect(store.webChangeBounds().lastCursor).toBe(afterFirst);
    expect(
      service.resolveBrowser({
        ...input,
        response: { kind: "text", text: "different-answer" },
      }),
    ).toEqual({
      outcome: "replay_conflict",
      replayed: true,
    });
    expect(
      service.resolveTerminal({
        correlationId: input.correlationId,
        answer: "late-terminal-answer",
        expected: {
          machineId: event().machineId,
          harness: event().harness,
          sessionId: event().sessionId,
          ...(event().turnId === undefined
            ? {}
            : { turnId: event().turnId as string }),
        },
      }),
    ).toMatchObject({ outcome: "duplicate" });
    expect(store.getPendingRequest(input.correlationId)).toMatchObject({
      answer: "release-candidate",
      resolvedBy: "web",
    });

    store.close();
  });

  it("validates single and canonical multi-select responses", () => {
    const selectRuntime = runtime();
    selectRuntime.service.ingest(event("select"));
    expect(
      selectRuntime.service.resolveBrowser({
        operationId: "operation_invalid_choice_12345678",
        correlationId: "request_web_control_12345678",
        response: {
          kind: "option",
          optionId: "unknown_option_12345678",
        },
      }),
    ).toMatchObject({ outcome: "invalid_answer" });
    expect(
      selectRuntime.service.resolveBrowser({
        operationId: "operation_valid_choice_1234567890",
        correlationId: "request_web_control_12345678",
        response: {
          kind: "option",
          optionId: "option_staging_12345678",
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    selectRuntime.store.close();

    const structuredRuntime = runtime();
    structuredRuntime.service.ingest(event("multi-select"));
    expect(
      structuredRuntime.service.resolveBrowser({
        operationId: "operation_structured_1234567890",
        correlationId: "request_web_control_12345678",
        response: {
          kind: "multi-select",
          optionIds: ["option_staging_12345678"],
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      structuredRuntime.store.getPendingRequest("request_web_control_12345678"),
    ).toMatchObject({ answer: '["option_staging_12345678"]' });
    structuredRuntime.store.close();
  });

  it("validates and atomically commits the shared ordered question-set contract", () => {
    const { store, service } = runtime();
    const input = questionSetEvent();
    service.ingest(input);
    const response = {
      kind: "question-set" as const,
      answers: [
        {
          questionId: "question_web_confirm_12345678",
          kind: "confirm" as const,
          optionId: "option_web_proceed_12345678",
        },
        {
          questionId: "question_web_units_1234567890",
          kind: "multi-select" as const,
          optionIds: [
            "option_web_core_1234567890",
            "option_web_ui_123456789012",
          ],
        },
        {
          questionId: "question_web_note_1234567890",
          kind: "free-text" as const,
          text: "Ship safely",
        },
      ],
    };

    expect(
      service.resolveBrowser({
        operationId: "operation_web_question_set_12345678",
        correlationId: input.request!.correlationId,
        response,
      }),
    ).toMatchObject({ outcome: "answered", replayed: false });
    expect(
      JSON.parse(
        store.getPendingRequest(input.request!.correlationId)?.answer ?? "",
      ),
    ).toMatchObject({
      schema: "agent-interaction-answer.v1",
      answerId: "operation_web_question_set_12345678",
      requestId: input.request!.correlationId,
      answers: response.answers,
    });
    expect(
      store.getQuestionSetDraft(input.request!.correlationId),
    ).toMatchObject({ state: "superseded" });
    expect(
      service.resolveBrowser({
        operationId: "operation_web_question_set_12345678",
        correlationId: input.request!.correlationId,
        response,
      }),
    ).toMatchObject({ outcome: "answered", replayed: true });
    store.close();

    const invalid = runtime();
    const invalidInput = questionSetEvent();
    invalid.service.ingest(invalidInput);
    expect(
      invalid.service.resolveBrowser({
        operationId: "operation_web_question_invalid_12345678",
        correlationId: invalidInput.request!.correlationId,
        response: {
          ...response,
          answers: response.answers.map((answer) =>
            answer.kind === "multi-select"
              ? { ...answer, optionIds: [] }
              : answer,
          ),
        },
      }),
    ).toMatchObject({ outcome: "invalid_answer", replayed: false });
    expect(
      invalid.store.getPendingRequest(invalidInput.request!.correlationId),
    ).toMatchObject({ state: "open" });
    invalid.store.close();
  });

  it("keeps Telegram and browser on one first-writer authority", () => {
    const { store, service } = runtime();
    const input = event();
    service.ingest(input);
    expect(
      store.resolveRequest({
        correlationId: input.request!.correlationId,
        answer: "telegram-first",
        resolvedBy: "telegram",
        now,
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      service.resolveBrowser({
        operationId: "operation_web_losing_surface_12345678",
        correlationId: input.request!.correlationId,
        response: { kind: "text", text: "browser-late" },
      }),
    ).toMatchObject({
      outcome: "duplicate",
      replayed: false,
      request: expect.objectContaining({
        state: "answered",
        resolvedBy: "telegram",
      }),
    });
    expect(store.getPendingRequest(input.request!.correlationId)).toMatchObject(
      {
        answer: "telegram-first",
        resolvedBy: "telegram",
      },
    );
    store.close();
  });

  it("keeps a committed browser answer and diagnoses notification edit failure", async () => {
    class FailingEditTransport extends FakeNotificationTransport {
      public override async editResolvedMessage(): Promise<void> {
        throw new TransportError(
          "synthetic notification edit timeout",
          "synthetic-edit-timeout",
          true,
        );
      }
    }
    const store = new RelayStore();
    const transport = new FailingEditTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(now),
    });
    const input = event();
    service.ingest(input);
    await service.drain();
    const result = service.resolveBrowser({
      operationId: "operation_web_edit_failure_12345678",
      correlationId: input.request!.correlationId,
      response: { kind: "text", text: "committed before edit" },
    });

    await expect(service.synchronizeBrowserResolution(result)).resolves.toBe(
      "failed",
    );
    expect(store.getPendingRequest(input.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "committed before edit",
        resolvedBy: "web",
      },
    );
    expect(store.listDiagnostics()).toEqual([
      expect.objectContaining({
        code: "web.resolution-surface-sync-failed",
        message: expect.not.stringContaining("committed before edit"),
      }),
    ]);
    store.close();
  });

  it("resumes the durable cursor after a store restart without duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-web-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const first = runtime(new RelayStore(databasePath));
    first.service.ingest(event());
    const cursor = first.store.listWebChanges(0, 2).at(-1)?.cursor ?? 0;
    first.store.close();

    const second = new RelayStore(databasePath);
    const resumed = second.listWebChanges(cursor, 100);
    expect(resumed.every((change) => change.cursor > cursor)).toBe(true);
    expect(new Set(resumed.map((change) => change.cursor)).size).toBe(
      resumed.length,
    );
    second.close();
  });

  it("isolates concurrent browser requests by correlation and session", () => {
    const { store, service } = runtime();
    const first = event();
    const second: AgentAttentionEventV1 = {
      ...event(),
      eventId: "event_web_second_12345678",
      machineId: "machine_web_second_12345678",
      bridgeSessionId: "bridge_web_second_12345678",
      sessionId: "session_web_second_12345678",
      turnId: "turn_web_second_12345678",
      request: {
        correlationId: "request_web_second_12345678",
        kind: "input",
        question: "Provide the second label",
        expiresAt: "2026-07-25T12:10:00.000Z",
      },
    };
    service.ingest(first);
    service.ingest(second);

    expect(
      service.resolveBrowser({
        operationId: "operation_web_first_12345678",
        correlationId: first.request!.correlationId,
        response: { kind: "text", text: "first-answer" },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      store.getPendingRequest(second.request!.correlationId),
    ).toMatchObject({
      state: "open",
    });
    expect(
      store.getPendingRequest(second.request!.correlationId)?.answer,
    ).toBeUndefined();
    expect(
      service.resolveBrowser({
        operationId: "operation_web_second_12345678",
        correlationId: second.request!.correlationId,
        response: { kind: "text", text: "second-answer" },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(store.getPendingRequest(first.request!.correlationId)?.answer).toBe(
      "first-answer",
    );
    expect(store.getPendingRequest(second.request!.correlationId)?.answer).toBe(
      "second-answer",
    );
    store.close();
  });

  it("rejects a stale browser answer without reopening the request", () => {
    const { store, service } = runtime();
    service.ingest(event());
    const lateService = new RelayService(
      store,
      new FakeNotificationTransport(),
      {
        now: () => new Date("2026-07-25T12:11:00.000Z"),
      },
    );

    expect(
      lateService.resolveBrowser({
        operationId: "operation_web_stale_12345678",
        correlationId: "request_web_control_12345678",
        response: { kind: "text", text: "late-answer" },
      }),
    ).toMatchObject({ outcome: "expired", replayed: false });
    expect(
      store.getPendingRequest("request_web_control_12345678"),
    ).toMatchObject({ state: "expired" });
    expect(
      store.getPendingRequest("request_web_control_12345678")?.answer,
    ).toBeUndefined();
    store.close();
  });

  it("targets exact session events and makes shared session controls replay-safe", async () => {
    const { store, service } = runtime();
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "event_web_session_action_12345678",
      type: "turn.stopped",
      request: {
        correlationId: "request_web_session_action_12345678",
        kind: "continuation",
        question: "Continue?",
        expiresAt: "2026-07-25T12:10:00.000Z",
      },
    };
    service.ingest(input);
    await service.drain();
    const key = sha256(
      `${input.machineId}\u001f${input.harness}\u001f${input.sessionId}`,
    ).slice(0, 24);
    const command = {
      operationId: "operation_web_session_action_12345678",
      sessionKey: key,
      eventId: input.eventId,
      action: "continue" as const,
    };
    const first = service.executeBrowserSessionAction(command);
    expect(first).toMatchObject({ outcome: "succeeded", replayed: false });
    expect(store.getPendingRequest(input.request!.correlationId)).toMatchObject(
      {
        state: "answered",
        answer: "Continue.",
        resolvedBy: "web",
      },
    );
    await expect(service.synchronizeBrowserSessionAction(first)).resolves.toBe(
      "updated",
    );
    expect(
      (service.transport as FakeNotificationTransport).messageEdits.at(-1)
        ?.text,
    ).toContain("Answered");
    expect(service.executeBrowserSessionAction(command)).toMatchObject({
      outcome: "succeeded",
      replayed: true,
    });
    expect(
      service.executeBrowserSessionAction({
        ...command,
        action: "mute",
      }),
    ).toMatchObject({ outcome: "replay_conflict", replayed: true });

    const other: AgentAttentionEventV1 = {
      ...event(),
      eventId: "event_web_session_other_12345678",
      machineId: "machine_web_session_other_12345678",
      bridgeSessionId: "bridge_web_session_other_12345678",
      sessionId: "session_web_session_other_12345678",
      request: undefined,
      type: "turn.activity",
    };
    service.ingest(other);
    const otherKey = sha256(
      `${other.machineId}\u001f${other.harness}\u001f${other.sessionId}`,
    ).slice(0, 24);
    expect(
      service.executeBrowserSessionAction({
        operationId: "operation_web_cross_session_12345678",
        sessionKey: otherKey,
        eventId: input.eventId,
        action: "mute",
      }),
    ).toMatchObject({ outcome: "identity_mismatch" });

    service.ingest({
      ...input,
      eventId: "event_web_session_newer_12345678",
      sequence: 2,
      request: undefined,
      type: "turn.activity",
    });
    expect(service.executeBrowserSessionAction(command)).toMatchObject({
      outcome: "succeeded",
      replayed: true,
    });
    expect(
      service.executeBrowserSessionAction({
        operationId: "operation_web_stale_control_12345678",
        sessionKey: key,
        eventId: input.eventId,
        action: "mute",
      }),
    ).toMatchObject({ outcome: "stale_event" });
    store.close();
  });

  it("correlates hook, delivery, answer, and continuation timeline entries", async () => {
    const { store, service } = runtime();
    const input: AgentAttentionEventV1 = {
      ...event(),
      eventId: "event_web_timeline_12345678",
      type: "turn.stopped",
      request: {
        correlationId: "request_web_timeline_12345678",
        kind: "continuation",
        question: "Continue?",
        expiresAt: "2026-07-25T12:10:00.000Z",
      },
    };
    service.ingest(input);
    await service.drain();
    service.resolveBrowser({
      operationId: "operation_web_timeline_12345678",
      correlationId: input.request!.correlationId,
      response: { kind: "text", text: "continue safely" },
    });
    expect(
      service.claimNextResume({
        machineId: input.machineId,
        bridgeSessionId: input.bridgeSessionId,
        harness: input.harness,
        ownerId: "owner_web_timeline_12345678",
      }),
    ).toMatchObject({ outcome: "claimed" });
    service.markResumeStarted(
      input.request!.correlationId,
      "owner_web_timeline_12345678",
    );
    service.markResumeFinished({
      correlationId: input.request!.correlationId,
      ownerId: "owner_web_timeline_12345678",
      succeeded: true,
      exitCode: 0,
    });

    const key = sha256(
      `${input.machineId}\u001f${input.harness}\u001f${input.sessionId}`,
    ).slice(0, 24);
    expect(service.listSessionTimeline(key, 100)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hook-event",
          eventId: input.eventId,
          correlationId: input.request!.correlationId,
        }),
        expect.objectContaining({
          kind: "delivery",
          eventId: input.eventId,
        }),
        expect.objectContaining({
          kind: "operator-action",
          label: "web",
          correlationId: input.request!.correlationId,
        }),
        expect.objectContaining({
          kind: "continuation",
          status: "succeeded",
          correlationId: input.request!.correlationId,
          detailCode: "exit-0",
        }),
      ]),
    );
    expect(
      service.listSessionTimeline("unknown-session-key", 100),
    ).toBeUndefined();
    store.close();
  });
});
