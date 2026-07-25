import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  AgentAttentionEventV1Schema,
  RelayDiagnosticV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
} from "@agent-relay/protocol";
import type {
  AgentAttentionEventV1,
  Harness,
  RelayDiagnosticV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
  Surface,
} from "@agent-relay/protocol";

import {
  CardActionKindSchema,
  CardActionTokenSchema,
  type CardActionKind,
} from "./card-action.js";

export type DeliveryStatus =
  "queued" | "retry" | "delivering" | "delivered" | "dead_letter";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface IngestResult {
  eventId: string;
  inserted: boolean;
  status: DeliveryStatus;
}

export interface ClaimedEvent {
  event: AgentAttentionEventV1;
  attemptNumber: number;
}

export interface SessionRecord {
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  surface: Surface;
  harnessVersion: string;
  sessionId: string;
  state: "active" | "waiting" | "stopped" | "suspected_stalled" | "exited";
  lastSeenAt: string;
  lastSequence: number;
}

export type TopicProvisioningStatus =
  "pending" | "creating" | "ready" | "retry" | "failed";

export interface SessionTopicRecord {
  machineId: string;
  harness: Harness;
  sessionId: string;
  transportName: string;
  transportScope: string;
  provider: Harness;
  repository: string;
  branch?: string;
  shortSessionId: string;
  lifecycleState: SessionRecord["state"];
  topicName: string;
  topicId?: string;
  provisioningStatus: TopicProvisioningStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CardActionRecord {
  token: string;
  eventId: string;
  kind: CardActionKind;
  createdAt: string;
}

export interface ClaimSessionTopicInput {
  machineId: string;
  harness: Harness;
  sessionId: string;
  transportName: string;
  transportScope: string;
  provider: Harness;
  repository: string;
  branch?: string;
  shortSessionId: string;
  lifecycleState: SessionRecord["state"];
  topicName: string;
  now: string;
}

export type SessionTopicClaimResult =
  | { outcome: "ready"; topic: SessionTopicRecord }
  | {
      outcome: "claimed";
      topic: SessionTopicRecord;
      attemptNumber: number;
    }
  | { outcome: "busy"; topic: SessionTopicRecord }
  | { outcome: "deferred"; topic: SessionTopicRecord }
  | { outcome: "failed"; topic: SessionTopicRecord };

export interface StoreStatus {
  events: Record<DeliveryStatus, number>;
  sessions: Record<SessionRecord["state"], number>;
  topics: Record<TopicProvisioningStatus, number>;
  resumeCommands: Record<ResumeCommandState, number>;
  diagnostics: Record<RelayDiagnosticV1["level"], number> & { total: number };
  pendingDeliveryCount: number;
}

export interface DiagnosticIngestResult {
  diagnosticId: string;
  inserted: boolean;
}

export interface RetentionCutoffs {
  deliveredBefore: string;
  deadLetterBefore: string;
  requestBefore: string;
  diagnosticBefore: string;
  telegramUpdateBefore: string;
  sessionBefore: string;
  limit?: number;
}

export interface RetentionResult {
  requestsExpired: number;
  pendingRequests: number;
  resumeCommands: number;
  events: number;
  deliveryAttempts: number;
  diagnostics: number;
  telegramUpdates: number;
  sessions: number;
}

export type PendingRequestState =
  "open" | "answered" | "expired" | "cancelled" | "failed";

export interface PendingOption {
  token: string;
  optionId: string;
  label: string;
}

export interface PendingRequestRecord {
  correlationId: string;
  eventId: string;
  machineId: string;
  harness: Harness;
  sessionId: string;
  turnId?: string;
  state: PendingRequestState;
  requestKind: "confirm" | "select" | "input" | "permission" | "continuation";
  question: string;
  expiresAt: string;
  resolvedBy?: "terminal" | "telegram";
  answer?: string;
  resolvedAt?: string;
  transportMessageId?: string;
  options: PendingOption[];
}

export type ResolutionOutcome =
  | "answered"
  | "duplicate"
  | "expired"
  | "cancelled"
  | "failed"
  | "not_found"
  | "identity_mismatch";

export interface ResolutionResult {
  outcome: ResolutionOutcome;
  request?: PendingRequestRecord;
}

export interface ResolveRequestInput {
  correlationId: string;
  answer: string;
  resolvedBy: "terminal" | "telegram";
  now: string;
  expected?: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    turnId?: string;
  };
}

export type ResumeCommandState =
  "claimed" | "running" | "succeeded" | "failed" | "unsupported";

