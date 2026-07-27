import { chmodSync, lstatSync } from "node:fs";

import Database from "better-sqlite3";

import type { CapabilityDescriptor, Sha256Digest } from "@session/contracts";
import type {
  RunnerNormalizedActuatorAction,
  RunnerCommandFrame,
  RunnerCommandOutcomeStatus,
  RunnerFrame,
  RunnerLane,
  RunnerReconcileEffectOutcome,
} from "@session/protocol-runner";

export const RUNNER_BRIDGE_STORE_SCHEMA_VERSION = 2;

export type RunnerBridgeLifecycleState =
  | "disabled"
  | "configured"
  | "connecting"
  | "reconciling"
  | "ready"
  | "disconnected"
  | "revoked";

export interface RunnerAuthorityRecord {
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly identityFingerprint: string;
  readonly revocationEpoch: number;
  readonly capabilitySnapshotDigest: Sha256Digest;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly state: RunnerBridgeLifecycleState;
  readonly updatedAt: string;
  readonly lastErrorCode?: string;
}

export interface ProductNativeBinding {
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly worktreeId?: string;
  readonly sessionId: string;
  readonly harnessProfileId: string;
  readonly nativeSessionReference: string;
  readonly capabilitySnapshotDigest: Sha256Digest;
  readonly actuatorOwner: "standalone-attention" | "product-managed";
  readonly aggregateRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProductTurnState =
  | "native_pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "outcome_unknown";

export interface ProductNativeTurnBinding {
  readonly sessionId: string;
  readonly turnId: string;
  readonly nativeTurnReference?: string;
  readonly aggregateRevision: number;
  readonly state: ProductTurnState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProductItemState = "running" | "completed" | "failed";

export interface ProductNativeItemBinding {
  readonly sessionId: string;
  readonly turnId: string;
  readonly partId: string;
  readonly nativeItemReference: string;
  readonly itemKind: string;
  readonly state: ProductItemState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProductApprovalState =
  "pending" | "dispatching" | "resolved" | "expired" | "outcome_unknown";

export interface ProductNativeApprovalBinding {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly nativeApprovalReference: string;
  readonly nativeItemReference: string;
  readonly action: RunnerNormalizedActuatorAction;
  readonly actionDigest: Sha256Digest;
  readonly capabilitySnapshotDigest: Sha256Digest;
  readonly expiresAt: string;
  readonly state: ProductApprovalState;
  readonly decision?: "approve" | "deny";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SessionAdoptionState =
  | "proposed"
  | "standalone_claimed"
  | "complete"
  | "rejected"
  | "blocked_recovery";

export interface StoredSessionAdoption {
  readonly adoptionId: string;
  readonly requestFingerprint: Sha256Digest;
  readonly requestJson: string;
  readonly state: SessionAdoptionState;
  readonly safeCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredCommandEffect {
  readonly idempotencyKey: string;
  readonly effectFingerprint: Sha256Digest;
  readonly commandSequence: number;
  readonly status: RunnerCommandOutcomeStatus;
  readonly resultDigest?: Sha256Digest;
  readonly safeCode?: string;
  readonly acceptedAt: string;
  readonly updatedAt: string;
}

export type CommandAcceptance =
  | { readonly kind: "accepted"; readonly effect: StoredCommandEffect }
  | { readonly kind: "duplicate"; readonly effect: StoredCommandEffect }
  | {
      readonly kind: "fingerprint_mismatch";
      readonly effect: StoredCommandEffect;
    };

interface AuthorityRow {
  workspace_id: string;
  runner_id: string;
  identity_fingerprint: string;
  revocation_epoch: number;
  capability_snapshot_digest: string;
  capabilities_json: string;
  state: RunnerBridgeLifecycleState;
  updated_at: string;
  last_error_code: string | null;
}

interface BindingRow {
  workspace_id: string;
  runner_id: string;
  project_id: string;
  worktree_id: string | null;
  session_id: string;
  harness_profile_id: string;
  native_session_reference: string;
  capability_snapshot_digest: string;
  actuator_owner: "standalone-attention" | "product-managed";
  aggregate_revision: number;
  created_at: string;
  updated_at: string;
}

interface TurnBindingRow {
  session_id: string;
  turn_id: string;
  native_turn_reference: string | null;
  aggregate_revision: number;
  state: ProductTurnState;
  created_at: string;
  updated_at: string;
}

interface ItemBindingRow {
  session_id: string;
  turn_id: string;
  part_id: string;
  native_item_reference: string;
  item_kind: string;
  state: ProductItemState;
  created_at: string;
  updated_at: string;
}

interface ApprovalBindingRow {
  approval_id: string;
  tool_call_id: string;
  session_id: string;
  turn_id: string;
  native_approval_reference: string;
  native_item_reference: string;
  action_kind: RunnerNormalizedActuatorAction["kind"];
  action_target_digest: string;
  action_parameters_digest: string;
  action_summary: string;
  action_digest: string;
  capability_snapshot_digest: string;
  expires_at: string;
  state: ProductApprovalState;
  decision: "approve" | "deny" | null;
  created_at: string;
  updated_at: string;
}

interface LaneRow {
  lane: RunnerLane;
  inbound_cursor: number;
  outbound_cursor: number;
  outbound_ack_cursor: number;
  paused: number;
}

interface OutboundRow {
  lane: RunnerLane;
  sequence: number;
  frame_json: string;
}

interface CommandRow {
  idempotency_key: string;
  effect_fingerprint: string;
  command_sequence: number;
  status: RunnerCommandOutcomeStatus;
  result_digest: string | null;
  safe_code: string | null;
  accepted_at: string;
  updated_at: string;
}

function parseCapabilities(value: string): readonly CapabilityDescriptor[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored runner capabilities are malformed.");
  }
  return parsed as readonly CapabilityDescriptor[];
}

function authorityFromRow(row: AuthorityRow): RunnerAuthorityRecord {
  return {
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    identityFingerprint: row.identity_fingerprint,
    revocationEpoch: row.revocation_epoch,
    capabilitySnapshotDigest: row.capability_snapshot_digest as Sha256Digest,
    capabilities: parseCapabilities(row.capabilities_json),
    state: row.state,
    updatedAt: row.updated_at,
    ...(row.last_error_code === null
      ? {}
      : { lastErrorCode: row.last_error_code }),
  };
}

function bindingFromRow(row: BindingRow): ProductNativeBinding {
  return {
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    projectId: row.project_id,
    ...(row.worktree_id === null ? {} : { worktreeId: row.worktree_id }),
    sessionId: row.session_id,
    harnessProfileId: row.harness_profile_id,
    nativeSessionReference: row.native_session_reference,
    capabilitySnapshotDigest: row.capability_snapshot_digest as Sha256Digest,
    actuatorOwner: row.actuator_owner,
    aggregateRevision: row.aggregate_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnBindingFromRow(row: TurnBindingRow): ProductNativeTurnBinding {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    ...(row.native_turn_reference === null
      ? {}
      : { nativeTurnReference: row.native_turn_reference }),
    aggregateRevision: row.aggregate_revision,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemBindingFromRow(row: ItemBindingRow): ProductNativeItemBinding {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    partId: row.part_id,
    nativeItemReference: row.native_item_reference,
    itemKind: row.item_kind,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function approvalBindingFromRow(
  row: ApprovalBindingRow,
): ProductNativeApprovalBinding {
  return {
    approvalId: row.approval_id,
    toolCallId: row.tool_call_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    nativeApprovalReference: row.native_approval_reference,
    nativeItemReference: row.native_item_reference,
    action: {
      schema: "actuator.action/v1",
      kind: row.action_kind,
      target_digest: row.action_target_digest as Sha256Digest,
      parameters_digest: row.action_parameters_digest as Sha256Digest,
      summary: row.action_summary,
    },
    actionDigest: row.action_digest as Sha256Digest,
    capabilitySnapshotDigest: row.capability_snapshot_digest as Sha256Digest,
    expiresAt: row.expires_at,
    state: row.state,
    ...(row.decision === null ? {} : { decision: row.decision }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commandFromRow(row: CommandRow): StoredCommandEffect {
  return {
    idempotencyKey: row.idempotency_key,
    effectFingerprint: row.effect_fingerprint as Sha256Digest,
    commandSequence: row.command_sequence,
    status: row.status,
    ...(row.result_digest === null
      ? {}
      : { resultDigest: row.result_digest as Sha256Digest }),
    ...(row.safe_code === null ? {} : { safeCode: row.safe_code }),
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  };
}

export class RunnerBridgeStore {
  readonly #database: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      try {
        const metadata = lstatSync(path);
        if (!metadata.isFile()) {
          throw new Error("Runner bridge store path is not a regular file.");
        }
        if ((metadata.mode & 0o077) !== 0) {
          throw new Error("Runner bridge store must be private.");
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    this.#database = new Database(path);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") {
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma("synchronous = FULL");
    }
    const version = this.#database.pragma("user_version", {
      simple: true,
    }) as number;
    if (version > RUNNER_BRIDGE_STORE_SCHEMA_VERSION) {
      this.#database.close();
      throw new Error("Runner bridge store schema is newer than this binary.");
    }
    if (version === 0) {
      this.#migrateFromZero();
    } else if (version === 1) {
      this.#migrateFromOne();
    }
  }

  #migrateFromZero(): void {
    this.#database.transaction(() => {
      this.#database.exec(`
        CREATE TABLE runner_authority (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          workspace_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          identity_fingerprint TEXT NOT NULL,
          revocation_epoch INTEGER NOT NULL CHECK (revocation_epoch >= 0),
          capability_snapshot_digest TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error_code TEXT
        );
        CREATE TABLE product_native_binding (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          worktree_id TEXT,
          harness_profile_id TEXT NOT NULL,
          native_session_reference TEXT NOT NULL,
          capability_snapshot_digest TEXT NOT NULL,
          actuator_owner TEXT NOT NULL CHECK (
            actuator_owner IN ('standalone-attention', 'product-managed')
          ),
          aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(harness_profile_id, native_session_reference)
        );
        CREATE INDEX product_native_binding_project
          ON product_native_binding(project_id);
        CREATE TABLE lane_state (
          lane TEXT PRIMARY KEY,
          inbound_cursor INTEGER NOT NULL DEFAULT -1,
          outbound_cursor INTEGER NOT NULL DEFAULT -1,
          outbound_ack_cursor INTEGER NOT NULL DEFAULT -1,
          paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))
        );
        INSERT INTO lane_state(lane) VALUES ('control'), ('event'), ('bulk');
        CREATE TABLE outbound_frame (
          lane TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          frame_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          acked_at TEXT,
          PRIMARY KEY(lane, sequence)
        );
        CREATE TABLE command_effect (
          idempotency_key TEXT PRIMARY KEY,
          effect_fingerprint TEXT NOT NULL,
          command_sequence INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('accepted', 'completed', 'outcome_unknown')
          ),
          result_digest TEXT,
          safe_code TEXT,
          accepted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX command_effect_sequence
          ON command_effect(command_sequence);
        CREATE TABLE reconciliation_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          reconciliation_id TEXT NOT NULL,
          session_lease TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('requested', 'complete')),
          updated_at TEXT NOT NULL
        );
        ${this.#versionTwoTablesSql()}
      `);
      this.#database.pragma(
        `user_version = ${String(RUNNER_BRIDGE_STORE_SCHEMA_VERSION)}`,
      );
    })();
  }

  #versionTwoTablesSql(): string {
    return `
      CREATE TABLE product_native_turn_binding (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        native_turn_reference TEXT,
        aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
        state TEXT NOT NULL CHECK (
          state IN (
            'native_pending', 'running', 'completed', 'failed',
            'interrupted', 'outcome_unknown'
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES product_native_binding(session_id)
          ON DELETE CASCADE,
        UNIQUE(session_id, native_turn_reference)
      );
      CREATE INDEX product_native_turn_session
        ON product_native_turn_binding(session_id);
      CREATE TABLE product_native_item_binding (
        part_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        native_item_reference TEXT NOT NULL,
        item_kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('running', 'completed', 'failed')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES product_native_binding(session_id)
          ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES product_native_turn_binding(turn_id)
          ON DELETE CASCADE,
        UNIQUE(session_id, native_item_reference)
      );
      CREATE INDEX product_native_item_turn
        ON product_native_item_binding(turn_id);
      CREATE TABLE product_native_approval_binding (
        approval_id TEXT PRIMARY KEY,
        tool_call_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        native_approval_reference TEXT NOT NULL,
        native_item_reference TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        action_target_digest TEXT NOT NULL,
        action_parameters_digest TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        capability_snapshot_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'pending', 'dispatching', 'resolved', 'expired',
            'outcome_unknown'
          )
        ),
        decision TEXT CHECK (decision IN ('approve', 'deny')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES product_native_binding(session_id)
          ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES product_native_turn_binding(turn_id)
          ON DELETE CASCADE,
        UNIQUE(session_id, native_approval_reference)
      );
      CREATE INDEX product_native_approval_session
        ON product_native_approval_binding(session_id, state);
      CREATE TABLE observation_transition (
        fingerprint TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE session_adoption (
        adoption_id TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'proposed', 'standalone_claimed', 'complete', 'rejected',
            'blocked_recovery'
          )
        ),
        safe_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;
  }

  #migrateFromOne(): void {
    this.#database.transaction(() => {
      this.#database.exec(`
        ALTER TABLE product_native_binding
          RENAME TO product_native_binding_v1;
        DROP INDEX IF EXISTS product_native_binding_project;
        CREATE TABLE product_native_binding (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          worktree_id TEXT,
          harness_profile_id TEXT NOT NULL,
          native_session_reference TEXT NOT NULL,
          capability_snapshot_digest TEXT NOT NULL,
          actuator_owner TEXT NOT NULL CHECK (
            actuator_owner IN ('standalone-attention', 'product-managed')
          ),
          aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(harness_profile_id, native_session_reference)
        );
        INSERT INTO product_native_binding(
          session_id, workspace_id, runner_id, project_id, worktree_id,
          harness_profile_id, native_session_reference,
          capability_snapshot_digest, actuator_owner, aggregate_revision,
          created_at, updated_at
        )
        SELECT
          session_id, workspace_id, runner_id, project_id, worktree_id,
          harness_profile_id, native_session_reference,
          capability_snapshot_digest, actuator_owner, aggregate_revision,
          created_at, updated_at
        FROM product_native_binding_v1;
        DROP TABLE product_native_binding_v1;
        CREATE INDEX product_native_binding_project
          ON product_native_binding(project_id);
        ${this.#versionTwoTablesSql()}
      `);
      this.#database.pragma(
        `user_version = ${String(RUNNER_BRIDGE_STORE_SCHEMA_VERSION)}`,
      );
    })();
  }

  close(): void {
    this.#database.close();
  }

  saveAuthority(authority: RunnerAuthorityRecord): void {
    this.#database
      .prepare(
        `INSERT INTO runner_authority(
          singleton, workspace_id, runner_id, identity_fingerprint,
          revocation_epoch, capability_snapshot_digest, capabilities_json,
          state, updated_at, last_error_code
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          runner_id = excluded.runner_id,
          identity_fingerprint = excluded.identity_fingerprint,
          revocation_epoch = excluded.revocation_epoch,
          capability_snapshot_digest = excluded.capability_snapshot_digest,
          capabilities_json = excluded.capabilities_json,
          state = excluded.state,
          updated_at = excluded.updated_at,
          last_error_code = excluded.last_error_code`,
      )
      .run(
        authority.workspaceId,
        authority.runnerId,
        authority.identityFingerprint,
        authority.revocationEpoch,
        authority.capabilitySnapshotDigest,
        JSON.stringify(authority.capabilities),
        authority.state,
        authority.updatedAt,
        authority.lastErrorCode ?? null,
      );
  }

  authority(): RunnerAuthorityRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM runner_authority WHERE singleton = 1")
      .get() as AuthorityRow | undefined;
    return row ? authorityFromRow(row) : undefined;
  }

  setLifecycle(
    state: RunnerBridgeLifecycleState,
    updatedAt: string,
    lastErrorCode?: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE runner_authority
         SET state = ?, updated_at = ?, last_error_code = ?
         WHERE singleton = 1`,
      )
      .run(state, updatedAt, lastErrorCode ?? null);
  }

  revoke(
    revocationEpoch: number,
    updatedAt: string,
    safeCode = "revoked",
  ): void {
    this.#database
      .prepare(
        `UPDATE runner_authority
         SET state = 'revoked', revocation_epoch = MAX(revocation_epoch, ?),
             updated_at = ?, last_error_code = ?
         WHERE singleton = 1`,
      )
      .run(revocationEpoch, updatedAt, safeCode);
  }

  putBinding(binding: ProductNativeBinding): void {
    this.#database.transaction(() => {
      const existing = this.binding(binding.sessionId);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(binding)) {
          return;
        }
        throw new Error("Product/native binding already exists.");
      }
      this.#database
        .prepare(
          `INSERT INTO product_native_binding(
          session_id, workspace_id, runner_id, project_id, worktree_id,
          harness_profile_id, native_session_reference,
          capability_snapshot_digest, actuator_owner, aggregate_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          binding.sessionId,
          binding.workspaceId,
          binding.runnerId,
          binding.projectId,
          binding.worktreeId ?? null,
          binding.harnessProfileId,
          binding.nativeSessionReference,
          binding.capabilitySnapshotDigest,
          binding.actuatorOwner,
          binding.aggregateRevision,
          binding.createdAt,
          binding.updatedAt,
        );
    })();
  }

  binding(sessionId: string): ProductNativeBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM product_native_binding WHERE session_id = ?")
      .get(sessionId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  bindingByNativeReference(
    harnessProfileId: string,
    nativeSessionReference: string,
  ): ProductNativeBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM product_native_binding
         WHERE harness_profile_id = ? AND native_session_reference = ?`,
      )
      .get(harnessProfileId, nativeSessionReference) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  adoptBinding(binding: ProductNativeBinding): void {
    if (binding.actuatorOwner !== "product-managed") {
      throw new Error("Adopted binding must be product managed.");
    }
    this.#database.transaction(() => {
      const existing = this.binding(binding.sessionId);
      if (!existing) {
        throw new Error("Standalone binding is missing.");
      }
      if (existing.actuatorOwner === "product-managed") {
        if (
          existing.workspaceId === binding.workspaceId &&
          existing.runnerId === binding.runnerId &&
          existing.projectId === binding.projectId &&
          existing.worktreeId === binding.worktreeId &&
          existing.harnessProfileId === binding.harnessProfileId &&
          existing.nativeSessionReference === binding.nativeSessionReference &&
          existing.capabilitySnapshotDigest ===
            binding.capabilitySnapshotDigest &&
          existing.aggregateRevision === binding.aggregateRevision
        ) {
          return;
        }
        throw new Error("Product-managed binding does not match adoption.");
      }
      if (
        existing.workspaceId !== binding.workspaceId ||
        existing.runnerId !== binding.runnerId ||
        existing.projectId !== binding.projectId ||
        existing.worktreeId !== binding.worktreeId ||
        existing.nativeSessionReference !== binding.nativeSessionReference
      ) {
        throw new Error("Standalone binding cannot be adopted.");
      }
      const result = this.#database
        .prepare(
          `UPDATE product_native_binding
           SET harness_profile_id = ?, capability_snapshot_digest = ?,
               actuator_owner = 'product-managed', aggregate_revision = ?,
               updated_at = ?
           WHERE session_id = ? AND actuator_owner = 'standalone-attention'`,
        )
        .run(
          binding.harnessProfileId,
          binding.capabilitySnapshotDigest,
          binding.aggregateRevision,
          binding.updatedAt,
          binding.sessionId,
        );
      if (result.changes !== 1) {
        throw new Error("Standalone binding adoption did not commit.");
      }
    })();
  }

