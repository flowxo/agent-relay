import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  RelayStore,
  type SessionAdoptionCandidateCheckpoint,
} from "@agent-relay/core";
import { HARNESS_COMPATIBILITY } from "@agent-relay/harnesses";
import {
  canonicalJson,
  RunnerBridgeAdoptionService,
  RunnerBridgeStore,
  sha256,
  type ProductNativeBinding,
  type SessionAdoptionRequest,
  type SessionAdoptionResult,
} from "@agent-relay/runner-bridge";

import {
  readRunnerBridgeConfiguration,
  runnerBridgeDatabaseExists,
  runnerBridgePaths,
} from "./runner-bridge-config.js";
import { RelayStoreSessionAuthority } from "./runner-bridge-session-authority.js";

const localSchema = "runner.session-adoption/local-v1" as const;
const maximumDocumentBytes = 32 * 1024;
const maximumOutputBytes = 64 * 1024;
const maximumRequestLines = 4;
const maximumCandidates = 20;
const selectionLifetimeMilliseconds = 10 * 60_000;
const supportedHarnessProfileId = "hpf_codex_app_server_0_145_0";
const supportedHarnessVersion = "0.145.0";
const boundedKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const cwdHashPattern = /^sha256:[a-f0-9]{64}$/u;

type LocalRequestType =
  "candidate.list" | "adoption.commit" | "adoption.recover" | "adoption.status";

type LocalResponseType =
  | "candidate.listed"
  | "adoption.complete"
  | "adoption.recovery_required"
  | "adoption.rejected"
  | "adoption.status";