export interface ResumeCommandRecord {
  correlationId: string;
  ownerId: string;
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  surface: Surface;
  sessionId: string;
  turnId?: string;
  answer: string;
  state: ResumeCommandState;
  claimedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type ResumeClaimResult =
  | { outcome: "none" }
  | {
      outcome: "waiting";
      correlationId: string;
      sessionId: string;
      expiresAt: string;
    }
  | { outcome: "claimed"; command: ResumeCommandRecord }
  | {
      outcome: "unsupported";
      correlationId: string;
      harness: Harness;
      surface: Surface;
      sessionId: string;
    };

export interface ClaimResumeInput {
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  ownerId: string;
  now: string;
}

interface EventRow {
  event_id: string;
  payload_json: string;
  status: DeliveryStatus;
  attempt_count: number;
}

interface SessionRow {
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  harness_version: string;
  session_id: string;
  state: SessionRecord["state"];
  last_seen_at: string;
  last_sequence: number;
}

interface SessionTopicRow {
  machine_id: string;
  harness: Harness;
  session_id: string;
  transport_name: string;
  transport_scope: string;
  provider: Harness;
  repository: string;
  branch: string | null;
  short_session_id: string;
  lifecycle_state: SessionRecord["state"];
  topic_name: string;
  topic_id: string | null;
  provisioning_status: TopicProvisioningStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CardActionRow {
  action_token: string;
  event_id: string;
  action_kind: CardActionKind;
  created_at: string;
}

interface CountRow {
  key: string;
  count: number;
}

interface PendingRow {
  correlation_id: string;
  event_id: string;
  machine_id: string;
  harness: Harness;
  session_id: string;
  turn_id: string | null;
  state: PendingRequestState;
  request_kind: PendingRequestRecord["requestKind"];
  question: string;
  expires_at: string;
  resolved_by: "terminal" | "telegram" | null;
  answer: string | null;
  resolved_at: string | null;
  transport_message_id: string | null;
}

interface PendingOptionRow {
  option_token: string;
  option_id: string;
  label: string;
}

interface ResumeCommandRow {
  correlation_id: string;
  owner_id: string;
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  session_id: string;
  turn_id: string | null;
  answer: string;
  state: ResumeCommandState;
  claimed_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ResumeCandidateRow {
  correlation_id: string;
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  session_id: string;
  turn_id: string | null;
  answer: string | null;
  state: PendingRequestState;
  expires_at: string;
  capabilities_json: string;
}

function stateForEvent(
  type: AgentAttentionEventV1["type"],
): SessionRecord["state"] {
  switch (type) {
    case "session.started":
    case "turn.started":
    case "turn.activity":
      return "active";
    case "turn.stopped":
    case "input.required":
    case "permission.required":
      return "waiting";
    case "turn.failed":
      return "stopped";
    case "process.stale":
      return "suspected_stalled";
    case "process.exited":
    case "session.ended":
      return "exited";
  }
}

function retryDelay(policy: RetryPolicy, attemptNumber: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attemptNumber - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

function assertIsoCutoff(value: string, name: string): void {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function collisionComparable(payloadJson: string): string {
  const event = AgentAttentionEventV1Schema.parse(
    JSON.parse(payloadJson) as unknown,
  );
  return JSON.stringify({
    ...event,
    occurredAt: "<retry-stable>",
    ...(event.request === undefined
      ? {}
      : {
          request: {
            ...event.request,
            expiresAt: "<retry-stable>",
          },
        }),
  });
}

function defaultOptions(
  request: AgentAttentionEventV1["request"],
): Array<{ id: string; label: string }> {
  if (request === undefined) {
    return [];
  }
  if (request.kind === "select") {
    return request.options ?? [];
  }
  if (request.kind === "confirm") {
    return [
      { id: "yes_option", label: "Yes" },
      { id: "no_option", label: "No" },
    ];
  }
  if (request.kind === "permission") {
    return [
      { id: "allow_once", label: "Allow once" },
      { id: "deny_request", label: "Deny" },
      { id: "terminal_only", label: "Handle at terminal" },
    ];
  }
  return [];
}

export class RelayStore {
  private readonly database: Database.Database;

  public constructor(path = ":memory:") {
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
    }
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bridge_session_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        harness_version TEXT NOT NULL,
        project_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        state TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, harness, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_topics (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        transport_name TEXT NOT NULL,
        transport_scope TEXT NOT NULL,
        provider TEXT NOT NULL,
        repository TEXT NOT NULL,
        branch TEXT,
        short_session_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        topic_id TEXT,
        provisioning_status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_started_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          machine_id, harness, session_id, transport_name, transport_scope
        ),
        UNIQUE (transport_name, transport_scope, topic_id),
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS session_topics_status_idx
        ON session_topics(
          provisioning_status, next_attempt_at, updated_at
        );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_started_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        transport_name TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
      );

      CREATE INDEX IF NOT EXISTS events_due_idx
        ON events(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS card_actions (
        action_token TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, action_kind),
        FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        UNIQUE(event_id, attempt_number),
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS pending_requests (
        correlation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        state TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        question TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_by TEXT,
        answer TEXT,
        resolved_at TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS pending_options (
        option_token TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        label TEXT NOT NULL,
        UNIQUE(correlation_id, option_id),
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id)
      );

      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL,
        outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resume_commands (
        correlation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        bridge_session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        surface TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        answer TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id)
      );

      CREATE INDEX IF NOT EXISTS resume_commands_owner_idx
        ON resume_commands(owner_id, state, claimed_at);

      CREATE TABLE IF NOT EXISTS diagnostics (
        diagnostic_id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS diagnostics_recorded_idx
        ON diagnostics(recorded_at, diagnostic_id);
    `);
  }

  public close(): void {
    this.database.close();
  }

  public registerSession(sessionInput: SessionRegistrationV1): void {
    const session = SessionRegistrationV1Schema.parse(sessionInput);
    this.database
      .prepare(
        `
        INSERT INTO sessions (
          machine_id, harness, session_id, bridge_session_id, surface,
          harness_version, project_json, capabilities_json, state,
          last_seen_at, last_sequence, updated_at
        ) VALUES (
          @machineId, @harness, @sessionId, @bridgeSessionId, @surface,
          @harnessVersion, @projectJson, @capabilitiesJson, 'active',
          @registeredAt, 0, @registeredAt
        )
        ON CONFLICT(machine_id, harness, session_id) DO UPDATE SET
          bridge_session_id = excluded.bridge_session_id,
          surface = excluded.surface,
          harness_version = excluded.harness_version,
          project_json = excluded.project_json,
          capabilities_json = excluded.capabilities_json,
          last_seen_at = CASE
            WHEN excluded.last_seen_at > sessions.last_seen_at
              THEN excluded.last_seen_at
            ELSE sessions.last_seen_at
          END,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        ...session,
        projectJson: JSON.stringify(session.project),
        capabilitiesJson: JSON.stringify(session.capabilities),
      });
  }

