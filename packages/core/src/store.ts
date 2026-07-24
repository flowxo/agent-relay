import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  AgentAttentionEventV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
} from "@agent-relay/protocol";
import type {
  AgentAttentionEventV1,
  Harness,
  SessionHeartbeatV1,
  SessionRegistrationV1,
  Surface,
} from "@agent-relay/protocol";

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

export interface StoreStatus {
  events: Record<DeliveryStatus, number>;
  sessions: Record<SessionRecord["state"], number>;
  resumeCommands: Record<ResumeCommandState, number>;
  pendingDeliveryCount: number;
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
    const resumeCommandCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM resume_commands GROUP BY state
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
    const resumeCommands: StoreStatus["resumeCommands"] = {
      claimed: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      unsupported: 0,
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
    for (const row of resumeCommandCounts) {
      if (row.key in resumeCommands) {
        resumeCommands[row.key as ResumeCommandState] = row.count;
      }
    }
    return {
      events,
      sessions,
      resumeCommands,
      pendingDeliveryCount: events.queued + events.retry + events.delivering,
    };
  }
}
