import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";

import { RelayStore } from "./store.js";

const project = makeProjectRef("/workspace/session-adoption");
const otherProject = makeProjectRef("/workspace/other-project");
const capabilities = {
  inlineContinue: true,
  lateResume: true,
  activeSteer: false,
  permissionDecision: true,
};

function event(input: {
  eventId: string;
  sessionId: string;
  sequence?: number;
  occurredAt?: string;
  type?: AgentAttentionEventV1["type"];
  project?: AgentAttentionEventV1["project"];
  harnessVersion?: string;
}): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: input.eventId,
    occurredAt: input.occurredAt ?? "2026-07-28T12:00:00.000Z",
    sequence: input.sequence ?? 1,
    machineId: `machine_${input.sessionId}`,
    bridgeSessionId: `bridge_${input.sessionId}`,
    harness: "codex",
    surface: "cli",
    harnessVersion: input.harnessVersion ?? "0.145.0",
    sessionId: input.sessionId,
    project: input.project ?? project,
    type: input.type ?? "turn.stopped",
    capabilities,
  };
}

describe("session adoption candidate checkpoints", () => {
  it("lists only exact eligible sessions without exposing competing state", () => {
    const store = new RelayStore();
    store.ingestEvent(
      event({
        eventId: "evt_candidate_old",
        sessionId: "native_candidate_old",
      }),
    );
    store.ingestEvent(
      event({
        eventId: "evt_candidate_new",
        sessionId: "native_candidate_new",
        occurredAt: "2026-07-28T12:01:00.000Z",
      }),
    );
    store.ingestEvent(
      event({
        eventId: "evt_wrong_project",
        sessionId: "native_wrong_project",
        project: otherProject,
      }),
    );
    store.ingestEvent(
      event({
        eventId: "evt_wrong_version",
        sessionId: "native_wrong_version",
        harnessVersion: "0.146.0",
      }),
    );
    store.ingestEvent(
      event({
        eventId: "evt_terminal_session",
        sessionId: "native_terminal_session",
        type: "session.ended",
      }),
    );
    store.ingestEvent({
      ...event({
        eventId: "evt_pending_session",
        sessionId: "native_pending_session",
        type: "input.required",
      }),
      request: {
        correlationId: "request_pending_session",
        kind: "confirm",
        question: "Continue the synthetic candidate?",
        expiresAt: "2026-07-28T12:30:00.000Z",
      },
    });

    const checkpoint = store.inspectSessionAdoptionCandidate({
      machineId: "machine_native_candidate_old",
      nativeSessionReference: "native_candidate_old",
      projectCwdHash: project.cwdHash,
      harnessVersion: "0.145.0",
    });
    expect(checkpoint).toMatchObject({
      nativeSessionReference: "native_candidate_old",
      projectName: "session-adoption",
      projectCwdHash: project.cwdHash,
      expectedSequence: 1,
      state: "waiting",
    });
    expect(checkpoint?.projectAuthorityDigest).toBe(
      `sha256:${sha256(JSON.stringify(project))}`,
    );
    expect(checkpoint?.standaloneCapabilityDigest).toBe(
      sha256(JSON.stringify(capabilities)),
    );

    const candidates = store.listSessionAdoptionCandidates({
      projectCwdHash: project.cwdHash,
      harnessVersion: "0.145.0",
    });
    expect(
      candidates.map(({ nativeSessionReference }) => nativeSessionReference),
    ).toEqual(["native_candidate_new", "native_candidate_old"]);
    expect(
      store.listSessionAdoptionCandidates({
        projectCwdHash: otherProject.cwdHash,
        harnessVersion: "0.145.0",
      }),
    ).toHaveLength(1);
    store.close();
  });

  it("rechecks changed checkpoints and excludes an existing product owner", () => {
    const store = new RelayStore();
    const original = event({
      eventId: "evt_candidate_changed_1",
      sessionId: "native_candidate_changed",
    });
    store.ingestEvent(original);
    const selected = store.inspectSessionAdoptionCandidate({
      machineId: original.machineId,
      nativeSessionReference: original.sessionId,
      projectCwdHash: project.cwdHash,
      harnessVersion: original.harnessVersion,
    });
    store.ingestEvent(
      event({
        eventId: "evt_candidate_changed_2",
        sessionId: original.sessionId,
        sequence: 2,
        occurredAt: "2026-07-28T12:02:00.000Z",
        type: "turn.started",
      }),
    );
    const changed = store.inspectSessionAdoptionCandidate({
      machineId: original.machineId,
      nativeSessionReference: original.sessionId,
      projectCwdHash: project.cwdHash,
      harnessVersion: original.harnessVersion,
    });
    expect(changed).not.toEqual(selected);
    expect(changed).toMatchObject({
      expectedSequence: 2,
      state: "active",
    });

    const claim = {
      adoptionId: "adoption_candidate_owner",
      requestFingerprint: sha256("candidate-owner"),
      machineId: original.machineId,
      harness: "codex" as const,
      surface: "cli" as const,
      sessionId: original.sessionId,
      bridgeSessionId: original.bridgeSessionId,
      expectedSequence: 2,
      projectAuthorityDigest: `sha256:${sha256(JSON.stringify(project))}`,
      capabilityDigest: sha256(JSON.stringify(capabilities)),
      harnessVersion: original.harnessVersion,
      productSessionId: "ses_candidate_owner",
      claimedAt: "2026-07-28T12:03:00.000Z",
    };
    expect(store.claimSessionForProduct(claim)).toMatchObject({
      outcome: "claimed",
    });
    expect(
      store.inspectSessionAdoptionCandidate({
        machineId: original.machineId,
        nativeSessionReference: original.sessionId,
        projectCwdHash: project.cwdHash,
        harnessVersion: original.harnessVersion,
      }),
    ).toBeUndefined();
    store.close();
  });

  it("rejects malformed and over-broad candidate queries", () => {
    const store = new RelayStore();
    expect(() =>
      store.listSessionAdoptionCandidates({
        projectCwdHash: "not-a-hash",
        harnessVersion: "0.145.0",
      }),
    ).toThrow("malformed");
    expect(() =>
      store.listSessionAdoptionCandidates({
        projectCwdHash: project.cwdHash,
        harnessVersion: "0.145.0",
        limit: 21,
      }),
    ).toThrow("malformed");
    store.close();
  });
});