  private topicFromRow(row: SessionTopicRow): SessionTopicRecord {
    return {
      machineId: row.machine_id,
      harness: row.harness,
      sessionId: row.session_id,
      transportName: row.transport_name,
      transportScope: row.transport_scope,
      provider: row.provider,
      repository: row.repository,
      ...(row.branch === null ? {} : { branch: row.branch }),
      shortSessionId: row.short_session_id,
      lifecycleState: row.lifecycle_state,
      topicName: row.topic_name,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      provisioningStatus: row.provisioning_status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      ...(row.last_error_code === null
        ? {}
        : { lastErrorCode: row.last_error_code }),
      ...(row.last_error_message === null
        ? {}
        : { lastErrorMessage: row.last_error_message }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getSessionTopicRow(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
  }): SessionTopicRow | undefined {
    return this.database
      .prepare(
        `
        SELECT
          machine_id, harness, session_id, transport_name, transport_scope,
          provider, repository, branch, short_session_id, lifecycle_state,
          topic_name, topic_id, provisioning_status, attempt_count,
          next_attempt_at, last_error_code, last_error_message, created_at,
          updated_at
        FROM session_topics
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
      `,
      )
      .get(input) as SessionTopicRow | undefined;
  }

  public claimSessionTopic(
    input: ClaimSessionTopicInput,
  ): SessionTopicClaimResult {
    assertIsoCutoff(input.now, "topic claim time");
    if (
      input.transportName.trim().length === 0 ||
      input.transportScope.trim().length === 0
    ) {
      throw new Error("topic transport identity is required");
    }
    if (
      input.repository.length < 1 ||
      input.repository.length > 120 ||
      input.topicName.length < 1 ||
      [...input.topicName].length > 128
    ) {
      throw new Error("topic metadata is outside supported bounds");
    }
    return this.database.transaction((): SessionTopicClaimResult => {
      this.database
        .prepare(
          `
          INSERT OR IGNORE INTO session_topics (
            machine_id, harness, session_id, transport_name, transport_scope,
            provider, repository, branch, short_session_id, lifecycle_state,
            topic_name, provisioning_status, next_attempt_at, created_at,
            updated_at
          ) VALUES (
            @machineId, @harness, @sessionId, @transportName, @transportScope,
            @provider, @repository, @branch, @shortSessionId, @lifecycleState,
            @topicName, 'pending', @now, @now, @now
          )
        `,
        )
        .run({
          ...input,
          branch: input.branch ?? null,
        });
      this.database
        .prepare(
          `
          UPDATE session_topics SET
            provider = @provider,
            repository = @repository,
            branch = @branch,
            short_session_id = @shortSessionId,
            lifecycle_state = @lifecycleState,
            topic_name = CASE
              WHEN provisioning_status = 'ready' THEN topic_name
              ELSE @topicName
            END,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
        `,
        )
        .run({
          ...input,
          branch: input.branch ?? null,
        });
      const currentRow = this.getSessionTopicRow(input);
      if (currentRow === undefined) {
        throw new Error("session topic disappeared during claim");
      }
      const current = this.topicFromRow(currentRow);
      if (current.provisioningStatus === "ready") {
        if (current.topicId === undefined) {
          throw new Error("ready session topic is missing its topic id");
        }
        return { outcome: "ready", topic: current };
      }
      if (current.provisioningStatus === "creating") {
        return { outcome: "busy", topic: current };
      }
      if (current.provisioningStatus === "failed") {
        return { outcome: "failed", topic: current };
      }
      if (
        current.provisioningStatus === "retry" &&
        current.nextAttemptAt > input.now
      ) {
        return { outcome: "deferred", topic: current };
      }
      const update = this.database
        .prepare(
          `
          UPDATE session_topics SET
            provisioning_status = 'creating',
            attempt_count = attempt_count + 1,
            lease_started_at = @now,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND provisioning_status IN ('pending', 'retry')
            AND next_attempt_at <= @now
        `,
        )
        .run(input);
      if (update.changes !== 1) {
        const raced = this.getSessionTopicRow(input);
        if (raced === undefined) {
          throw new Error("session topic disappeared after claim race");
        }
        return { outcome: "busy", topic: this.topicFromRow(raced) };
      }
      const claimedRow = this.getSessionTopicRow(input);
      if (claimedRow === undefined) {
        throw new Error("claimed session topic disappeared");
      }
      const claimed = this.topicFromRow(claimedRow);
      return {
        outcome: "claimed",
        topic: claimed,
        attemptNumber: claimed.attemptCount,
      };
    })();
  }

  public markSessionTopicReady(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    attemptNumber: number;
    topicId: string;
    now: string;
  }): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic ready time");
    if (input.topicId.trim().length === 0 || input.topicId.length > 128) {
      throw new Error("topic id is outside supported bounds");
    }
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          topic_id = @topicId,
          provisioning_status = 'ready',
          lease_started_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND provisioning_status = 'creating'
          AND attempt_count = @attemptNumber
      `,
      )
      .run(input).changes;
    if (changes !== 1) {
      throw new Error("cannot complete an unclaimed session topic");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("ready session topic disappeared");
    }
    return this.topicFromRow(row);
  }

  public markSessionTopicFailed(
    input: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      transportName: string;
      transportScope: string;
      attemptNumber: number;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      now: string;
    },
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic failure time");
    const exhausted = input.attemptNumber >= policy.maxAttempts;
    const provisioningStatus: TopicProvisioningStatus =
      input.retryable && !exhausted ? "retry" : "failed";
    const nextAttemptAt = new Date(
      Date.parse(input.now) + retryDelay(policy, input.attemptNumber),
    ).toISOString();
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          provisioning_status = @provisioningStatus,
          next_attempt_at = @nextAttemptAt,
          lease_started_at = NULL,
          last_error_code = @errorCode,
          last_error_message = @errorMessage,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND provisioning_status = 'creating'
          AND attempt_count = @attemptNumber
      `,
      )
      .run({
        ...input,
        provisioningStatus,
        nextAttemptAt,
        errorMessage: input.errorMessage.slice(0, 2_000),
      }).changes;
    if (changes !== 1) {
      throw new Error("cannot fail an unclaimed session topic");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("failed session topic disappeared");
    }
    return this.topicFromRow(row);
  }

