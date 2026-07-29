import { describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import {
  makeProjectRef,
  sha256 as protocolSha256,
} from "@agent-relay/protocol";
import { RelayStore } from "@agent-relay/core";
import {
  canonicalJson,
  RunnerBridgeAdoptionService,
  RunnerBridgeStore,
  sha256,
  type SessionAdoptionRequest,
} from "@agent-relay/runner-bridge";

import { RelayStoreSessionAuthority } from "./runner-bridge-session-authority.js";

const now = "2026-07-27T12:00:00.000Z";
const project = makeProjectRef("/workspace/adoption-integration");
const capabilities = {
  inlineContinue: true,
  lateResume: true,
  activeSteer: false,
  permissionDecision: true,
};
const standaloneCapabilityDigest = sha256(JSON.stringify(capabilities));
const capabilitySnapshotDigest = sha256("product-capability-snapshot");

function event(): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_adoption_integration",
    occurredAt: now,
    sequence: 4,
    machineId: "machine_adoption_integration",
    bridgeSessionId: "bridge_adoption_integration",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    sessionId: "native_adoption_integration",
    project,
    type: "turn.stopped",
    capabilities,
  };
}

function request(): SessionAdoptionRequest {
  return {
    schema: "agent-relay-session-adoption.v1",
    adoptionId: "adoption_integration_0001",
    issuedAt: now as SessionAdoptionRequest["issuedAt"],
    expiresAt:
      "2026-07-27T12:10:00.000Z" as SessionAdoptionRequest["expiresAt"],
    machineId: "machine_adoption_integration",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    nativeSessionReference: "native_adoption_integration",
    bridgeSessionId: "bridge_adoption_integration",
    expectedSequence: 4,
    projectAuthorityDigest: `sha256:${protocolSha256(JSON.stringify(project))}`,
    standaloneCapabilityDigest,
    standaloneCapabilityEvidenceId: "codex-cli-0.145.0",
    workspaceId: "wsp_adoption_integration",
    runnerId: "run_adoption_integration",
    projectId: "prj_adoption_integration",
    productSessionId: "ses_adoption_integration",
    aggregateRevision: 0,
    harnessProfileId: "hpf_codex_app_server_0_145_0",
    capabilitySnapshotDigest,
  };
}

function service(
  bridgeStore: RunnerBridgeStore,
  coreStore: RelayStore,
): RunnerBridgeAdoptionService {
  return new RunnerBridgeAdoptionService({
    store: bridgeStore,
    authority: new RelayStoreSessionAuthority(coreStore),
    configuration: {
      workspaceId: request().workspaceId,
      runnerId: request().runnerId,
      harnessProfileId: request().harnessProfileId,
      harnessVersion: request().harnessVersion,
      standaloneCapabilityEvidenceId: request().standaloneCapabilityEvidenceId,
      capabilitySnapshotDigest,
      authorizedProjectIds: new Set([request().projectId]),
      now: () => now as SessionAdoptionRequest["issuedAt"],
    },
  });
}

