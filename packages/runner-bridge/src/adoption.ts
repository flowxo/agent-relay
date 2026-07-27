import type { IsoTimestamp, Sha256Digest } from "@session/contracts";

import { canonicalJson, sha256 } from "./digests.js";
import type {
  StandaloneSessionAdoptionClaim,
  StandaloneSessionAdoptionReceipt,
  StandaloneSessionAuthorityPort,
} from "./ports.js";
import type {
  ProductNativeBinding,
  RunnerBridgeStore,
  StoredSessionAdoption,
} from "./store.js";

export interface SessionAdoptionRequest {
  readonly schema: "agent-relay-session-adoption.v1";
  readonly adoptionId: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly machineId: string;
  readonly harness: "codex";
  readonly surface: "cli";
  readonly harnessVersion: string;
  readonly nativeSessionReference: string;
  readonly bridgeSessionId: string;
  readonly expectedSequence: number;
  readonly projectAuthorityDigest: string;
  readonly standaloneCapabilityDigest: Sha256Digest;
  readonly standaloneCapabilityEvidenceId: string;
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly worktreeId?: string;
  readonly productSessionId: string;
  readonly aggregateRevision: number;
  readonly harnessProfileId: string;
  readonly capabilitySnapshotDigest: Sha256Digest;
}

export type SessionAdoptionResult =
  | {
      readonly status: "complete";
      readonly duplicate: boolean;
      readonly binding: ProductNativeBinding;
    }
  | {
      readonly status: "rejected" | "blocked_recovery";
      readonly safeCode: string;
    };

export interface RunnerBridgeAdoptionConfiguration {
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly harnessProfileId: string;
  readonly harnessVersion: string;
  readonly capabilitySnapshotDigest: Sha256Digest;
  readonly authorizedProjectIds: ReadonlySet<string>;
  readonly now: () => IsoTimestamp;
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function requestFingerprint(request: SessionAdoptionRequest): Sha256Digest {
  return sha256(canonicalJson(request));
}

function parseStoredRequest(value: string): SessionAdoptionRequest {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Stored session adoption request is malformed.");
  }
  return parsed as SessionAdoptionRequest;
}

export class RunnerBridgeAdoptionService {
  readonly #store: RunnerBridgeStore;
  readonly #authority: StandaloneSessionAuthorityPort;
  readonly #configuration: RunnerBridgeAdoptionConfiguration;

  constructor(input: {
    readonly store: RunnerBridgeStore;
    readonly authority: StandaloneSessionAuthorityPort;
    readonly configuration: RunnerBridgeAdoptionConfiguration;
  }) {
    this.#store = input.store;
    this.#authority = input.authority;
    this.#configuration = input.configuration;
  }