  public reconcileUnavailableSessionTopic(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    topicId: string;
    errorCode: string;
    errorMessage: string;
    now: string;
  }): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic reconciliation time");
    return this.database.transaction(() => {
      const currentRow = this.getSessionTopicRow(input);
      if (currentRow === undefined) {
        throw new Error("cannot reconcile an unknown session topic");
      }
      const current = this.topicFromRow(currentRow);
      if (
        current.provisioningStatus !== "ready" ||
        current.topicId !== input.topicId
      ) {
        return current;
      }
      const changes = this.database
        .prepare(
          `
          UPDATE session_topics SET
            topic_id = NULL,
            provisioning_status = 'retry',
            next_attempt_at = @now,
            lease_started_at = NULL,
            last_error_code = @errorCode,
            last_error_message = @errorMessage,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND provisioning_status = 'ready'
            AND topic_id = @topicId
        `,
        )
        .run({
          ...input,
          errorMessage: input.errorMessage.slice(0, 2_000),
        }).changes;
      if (changes !== 1) {
        const raced = this.getSessionTopicRow(input);
        if (raced === undefined) {
          throw new Error("session topic disappeared during reconciliation");
        }
        return this.topicFromRow(raced);
      }
      const reconciled = this.getSessionTopicRow(input);
      if (reconciled === undefined) {
        throw new Error("reconciled session topic disappeared");
      }
      return this.topicFromRow(reconciled);
    })();
  }

  public recoverInterruptedTopics(now: string): number {
    assertIsoCutoff(now, "topic recovery time");
    return this.database
      .prepare(
        `
        UPDATE session_topics SET
          provisioning_status = 'retry',
          next_attempt_at = ?,
          lease_started_at = NULL,
          last_error_code = 'topic-creation-interrupted',
          last_error_message = 'daemon stopped during topic creation',
          updated_at = ?
        WHERE provisioning_status = 'creating'
      `,
      )
      .run(now, now).changes;
  }

  public getSessionTopic(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
  }): SessionTopicRecord | undefined {
    const row = this.getSessionTopicRow(input);
    return row === undefined ? undefined : this.topicFromRow(row);
  }

  public listSessionTopics(): SessionTopicRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT
          machine_id, harness, session_id, transport_name, transport_scope,
          provider, repository, branch, short_session_id, lifecycle_state,
          topic_name, topic_id, provisioning_status, attempt_count,
          next_attempt_at, last_error_code, last_error_message, created_at,
          updated_at
        FROM session_topics
        ORDER BY updated_at DESC, machine_id, harness, session_id
      `,
      )
      .all() as SessionTopicRow[];
    return rows.map((row) => this.topicFromRow(row));
  }

  public heartbeat(heartbeatInput: SessionHeartbeatV1): boolean {
    const heartbeat = SessionHeartbeatV1Schema.parse(heartbeatInput);
    const result = this.database
      .prepare(
        `
        UPDATE sessions SET
          state = CASE
            WHEN @sequence >= last_sequence THEN @state
            ELSE state
          END,
          last_sequence = MAX(last_sequence, @sequence),
          last_seen_at = MAX(last_seen_at, @observedAt),
          updated_at = @observedAt
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
      `,
      )
      .run(heartbeat);
    return result.changes === 1;
  }

  public ingestEvent(eventInput: AgentAttentionEventV1): IngestResult {
    const event = AgentAttentionEventV1Schema.parse(eventInput);
    return this.database.transaction(() => {
      this.registerSession({
        schema: "agent-session.v1",
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        surface: event.surface,
        harnessVersion: event.harnessVersion,
        sessionId: event.sessionId,
        project: event.project,
        capabilities: event.capabilities,
        registeredAt: event.occurredAt,
      });

      const state = stateForEvent(event.type);
      this.database
        .prepare(
          `
          UPDATE sessions SET
            state = CASE
              WHEN @sequence >= last_sequence THEN @state
              ELSE state
            END,
            last_sequence = MAX(last_sequence, @sequence),
            last_seen_at = MAX(last_seen_at, @occurredAt),
            updated_at = @occurredAt
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
        `,
        )
        .run({ ...event, state });

      const payloadJson = JSON.stringify(event);
      const result = this.database
        .prepare(
          `
          INSERT OR IGNORE INTO events (
            event_id, machine_id, harness, session_id, type, payload_json,
            status, next_attempt_at, created_at
          ) VALUES (
            @eventId, @machineId, @harness, @sessionId, @type, @payloadJson,
            'queued', @occurredAt, @occurredAt
          )
        `,
        )
        .run({ ...event, payloadJson });
      const inserted = result.changes === 1;

      const existing = this.database
        .prepare(
          `
          SELECT event_id, payload_json, status, attempt_count
          FROM events WHERE event_id = ?
        `,
        )
        .get(event.eventId) as EventRow | undefined;
      if (existing === undefined) {
        throw new Error(`event ${event.eventId} disappeared after ingestion`);
      }
      if (
        !inserted &&
        collisionComparable(existing.payload_json) !==
          collisionComparable(payloadJson)
      ) {
        throw new Error(
          `event id collision: ${event.eventId} has a different payload`,
        );
      }
      if (inserted && event.request !== undefined) {
        this.database
          .prepare(
            `
            INSERT INTO pending_requests (
              correlation_id, event_id, machine_id, harness, session_id,
              turn_id, state, request_kind, question, expires_at, created_at
            ) VALUES (
              @correlationId, @eventId, @machineId, @harness, @sessionId,
              @turnId, 'open', @requestKind, @question, @expiresAt, @createdAt
            )
          `,
          )
          .run({
            correlationId: event.request.correlationId,
            eventId: event.eventId,
            machineId: event.machineId,
            harness: event.harness,
            sessionId: event.sessionId,
            turnId: event.turnId ?? null,
            requestKind: event.request.kind,
            question: event.request.question,
            expiresAt: event.request.expiresAt,
            createdAt: event.occurredAt,
          });
        const insertOption = this.database.prepare(
          `
          INSERT INTO pending_options (
            option_token, correlation_id, option_id, label
          ) VALUES (?, ?, ?, ?)
        `,
        );
        for (const option of defaultOptions(event.request)) {
          insertOption.run(
            `decision_${randomUUID()}`,
            event.request.correlationId,
            option.id,
            option.label,
          );
        }
      }
      return {
        eventId: event.eventId,
        inserted,
        status: existing.status,
      };
    })();
  }

  public claimDueEvents(now: string, limit = 50): ClaimedEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("delivery claim limit must be between 1 and 500");
    }
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT event_id, payload_json, status, attempt_count
          FROM events
          WHERE status IN ('queued', 'retry')
            AND next_attempt_at <= ?
          ORDER BY created_at, event_id
          LIMIT ?
        `,
        )
        .all(now, limit) as EventRow[];

      const claimed: ClaimedEvent[] = [];
      for (const row of rows) {
        const attemptNumber = row.attempt_count + 1;
        const update = this.database
          .prepare(
            `
            UPDATE events SET
              status = 'delivering',
              attempt_count = ?,
              lease_started_at = ?
            WHERE event_id = ?
              AND status IN ('queued', 'retry')
          `,
          )
          .run(attemptNumber, now, row.event_id);
        if (update.changes !== 1) {
          continue;
        }
        this.database
          .prepare(
            `
            INSERT INTO delivery_attempts (
              event_id, attempt_number, status, started_at
            ) VALUES (?, ?, 'delivering', ?)
          `,
          )
          .run(row.event_id, attemptNumber, now);
        claimed.push({
          event: AgentAttentionEventV1Schema.parse(
            JSON.parse(row.payload_json) as unknown,
          ),
          attemptNumber,
        });
      }
      return claimed;
    })();
  }

  public markDelivered(
    eventId: string,
    attemptNumber: number,
    transportName: string,
    messageId: string,
    now: string,
  ): void {
    const result = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `
          UPDATE events SET
            status = 'delivered',
            transport_name = ?,
            transport_message_id = ?,
            delivered_at = ?,
            lease_started_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL
          WHERE event_id = ? AND status = 'delivering'
        `,
        )
        .run(transportName, messageId, now, eventId);
      this.database
        .prepare(
          `
          UPDATE delivery_attempts SET
            status = 'delivered',
            finished_at = ?
          WHERE event_id = ? AND attempt_number = ?
        `,
        )
        .run(now, eventId, attemptNumber);
      this.database
        .prepare(
          `
          UPDATE pending_requests SET transport_message_id = ?
          WHERE event_id = ?
        `,
        )
        .run(messageId, eventId);
      return update.changes;
    })();
    if (result !== 1) {
      throw new Error(`cannot mark non-delivering event ${eventId} delivered`);
    }
  }

  public markDeliveryFailed(
    eventId: string,
    attemptNumber: number,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    now: string,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): DeliveryStatus {
    const exhausted = attemptNumber >= policy.maxAttempts;
    const status: DeliveryStatus =
      retryable && !exhausted ? "retry" : "dead_letter";
    const nextAttemptAt = new Date(
      Date.parse(now) + retryDelay(policy, attemptNumber),
    ).toISOString();
    const changes = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `
          UPDATE events SET
            status = @status,
            next_attempt_at = @nextAttemptAt,
            lease_started_at = NULL,
            last_error_code = @errorCode,
            last_error_message = @errorMessage
          WHERE event_id = @eventId AND status = 'delivering'
        `,
        )
        .run({
          eventId,
          status,
          nextAttemptAt,
          errorCode,
          errorMessage: errorMessage.slice(0, 2_000),
        });
      this.database
        .prepare(
          `
          UPDATE delivery_attempts SET
            status = @status,
            finished_at = @now,
            error_code = @errorCode,
            error_message = @errorMessage
          WHERE event_id = @eventId AND attempt_number = @attemptNumber
        `,
        )
        .run({
          eventId,
          attemptNumber,
          status,
          now,
          errorCode,
          errorMessage: errorMessage.slice(0, 2_000),
        });
      return update.changes;
    })();
    if (changes !== 1) {
      throw new Error(`cannot fail non-delivering event ${eventId}`);
    }
    return status;
  }

  public recoverInterruptedDeliveries(now: string): number {
    const result = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT event_id, attempt_count
          FROM events WHERE status = 'delivering'
        `,
        )
        .all() as Array<{ event_id: string; attempt_count: number }>;
      for (const row of rows) {
        this.database
          .prepare(
            `
            UPDATE delivery_attempts SET
              status = 'retry',
              finished_at = ?,
              error_code = 'delivery-interrupted',
              error_message = 'daemon stopped during delivery'
            WHERE event_id = ? AND attempt_number = ?
          `,
          )
          .run(now, row.event_id, row.attempt_count);
      }
      return this.database
        .prepare(
          `
          UPDATE events SET
            status = 'retry',
            next_attempt_at = ?,
            lease_started_at = NULL,
            last_error_code = 'delivery-interrupted',
            last_error_message = 'daemon stopped during delivery'
          WHERE status = 'delivering'
        `,
        )
        .run(now).changes;
    })();
    return result;
  }

  public getEvent(
    eventId: string,
  ): { event: AgentAttentionEventV1; status: DeliveryStatus } | undefined {
    const row = this.database
      .prepare(
        `
        SELECT event_id, payload_json, status, attempt_count
        FROM events WHERE event_id = ?
      `,
      )
      .get(eventId) as EventRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      event: AgentAttentionEventV1Schema.parse(
        JSON.parse(row.payload_json) as unknown,
      ),
      status: row.status,
    };
  }

  public registerCardActions(
    eventId: string,
    actions: Array<{ token: string; kind: CardActionKind }>,
    now: string,
  ): CardActionRecord[] {
    assertIsoCutoff(now, "card action registration time");
    return this.database.transaction(() => {
      for (const action of actions) {
        const token = CardActionTokenSchema.parse(action.token);
        const kind = CardActionKindSchema.parse(action.kind);
        this.database
          .prepare(
            `
            INSERT OR IGNORE INTO card_actions (
              action_token, event_id, action_kind, created_at
            ) VALUES (?, ?, ?, ?)
          `,
          )
          .run(token, eventId, kind, now);
        const existing = this.database
          .prepare(
            `
            SELECT action_token, event_id, action_kind, created_at
            FROM card_actions WHERE action_token = ?
          `,
          )
          .get(token) as CardActionRow | undefined;
        if (
          existing === undefined ||
          existing.event_id !== eventId ||
          existing.action_kind !== kind
        ) {
          throw new Error(`card action token collision for ${token}`);
        }
      }
      return actions.map((action) => {
        const registered = this.getCardAction(action.token);
        if (registered === undefined) {
          throw new Error(`card action ${action.token} disappeared`);
        }
        return registered;
      });
    })();
  }

  public getCardAction(token: string): CardActionRecord | undefined {
    const parsed = CardActionTokenSchema.safeParse(token);
    if (!parsed.success) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `
        SELECT action_token, event_id, action_kind, created_at
        FROM card_actions WHERE action_token = ?
      `,
      )
      .get(parsed.data) as CardActionRow | undefined;
    return row === undefined
      ? undefined
      : {
          token: row.action_token,
          eventId: row.event_id,
          kind: row.action_kind,
          createdAt: row.created_at,
        };
  }

  private pendingFromRow(row: PendingRow): PendingRequestRecord {
    const optionRows = this.database
      .prepare(
        `
        SELECT option_token, option_id, label
        FROM pending_options
        WHERE correlation_id = ?
        ORDER BY rowid
      `,
      )
      .all(row.correlation_id) as PendingOptionRow[];
    return {
      correlationId: row.correlation_id,
      eventId: row.event_id,
      machineId: row.machine_id,
      harness: row.harness,
      sessionId: row.session_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      state: row.state,
      requestKind: row.request_kind,
      question: row.question,
      expiresAt: row.expires_at,
      ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by }),
      ...(row.answer === null ? {} : { answer: row.answer }),
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
      ...(row.transport_message_id === null
        ? {}
        : { transportMessageId: row.transport_message_id }),
      options: optionRows.map((option) => ({
        token: option.option_token,
        optionId: option.option_id,
        label: option.label,
      })),
    };
  }

  public getPendingRequest(
    correlationId: string,
  ): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  public getPendingForEvent(eventId: string): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE event_id = ?
      `,
      )
      .get(eventId) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  private requirePending(correlationId: string): PendingRequestRecord {
    const request = this.getPendingRequest(correlationId);
    if (request === undefined) {
      throw new Error(`pending request ${correlationId} disappeared`);
    }
    return request;
  }

  public resolveRequest(input: ResolveRequestInput): ResolutionResult {
    const answer = input.answer.trim().slice(0, 4_000);
    if (answer.length === 0) {
      throw new Error("request answer cannot be empty");
    }
    return this.database.transaction((): ResolutionResult => {
      const current = this.getPendingRequest(input.correlationId);
      if (current === undefined) {
        return { outcome: "not_found" };
      }
      if (
        input.expected !== undefined &&
        (current.machineId !== input.expected.machineId ||
          current.harness !== input.expected.harness ||
          current.sessionId !== input.expected.sessionId ||
          current.turnId !== input.expected.turnId)
      ) {
        return { outcome: "identity_mismatch", request: current };
      }
      if (current.state !== "open") {
        return {
          outcome: current.state === "answered" ? "duplicate" : current.state,
          request: current,
        };
      }
      if (input.now >= current.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests SET
              state = 'expired',
              resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, input.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(input.correlationId),
        };
      }
      const update = this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'answered',
            resolved_by = ?,
            answer = ?,
            resolved_at = ?
          WHERE correlation_id = ? AND state = 'open'
        `,
        )
        .run(input.resolvedBy, answer, input.now, input.correlationId);
      if (update.changes !== 1) {
        return {
          outcome: "duplicate",
          request: this.requirePending(input.correlationId),
        };
      }
      return {
        outcome: "answered",
        request: this.requirePending(input.correlationId),
      };
    })();
  }

  public resolveOptionToken(
    token: string,
    resolvedBy: "terminal" | "telegram",
    now: string,
  ): ResolutionResult {
    const option = this.database
      .prepare(
        `
        SELECT correlation_id, option_id
        FROM pending_options
        WHERE option_token = ?
      `,
      )
      .get(token) as { correlation_id: string; option_id: string } | undefined;
    if (option === undefined) {
      return { outcome: "not_found" };
    }
    return this.resolveRequest({
      correlationId: option.correlation_id,
      answer: option.option_id,
      resolvedBy,
      now,
    });
  }

  public resolveTransportReply(
    messageId: string,
    answer: string,
    now: string,
  ): ResolutionResult {
    const row = this.database
      .prepare(
        `
        SELECT correlation_id
        FROM pending_requests
        WHERE transport_message_id = ?
      `,
      )
      .get(messageId) as { correlation_id: string } | undefined;
    if (row === undefined) {
      return { outcome: "not_found" };
    }
    return this.resolveRequest({
      correlationId: row.correlation_id,
      answer,
      resolvedBy: "telegram",
      now,
    });
  }

  public cancelRequest(correlationId: string, now: string): ResolutionResult {
    const current = this.getPendingRequest(correlationId);
    if (current === undefined) {
      return { outcome: "not_found" };
    }
    if (current.state !== "open") {
      return {
        outcome: current.state === "answered" ? "duplicate" : current.state,
        request: current,
      };
    }
    this.database
      .prepare(
        `
        UPDATE pending_requests SET
          state = 'cancelled',
          resolved_at = ?
        WHERE correlation_id = ? AND state = 'open'
      `,
      )
      .run(now, correlationId);
    return {
      outcome: "cancelled",
      request: this.requirePending(correlationId),
    };
  }

  public expireRequests(now: string): number {
    return this.database
      .prepare(
        `
        UPDATE pending_requests SET
          state = 'expired',
          resolved_at = ?
        WHERE state = 'open' AND expires_at <= ?
      `,
      )
      .run(now, now).changes;
  }

  private resumeCommandFromRow(row: ResumeCommandRow): ResumeCommandRecord {
    return {
      correlationId: row.correlation_id,
      ownerId: row.owner_id,
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: row.harness,
      surface: row.surface,
      sessionId: row.session_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      answer: row.answer,
      state: row.state,
      claimedAt: row.claimed_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      ...(row.signal === null ? {} : { signal: row.signal }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.error_message === null
        ? {}
        : { errorMessage: row.error_message }),
    };
  }

  public getResumeCommand(
    correlationId: string,
  ): ResumeCommandRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT * FROM resume_commands
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as ResumeCommandRow | undefined;
    return row === undefined ? undefined : this.resumeCommandFromRow(row);
  }

  public listResumeCommands(): ResumeCommandRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT * FROM resume_commands
        ORDER BY claimed_at, correlation_id
      `,
      )
      .all() as ResumeCommandRow[];
    return rows.map((row) => this.resumeCommandFromRow(row));
  }

  public claimNextResume(input: ClaimResumeInput): ResumeClaimResult {
    return this.database.transaction((): ResumeClaimResult => {
      this.expireRequests(input.now);
      const candidates = this.database
        .prepare(
          `
          SELECT
            pending.correlation_id,
            pending.machine_id,
            sessions.bridge_session_id,
            pending.harness,
            sessions.surface,
            pending.session_id,
            pending.turn_id,
            pending.answer,
            pending.state,
            pending.expires_at,
            sessions.capabilities_json
          FROM pending_requests AS pending
          JOIN sessions
            ON sessions.machine_id = pending.machine_id
            AND sessions.harness = pending.harness
            AND sessions.session_id = pending.session_id
          LEFT JOIN resume_commands AS commands
            ON commands.correlation_id = pending.correlation_id
          WHERE pending.machine_id = ?
            AND sessions.bridge_session_id = ?
            AND pending.harness = ?
            AND pending.request_kind = 'continuation'
            AND pending.state IN ('open', 'answered')
            AND pending.expires_at > ?
            AND commands.correlation_id IS NULL
          ORDER BY pending.created_at, pending.correlation_id
        `,
        )
        .all(
          input.machineId,
          input.bridgeSessionId,
          input.harness,
          input.now,
        ) as ResumeCandidateRow[];

      for (const candidate of candidates) {
        if (candidate.state === "open") {
          return {
            outcome: "waiting",
            correlationId: candidate.correlation_id,
            sessionId: candidate.session_id,
            expiresAt: candidate.expires_at,
          };
        }
        if (candidate.answer === null) {
          continue;
        }
        const capabilities = JSON.parse(candidate.capabilities_json) as {
          lateResume?: unknown;
        };
        const supported =
          candidate.surface === "cli" && capabilities.lateResume === true;
        const state: ResumeCommandState = supported ? "claimed" : "unsupported";
        const inserted = this.database
          .prepare(
            `
            INSERT OR IGNORE INTO resume_commands (
              correlation_id, owner_id, machine_id, bridge_session_id,
              harness, surface, session_id, turn_id, answer, state, claimed_at,
              finished_at, error_code, error_message
            ) VALUES (
              @correlationId, @ownerId, @machineId, @bridgeSessionId,
              @harness, @surface, @sessionId, @turnId, @answer, @state,
              @claimedAt, @finishedAt, @errorCode, @errorMessage
            )
          `,
          )
          .run({
            correlationId: candidate.correlation_id,
            ownerId: input.ownerId,
            machineId: candidate.machine_id,
            bridgeSessionId: candidate.bridge_session_id,
            harness: candidate.harness,
            surface: candidate.surface,
            sessionId: candidate.session_id,
            turnId: candidate.turn_id,
            answer: candidate.answer,
            state,
            claimedAt: input.now,
            finishedAt: supported ? null : input.now,
            errorCode: supported ? null : "late-resume-unsupported",
            errorMessage: supported
              ? null
              : `late resume is unsupported for ${candidate.harness}/${candidate.surface}`,
          }).changes;
        if (inserted !== 1) {
          continue;
        }
        if (!supported) {
          return {
            outcome: "unsupported",
            correlationId: candidate.correlation_id,
            harness: candidate.harness,
            surface: candidate.surface,
            sessionId: candidate.session_id,
          };
        }
        const command = this.getResumeCommand(candidate.correlation_id);
        if (command === undefined) {
          throw new Error(
            `claimed resume command ${candidate.correlation_id} disappeared`,
          );
        }
        return { outcome: "claimed", command };
      }
      return { outcome: "none" };
    })();
  }

  public markResumeStarted(
    correlationId: string,
    ownerId: string,
    now: string,
  ): ResumeCommandRecord {
    const changes = this.database
      .prepare(
        `
        UPDATE resume_commands SET
          state = 'running',
          started_at = ?
        WHERE correlation_id = ?
          AND owner_id = ?
          AND state = 'claimed'
      `,
      )
      .run(now, correlationId, ownerId).changes;
    if (changes !== 1) {
      throw new Error(
        `resume command ${correlationId} is not claimable by ${ownerId}`,
      );
    }
    const command = this.getResumeCommand(correlationId);
    if (command === undefined) {
      throw new Error(`resume command ${correlationId} disappeared`);
    }
    return command;
  }

  public markResumeFinished(input: {
    correlationId: string;
    ownerId: string;
    succeeded: boolean;
    now: string;
    exitCode?: number;
    signal?: string;
    errorCode?: string;
    errorMessage?: string;
  }): ResumeCommandRecord {
    const changes = this.database
      .prepare(
        `
        UPDATE resume_commands SET
          state = @state,
          finished_at = @now,
          exit_code = @exitCode,
          signal = @signal,
          error_code = @errorCode,
          error_message = @errorMessage
        WHERE correlation_id = @correlationId
          AND owner_id = @ownerId
          AND state = 'running'
      `,
      )
      .run({
        ...input,
        state: input.succeeded ? "succeeded" : "failed",
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
      }).changes;
    if (changes !== 1) {
      throw new Error(
        `resume command ${input.correlationId} is not running for ${input.ownerId}`,
      );
    }
    const command = this.getResumeCommand(input.correlationId);
    if (command === undefined) {
      throw new Error(`resume command ${input.correlationId} disappeared`);
    }
    return command;
  }

  public claimTelegramUpdate(updateId: number, receivedAt: string): boolean {
    return (
      this.database
        .prepare(
          `
          INSERT OR IGNORE INTO telegram_updates (
            update_id, received_at, outcome
          ) VALUES (?, ?, 'claimed')
        `,
        )
        .run(updateId, receivedAt).changes === 1
    );
  }

  public completeTelegramUpdate(updateId: number, outcome: string): void {
    this.database
      .prepare(
        `
        UPDATE telegram_updates SET outcome = ?
        WHERE update_id = ?
      `,
      )
      .run(outcome.slice(0, 120), updateId);
  }

  public recordDiagnostic(
    diagnosticInput: RelayDiagnosticV1,
  ): DiagnosticIngestResult {
    const diagnostic = RelayDiagnosticV1Schema.parse(diagnosticInput);
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO diagnostics (
          diagnostic_id, recorded_at, source, level, code, message, created_at
        ) VALUES (
          @diagnosticId, @recordedAt, @source, @level, @code, @message,
          @recordedAt
        )
      `,
      )
      .run(diagnostic);
    if (result.changes === 0) {
      const existing = this.database
        .prepare(
          `
          SELECT recorded_at, source, level, code, message
          FROM diagnostics WHERE diagnostic_id = ?
        `,
        )
        .get(diagnostic.diagnosticId) as
        | {
            recorded_at: string;
            source: string;
            level: string;
            code: string;
            message: string;
          }
        | undefined;
      if (
        existing === undefined ||
        existing.recorded_at !== diagnostic.recordedAt ||
        existing.source !== diagnostic.source ||
        existing.level !== diagnostic.level ||
        existing.code !== diagnostic.code ||
        existing.message !== diagnostic.message
      ) {
        throw new Error(
          `diagnostic id collision: ${diagnostic.diagnosticId} has a different payload`,
        );
      }
    }
    return {
      diagnosticId: diagnostic.diagnosticId,
      inserted: result.changes === 1,
    };
  }

  public listDiagnostics(limit = 100): RelayDiagnosticV1[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("diagnostic limit must be between 1 and 500");
    }
    const rows = this.database
      .prepare(
        `
        SELECT diagnostic_id, recorded_at, source, level, code, message
        FROM diagnostics
        ORDER BY recorded_at DESC, diagnostic_id DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<{
      diagnostic_id: string;
      recorded_at: string;
      source: RelayDiagnosticV1["source"];
      level: RelayDiagnosticV1["level"];
      code: string;
      message: string;
    }>;
    return rows.map((row) => ({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: row.diagnostic_id,
      recordedAt: row.recorded_at,
      source: row.source,
      level: row.level,
      code: row.code,
      message: row.message,
    }));
  }

  public pruneRetention(cutoffs: RetentionCutoffs): RetentionResult {
    for (const [name, value] of Object.entries(cutoffs)) {
      if (name !== "limit") {
        assertIsoCutoff(String(value), name);
      }
    }
    const limit = cutoffs.limit ?? 5_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
      throw new Error("retention limit must be between 1 and 50000");
    }

    return this.database.transaction((): RetentionResult => {
      const result: RetentionResult = {
        requestsExpired: 0,
        pendingRequests: 0,
        resumeCommands: 0,
        events: 0,
        deliveryAttempts: 0,
        diagnostics: 0,
        telegramUpdates: 0,
        sessions: 0,
      };
      const requestRows = this.database
        .prepare(
          `
          SELECT pending.correlation_id
          FROM pending_requests AS pending
          WHERE COALESCE(pending.resolved_at, pending.expires_at) < ?
            AND (
              pending.state IN ('expired', 'cancelled', 'failed')
              OR (
                pending.state = 'answered'
                AND NOT EXISTS (
                  SELECT 1 FROM resume_commands AS command
                  WHERE command.correlation_id = pending.correlation_id
                    AND command.state IN ('claimed', 'running')
                )
              )
            )
          ORDER BY COALESCE(pending.resolved_at, pending.expires_at),
            pending.correlation_id
          LIMIT ?
        `,
        )
        .all(cutoffs.requestBefore, limit) as Array<{
        correlation_id: string;
      }>;
      const deleteResume = this.database.prepare(
        "DELETE FROM resume_commands WHERE correlation_id = ?",
      );
      const deleteOptions = this.database.prepare(
        "DELETE FROM pending_options WHERE correlation_id = ?",
      );
      const deleteRequest = this.database.prepare(
        "DELETE FROM pending_requests WHERE correlation_id = ?",
      );
      for (const row of requestRows) {
        result.resumeCommands += deleteResume.run(row.correlation_id).changes;
        deleteOptions.run(row.correlation_id);
        result.pendingRequests += deleteRequest.run(row.correlation_id).changes;
      }

      const eventRows = this.database
        .prepare(
          `
          SELECT events.event_id
          FROM events
          WHERE (
              (
                events.status = 'delivered'
                AND events.delivered_at IS NOT NULL
                AND events.delivered_at < @deliveredBefore
              )
              OR (
                events.status = 'dead_letter'
                AND events.created_at < @deadLetterBefore
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM pending_requests AS pending
              WHERE pending.event_id = events.event_id
            )
          ORDER BY events.created_at, events.event_id
          LIMIT @limit
        `,
        )
        .all({
          deliveredBefore: cutoffs.deliveredBefore,
          deadLetterBefore: cutoffs.deadLetterBefore,
          limit,
        }) as Array<{ event_id: string }>;
      const deleteAttempts = this.database.prepare(
        "DELETE FROM delivery_attempts WHERE event_id = ?",
      );
      const deleteEvent = this.database.prepare(
        `
        DELETE FROM events
        WHERE event_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM pending_requests
            WHERE pending_requests.event_id = events.event_id
          )
      `,
      );
      for (const row of eventRows) {
        result.deliveryAttempts += deleteAttempts.run(row.event_id).changes;
        result.events += deleteEvent.run(row.event_id).changes;
      }

      result.diagnostics = this.database
        .prepare(
          `
          DELETE FROM diagnostics
          WHERE diagnostic_id IN (
            SELECT diagnostic_id FROM diagnostics
            WHERE recorded_at < ?
            ORDER BY recorded_at, diagnostic_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.diagnosticBefore, limit).changes;
      result.telegramUpdates = this.database
        .prepare(
          `
          DELETE FROM telegram_updates
          WHERE update_id IN (
            SELECT update_id FROM telegram_updates
            WHERE received_at < ?
            ORDER BY received_at, update_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.telegramUpdateBefore, limit).changes;
      result.sessions = this.database
        .prepare(
          `
          DELETE FROM sessions
          WHERE rowid IN (
            SELECT sessions.rowid FROM sessions
            WHERE sessions.last_seen_at < ?
              AND sessions.state IN ('stopped', 'suspected_stalled', 'exited')
              AND NOT EXISTS (
                SELECT 1 FROM events
                WHERE events.machine_id = sessions.machine_id
                  AND events.harness = sessions.harness
                  AND events.session_id = sessions.session_id
              )
            ORDER BY sessions.last_seen_at, sessions.rowid
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.sessionBefore, limit).changes;
      return result;
    })();
  }

  public listSessions(): SessionRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT
          machine_id, bridge_session_id, harness, surface, harness_version,
          session_id, state, last_seen_at, last_sequence
        FROM sessions
        ORDER BY last_seen_at DESC, machine_id, harness, session_id
      `,
      )
      .all() as SessionRow[];
    return rows.map((row) => ({
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: row.harness,
      surface: row.surface,
      harnessVersion: row.harness_version,
      sessionId: row.session_id,
      state: row.state,
      lastSeenAt: row.last_seen_at,
      lastSequence: row.last_sequence,
    }));
  }

  public listSessionsByBridge(input: {
    machineId: string;
    bridgeSessionId: string;
    harness: Harness;
  }): SessionRecord[] {
    return this.listSessions().filter(
      (session) =>
        session.machineId === input.machineId &&
        session.bridgeSessionId === input.bridgeSessionId &&
        session.harness === input.harness,
    );
  }

  public status(): StoreStatus {
    const eventCounts = this.database
      .prepare(
        `
        SELECT status AS key, COUNT(*) AS count
        FROM events GROUP BY status
      `,
      )
      .all() as CountRow[];
    const sessionCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM sessions GROUP BY state
      `,
      )
      .all() as CountRow[];
    const topicCounts = this.database
      .prepare(
        `
        SELECT provisioning_status AS key, COUNT(*) AS count
        FROM session_topics GROUP BY provisioning_status
      `,
      )
      .all() as CountRow[];
    const resumeCommandCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM resume_commands GROUP BY state
      `,
      )
      .all() as CountRow[];
    const diagnosticCounts = this.database
      .prepare(
        `
        SELECT level AS key, COUNT(*) AS count
        FROM diagnostics GROUP BY level
      `,
      )
      .all() as CountRow[];
    const events: StoreStatus["events"] = {
      queued: 0,
      retry: 0,
      delivering: 0,
      delivered: 0,
      dead_letter: 0,
    };
    const sessions: StoreStatus["sessions"] = {
      active: 0,
      waiting: 0,
      stopped: 0,
      suspected_stalled: 0,
      exited: 0,
    };
    const topics: StoreStatus["topics"] = {
      pending: 0,
      creating: 0,
      ready: 0,
      retry: 0,
      failed: 0,
    };
    const resumeCommands: StoreStatus["resumeCommands"] = {
      claimed: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      unsupported: 0,
    };
    const diagnostics: StoreStatus["diagnostics"] = {
      info: 0,
      warn: 0,
      error: 0,
      total: 0,
    };
    for (const row of eventCounts) {
      if (row.key in events) {
        events[row.key as DeliveryStatus] = row.count;
      }
    }
    for (const row of sessionCounts) {
      if (row.key in sessions) {
        sessions[row.key as SessionRecord["state"]] = row.count;
      }
    }
    for (const row of topicCounts) {
      if (row.key in topics) {
        topics[row.key as TopicProvisioningStatus] = row.count;
      }
    }
    for (const row of resumeCommandCounts) {
      if (row.key in resumeCommands) {
        resumeCommands[row.key as ResumeCommandState] = row.count;
      }
    }
    for (const row of diagnosticCounts) {
      if (row.key === "info" || row.key === "warn" || row.key === "error") {
        diagnostics[row.key] = row.count;
        diagnostics.total += row.count;
      }
    }
    return {
      events,
      sessions,
      topics,
      resumeCommands,
      diagnostics,
      pendingDeliveryCount: events.queued + events.retry + events.delivering,
    };
  }
}