  hasProject(projectId: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 AS present FROM product_native_binding WHERE project_id = ? LIMIT 1",
        )
        .get(projectId) !== undefined
    );
  }

  bindingCount(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM product_native_binding")
      .get() as { count: number };
    return row.count;
  }

  bindingCountByOwner(
    actuatorOwner: ProductNativeBinding["actuatorOwner"],
  ): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM product_native_binding
         WHERE actuator_owner = ?`,
      )
      .get(actuatorOwner) as { count: number };
    return row.count;
  }

  putPendingTurn(binding: ProductNativeTurnBinding): void {
    if (
      binding.state !== "native_pending" ||
      binding.nativeTurnReference !== undefined
    ) {
      throw new Error("Pending turn binding is malformed.");
    }
    const existing = this.turn(binding.turnId);
    if (existing) {
      if (
        existing.sessionId === binding.sessionId &&
        existing.aggregateRevision === binding.aggregateRevision
      ) {
        return;
      }
      throw new Error("Product turn binding already exists.");
    }
    this.#database
      .prepare(
        `INSERT INTO product_native_turn_binding(
          session_id, turn_id, native_turn_reference, aggregate_revision,
          state, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'native_pending', ?, ?)`,
      )
      .run(
        binding.sessionId,
        binding.turnId,
        binding.aggregateRevision,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  bindTurn(
    turnId: string,
    nativeTurnReference: string,
    updatedAt: string,
  ): ProductNativeTurnBinding {
    return this.#database.transaction(() => {
      const existing = this.turn(turnId);
      if (!existing) {
        throw new Error("Product turn binding is missing.");
      }
      if (existing.nativeTurnReference !== undefined) {
        if (existing.nativeTurnReference === nativeTurnReference) {
          return existing;
        }
        throw new Error("Product turn already has another native reference.");
      }
      const result = this.#database
        .prepare(
          `UPDATE product_native_turn_binding
           SET native_turn_reference = ?, state = 'running', updated_at = ?
           WHERE turn_id = ? AND state = 'native_pending'
             AND native_turn_reference IS NULL`,
        )
        .run(nativeTurnReference, updatedAt, turnId);
      if (result.changes !== 1) {
        throw new Error("Product/native turn binding did not commit.");
      }
      const bound = this.turn(turnId);
      if (!bound) {
        throw new Error("Bound product turn disappeared.");
      }
      return bound;
    })();
  }

  turn(turnId: string): ProductNativeTurnBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM product_native_turn_binding WHERE turn_id = ?")
      .get(turnId) as TurnBindingRow | undefined;
    return row ? turnBindingFromRow(row) : undefined;
  }

  turnByNativeReference(
    sessionId: string,
    nativeTurnReference: string,
  ): ProductNativeTurnBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM product_native_turn_binding
         WHERE session_id = ? AND native_turn_reference = ?`,
      )
      .get(sessionId, nativeTurnReference) as TurnBindingRow | undefined;
    return row ? turnBindingFromRow(row) : undefined;
  }

  setTurnState(
    turnId: string,
    state: Exclude<ProductTurnState, "native_pending">,
    updatedAt: string,
  ): "advanced" | "duplicate" | "invalid" {
    const existing = this.turn(turnId);
    if (!existing) {
      return "invalid";
    }
    if (existing.state === state) {
      return "duplicate";
    }
    if (
      existing.state === "completed" ||
      existing.state === "failed" ||
      existing.state === "interrupted" ||
      existing.state === "outcome_unknown"
    ) {
      return "invalid";
    }
    const result = this.#database
      .prepare(
        `UPDATE product_native_turn_binding SET state = ?, updated_at = ?
         WHERE turn_id = ? AND state IN ('native_pending', 'running')`,
      )
      .run(state, updatedAt, turnId);
    return result.changes === 1 ? "advanced" : "invalid";
  }

  turnCount(state?: ProductTurnState): number {
    const row =
      state === undefined
        ? (this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM product_native_turn_binding",
            )
            .get() as { count: number })
        : (this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM product_native_turn_binding
               WHERE state = ?`,
            )
            .get(state) as { count: number });
    return row.count;
  }

  interruptActiveTurns(sessionId: string, updatedAt: string): number {
    const result = this.#database
      .prepare(
        `UPDATE product_native_turn_binding
         SET state = 'interrupted', updated_at = ?
         WHERE session_id = ? AND state IN ('native_pending', 'running')`,
      )
      .run(updatedAt, sessionId);
    return result.changes;
  }

  putItem(binding: ProductNativeItemBinding): void {
    if (binding.state !== "running") {
      throw new Error("New native item must be running.");
    }
    const existing = this.item(binding.partId);
    if (existing) {
      if (
        existing.sessionId === binding.sessionId &&
        existing.turnId === binding.turnId &&
        existing.nativeItemReference === binding.nativeItemReference &&
        existing.itemKind === binding.itemKind
      ) {
        return;
      }
      throw new Error("Product item binding already exists.");
    }
    this.#database
      .prepare(
        `INSERT INTO product_native_item_binding(
          session_id, turn_id, part_id, native_item_reference, item_kind,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        binding.sessionId,
        binding.turnId,
        binding.partId,
        binding.nativeItemReference,
        binding.itemKind,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  item(partId: string): ProductNativeItemBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM product_native_item_binding WHERE part_id = ?")
      .get(partId) as ItemBindingRow | undefined;
    return row ? itemBindingFromRow(row) : undefined;
  }

  itemByNativeReference(
    sessionId: string,
    nativeItemReference: string,
  ): ProductNativeItemBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM product_native_item_binding
         WHERE session_id = ? AND native_item_reference = ?`,
      )
      .get(sessionId, nativeItemReference) as ItemBindingRow | undefined;
    return row ? itemBindingFromRow(row) : undefined;
  }

  setItemState(
    partId: string,
    state: Exclude<ProductItemState, "running">,
    updatedAt: string,
  ): "advanced" | "duplicate" | "invalid" {
    const existing = this.item(partId);
    if (!existing) {
      return "invalid";
    }
    if (existing.state === state) {
      return "duplicate";
    }
    if (existing.state !== "running") {
      return "invalid";
    }
    const result = this.#database
      .prepare(
        `UPDATE product_native_item_binding SET state = ?, updated_at = ?
         WHERE part_id = ? AND state = 'running'`,
      )
      .run(state, updatedAt, partId);
    return result.changes === 1 ? "advanced" : "invalid";
  }

  itemCount(state?: ProductItemState): number {
    const row =
      state === undefined
        ? (this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM product_native_item_binding",
            )
            .get() as { count: number })
        : (this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM product_native_item_binding
               WHERE state = ?`,
            )
            .get(state) as { count: number });
    return row.count;
  }

  putApproval(binding: ProductNativeApprovalBinding): void {
    if (binding.state !== "pending") {
      throw new Error("New native approval must be pending.");
    }
    const existing = this.approval(binding.approvalId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(binding)) {
        return;
      }
      throw new Error("Product approval binding already exists.");
    }
    this.#database
      .prepare(
        `INSERT INTO product_native_approval_binding(
          approval_id, tool_call_id, session_id, turn_id,
          native_approval_reference, native_item_reference, action_kind,
          action_target_digest, action_parameters_digest, action_summary,
          action_digest, capability_snapshot_digest, expires_at, state,
          decision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      )
      .run(
        binding.approvalId,
        binding.toolCallId,
        binding.sessionId,
        binding.turnId,
        binding.nativeApprovalReference,
        binding.nativeItemReference,
        binding.action.kind,
        binding.action.target_digest,
        binding.action.parameters_digest,
        binding.action.summary,
        binding.actionDigest,
        binding.capabilitySnapshotDigest,
        binding.expiresAt,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  approval(approvalId: string): ProductNativeApprovalBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM product_native_approval_binding
         WHERE approval_id = ?`,
      )
      .get(approvalId) as ApprovalBindingRow | undefined;
    return row ? approvalBindingFromRow(row) : undefined;
  }

  approvalByNativeReference(
    sessionId: string,
    nativeApprovalReference: string,
  ): ProductNativeApprovalBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM product_native_approval_binding
         WHERE session_id = ? AND native_approval_reference = ?`,
      )
      .get(sessionId, nativeApprovalReference) as
      ApprovalBindingRow | undefined;
    return row ? approvalBindingFromRow(row) : undefined;
  }

  beginApprovalDispatch(
    approvalId: string,
    decision: "approve" | "deny",
    updatedAt: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE product_native_approval_binding
         SET state = 'dispatching', decision = ?, updated_at = ?
         WHERE approval_id = ? AND state = 'pending' AND expires_at > ?`,
      )
      .run(decision, updatedAt, approvalId, updatedAt);
    return result.changes === 1;
  }

  finishApprovalDispatch(
    approvalId: string,
    state: "resolved" | "outcome_unknown",
    updatedAt: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE product_native_approval_binding SET state = ?, updated_at = ?
         WHERE approval_id = ? AND state = 'dispatching'`,
      )
      .run(state, updatedAt, approvalId);
    return result.changes === 1;
  }

  recoverDispatchingApprovals(updatedAt: string): number {
    const result = this.#database
      .prepare(
        `UPDATE product_native_approval_binding
         SET state = 'outcome_unknown', updated_at = ?
         WHERE state = 'dispatching'`,
      )
      .run(updatedAt);
    return result.changes;
  }

  expireApprovals(updatedAt: string): number {
    const result = this.#database
      .prepare(
        `UPDATE product_native_approval_binding
         SET state = 'expired', updated_at = ?
         WHERE state = 'pending' AND expires_at <= ?`,
      )
      .run(updatedAt, updatedAt);
    return result.changes;
  }

  invalidatePendingApprovals(updatedAt: string, sessionId?: string): number {
    const result =
      sessionId === undefined
        ? this.#database
            .prepare(
              `UPDATE product_native_approval_binding
               SET state = 'outcome_unknown', updated_at = ?
               WHERE state IN ('pending', 'dispatching')`,
            )
            .run(updatedAt)
        : this.#database
            .prepare(
              `UPDATE product_native_approval_binding
               SET state = 'outcome_unknown', updated_at = ?
               WHERE session_id = ? AND state IN ('pending', 'dispatching')`,
            )
            .run(updatedAt, sessionId);
    return result.changes;
  }

  approvalCount(state?: ProductApprovalState): number {
    const row =
      state === undefined
        ? (this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM product_native_approval_binding",
            )
            .get() as { count: number })
        : (this.#database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM product_native_approval_binding WHERE state = ?`,
            )
            .get(state) as { count: number });
    return row.count;
  }

  appendObservationOutbound(
    fingerprint: Sha256Digest,
    kind: string,
    observedAt: string,
    build: (sequence: number) => RunnerFrame,
    beforeAppend?: () => void,
  ): RunnerFrame | undefined {
    return this.#database.transaction(() => {
      const current = this.lane("event").outbound_cursor;
      const sequence = current + 1;
      const inserted = this.#database
        .prepare(
          `INSERT OR IGNORE INTO observation_transition(
            fingerprint, kind, event_sequence, observed_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(fingerprint, kind, sequence, observedAt);
      if (inserted.changes === 0) {
        return undefined;
      }
      beforeAppend?.();
      const frame = build(sequence);
      if (frame.lane !== "event" || frame.sequence !== sequence) {
        throw new Error("Observation frame changed its lane or sequence.");
      }
      this.#database
        .prepare(
          `INSERT INTO outbound_frame(
            lane, sequence, frame_json, created_at
          ) VALUES ('event', ?, ?, ?)`,
        )
        .run(sequence, JSON.stringify(frame), observedAt);
      this.#database
        .prepare(
          "UPDATE lane_state SET outbound_cursor = ? WHERE lane = 'event'",
        )
        .run(sequence);
      return frame;
    })();
  }

  observationCount(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM observation_transition")
      .get() as { count: number };
    return row.count;
  }

  proposeAdoption(adoption: StoredSessionAdoption): "accepted" | "duplicate" {
    const existing = this.adoption(adoption.adoptionId);
    if (existing) {
      if (existing.requestFingerprint === adoption.requestFingerprint) {
        return "duplicate";
      }
      throw new Error("Adoption identity was reused for another request.");
    }
    if (adoption.state !== "proposed") {
      throw new Error("New adoption must be proposed.");
    }
    this.#database
      .prepare(
        `INSERT INTO session_adoption(
          adoption_id, request_fingerprint, request_json, state,
          safe_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'proposed', NULL, ?, ?)`,
      )
      .run(
        adoption.adoptionId,
        adoption.requestFingerprint,
        adoption.requestJson,
        adoption.createdAt,
        adoption.updatedAt,
      );
    return "accepted";
  }

  adoption(adoptionId: string): StoredSessionAdoption | undefined {
    const row = this.#database
      .prepare("SELECT * FROM session_adoption WHERE adoption_id = ?")
      .get(adoptionId) as
      | {
          adoption_id: string;
          request_fingerprint: string;
          request_json: string;
          state: SessionAdoptionState;
          safe_code: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          adoptionId: row.adoption_id,
          requestFingerprint: row.request_fingerprint as Sha256Digest,
          requestJson: row.request_json,
          state: row.state,
          ...(row.safe_code === null ? {} : { safeCode: row.safe_code }),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  transitionAdoption(
    adoptionId: string,
    expected: SessionAdoptionState,
    state: SessionAdoptionState,
    updatedAt: string,
    safeCode?: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE session_adoption
         SET state = ?, safe_code = ?, updated_at = ?
         WHERE adoption_id = ? AND state = ?`,
      )
      .run(state, safeCode ?? null, updatedAt, adoptionId, expected);
    return result.changes === 1;
  }

  adoptionCount(state?: SessionAdoptionState): number {
    const row =
      state === undefined
        ? (this.#database
            .prepare("SELECT COUNT(*) AS count FROM session_adoption")
            .get() as { count: number })
        : (this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM session_adoption WHERE state = ?",
            )
            .get(state) as { count: number });
    return row.count;
  }

  lane(lane: RunnerLane): LaneRow {
    const row = this.#database
      .prepare("SELECT * FROM lane_state WHERE lane = ?")
      .get(lane) as LaneRow | undefined;
    if (!row) {
      throw new Error("Runner bridge lane state is missing.");
    }
    return row;
  }

  cursors(
    direction: "inbound" | "outbound_ack",
  ): Readonly<Record<RunnerLane, number>> {
    const rows = this.#database
      .prepare("SELECT * FROM lane_state ORDER BY lane")
      .all() as LaneRow[];
    const value = { control: -1, event: -1, bulk: -1 };
    for (const row of rows) {
      value[row.lane] =
        direction === "inbound" ? row.inbound_cursor : row.outbound_ack_cursor;
    }
    return value;
  }

  inspectInbound(
    lane: RunnerLane,
    sequence: number,
  ): "next" | "duplicate" | "gap" {
    const cursor = this.lane(lane).inbound_cursor;
    if (sequence <= cursor) {
      return "duplicate";
    }
    return sequence === cursor + 1 ? "next" : "gap";
  }

  commitInbound(lane: RunnerLane, sequence: number): void {
    const result = this.#database
      .prepare(
        `UPDATE lane_state SET inbound_cursor = ?
         WHERE lane = ? AND inbound_cursor = ?`,
      )
      .run(sequence, lane, sequence - 1);
    if (result.changes !== 1) {
      throw new Error("Runner inbound cursor cannot skip or regress.");
    }
  }

  appendOutbound(
    lane: RunnerLane,
    createdAt: string,
    build: (sequence: number) => RunnerFrame,
  ): RunnerFrame {
    return this.#database.transaction(() => {
      const current = this.lane(lane).outbound_cursor;
      const sequence = current + 1;
      const frame = build(sequence);
      if (frame.lane !== lane || frame.sequence !== sequence) {
        throw new Error("Outbound frame builder changed its lane or sequence.");
      }
      this.#database
        .prepare(
          `INSERT INTO outbound_frame(lane, sequence, frame_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(lane, sequence, JSON.stringify(frame), createdAt);
      this.#database
        .prepare("UPDATE lane_state SET outbound_cursor = ? WHERE lane = ?")
        .run(sequence, lane);
      return frame;
    })();
  }

  acknowledgeOutbound(
    lane: RunnerLane,
    throughSequence: number,
    acknowledgedAt: string,
  ): "advanced" | "duplicate" | "invalid" {
    return this.#database.transaction(() => {
      const state = this.lane(lane);
      if (throughSequence <= state.outbound_ack_cursor) {
        return "duplicate";
      }
      if (throughSequence > state.outbound_cursor) {
        return "invalid";
      }
      this.#database
        .prepare(
          `UPDATE outbound_frame SET acked_at = ?
           WHERE lane = ? AND sequence <= ? AND acked_at IS NULL`,
        )
        .run(acknowledgedAt, lane, throughSequence);
      this.#database
        .prepare("UPDATE lane_state SET outbound_ack_cursor = ? WHERE lane = ?")
        .run(throughSequence, lane);
      return "advanced";
    })();
  }

  pendingOutboundAfter(
    lane: RunnerLane,
    remoteCursor: number,
  ): readonly RunnerFrame[] {
    const rows = this.#database
      .prepare(
        `SELECT lane, sequence, frame_json FROM outbound_frame
         WHERE lane = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(lane, remoteCursor) as Array<OutboundRow & { frame_json: string }>;
    return rows.map(({ frame_json }) => JSON.parse(frame_json) as RunnerFrame);
  }

  pendingOutboundCount(lane?: RunnerLane): number {
    const row =
      lane === undefined
        ? (this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM outbound_frame WHERE acked_at IS NULL",
            )
            .get() as { count: number })
        : (this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM outbound_frame
               WHERE acked_at IS NULL AND lane = ?`,
            )
            .get(lane) as { count: number });
    return row.count;
  }

  setLanePaused(lane: RunnerLane, paused: boolean): void {
    this.#database
      .prepare("UPDATE lane_state SET paused = ? WHERE lane = ?")
      .run(paused ? 1 : 0, lane);
  }

  isLanePaused(lane: RunnerLane): boolean {
    return this.lane(lane).paused === 1;
  }

  acceptCommand(
    command: RunnerCommandFrame,
    effectFingerprint: Sha256Digest,
    acceptedAt: string,
  ): CommandAcceptance {
    return this.#database.transaction((): CommandAcceptance => {
      const observed = this.#database
        .prepare("SELECT * FROM command_effect WHERE idempotency_key = ?")
        .get(command.idempotency_key) as CommandRow | undefined;
      if (observed) {
        const effect = commandFromRow(observed);
        return effect.effectFingerprint === effectFingerprint
          ? { kind: "duplicate", effect }
          : { kind: "fingerprint_mismatch", effect };
      }
      this.#database
        .prepare(
          `INSERT INTO command_effect(
            idempotency_key, effect_fingerprint, command_sequence, status,
            accepted_at, updated_at
          ) VALUES (?, ?, ?, 'accepted', ?, ?)`,
        )
        .run(
          command.idempotency_key,
          effectFingerprint,
          command.sequence,
          acceptedAt,
          acceptedAt,
        );
      const effect = this.command(command.idempotency_key);
      if (!effect) {
        throw new Error("Accepted runner command was not persisted.");
      }
      return { kind: "accepted", effect };
    })();
  }

  command(idempotencyKey: string): StoredCommandEffect | undefined {
    const row = this.#database
      .prepare("SELECT * FROM command_effect WHERE idempotency_key = ?")
      .get(idempotencyKey) as CommandRow | undefined;
    return row ? commandFromRow(row) : undefined;
  }

  finishCommand(
    idempotencyKey: string,
    status: Exclude<RunnerCommandOutcomeStatus, "accepted">,
    resultDigest: Sha256Digest,
    updatedAt: string,
    safeCode?: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE command_effect
         SET status = ?, result_digest = ?, safe_code = ?, updated_at = ?
         WHERE idempotency_key = ? AND status = 'accepted'`,
      )
      .run(status, resultDigest, safeCode ?? null, updatedAt, idempotencyKey);
    if (result.changes !== 1) {
      throw new Error("Runner command outcome cannot transition.");
    }
  }

  recoverInterruptedCommands(
    resultDigest: Sha256Digest,
    updatedAt: string,
  ): number {
    const result = this.#database
      .prepare(
        `UPDATE command_effect
         SET status = 'outcome_unknown', result_digest = ?,
             safe_code = 'interrupted', updated_at = ?
         WHERE status = 'accepted'`,
      )
      .run(resultDigest, updatedAt);
    return result.changes;
  }

  commandCursor(): number {
    const row = this.#database
      .prepare(
        "SELECT COALESCE(MAX(command_sequence), -1) AS cursor FROM command_effect",
      )
      .get() as { cursor: number };
    return row.cursor;
  }

  effectOutcomes(limit: number): readonly RunnerReconcileEffectOutcome[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM command_effect
         ORDER BY command_sequence DESC LIMIT ?`,
      )
      .all(limit) as CommandRow[];
    return rows.reverse().map((row): RunnerReconcileEffectOutcome => {
      const effect = commandFromRow(row);
      return {
        idempotency_key: effect.idempotencyKey,
        effect_fingerprint: effect.effectFingerprint,
        status: effect.status,
        ...(effect.resultDigest === undefined
          ? {}
          : { result_digest: effect.resultDigest }),
      } as RunnerReconcileEffectOutcome;
    });
  }

  outcomeCount(status: RunnerCommandOutcomeStatus): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM command_effect WHERE status = ?")
      .get(status) as { count: number };
    return row.count;
  }

  beginReconciliation(
    reconciliationId: string,
    sessionLease: string,
    updatedAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO reconciliation_state(
          singleton, reconciliation_id, session_lease, state, updated_at
        ) VALUES (1, ?, ?, 'requested', ?)
        ON CONFLICT(singleton) DO UPDATE SET
          reconciliation_id = excluded.reconciliation_id,
          session_lease = excluded.session_lease,
          state = excluded.state,
          updated_at = excluded.updated_at`,
      )
      .run(reconciliationId, sessionLease, updatedAt);
  }

  completeReconciliation(
    reconciliationId: string,
    sessionLease: string,
    updatedAt: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE reconciliation_state
         SET state = 'complete', updated_at = ?
         WHERE singleton = 1 AND reconciliation_id = ?
           AND session_lease = ? AND state = 'requested'`,
      )
      .run(updatedAt, reconciliationId, sessionLease);
    return result.changes === 1;
  }

  reconciliation():
    | {
        readonly reconciliationId: string;
        readonly sessionLease: string;
        readonly state: "requested" | "complete";
      }
    | undefined {
    const row = this.#database
      .prepare(
        `SELECT reconciliation_id, session_lease, state
         FROM reconciliation_state WHERE singleton = 1`,
      )
      .get() as
      | {
          reconciliation_id: string;
          session_lease: string;
          state: "requested" | "complete";
        }
      | undefined;
    return row
      ? {
          reconciliationId: row.reconciliation_id,
          sessionLease: row.session_lease,
          state: row.state,
        }
      : undefined;
  }
}