function seedBridge(store: RunnerBridgeStore): void {
  store.putBinding({
    workspaceId: request().workspaceId,
    runnerId: request().runnerId,
    projectId: request().projectId,
    sessionId: request().productSessionId,
    harnessProfileId: request().harnessProfileId,
    nativeSessionReference: request().nativeSessionReference,
    capabilitySnapshotDigest,
    actuatorOwner: "standalone-attention",
    aggregateRevision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

describe("runner bridge standalone ownership adapter", () => {
  it("adopts one exact local Codex checkpoint idempotently", async () => {
    const coreStore = new RelayStore();
    coreStore.ingestEvent(event());
    const bridgeStore = new RunnerBridgeStore(":memory:");
    seedBridge(bridgeStore);

    await expect(
      service(bridgeStore, coreStore).adopt(request()),
    ).resolves.toMatchObject({
      status: "complete",
      duplicate: false,
      binding: { actuatorOwner: "product-managed" },
    });
    await expect(
      service(bridgeStore, coreStore).adopt(request()),
    ).resolves.toMatchObject({
      status: "complete",
      duplicate: true,
    });
    expect(
      coreStore.sessionActuatorOwner({
        machineId: event().machineId,
        harness: event().harness,
        sessionId: event().sessionId,
      }),
    ).toBe("product-managed");
    bridgeStore.close();
    coreStore.close();
  });

  it("recovers after the core claim commits before the bridge binding", async () => {
    const coreStore = new RelayStore();
    coreStore.ingestEvent(event());
    const bridgeStore = new RunnerBridgeStore(":memory:");
    seedBridge(bridgeStore);
    const adoption = request();
    const fingerprint = sha256(canonicalJson(adoption));
    bridgeStore.proposeAdoption({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      requestJson: canonicalJson(adoption),
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    const authority = new RelayStoreSessionAuthority(coreStore);
    await authority.claim({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      machineId: adoption.machineId,
      harness: adoption.harness,
      surface: adoption.surface,
      nativeSessionReference: adoption.nativeSessionReference,
      bridgeSessionId: adoption.bridgeSessionId,
      expectedSequence: adoption.expectedSequence,
      projectAuthorityDigest: adoption.projectAuthorityDigest,
      standaloneCapabilityDigest: adoption.standaloneCapabilityDigest,
      harnessVersion: adoption.harnessVersion,
      productSessionId: adoption.productSessionId,
      claimedAt: now as SessionAdoptionRequest["issuedAt"],
    });
    bridgeStore.transitionAdoption(
      adoption.adoptionId,
      "proposed",
      "standalone_claimed",
      now,
    );

    await expect(
      service(bridgeStore, coreStore).recover(adoption.adoptionId),
    ).resolves.toMatchObject({
      status: "complete",
      binding: { actuatorOwner: "product-managed" },
    });
    bridgeStore.close();
    coreStore.close();
  });

  it("recovers the same durable claim after its offer expires", async () => {
    const coreStore = new RelayStore();
    coreStore.ingestEvent(event());
    const bridgeStore = new RunnerBridgeStore(":memory:");
    seedBridge(bridgeStore);
    const adoption = request();
    const fingerprint = sha256(canonicalJson(adoption));
    bridgeStore.proposeAdoption({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      requestJson: canonicalJson(adoption),
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    const authority = new RelayStoreSessionAuthority(coreStore);
    await authority.claim({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      machineId: adoption.machineId,
      harness: adoption.harness,
      surface: adoption.surface,
      nativeSessionReference: adoption.nativeSessionReference,
      bridgeSessionId: adoption.bridgeSessionId,
      expectedSequence: adoption.expectedSequence,
      projectAuthorityDigest: adoption.projectAuthorityDigest,
      standaloneCapabilityDigest: adoption.standaloneCapabilityDigest,
      harnessVersion: adoption.harnessVersion,
      productSessionId: adoption.productSessionId,
      claimedAt: now as SessionAdoptionRequest["issuedAt"],
    });
    bridgeStore.transitionAdoption(
      adoption.adoptionId,
      "proposed",
      "standalone_claimed",
      now,
    );

    const expired = new RunnerBridgeAdoptionService({
      store: bridgeStore,
      authority,
      configuration: {
        workspaceId: adoption.workspaceId,
        runnerId: adoption.runnerId,
        harnessProfileId: adoption.harnessProfileId,
        harnessVersion: adoption.harnessVersion,
        standaloneCapabilityEvidenceId: adoption.standaloneCapabilityEvidenceId,
        capabilitySnapshotDigest,
        authorizedProjectIds: new Set([adoption.projectId]),
        now: () =>
          "2026-07-27T13:00:00.000Z" as SessionAdoptionRequest["issuedAt"],
      },
    });
    await expect(expired.adopt(adoption)).resolves.toEqual({
      status: "rejected",
      safeCode: "adoption_request_malformed",
    });
    await expect(expired.recover(adoption.adoptionId)).resolves.toMatchObject({
      status: "complete",
      binding: { actuatorOwner: "product-managed" },
    });
    bridgeStore.close();
    coreStore.close();
  });

  it("recovers an atomically prepared intent after expiry before the core claim", async () => {
    const coreStore = new RelayStore();
    coreStore.ingestEvent(event());
    const bridgeStore = new RunnerBridgeStore(":memory:");
    const adoption = request();
    const fingerprint = sha256(canonicalJson(adoption));
    bridgeStore.prepareStandaloneAdoption(
      {
        adoptionId: adoption.adoptionId,
        requestFingerprint: fingerprint,
        requestJson: canonicalJson(adoption),
        state: "proposed",
        createdAt: now,
        updatedAt: now,
      },
      {
        workspaceId: adoption.workspaceId,
        runnerId: adoption.runnerId,
        projectId: adoption.projectId,
        sessionId: adoption.productSessionId,
        harnessProfileId: adoption.harnessProfileId,
        nativeSessionReference: adoption.nativeSessionReference,
        capabilitySnapshotDigest,
        actuatorOwner: "standalone-attention",
        aggregateRevision: adoption.aggregateRevision,
        createdAt: now,
        updatedAt: now,
      },
    );
    const expired = new RunnerBridgeAdoptionService({
      store: bridgeStore,
      authority: new RelayStoreSessionAuthority(coreStore),
      configuration: {
        workspaceId: adoption.workspaceId,
        runnerId: adoption.runnerId,
        harnessProfileId: adoption.harnessProfileId,
        harnessVersion: adoption.harnessVersion,
        standaloneCapabilityEvidenceId: adoption.standaloneCapabilityEvidenceId,
        capabilitySnapshotDigest,
        authorizedProjectIds: new Set([adoption.projectId]),
        now: () =>
          "2026-07-27T13:00:00.000Z" as SessionAdoptionRequest["issuedAt"],
      },
    });
    await expect(expired.recover(adoption.adoptionId)).resolves.toMatchObject({
      status: "complete",
      binding: { actuatorOwner: "product-managed" },
    });
    expect(
      coreStore.sessionActuatorOwner({
        machineId: adoption.machineId,
        harness: adoption.harness,
        sessionId: adoption.nativeSessionReference,
      }),
    ).toBe("product-managed");
    bridgeStore.close();
    coreStore.close();
  });
});
