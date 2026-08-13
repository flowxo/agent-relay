import {
  SESSION_ACTIVITY_FIXTURE_SET_VERSION,
  SESSION_ACTIVITY_POLICY_VERSION,
} from "./activity.js";

export const SESSION_ACTIVITY_SCHEMA_UP_SQL = `
  CREATE TABLE IF NOT EXISTS activity_identity_secrets (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret BLOB NOT NULL CHECK (length(secret) = 32),
    created_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO activity_identity_secrets (id, secret, created_at)
  VALUES (1, randomblob(32), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  CREATE TABLE IF NOT EXISTS session_activity (
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    foreground TEXT NOT NULL
      CHECK (foreground IN ('not_started', 'working', 'stopped')),
    ended INTEGER NOT NULL CHECK (ended IN (0, 1)),
    evidence_gap INTEGER NOT NULL CHECK (evidence_gap IN (0, 1)),
    failure_reason TEXT
      CHECK (failure_reason IN ('turn_failed', 'owned_process_failed')),
    last_observed_at TEXT NOT NULL,
    idle_since TEXT,
    last_source TEXT NOT NULL CHECK (
      last_source IN (
        'codex_cli', 'claude_cli', 'cursor_cli', 'codex_app_server',
        'relay_interaction', 'owned_process', 'operator', 'recovery'
      )
    ),
    background_snapshot_count INTEGER NOT NULL
      CHECK (background_snapshot_count BETWEEN 0 AND 1000),
    state TEXT NOT NULL CHECK (
      state IN (
        'working', 'needs_input', 'background_work', 'idle',
        'done', 'failed', 'unknown', 'ended'
      )
    ),
    confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'inferred')),
    reason TEXT NOT NULL CHECK (
      reason IN (
        'session_observed', 'foreground_recent', 'work_open', 'request_open',
        'foreground_stopped', 'background_work_open', 'idle_grace_elapsed',
        'terminal_missing', 'foreground_work_stale', 'background_work_stale',
        'evidence_gap', 'turn_failed', 'owned_process_failed', 'session_ended'
      )
    ),
    in_flight_count INTEGER NOT NULL CHECK (in_flight_count BETWEEN 0 AND 1000),
    request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1000),
    last_applied_sequence INTEGER NOT NULL CHECK (last_applied_sequence >= 0),
    policy_version TEXT NOT NULL,
    fixture_set_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (machine_id, harness, session_id),
    FOREIGN KEY (machine_id, harness, session_id)
      REFERENCES sessions(machine_id, harness, session_id) ON DELETE CASCADE
  );

  CREATE TRIGGER IF NOT EXISTS session_activity_sessions_insert
  AFTER INSERT ON sessions
  BEGIN
    INSERT OR IGNORE INTO session_activity (
      machine_id, harness, session_id, epoch, foreground, ended,
      evidence_gap, failure_reason, last_observed_at, idle_since,
      last_source, background_snapshot_count, state, confidence, reason,
      in_flight_count, request_count, last_applied_sequence,
      policy_version, fixture_set_version, created_at, updated_at
    ) VALUES (
      NEW.machine_id, NEW.harness, NEW.session_id, 0, 'not_started', 0, 0,
      NULL, NEW.last_seen_at, NULL, 'recovery', 0, 'idle', 'confirmed',
      'session_observed', 0, 0, 0, '${SESSION_ACTIVITY_POLICY_VERSION}',
      '${SESSION_ACTIVITY_FIXTURE_SET_VERSION}', NEW.last_seen_at,
      NEW.updated_at
    );
  END;

  CREATE TABLE IF NOT EXISTS session_activity_correlations (
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    correlation_kind TEXT NOT NULL CHECK (correlation_kind IN ('work', 'request')),
    correlation_digest TEXT NOT NULL CHECK (length(correlation_digest) = 64),
    correlation_state TEXT NOT NULL CHECK (
      correlation_state IN (
        'open', 'finished', 'failed', 'resolved',
        'unmatched_finished', 'unmatched_failed', 'unmatched_resolved'
      )
    ),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (
      machine_id, harness, session_id, correlation_kind, correlation_digest
    ),
    FOREIGN KEY (machine_id, harness, session_id)
      REFERENCES session_activity(machine_id, harness, session_id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_activity_events (
    safe_identity TEXT PRIMARY KEY CHECK (length(safe_identity) = 64),
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    receive_sequence INTEGER NOT NULL CHECK (receive_sequence > 0),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'session_observed', 'prompt_submitted', 'activity_observed',
        'work_started', 'work_finished', 'work_failed', 'background_snapshot',
        'request_opened', 'request_resolved', 'foreground_stopped',
        'turn_failed', 'session_ended', 'owned_process_failed', 'evidence_gap'
      )
    ),
    source TEXT NOT NULL CHECK (
      source IN (
        'codex_cli', 'claude_cli', 'cursor_cli', 'codex_app_server',
        'relay_interaction', 'owned_process', 'operator', 'recovery'
      )
    ),
    observed_at TEXT NOT NULL,
    UNIQUE (machine_id, harness, session_id, receive_sequence),
    FOREIGN KEY (machine_id, harness, session_id)
      REFERENCES session_activity(machine_id, harness, session_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS session_activity_state_idx
    ON session_activity(state, last_observed_at);
`;

/** Test/rollback proof only. Production remains forward-only. */
export const SESSION_ACTIVITY_SCHEMA_DOWN_SQL = `
  DROP INDEX IF EXISTS session_activity_state_idx;
  DROP TRIGGER IF EXISTS session_activity_sessions_insert;
  DROP TABLE IF EXISTS session_activity_events;
  DROP TABLE IF EXISTS session_activity_correlations;
  DROP TABLE IF EXISTS session_activity;
  DROP TABLE IF EXISTS activity_identity_secrets;
`;
