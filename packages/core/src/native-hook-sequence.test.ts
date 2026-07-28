import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";

import { RelayStore } from "./store.js";

const allocatedAt = "2026-07-28T12:00:00.000Z";

function fingerprint(value: string): string {
  return sha256(`native-hook-sequence:${value}`);
}

function allocation(
  value: string,
  overrides: Partial<{
    machineId: string;
    harness: "codex" | "claude" | "cursor";
    sessionId: string;
    eventId: string;
    allocatedAt: string;
  }> = {},
) {
  return {
    machineId: overrides.machineId ?? "machine_hook_sequence_12345678",
    harness: overrides.harness ?? ("claude" as const),
    sessionId: overrides.sessionId ?? "session_hook_sequence_12345678",
    eventId: overrides.eventId ?? `event_hook_sequence_${value}_12345678`,
    sourceFingerprint: fingerprint(value),
    allocatedAt: overrides.allocatedAt ?? allocatedAt,
  };
}

function event(
  eventId: string,
  sequence: number,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: allocatedAt,
    sequence,
    machineId: overrides.machineId ?? "machine_hook_sequence_legacy",
    bridgeSessionId: "bridge_hook_sequence_legacy",
    harness: overrides.harness ?? "claude",
    surface: "cli",
    harnessVersion: "test",
    sessionId: overrides.sessionId ?? "session_hook_sequence_legacy",
    project: makeProjectRef("/workspace/native-hook-sequence"),
    type: overrides.type ?? "turn.stopped",
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
    ...overrides,
  };
}

describe("durable native hook sequence allocation", () => {
  it("reuses one fingerprint and advances distinct events across connections and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-sequence-"));
    const databasePath = join(directory, "relay.sqlite");
    const first = new RelayStore(databasePath);
    const second = new RelayStore(databasePath);

    expect(first.allocateNativeHookSequence(allocation("one"))).toBe(1);
    expect(second.allocateNativeHookSequence(allocation("one"))).toBe(1);
    expect(second.allocateNativeHookSequence(allocation("two"))).toBe(2);
    first.close();
    second.close();

    const restarted = new RelayStore(databasePath);
    expect(restarted.allocateNativeHookSequence(allocation("three"))).toBe(3);
    restarted.close();
  });

  it("adopts a retained legacy event sequence and advances beyond session state", () => {
    const store = new RelayStore();
    const legacy = event("event_hook_sequence_retained_12345678", 900, {
      type: "turn.activity",
      backgroundWork: {
        inFlightCount: 1,
        scheduledCount: 0,
      },
    });
    store.ingestEvent(legacy);
    expect(store.listSessions()[0]).toMatchObject({
      state: "active",
      lastSequence: 900,
    });

    expect(
      store.allocateNativeHookSequence(
        allocation("retained", {
          machineId: legacy.machineId,
          harness: legacy.harness,
          sessionId: legacy.sessionId,
          eventId: legacy.eventId,
        }),
      ),
    ).toBe(900);
    const nextInput = allocation("next", {
      machineId: legacy.machineId,
      harness: legacy.harness,
      sessionId: legacy.sessionId,
    });
    const nextSequence = store.allocateNativeHookSequence(nextInput);
    expect(nextSequence).toBe(901);
    store.ingestEvent(
      event(nextInput.eventId, nextSequence, {
        machineId: legacy.machineId,
        harness: legacy.harness,
        sessionId: legacy.sessionId,
      }),
    );
    expect(store.listSessions()[0]).toMatchObject({
      state: "waiting",
      lastSequence: 901,
    });
    store.close();
  });

  it("prunes orphaned old mappings and counters without touching retained events", () => {
    const store = new RelayStore();
    const orphan = allocation("orphan", {
      allocatedAt: "2026-01-01T12:00:00.000Z",
      sessionId: "session_hook_sequence_orphan",
    });
    const retainedInput = allocation("retained-event", {
      allocatedAt: "2026-01-01T12:00:00.000Z",
      machineId: "machine_hook_sequence_retention",
      sessionId: "session_hook_sequence_retention",
      eventId: "event_hook_sequence_retention_12345678",
    });
    const retained = event(retainedInput.eventId, 41, {
      machineId: retainedInput.machineId,
      harness: retainedInput.harness,
      sessionId: retainedInput.sessionId,
    });
    expect(store.allocateNativeHookSequence(orphan)).toBe(1);
    store.ingestEvent(retained);
    expect(store.allocateNativeHookSequence(retainedInput)).toBe(41);

    const result = store.pruneRetention({
      deliveredBefore: "2026-06-01T12:00:00.000Z",
      deadLetterBefore: "2026-06-01T12:00:00.000Z",
      requestBefore: "2026-06-01T12:00:00.000Z",
      diagnosticBefore: "2026-06-01T12:00:00.000Z",
      telegramUpdateBefore: "2026-06-01T12:00:00.000Z",
      topicCleanupBefore: "2026-06-01T12:00:00.000Z",
      sessionBefore: "2026-06-01T12:00:00.000Z",
      webChangeBefore: "2026-06-01T12:00:00.000Z",
      browserCommandBefore: "2026-06-01T12:00:00.000Z",
    });
    expect(result).toMatchObject({
      nativeHookSequenceAllocations: 1,
      nativeHookSequenceCounters: 1,
    });
    expect(store.allocateNativeHookSequence(orphan)).toBe(1);
    expect(store.allocateNativeHookSequence(retainedInput)).toBe(41);
    store.close();
  });

  it("rejects malformed fingerprints and cross-session event identity reuse", () => {
    const store = new RelayStore();
    expect(() =>
      store.allocateNativeHookSequence({
        ...allocation("malformed"),
        sourceFingerprint: "not-a-sha256",
      }),
    ).toThrow();

    const allocated = allocation("allocated-collision");
    expect(store.allocateNativeHookSequence(allocated)).toBe(1);
    expect(() =>
      store.allocateNativeHookSequence({
        ...allocation("other-source", {
          eventId: allocated.eventId,
        }),
      }),
    ).toThrow("already bound to another source");

    const retained = event("event_hook_sequence_collision_12345678", 7);
    store.ingestEvent(retained);
    expect(() =>
      store.allocateNativeHookSequence(
        allocation("collision", {
          eventId: retained.eventId,
          machineId: "machine_hook_sequence_other",
          sessionId: "session_hook_sequence_other",
        }),
      ),
    ).toThrow("already bound to another session");
    store.close();
  });
});