export interface LocalRequest {
  readonly schema: typeof localSchema;
  readonly requestId: string;
  readonly type: LocalRequestType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LocalResponse {
  readonly schema: typeof localSchema;
  readonly requestId: string;
  readonly type: LocalResponseType;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface ProductAdoptionOffer {
  readonly schema: "runner.session-adoption/offer-v1";
  readonly adoptionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly worktreeId?: string;
  readonly productSessionId: string;
  readonly aggregateRevision: 0;
  readonly harnessProfileId: string;
  readonly capabilitySnapshotDigest: string;
  readonly projectCwdHash: string;
}

interface SelectedCandidate {
  readonly checkpoint: SessionAdoptionCandidateCheckpoint;
  readonly expiresAt: number;
}

type AdoptionSafeCode =
  | "adoption_identity_conflict"
  | "adoption_not_found"
  | "agent_relay_adoption_unsupported"
  | "agent_relay_bridge_disabled"
  | "candidate_changed"
  | "candidate_not_found"
  | "malformed"
  | "product_authority_changed"
  | "recovery_required"
  | "storage_conflict"
  | "storage_unavailable";

interface AdoptionAvailability {
  readonly status: "ready" | "unavailable" | "recovery_required";
  readonly safeCode?: AdoptionSafeCode;
}

export interface RunnerBridgeAdoptionStdioRuntime {
  readonly stateDirectory: string;
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (value: string) => void | Promise<void>;
  readonly now?: () => Date;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function boundedKey(value: unknown): value is string {
  return typeof value === "string" && boundedKeyPattern.test(value);
}

function qualifiedKey(prefix: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${prefix}_`) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.slice(prefix.length + 1))
  );
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseRequest(value: unknown): LocalRequest {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["schema", "requestId", "type", "payload"]) ||
    value["schema"] !== localSchema ||
    !boundedKey(value["requestId"]) ||
    ![
      "candidate.list",
      "adoption.commit",
      "adoption.recover",
      "adoption.status",
    ].includes(String(value["type"])) ||
    !plainRecord(value["payload"])
  ) {
    throw new TypeError("Local adoption request is malformed.");
  }
  return {
    schema: localSchema,
    requestId: value["requestId"],
    type: value["type"] as LocalRequestType,
    payload: value["payload"],
  };
}

function parseOffer(value: unknown): ProductAdoptionOffer | undefined {
  if (
    !plainRecord(value) ||
    !exactKeys(
      value,
      [
        "schema",
        "adoptionId",
        "issuedAt",
        "expiresAt",
        "workspaceId",
        "runnerId",
        "projectId",
        "productSessionId",
        "aggregateRevision",
        "harnessProfileId",
        "capabilitySnapshotDigest",
        "projectCwdHash",
      ],
      ["worktreeId"],
    ) ||
    value["schema"] !== "runner.session-adoption/offer-v1" ||
    !boundedKey(value["adoptionId"]) ||
    !isoTimestamp(value["issuedAt"]) ||
    !isoTimestamp(value["expiresAt"]) ||
    Date.parse(value["issuedAt"]) >= Date.parse(value["expiresAt"]) ||
    Date.parse(value["expiresAt"]) - Date.parse(value["issuedAt"]) >
      selectionLifetimeMilliseconds ||
    !qualifiedKey("wsp", value["workspaceId"]) ||
    !qualifiedKey("run", value["runnerId"]) ||
    !qualifiedKey("prj", value["projectId"]) ||
    (value["worktreeId"] !== undefined &&
      !qualifiedKey("wkt", value["worktreeId"])) ||
    !qualifiedKey("ses", value["productSessionId"]) ||
    value["aggregateRevision"] !== 0 ||
    !qualifiedKey("hpf", value["harnessProfileId"]) ||
    typeof value["capabilitySnapshotDigest"] !== "string" ||
    !sha256Pattern.test(value["capabilitySnapshotDigest"]) ||
    typeof value["projectCwdHash"] !== "string" ||
    !cwdHashPattern.test(value["projectCwdHash"])
  ) {
    return undefined;
  }
  return {
    schema: value["schema"],
    adoptionId: value["adoptionId"],
    issuedAt: value["issuedAt"],
    expiresAt: value["expiresAt"],
    workspaceId: value["workspaceId"],
    runnerId: value["runnerId"],
    projectId: value["projectId"],
    ...(value["worktreeId"] === undefined
      ? {}
      : { worktreeId: value["worktreeId"] }),
    productSessionId: value["productSessionId"],
    aggregateRevision: value["aggregateRevision"],
    harnessProfileId: value["harnessProfileId"],
    capabilitySnapshotDigest: value["capabilitySnapshotDigest"],
    projectCwdHash: value["projectCwdHash"],
  };
}

function parseOfferPayload(
  payload: Readonly<Record<string, unknown>>,
  mode: "commit" | "recover",
):
  | {
      readonly offer: ProductAdoptionOffer;
      readonly offerFingerprint: string;
      readonly standaloneSelectionKey?: string;
    }
  | undefined {
  const required =
    mode === "commit"
      ? ["standaloneSelectionKey", "offer", "offerFingerprint"]
      : ["offer", "offerFingerprint"];
  if (
    !exactKeys(payload, required) ||
    (mode === "commit" && !boundedKey(payload["standaloneSelectionKey"])) ||
    typeof payload["offerFingerprint"] !== "string" ||
    !sha256Pattern.test(payload["offerFingerprint"])
  ) {
    return undefined;
  }
  const offer = parseOffer(payload["offer"]);
  if (
    offer === undefined ||
    sha256(canonicalJson(offer)) !== payload["offerFingerprint"]
  ) {
    return undefined;
  }
  return {
    offer,
    offerFingerprint: payload["offerFingerprint"],
    ...(mode === "commit"
      ? { standaloneSelectionKey: payload["standaloneSelectionKey"] as string }
      : {}),
  };
}

function codexCliEvidence():
  { readonly evidenceId: string; readonly harnessVersion: string } | undefined {
  const record = HARNESS_COMPATIBILITY.records.find(
    (candidate) => candidate.harness === "codex" && candidate.surface === "cli",
  );
  return record?.classification === "verified" &&
    record.verifiedVersion === `codex-cli ${supportedHarnessVersion}`
    ? {
        evidenceId: record.evidence.id,
        harnessVersion: supportedHarnessVersion,
      }
    : undefined;
}

function response(
  request: LocalRequest,
  type: LocalResponseType,
  payload: Readonly<Record<string, unknown>>,
): LocalResponse {
  return {
    schema: localSchema,
    requestId: request.requestId,
    type,
    payload,
  };
}

function resultResponse(
  request: LocalRequest,
  result: SessionAdoptionResult,
): LocalResponse {
  if (result.status === "complete") {
    return response(request, "adoption.complete", {
      duplicate: result.duplicate,
    });
  }
  if (result.status === "blocked_recovery") {
    return response(request, "adoption.recovery_required", {
      duplicate: false,
      safeCode: "recovery_required",
    });
  }
  return response(request, "adoption.rejected", {
    duplicate: false,
    safeCode: mapServiceSafeCode(result.safeCode),
  });
}

function rejected(
  request: LocalRequest,
  safeCode: AdoptionSafeCode,
): LocalResponse {
  return response(request, "adoption.rejected", {
    duplicate: false,
    safeCode,
  });
}

function mapServiceSafeCode(value: string): AdoptionSafeCode {
  switch (value) {
    case "adoption_identity_conflict":
      return "adoption_identity_conflict";
    case "adoption_not_found":
      return "adoption_not_found";
    case "adoption_profile_unsupported":
      return "agent_relay_adoption_unsupported";
    case "adoption_unauthorized":
      return "product_authority_changed";
    case "adoption_request_malformed":
      return "malformed";
    case "session_not_found":
      return "candidate_not_found";
    case "session_checkpoint_changed":
    case "session_ineligible":
    case "session_owner_conflict":
    case "standalone_interaction_pending":
      return "candidate_changed";
    case "adoption_binding_missing":
    case "adoption_binding_commit_failed":
    case "adoption_receipt_mismatch":
    case "adoption_receipt_missing":
    case "adoption_record_malformed":
    case "adoption_record_mismatch":
      return "recovery_required";
    default:
      return "storage_conflict";
  }
}

function sameCheckpoint(
  left: SessionAdoptionCandidateCheckpoint,
  right: SessionAdoptionCandidateCheckpoint,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameBinding(
  binding: ProductNativeBinding,
  request: SessionAdoptionRequest,
): boolean {
  return (
    binding.workspaceId === request.workspaceId &&
    binding.runnerId === request.runnerId &&
    binding.projectId === request.projectId &&
    binding.worktreeId === request.worktreeId &&
    binding.sessionId === request.productSessionId &&
    binding.harnessProfileId === request.harnessProfileId &&
    binding.nativeSessionReference === request.nativeSessionReference &&
    binding.capabilitySnapshotDigest === request.capabilitySnapshotDigest &&
    binding.aggregateRevision === request.aggregateRevision
  );
}

function offerMatchesRequest(
  offer: ProductAdoptionOffer,
  request: SessionAdoptionRequest,
): boolean {
  return (
    offer.adoptionId === request.adoptionId &&
    offer.issuedAt === request.issuedAt &&
    offer.expiresAt === request.expiresAt &&
    offer.workspaceId === request.workspaceId &&
    offer.runnerId === request.runnerId &&
    offer.projectId === request.projectId &&
    offer.worktreeId === request.worktreeId &&
    offer.productSessionId === request.productSessionId &&
    offer.aggregateRevision === request.aggregateRevision &&
    offer.harnessProfileId === request.harnessProfileId &&
    offer.capabilitySnapshotDigest === request.capabilitySnapshotDigest
  );
}

async function inspectOwnerOnlyStateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("Local adoption state directory is unavailable.");
  }
}

async function inspectOwnerStateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("Local adoption state file is unavailable.");
  }
}

export class LocalRunnerBridgeAdoptionServer {
  readonly #stateDirectory: string;
  readonly #now: () => Date;
  readonly #selections = new Map<string, SelectedCandidate>();

  constructor(input: {
    readonly stateDirectory: string;
    readonly now: () => Date;
  }) {
    this.#stateDirectory = resolve(input.stateDirectory);
    this.#now = input.now;
  }

  async handle(request: LocalRequest): Promise<LocalResponse> {
    switch (request.type) {
      case "adoption.status":
        return await this.#status(request);
      case "candidate.list":
        return await this.#list(request);
      case "adoption.commit":
        return await this.#commit(request);
      case "adoption.recover":
        return await this.#recover(request);
    }
  }

  async #availability(): Promise<AdoptionAvailability> {
    const evidence = codexCliEvidence();
    if (evidence === undefined) {
      return {
        status: "unavailable",
        safeCode: "agent_relay_adoption_unsupported",
      };
    }
    try {
      await inspectOwnerOnlyStateDirectory(this.#stateDirectory);
      const paths = runnerBridgePaths(this.#stateDirectory);
      const configuration = await readRunnerBridgeConfiguration(
        paths.configuration,
      );
      if (configuration?.enabled !== true) {
        return {
          status: "unavailable",
          safeCode: "agent_relay_bridge_disabled",
        };
      }
      const corePath = join(this.#stateDirectory, "relay.sqlite");
      await inspectOwnerStateFile(corePath);
      if (!(await runnerBridgeDatabaseExists(paths.database))) {
        return {
          status: "unavailable",
          safeCode: "agent_relay_adoption_unsupported",
        };
      }
      const bridgeStore = new RunnerBridgeStore(paths.database);
      try {
        if (
          bridgeStore.adoptionCount("standalone_claimed") > 0 ||
          bridgeStore.adoptionCount("blocked_recovery") > 0
        ) {
          return {
            status: "recovery_required",
            safeCode: "recovery_required",
          };
        }
        const authority = bridgeStore.authority();
        return authority === undefined ||
          authority.state === "disabled" ||
          authority.state === "revoked"
          ? {
              status: "unavailable",
              safeCode: "agent_relay_adoption_unsupported",
            }
          : { status: "ready" };
      } finally {
        bridgeStore.close();
      }
    } catch {
      return { status: "unavailable", safeCode: "storage_unavailable" };
    }
  }

  async #status(request: LocalRequest): Promise<LocalResponse> {
    if (!exactKeys(request.payload, [])) {
      return rejected(request, "malformed");
    }
    const availability = await this.#availability();
    return response(request, "adoption.status", {
      status: availability.status,
      ...(availability.safeCode === undefined
        ? {}
        : { safeCode: availability.safeCode }),
    });
  }

  async #list(request: LocalRequest): Promise<LocalResponse> {
    if (
      !exactKeys(request.payload, ["projectCwdHash"]) ||
      typeof request.payload["projectCwdHash"] !== "string" ||
      !cwdHashPattern.test(request.payload["projectCwdHash"])
    ) {
      return response(request, "candidate.listed", { candidates: [] });
    }
    if ((await this.#availability()).status !== "ready") {
      return response(request, "candidate.listed", { candidates: [] });
    }
    const corePath = join(this.#stateDirectory, "relay.sqlite");
    let coreStore: RelayStore | undefined;
    try {
      await inspectOwnerStateFile(corePath);
      coreStore = new RelayStore(corePath);
      const candidates = coreStore.listSessionAdoptionCandidates({
        projectCwdHash: request.payload["projectCwdHash"],
        harnessVersion: supportedHarnessVersion,
        limit: maximumCandidates,
      });
      this.#selections.clear();
      const expiresAt = this.#now().getTime() + selectionLifetimeMilliseconds;
      const visible = candidates.map((checkpoint) => {
        const selectionKey = `selection_${randomUUID().replaceAll("-", "")}`;
        this.#selections.set(selectionKey, { checkpoint, expiresAt });
        return {
          selectionKey,
          projectName: checkpoint.projectName,
          harness: checkpoint.harness,
          surface: checkpoint.surface,
          harnessVersion: checkpoint.harnessVersion,
          state: checkpoint.state,
          lastSeenAt: checkpoint.lastSeenAt,
        };
      });
      return response(request, "candidate.listed", { candidates: visible });
    } catch {
      this.#selections.clear();
      return response(request, "candidate.listed", { candidates: [] });
    } finally {
      coreStore?.close();
    }
  }

  async #commit(request: LocalRequest): Promise<LocalResponse> {
    const parsed = parseOfferPayload(request.payload, "commit");
    if (parsed?.standaloneSelectionKey === undefined) {
      return rejected(request, "malformed");
    }
    const selected = this.#selections.get(parsed.standaloneSelectionKey);
    this.#selections.delete(parsed.standaloneSelectionKey);
    const now = this.#now().getTime();
    if (
      selected === undefined ||
      selected.expiresAt <= now ||
      Date.parse(parsed.offer.issuedAt) > now ||
      Date.parse(parsed.offer.expiresAt) <= now
    ) {
      return rejected(request, "candidate_not_found");
    }
    if (
      parsed.offer.harnessProfileId !== supportedHarnessProfileId ||
      selected.checkpoint.projectCwdHash !== parsed.offer.projectCwdHash
    ) {
      return rejected(request, "agent_relay_adoption_unsupported");
    }
    const availability = await this.#availability();
    if (availability.status !== "ready") {
      return rejected(
        request,
        availability.safeCode ?? "agent_relay_adoption_unsupported",
      );
    }
    return await this.#commitSelected(
      request,
      parsed.offer,
      selected.checkpoint,
    );
  }

  async #commitSelected(
    request: LocalRequest,
    offer: ProductAdoptionOffer,
    selected: SessionAdoptionCandidateCheckpoint,
  ): Promise<LocalResponse> {
    const paths = runnerBridgePaths(this.#stateDirectory);
    const corePath = join(this.#stateDirectory, "relay.sqlite");
    let coreStore: RelayStore | undefined;
    let bridgeStore: RunnerBridgeStore | undefined;
    try {
      await inspectOwnerStateFile(corePath);
      coreStore = new RelayStore(corePath);
      bridgeStore = new RunnerBridgeStore(paths.database);
      const live = coreStore.inspectSessionAdoptionCandidate({
        machineId: selected.machineId,
        nativeSessionReference: selected.nativeSessionReference,
        projectCwdHash: offer.projectCwdHash,
        harnessVersion: selected.harnessVersion,
      });
      if (live === undefined || !sameCheckpoint(live, selected)) {
        return rejected(request, "candidate_changed");
      }
      const authority = bridgeStore.authority();
      if (
        authority === undefined ||
        authority.state === "disabled" ||
        authority.state === "revoked" ||
        authority.workspaceId !== offer.workspaceId ||
        authority.runnerId !== offer.runnerId ||
        authority.capabilitySnapshotDigest !== offer.capabilitySnapshotDigest
      ) {
        return rejected(request, "product_authority_changed");
      }
      const evidence = codexCliEvidence();
      if (
        evidence === undefined ||
        live.harnessVersion !== evidence.harnessVersion
      ) {
        return rejected(request, "agent_relay_adoption_unsupported");
      }
      const adoptionRequest = this.#adoptionRequest(
        offer,
        live,
        evidence.evidenceId,
      );
      const existingProduct = bridgeStore.binding(offer.productSessionId);
      const existingNative = bridgeStore.bindingByNativeSessionReference(
        live.nativeSessionReference,
      );
      if (
        (existingProduct !== undefined &&
          !sameBinding(existingProduct, adoptionRequest)) ||
        (existingNative !== undefined &&
          !sameBinding(existingNative, adoptionRequest))
      ) {
        return rejected(request, "adoption_identity_conflict");
      }
      if (
        existingProduct?.actuatorOwner !== "product-managed" &&
        existingNative?.actuatorOwner !== "product-managed"
      ) {
        const timestamp = this.#now().toISOString();
        const binding: ProductNativeBinding = {
          workspaceId: offer.workspaceId,
          runnerId: offer.runnerId,
          projectId: offer.projectId,
          ...(offer.worktreeId === undefined
            ? {}
            : { worktreeId: offer.worktreeId }),
          sessionId: offer.productSessionId,
          harnessProfileId: offer.harnessProfileId,
          nativeSessionReference: live.nativeSessionReference,
          capabilitySnapshotDigest:
            offer.capabilitySnapshotDigest as SessionAdoptionRequest["capabilitySnapshotDigest"],
          actuatorOwner: "standalone-attention",
          aggregateRevision: offer.aggregateRevision,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        bridgeStore.prepareStandaloneAdoption(
          {
            adoptionId: adoptionRequest.adoptionId,
            requestFingerprint: sha256(canonicalJson(adoptionRequest)),
            requestJson: canonicalJson(adoptionRequest),
            state: "proposed",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          binding,
        );
      }
      const service = this.#service(
        bridgeStore,
        coreStore,
        adoptionRequest,
        evidence.evidenceId,
      );
      return resultResponse(
        request,
        await service.adoptPrepared(adoptionRequest),
      );
    } catch {
      return rejected(request, "storage_unavailable");
    } finally {
      bridgeStore?.close();
      coreStore?.close();
    }
  }

  async #recover(request: LocalRequest): Promise<LocalResponse> {
    const parsed = parseOfferPayload(request.payload, "recover");
    if (parsed === undefined) {
      return rejected(request, "malformed");
    }
    const paths = runnerBridgePaths(this.#stateDirectory);
    const corePath = join(this.#stateDirectory, "relay.sqlite");
    let coreStore: RelayStore | undefined;
    let bridgeStore: RunnerBridgeStore | undefined;
    try {
      await inspectOwnerOnlyStateDirectory(this.#stateDirectory);
      await inspectOwnerStateFile(corePath);
      if (!(await runnerBridgeDatabaseExists(paths.database))) {
        return rejected(request, "adoption_not_found");
      }
      coreStore = new RelayStore(corePath);
      bridgeStore = new RunnerBridgeStore(paths.database);
      const stored = bridgeStore.adoption(parsed.offer.adoptionId);
      if (stored === undefined) {
        return rejected(request, "adoption_not_found");
      }
      let adoptionRequest: SessionAdoptionRequest;
      try {
        adoptionRequest = JSON.parse(
          stored.requestJson,
        ) as SessionAdoptionRequest;
      } catch {
        return response(request, "adoption.recovery_required", {
          duplicate: false,
          safeCode: "recovery_required",
        });
      }
      const native = coreStore
        .listSessions()
        .find(
          (session) =>
            session.machineId === adoptionRequest.machineId &&
            session.harness === adoptionRequest.harness &&
            session.sessionId === adoptionRequest.nativeSessionReference,
        );
      if (
        !offerMatchesRequest(parsed.offer, adoptionRequest) ||
        native?.project.cwdHash !== parsed.offer.projectCwdHash
      ) {
        return rejected(request, "adoption_identity_conflict");
      }
      const evidence = codexCliEvidence();
      if (
        evidence === undefined ||
        adoptionRequest.harnessVersion !== evidence.harnessVersion ||
        adoptionRequest.standaloneCapabilityEvidenceId !==
          evidence.evidenceId ||
        adoptionRequest.harnessProfileId !== supportedHarnessProfileId
      ) {
        return response(request, "adoption.recovery_required", {
          duplicate: false,
          safeCode: "recovery_required",
        });
      }
      const authority = bridgeStore.authority();
      if (
        authority === undefined ||
        authority.state === "disabled" ||
        authority.state === "revoked" ||
        authority.workspaceId !== adoptionRequest.workspaceId ||
        authority.runnerId !== adoptionRequest.runnerId ||
        authority.capabilitySnapshotDigest !==
          adoptionRequest.capabilitySnapshotDigest
      ) {
        return response(request, "adoption.recovery_required", {
          duplicate: false,
          safeCode: "recovery_required",
        });
      }
      const service = this.#service(
        bridgeStore,
        coreStore,
        adoptionRequest,
        evidence.evidenceId,
      );
      return resultResponse(
        request,
        await service.recover(adoptionRequest.adoptionId),
      );
    } catch {
      return rejected(request, "storage_unavailable");
    } finally {
      bridgeStore?.close();
      coreStore?.close();
    }
  }

  #adoptionRequest(
    offer: ProductAdoptionOffer,
    checkpoint: SessionAdoptionCandidateCheckpoint,
    evidenceId: string,
  ): SessionAdoptionRequest {
    return {
      schema: "agent-relay-session-adoption.v1",
      adoptionId: offer.adoptionId,
      issuedAt: offer.issuedAt as SessionAdoptionRequest["issuedAt"],
      expiresAt: offer.expiresAt as SessionAdoptionRequest["expiresAt"],
      machineId: checkpoint.machineId,
      harness: checkpoint.harness,
      surface: checkpoint.surface,
      harnessVersion: checkpoint.harnessVersion,
      nativeSessionReference: checkpoint.nativeSessionReference,
      bridgeSessionId: checkpoint.bridgeSessionId,
      expectedSequence: checkpoint.expectedSequence,
      projectAuthorityDigest: checkpoint.projectAuthorityDigest,
      standaloneCapabilityDigest:
        checkpoint.standaloneCapabilityDigest as SessionAdoptionRequest["standaloneCapabilityDigest"],
      standaloneCapabilityEvidenceId: evidenceId,
      workspaceId: offer.workspaceId,
      runnerId: offer.runnerId,
      projectId: offer.projectId,
      ...(offer.worktreeId === undefined
        ? {}
        : { worktreeId: offer.worktreeId }),
      productSessionId: offer.productSessionId,
      aggregateRevision: offer.aggregateRevision,
      harnessProfileId: offer.harnessProfileId,
      capabilitySnapshotDigest:
        offer.capabilitySnapshotDigest as SessionAdoptionRequest["capabilitySnapshotDigest"],
    };
  }

  #service(
    bridgeStore: RunnerBridgeStore,
    coreStore: RelayStore,
    adoptionRequest: SessionAdoptionRequest,
    evidenceId: string,
  ): RunnerBridgeAdoptionService {
    return new RunnerBridgeAdoptionService({
      store: bridgeStore,
      authority: new RelayStoreSessionAuthority(coreStore),
      configuration: {
        workspaceId: adoptionRequest.workspaceId,
        runnerId: adoptionRequest.runnerId,
        harnessProfileId: adoptionRequest.harnessProfileId,
        harnessVersion: adoptionRequest.harnessVersion,
        standaloneCapabilityEvidenceId: evidenceId,
        capabilitySnapshotDigest: adoptionRequest.capabilitySnapshotDigest,
        authorizedProjectIds: new Set([adoptionRequest.projectId]),
        now: () =>
          this.#now().toISOString() as SessionAdoptionRequest["issuedAt"],
      },
    });
  }
}

export async function runRunnerBridgeAdoptionStdio(
  runtime: RunnerBridgeAdoptionStdioRuntime,
): Promise<void> {
  const server = new LocalRunnerBridgeAdoptionServer({
    stateDirectory: runtime.stateDirectory,
    now: runtime.now ?? (() => new Date()),
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let requestLines = 0;
  let outputBytes = 0;

  const writeResponse = async (value: LocalResponse): Promise<void> => {
    const encoded = `${JSON.stringify(value)}\n`;
    outputBytes += Buffer.byteLength(encoded, "utf8");
    if (
      Buffer.byteLength(encoded, "utf8") > maximumDocumentBytes ||
      outputBytes > maximumOutputBytes
    ) {
      throw new Error("Local adoption stdio output is oversized.");
    }
    await runtime.write(encoded);
  };

  const acceptLine = async (line: string): Promise<void> => {
    requestLines += 1;
    if (
      requestLines > maximumRequestLines ||
      line.length === 0 ||
      line.endsWith("\r") ||
      Buffer.byteLength(line, "utf8") > maximumDocumentBytes
    ) {
      throw new Error("Local adoption stdio input is malformed.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Local adoption stdio input is malformed.");
    }
    await writeResponse(await server.handle(parseRequest(decoded)));
  };

  for await (const chunk of runtime.input) {
    try {
      buffer += decoder.decode(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        { stream: true },
      );
    } catch {
      throw new Error("Local adoption stdio input is not UTF-8.");
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await acceptLine(line);
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > maximumDocumentBytes) {
      throw new Error("Local adoption stdio input is oversized.");
    }
  }
  try {
    buffer += decoder.decode();
  } catch {
    throw new Error("Local adoption stdio input is not UTF-8.");
  }
  if (buffer.length !== 0) {
    throw new Error("Local adoption stdio input has trailing data.");
  }
}
