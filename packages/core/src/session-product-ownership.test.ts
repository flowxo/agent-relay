import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";

import { RelayStore } from "./store.js";

const project = makeProjectRef("/workspace/adoption-fixture");
const capabilities = {
  inlineContinue: true,
  lateResume: true,
  activeSteer: false,
  permissionDecision: true,
};

function event(
  eventId: string,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: "2026-07-27T12:00:00.000Z",
    sequence: 7,
    machineId: "machine_adoption_fixture",
    bridgeSessionId: "bridge_adoption_fixture",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    sessionId: "native_adoption_fixture",
    project,
    type: "turn.stopped",
    capabilities,
    ...overrides,
  };
}

function claim() {
  return {
    adoptionId: "adoption_fixture_0001",
    requestFingerprint: sha256("adoption-request"),
    machineId: "machine_adoption_fixture",
    harness: "codex" as const,
    surface: "cli" as const,
    sessionId: "native_adoption_fixture",
    bridgeSessionId: "bridge_adoption_fixture",
    expectedSequence: 7,
    projectAuthorityDigest: `sha256:${sha256(JSON.stringify(project))}`,
    capabilityDigest: sha256(JSON.stringify(capabilities)),
    harnessVersion: "0.145.0",
    productSessionId: "ses_adopted_fixture",
    claimedAt: "2026-07-27T12:01:00.000Z",
  };
}

describe("standalone session product ownership", () => {
  it("claims one exact checkpoint and then rejects standalone ingestion", () => {
    const store = new RelayStore();
    store.ingestEvent(event("evt_adoption_fixture_1"));

    expect(store.claimSessionForProduct(claim())).toMatchObject({
      outcome: "claimed",
      receipt: {
        adoptionId: "adoption_fixture_0001",
        productSessionId: "ses_adopted_fixture",
      },
    });
    expect(store.claimSessionForProduct(claim())).toMatchObject({
      outcome: "duplicate",
    });
    expect(
      store.sessionActuatorOwner({
        machineId: claim().machineId,
        harness: claim().harness,
        sessionId: claim().sessionId,
      }),
    ).toBe("product-managed");
    expect(() =>
      store.ingestEvent(
        event("evt_adoption_fixture_2", {
          sequence: 8,
          type: "turn.started",
        }),
      ),
    ).toThrow("rejects standalone attention ingestion");
    store.close();
  });

  it("fails changed checkpoints and pending standalone decisions closed", () => {
    const changed = new RelayStore();
    changed.ingestEvent(event("evt_adoption_changed"));
    expect(
      changed.claimSessionForProduct({
        ...claim(),
        expectedSequence: 8,
      }),
    ).toEqual({
      outcome: "rejected",
      safeCode: "session_checkpoint_changed",
    });
    changed.close();

    const pending = new RelayStore();
    pending.ingestEvent(
      event("evt_adoption_pending", {
        type: "input.required",
        request: {
          correlationId: "request_adoption_pending",
          kind: "confirm",
          question: "Continue the synthetic fixture?",
          expiresAt: "2026-07-27T12:30:00.000Z",
        },
      }),
    );
    expect(pending.claimSessionForProduct(claim())).toEqual({
      outcome: "rejected",
      safeCode: "standalone_interaction_pending",
    });
    pending.close();
  });
});
