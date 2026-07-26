import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const oldTime = "2026-01-01T12:00:00.000Z";
const currentTime = "2026-07-24T12:00:00.000Z";

function event(
  eventId: string,
  occurredAt: string,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt,
    sequence: overrides.sequence ?? 1,
    machineId: overrides.machineId ?? "machine_retention_12345678",
    bridgeSessionId: overrides.bridgeSessionId ?? "bridge_retention_12345678",
    harness: overrides.harness ?? "codex",
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "test",
    sessionId: overrides.sessionId ?? `session_${eventId.replace("evt_", "")}`,
    project: overrides.project ?? makeProjectRef("/workspace/retention"),
    type: overrides.type ?? "turn.stopped",
    summary: overrides.summary ?? "Synthetic retention event",
    ...(overrides.request === undefined ? {} : { request: overrides.request }),
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.processExit === undefined
      ? {}
      : { processExit: overrides.processExit }),
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

describe("durable retention controls", () => {
  it("prunes terminal history while preserving recent and open work", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const oldService = new RelayService(store, transport, {
      now: () => new Date(oldTime),
    });
    const currentService = new RelayService(store, transport, {
      now: () => new Date(currentTime),
    });

    const oldDelivered = event("evt_retention_old_delivered", oldTime);
    oldService.ingest(oldDelivered);
    await oldService.drain();

    const answered = event("evt_retention_answered", oldTime, {
      request: {
        correlationId: "correlation_retention_answered",
        kind: "input",
        question: "Synthetic completed question?",
        expiresAt: "2026-01-02T12:00:00.000Z",
      },
    });
    oldService.ingest(answered);
    await oldService.drain();
    oldService.resolveTerminal({
      correlationId: answered.request?.correlationId ?? "",
      answer: "completed",
      expected: {
        machineId: answered.machineId,
        harness: answered.harness,
        sessionId: answered.sessionId,
      },
    });

    const stillOpen = event("evt_retention_open", oldTime, {
      request: {
        correlationId: "correlation_retention_open",
        kind: "input",
        question: "Synthetic still-open question?",
        expiresAt: "2026-01-02T12:00:00.000Z",
      },
    });
    oldService.ingest(stillOpen);
    await oldService.drain();

    const deadLetter = event("evt_retention_dead_letter", oldTime);
    oldService.ingest(deadLetter);
    const claimed = store.claimDueEvents(oldTime);
    expect(claimed).toHaveLength(1);
    store.markDeliveryFailed(
      deadLetter.eventId,
      claimed[0]?.attemptNumber ?? 1,
      "synthetic-terminal",
      "Synthetic terminal failure",
      false,
      oldTime,
    );

    const exited = event("evt_retention_exited", oldTime, {
      type: "process.exited",
      failure: {
        class: "exit-code",
        message: "Synthetic exit",
      },
      processExit: {
        source: "owned-child",
        supervisorId: "supervisor_retention_12345678",
        startedAt: "2026-01-01T11:00:00.000Z",
        exitedAt: oldTime,
        exitCode: 17,
        classification: "nonzero-exit",
        expected: false,
      },
    });
    oldService.ingest(exited);
    await oldService.drain();

    const recent = event("evt_retention_recent", currentTime);
    currentService.ingest(recent);
    await currentService.drain();

    oldService.reportDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: "diag_retention_old_12345678",
      recordedAt: oldTime,
      source: "daemon",
      level: "warn",
      code: "synthetic.old",
      message: "Synthetic old diagnostic",
    });
    currentService.reportDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: "diag_retention_recent_12345678",
      recordedAt: currentTime,
      source: "daemon",
      level: "info",
      code: "synthetic.recent",
      message: "Synthetic recent diagnostic",
    });
    store.claimTelegramUpdate(1, oldTime);
    store.claimTelegramUpdate(2, currentTime);

    const first = currentService.maintainRetention({
      deliveredDays: 30,
      deadLetterDays: 90,
      requestDays: 30,
      diagnosticDays: 90,
      telegramUpdateDays: 30,
      sessionDays: 90,
    });
    expect(first).toMatchObject({
      requestsExpired: 1,
      pendingRequests: 1,
      events: 4,
      deliveryAttempts: 4,
      diagnostics: 1,
      telegramUpdates: 1,
      sessions: 1,
    });
    expect(store.getEvent(oldDelivered.eventId)).toBeUndefined();
    expect(store.getEvent(answered.eventId)).toBeUndefined();
    expect(store.getEvent(deadLetter.eventId)).toBeUndefined();
    expect(store.getEvent(exited.eventId)).toBeUndefined();
    expect(store.getEvent(stillOpen.eventId)).toBeDefined();
    expect(store.getEvent(recent.eventId)).toBeDefined();
    expect(store.getPendingRequest("correlation_retention_open")).toMatchObject(
      { state: "expired" },
    );
    expect(store.listDiagnostics()).toEqual([
      expect.objectContaining({
        diagnosticId: "diag_retention_recent_12345678",
      }),
    ]);
    expect(
      currentService.maintainRetention({
        deliveredDays: 30,
        deadLetterDays: 90,
        requestDays: 30,
        diagnosticDays: 90,
        telegramUpdateDays: 30,
        sessionDays: 90,
      }),
    ).toEqual({
      requestsExpired: 0,
      pendingRequests: 0,
      interactionDrafts: 0,
      questionSetDrafts: 0,
      resumeCommands: 0,
      events: 0,
      deliveryAttempts: 0,
      diagnostics: 0,
      telegramUpdates: 0,
      sessions: 0,
    });
    store.close();
  });

  it("never prunes a request with an active resume command", () => {
    const store = new RelayStore();
    const oldService = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(oldTime),
    });
    const currentService = new RelayService(
      store,
      new FakeTelegramTransport(),
      { now: () => new Date(currentTime) },
    );
    const continuation = event("evt_retention_active_resume", oldTime, {
      request: {
        correlationId: "correlation_retention_active_resume",
        kind: "continuation",
        question: "Continue?",
        expiresAt: "2026-12-01T12:00:00.000Z",
      },
    });
    oldService.ingest(continuation);
    oldService.resolveTerminal({
      correlationId: continuation.request?.correlationId ?? "",
      answer: "continue",
      expected: {
        machineId: continuation.machineId,
        harness: continuation.harness,
        sessionId: continuation.sessionId,
      },
    });
    expect(
      oldService.claimNextResume({
        machineId: continuation.machineId,
        bridgeSessionId: continuation.bridgeSessionId,
        harness: continuation.harness,
        ownerId: "supervisor_retention_12345678",
      }),
    ).toMatchObject({ outcome: "claimed" });

    const result = currentService.maintainRetention({ requestDays: 30 });
    expect(result.pendingRequests).toBe(0);
    expect(result.resumeCommands).toBe(0);
    expect(
      store.getPendingRequest("correlation_retention_active_resume"),
    ).toBeDefined();
    expect(store.listResumeCommands()).toHaveLength(1);
    store.close();
  });
});
