import type {
  SessionProductOwnershipReceipt,
  RelayStore,
} from "@agent-relay/core";
import type {
  StandaloneSessionAdoptionReceipt,
  StandaloneSessionAuthorityPort,
} from "@agent-relay/runner-bridge";

function receipt(
  value: SessionProductOwnershipReceipt,
): StandaloneSessionAdoptionReceipt {
  return {
    adoptionId: value.adoptionId,
    requestFingerprint:
      value.requestFingerprint as StandaloneSessionAdoptionReceipt["requestFingerprint"],
    productSessionId: value.productSessionId,
    nativeSessionReference: value.sessionId,
    claimedAt: value.claimedAt as StandaloneSessionAdoptionReceipt["claimedAt"],
  };
}

export class RelayStoreSessionAuthority implements StandaloneSessionAuthorityPort {
  readonly #store: RelayStore;

  constructor(store: RelayStore) {
    this.#store = store;
  }

  claim(
    claim: Parameters<StandaloneSessionAuthorityPort["claim"]>[0],
  ): ReturnType<StandaloneSessionAuthorityPort["claim"]> {
    const result = this.#store.claimSessionForProduct({
      adoptionId: claim.adoptionId,
      requestFingerprint: claim.requestFingerprint,
      machineId: claim.machineId,
      harness: claim.harness,
      surface: claim.surface,
      sessionId: claim.nativeSessionReference,
      bridgeSessionId: claim.bridgeSessionId,
      expectedSequence: claim.expectedSequence,
      projectAuthorityDigest: claim.projectAuthorityDigest,
      capabilityDigest: claim.standaloneCapabilityDigest,
      harnessVersion: claim.harnessVersion,
      productSessionId: claim.productSessionId,
      claimedAt: claim.claimedAt,
    });
    return Promise.resolve(
      result.outcome === "rejected"
        ? { status: "rejected", safeCode: result.safeCode }
        : { status: result.outcome, receipt: receipt(result.receipt) },
    );
  }

  inspect(
    adoptionId: string,
  ): ReturnType<StandaloneSessionAuthorityPort["inspect"]> {
    const observed = this.#store.inspectSessionProductOwnership(adoptionId);
    return Promise.resolve(observed ? receipt(observed) : undefined);
  }
}
