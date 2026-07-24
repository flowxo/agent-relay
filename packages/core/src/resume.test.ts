import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const now = "2026-07-24T12:00:00.000Z";

function continuationEvent(
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: overrides.eventId ?? "evt_resume_question_12345678",
    occurredAt: overrides.occurredAt ?? now,
    sequence: overrides.sequence ?? 10,
    machineId: overrides.machineId ?? "machine_resume_12345678",
    bridgeSessionId: overrides.bridgeSessionId ?? "bridge_resume_12345678",
    harness: overrides.harness ?? "codex",
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "test",
    sessionId: overrides.sessionId ?? "session_resume_12345678",
    turnId: overrides.turnId ?? "turn_resume_12345678",
    project: overrides.project ?? makeProjectRef("/workspace/resume"),
    type: "turn.stopped",
    summary: "Synthetic stopped turn",
    request: overrides.request ?? {
      correlationId: "correlation_resume_12345678",
      kind: "continuation",
      question: "Continue?",
      expiresAt: "2026-07-24T12:10:00.000Z",
    },
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

describe("durable late resume commands", () => {
  it("claims an answered continuation once and audits every transition", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(now),
    });
    const event = continuationEvent();
    service.ingest(event);
    service.resolveTerminal({
      correlationId: event.request?.correlationId ?? "",
      answer: "continue with the safe path",
      expected: {
        machineId: event.machineId,
        harness: event.harness,
        sessionId: event.sessionId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      },
    });

    const first = service.claimNextResume({
      machineId: event.machineId,
      bridgeSessionId: event.bridgeSessionId,
      harness: event.harness,
      ownerId: "supervisor_owner_one",
    });
    const duplicate = service.claimNextResume({
      machineId: event.machineId,
      bridgeSessionId: event.bridgeSessionId,
      harness: event.harness,
      ownerId: "supervisor_owner_two",
    });

    expect(first).toMatchObject({
      outcome: "claimed",
      command: {
        correlationId: event.request?.correlationId,
        ownerId: "supervisor_owner_one",
        answer: "continue with the safe path",
        state: "claimed",
      },
    });
    expect(duplicate).toEqual({ outcome: "none" });
    expect(() =>
      service.markResumeStarted(
        event.request?.correlationId ?? "",
        "supervisor_owner_two",
      ),
    ).toThrow("not claimable");
    expect(
      service.markResumeStarted(
        event.request?.correlationId ?? "",
        "supervisor_owner_one",
      ),
    ).toMatchObject({ state: "running" });
    expect(
      service.markResumeFinished({
        correlationId: event.request?.correlationId ?? "",
        ownerId: "supervisor_owner_one",
        succeeded: true,
        exitCode: 0,
      }),
    ).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect(store.status().resumeCommands.succeeded).toBe(1);
    store.close();
  });

  it("returns a waiting state without treating inactivity as a hang", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(now),
    });
    const event = continuationEvent();
    service.ingest(event);

    expect(
      service.claimNextResume({
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        ownerId: "supervisor_waiting_12345678",
      }),
    ).toMatchObject({
      outcome: "waiting",
      correlationId: event.request?.correlationId,
    });
    expect(store.listSessions()[0]?.state).toBe("waiting");
    expect(store.status().sessions.suspected_stalled).toBe(0);
    store.close();
  });

  it("never claims an answer after its continuation expiry", () => {
    let current = new Date(now);
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(current),
    });
    const event = continuationEvent({
      eventId: "evt_resume_stale_answer_12345678",
      request: {
        correlationId: "correlation_resume_stale_12345678",
        kind: "continuation",
        question: "Continue briefly?",
        expiresAt: "2026-07-24T12:00:01.000Z",
      },
    });
    service.ingest(event);
    service.resolveTerminal({
      correlationId: event.request?.correlationId ?? "",
      answer: "timely answer",
      expected: {
        machineId: event.machineId,
        harness: event.harness,
        sessionId: event.sessionId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      },
    });
    current = new Date("2026-07-24T12:00:02.000Z");

    expect(
      service.claimNextResume({
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        ownerId: "supervisor_stale_12345678",
      }),
    ).toEqual({ outcome: "none" });
    expect(store.listResumeCommands()).toEqual([]);
    store.close();
  });

  it("audits an answered Cursor IDE request as unsupported", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(now),
    });
    const event = continuationEvent({
      eventId: "evt_resume_cursor_ide_12345678",
      harness: "cursor",
      surface: "ide",
      sessionId: "session_cursor_ide_12345678",
      turnId: "turn_cursor_ide_12345678",
      request: {
        correlationId: "correlation_cursor_ide_12345678",
        kind: "continuation",
        question: "Continue?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
      capabilities: {
        inlineContinue: true,
        lateResume: false,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    service.ingest(event);
    service.resolveTerminal({
      correlationId: event.request?.correlationId ?? "",
      answer: "continue",
      expected: {
        machineId: event.machineId,
        harness: event.harness,
        sessionId: event.sessionId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      },
    });

    expect(
      service.claimNextResume({
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        ownerId: "supervisor_cursor_12345678",
      }),
    ).toMatchObject({
      outcome: "unsupported",
      harness: "cursor",
      surface: "ide",
    });
    expect(store.listResumeCommands()[0]).toMatchObject({
      state: "unsupported",
      errorCode: "late-resume-unsupported",
    });
    store.close();
  });

  it("isolates resume claims across concurrent bridge sessions", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(now),
    });
    const first = continuationEvent({
      eventId: "evt_resume_isolation_one",
      bridgeSessionId: "bridge_resume_isolation_one",
      sessionId: "session_resume_isolation_one",
      turnId: "turn_resume_isolation_one",
      request: {
        correlationId: "correlation_resume_isolation_one",
        kind: "continuation",
        question: "Continue first?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    });
    const second = continuationEvent({
      eventId: "evt_resume_isolation_two",
      harness: "claude",
      bridgeSessionId: "bridge_resume_isolation_two",
      sessionId: "session_resume_isolation_two",
      turnId: "turn_resume_isolation_two",
      request: {
        correlationId: "correlation_resume_isolation_two",
        kind: "continuation",
        question: "Continue second?",
        expiresAt: "2026-07-24T12:10:00.000Z",
      },
    });
    service.ingest(first);
    service.ingest(second);
    for (const [event, answer] of [
      [first, "first answer"],
      [second, "second answer"],
    ] as const) {
      service.resolveTerminal({
        correlationId: event.request?.correlationId ?? "",
        answer,
        expected: {
          machineId: event.machineId,
          harness: event.harness,
          sessionId: event.sessionId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        },
      });
    }

    expect(
      service.claimNextResume({
        machineId: first.machineId,
        bridgeSessionId: first.bridgeSessionId,
        harness: first.harness,
        ownerId: "supervisor_isolation_one",
      }),
    ).toMatchObject({
      outcome: "claimed",
      command: {
        sessionId: first.sessionId,
        answer: "first answer",
      },
    });
    expect(
      service.claimNextResume({
        machineId: second.machineId,
        bridgeSessionId: second.bridgeSessionId,
        harness: second.harness,
        ownerId: "supervisor_isolation_two",
      }),
    ).toMatchObject({
      outcome: "claimed",
      command: {
        sessionId: second.sessionId,
        answer: "second answer",
      },
    });
    store.close();
  });

  it("represents a probe-backed stale event as a distinct warning state", () => {
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport());
    const event = continuationEvent({
      eventId: "evt_process_stale_12345678",
    });
    event.type = "process.stale";
    event.summary = "Synthetic harness health probe failed";
    delete event.request;
    service.ingest(event);

    expect(store.listSessions()[0]?.state).toBe("suspected_stalled");
    expect(store.status().sessions).toMatchObject({
      suspected_stalled: 1,
      exited: 0,
    });
    store.close();
  });
});
