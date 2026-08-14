export const PROJECT_READ_SCHEMA_UP_SQL = `
  CREATE TABLE IF NOT EXISTS project_identities (
    project_cwd_hash TEXT PRIMARY KEY
      CHECK (substr(project_cwd_hash, 1, 7) = 'sha256:'
        AND substr(project_cwd_hash, 8) NOT GLOB '*[^a-f0-9]*'
        AND length(project_cwd_hash) = 71),
    project_key TEXT NOT NULL UNIQUE
      CHECK (substr(project_key, 1, 4) = 'prj_'
        AND substr(project_key, 5) NOT GLOB '*[^a-f0-9]*'
        AND length(project_key) = 52),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_project_recent_idx
    ON sessions(
      json_extract(project_json, '$.cwdHash'),
      last_seen_at DESC,
      machine_id,
      harness,
      session_id
    );

  CREATE INDEX IF NOT EXISTS sessions_recent_idx
    ON sessions(last_seen_at DESC, machine_id, harness, session_id);

  CREATE TRIGGER IF NOT EXISTS project_read_activity_insert
  AFTER INSERT ON session_activity
  BEGIN
    INSERT INTO web_changes (
      kind, action, entity_id, session_id, occurred_at, payload_json
    ) VALUES (
      'session', 'insert',
      NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
      NEW.session_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      json_object(
        'projectReadActivity', 1,
        'state', NEW.state,
        'confidence', NEW.confidence,
        'reason', NEW.reason,
        'lastObservedAt', NEW.last_observed_at,
        'inFlightCount', NEW.in_flight_count,
        'requestCount', NEW.request_count
      )
    );
  END;

  CREATE TRIGGER IF NOT EXISTS project_read_activity_update
  AFTER UPDATE ON session_activity
  BEGIN
    INSERT INTO web_changes (
      kind, action, entity_id, session_id, occurred_at, payload_json
    ) VALUES (
      'session', 'update',
      NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
      NEW.session_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      json_object(
        'projectReadActivity', 1,
        'state', NEW.state,
        'confidence', NEW.confidence,
        'reason', NEW.reason,
        'lastObservedAt', NEW.last_observed_at,
        'inFlightCount', NEW.in_flight_count,
        'requestCount', NEW.request_count
      )
    );
  END;

  CREATE TRIGGER IF NOT EXISTS project_read_activity_delete
  AFTER DELETE ON session_activity
  BEGIN
    INSERT INTO web_changes (
      kind, action, entity_id, session_id, occurred_at, payload_json
    ) VALUES (
      'session', 'delete',
      OLD.machine_id || ':' || OLD.harness || ':' || OLD.session_id,
      OLD.session_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      json_object('projectReadActivity', 1, 'state', OLD.state)
    );
  END;
`;

/** Test/rollback proof only. Production remains forward-only. */
export const PROJECT_READ_SCHEMA_DOWN_SQL = `
  DROP TRIGGER IF EXISTS project_read_activity_delete;
  DROP TRIGGER IF EXISTS project_read_activity_update;
  DROP TRIGGER IF EXISTS project_read_activity_insert;
  DROP INDEX IF EXISTS sessions_recent_idx;
  DROP INDEX IF EXISTS sessions_project_recent_idx;
  DROP TABLE IF EXISTS project_identities;
`;
