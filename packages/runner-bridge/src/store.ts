import { chmodSync, lstatSync } from "node:fs";

import Database from "better-sqlite3";

import type { CapabilityDescriptor, Sha256Digest } from "@session/contracts";
import type {
  RunnerCommandFrame,
  RunnerCommandOutcomeStatus,
  RunnerFrame,
  RunnerLane,
  RunnerReconcileEffectOutcome,
} from "@session/protocol-runner";

export const RUNNER_BRIDGE_STORE_SCHEMA_VERSION = 1;

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
  readonly actuatorOwner: "product-managed";
  readonly aggregateRevision: number;
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
  actuator_owner: "product-managed";
  aggregate_revision: number;
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
          actuator_owner TEXT NOT NULL CHECK (actuator_owner = 'product-managed'),
          aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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
    this.#database
      .prepare(
        `INSERT INTO product_native_binding(
          session_id, workspace_id, runner_id, project_id, worktree_id,
          harness_profile_id, native_session_reference,
          capability_snapshot_digest, actuator_owner, aggregate_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          runner_id = excluded.runner_id,
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          harness_profile_id = excluded.harness_profile_id,
          native_session_reference = excluded.native_session_reference,
          capability_snapshot_digest = excluded.capability_snapshot_digest,
          actuator_owner = excluded.actuator_owner,
          aggregate_revision = excluded.aggregate_revision,
          updated_at = excluded.updated_at`,
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
  }

  binding(sessionId: string): ProductNativeBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM product_native_binding WHERE session_id = ?")
      .get(sessionId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
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