  async adopt(request: SessionAdoptionRequest): Promise<SessionAdoptionResult> {
    const failure = this.#validate(request);
    if (failure) {
      return { status: "rejected", safeCode: failure };
    }
    const fingerprint = requestFingerprint(request);
    const now = this.#configuration.now();
    const proposed: StoredSessionAdoption = {
      adoptionId: request.adoptionId,
      requestFingerprint: fingerprint,
      requestJson: canonicalJson(request),
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    let duplicate: boolean;
    try {
      duplicate = this.#store.proposeAdoption(proposed) === "duplicate";
    } catch {
      return { status: "rejected", safeCode: "adoption_identity_conflict" };
    }
    const stored = this.#store.adoption(request.adoptionId);
    if (!stored || stored.requestFingerprint !== fingerprint) {
      return { status: "rejected", safeCode: "adoption_identity_conflict" };
    }
    if (stored.state === "complete") {
      const binding = this.#store.binding(request.productSessionId);
      return binding
        ? { status: "complete", duplicate: true, binding }
        : {
            status: "blocked_recovery",
            safeCode: "adoption_binding_missing",
          };
    }
    if (stored.state === "rejected") {
      return {
        status: "rejected",
        safeCode: stored.safeCode ?? "adoption_rejected",
      };
    }
    if (
      stored.state === "standalone_claimed" ||
      stored.state === "blocked_recovery"
    ) {
      return await this.#finishClaimed(request, fingerprint);
    }
    const claim = await this.#authority.claim(
      this.#claim(request, fingerprint, now),
    );
    if (claim.status === "rejected") {
      this.#store.transitionAdoption(
        request.adoptionId,
        "proposed",
        "rejected",
        this.#configuration.now(),
        claim.safeCode,
      );
      return { status: "rejected", safeCode: claim.safeCode };
    }
    if (
      claim.receipt.requestFingerprint !== fingerprint ||
      claim.receipt.productSessionId !== request.productSessionId ||
      claim.receipt.nativeSessionReference !== request.nativeSessionReference
    ) {
      this.#store.transitionAdoption(
        request.adoptionId,
        "proposed",
        "blocked_recovery",
        this.#configuration.now(),
        "adoption_receipt_mismatch",
      );
      return {
        status: "blocked_recovery",
        safeCode: "adoption_receipt_mismatch",
      };
    }
    this.#store.transitionAdoption(
      request.adoptionId,
      "proposed",
      "standalone_claimed",
      this.#configuration.now(),
    );
    return this.#commitBinding(
      request,
      duplicate || claim.status === "duplicate",
    );
  }

  async recover(adoptionId: string): Promise<SessionAdoptionResult> {
    const stored = this.#store.adoption(adoptionId);
    if (!stored) {
      return { status: "rejected", safeCode: "adoption_not_found" };
    }
    let request: SessionAdoptionRequest;
    try {
      request = parseStoredRequest(stored.requestJson);
    } catch {
      return {
        status: "blocked_recovery",
        safeCode: "adoption_record_malformed",
      };
    }
    if (requestFingerprint(request) !== stored.requestFingerprint) {
      return {
        status: "blocked_recovery",
        safeCode: "adoption_record_mismatch",
      };
    }
    return await this.adopt(request);
  }

  #validate(request: SessionAdoptionRequest): string | undefined {
    const now = Date.parse(this.#configuration.now());
    if (
      !Number.isFinite(now) ||
      request.schema !== "agent-relay-session-adoption.v1" ||
      !isBoundedId(request.adoptionId) ||
      !isBoundedId(request.machineId) ||
      !isBoundedId(request.nativeSessionReference) ||
      !isBoundedId(request.bridgeSessionId) ||
      !isBoundedId(request.productSessionId) ||
      !isBoundedId(request.standaloneCapabilityEvidenceId) ||
      !isBoundedId(request.workspaceId) ||
      !isBoundedId(request.runnerId) ||
      !isBoundedId(request.projectId) ||
      (request.worktreeId !== undefined && !isBoundedId(request.worktreeId)) ||
      !isBoundedId(request.harnessProfileId) ||
      typeof request.harnessVersion !== "string" ||
      !Number.isSafeInteger(request.expectedSequence) ||
      request.expectedSequence < 0 ||
      !Number.isSafeInteger(request.aggregateRevision) ||
      request.aggregateRevision < 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(request.projectAuthorityDigest) ||
      !/^[a-f0-9]{64}$/u.test(request.standaloneCapabilityDigest) ||
      !/^[a-f0-9]{64}$/u.test(request.capabilitySnapshotDigest) ||
      !Number.isFinite(Date.parse(request.issuedAt)) ||
      !Number.isFinite(Date.parse(request.expiresAt)) ||
      Date.parse(request.issuedAt) > now ||
      Date.parse(request.expiresAt) <= now ||
      Date.parse(request.issuedAt) >= Date.parse(request.expiresAt)
    ) {
      return "adoption_request_malformed";
    }
    if (
      request.harness !== "codex" ||
      request.surface !== "cli" ||
      request.harnessVersion !== this.#configuration.harnessVersion ||
      request.harnessProfileId !== this.#configuration.harnessProfileId
    ) {
      return "adoption_profile_unsupported";
    }
    if (
      request.workspaceId !== this.#configuration.workspaceId ||
      request.runnerId !== this.#configuration.runnerId ||
      request.capabilitySnapshotDigest !==
        this.#configuration.capabilitySnapshotDigest ||
      !this.#configuration.authorizedProjectIds.has(request.projectId)
    ) {
      return "adoption_unauthorized";
    }
    return undefined;
  }

  #claim(
    request: SessionAdoptionRequest,
    fingerprint: Sha256Digest,
    now: IsoTimestamp,
  ): StandaloneSessionAdoptionClaim {
    return {
      adoptionId: request.adoptionId,
      requestFingerprint: fingerprint,
      machineId: request.machineId,
      harness: request.harness,
      surface: request.surface,
      nativeSessionReference: request.nativeSessionReference,
      bridgeSessionId: request.bridgeSessionId,
      expectedSequence: request.expectedSequence,
      projectAuthorityDigest: request.projectAuthorityDigest,
      standaloneCapabilityDigest: request.standaloneCapabilityDigest,
      harnessVersion: request.harnessVersion,
      productSessionId: request.productSessionId,
      claimedAt: now,
    };
  }

  async #finishClaimed(
    request: SessionAdoptionRequest,
    fingerprint: Sha256Digest,
  ): Promise<SessionAdoptionResult> {
    const receipt = await this.#authority.inspect(request.adoptionId);
    if (!receipt) {
      return {
        status: "blocked_recovery",
        safeCode: "adoption_receipt_missing",
      };
    }
    if (!this.#receiptMatches(receipt, request, fingerprint)) {
      return {
        status: "blocked_recovery",
        safeCode: "adoption_receipt_mismatch",
      };
    }
    return this.#commitBinding(request, true);
  }

  #receiptMatches(
    receipt: StandaloneSessionAdoptionReceipt,
    request: SessionAdoptionRequest,
    fingerprint: Sha256Digest,
  ): boolean {
    return (
      receipt.adoptionId === request.adoptionId &&
      receipt.requestFingerprint === fingerprint &&
      receipt.productSessionId === request.productSessionId &&
      receipt.nativeSessionReference === request.nativeSessionReference
    );
  }

  #commitBinding(
    request: SessionAdoptionRequest,
    duplicate: boolean,
  ): SessionAdoptionResult {
    const now = this.#configuration.now();
    const binding: ProductNativeBinding = {
      workspaceId: request.workspaceId,
      runnerId: request.runnerId,
      projectId: request.projectId,
      ...(request.worktreeId === undefined
        ? {}
        : { worktreeId: request.worktreeId }),
      sessionId: request.productSessionId,
      harnessProfileId: request.harnessProfileId,
      nativeSessionReference: request.nativeSessionReference,
      capabilitySnapshotDigest: request.capabilitySnapshotDigest,
      actuatorOwner: "product-managed",
      aggregateRevision: request.aggregateRevision,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.#store.adoptBinding(binding);
      let stored = this.#store.adoption(request.adoptionId);
      if (stored?.state === "complete") {
        const committed = this.#store.binding(request.productSessionId);
        if (!committed || committed.actuatorOwner !== "product-managed") {
          throw new Error("Completed adoption binding is unavailable.");
        }
        return { status: "complete", duplicate: true, binding: committed };
      }
      if (stored?.state === "blocked_recovery") {
        if (
          !this.#store.transitionAdoption(
            request.adoptionId,
            "blocked_recovery",
            "standalone_claimed",
            now,
          )
        ) {
          throw new Error("Blocked adoption did not resume.");
        }
        stored = this.#store.adoption(request.adoptionId);
      }
      if (
        stored?.state !== "standalone_claimed" ||
        !this.#store.transitionAdoption(
          request.adoptionId,
          "standalone_claimed",
          "complete",
          now,
        )
      ) {
        throw new Error("Claimed adoption did not complete.");
      }
      const committed = this.#store.binding(request.productSessionId);
      if (!committed || committed.actuatorOwner !== "product-managed") {
        throw new Error("Adopted binding is unavailable.");
      }
      return { status: "complete", duplicate, binding: committed };
    } catch {
      const stored = this.#store.adoption(request.adoptionId);
      const committed = this.#store.binding(request.productSessionId);
      if (
        stored?.state === "complete" &&
        committed?.actuatorOwner === "product-managed"
      ) {
        return { status: "complete", duplicate: true, binding: committed };
      }
      if (stored?.state === "standalone_claimed") {
        this.#store.transitionAdoption(
          request.adoptionId,
          "standalone_claimed",
          "blocked_recovery",
          now,
          "adoption_binding_commit_failed",
        );
      }
      return {
        status: "blocked_recovery",
        safeCode: "adoption_binding_commit_failed",
      };
    }
  }
}
