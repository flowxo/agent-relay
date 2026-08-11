import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { RELAY_STORE_SCHEMA_VERSION, RelayStore } from "./store.js";

function schemaVersion(database: Database.Database): number {
  return database.pragma("user_version", { simple: true }) as number;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("SQLite schema compatibility", () => {
  it("upgrades an unversioned prior store without losing retained data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();

    const prior = new Database(databasePath);
    prior.exec(
      "CREATE TABLE retained_fixture (value TEXT NOT NULL); INSERT INTO retained_fixture VALUES ('preserved-answer');",
    );
    prior.pragma("user_version = 0");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded.prepare("SELECT value FROM retained_fixture").pluck().get(),
    ).toBe("preserved-answer");
    upgraded.close();
  });

  it("migrates a version-one store to every durable hosted-work table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();
    const prior = new Database(databasePath);
    prior.exec(`
      DROP TABLE hosted_message_updates;
      DROP TABLE hosted_event_acknowledgements;
      DROP TABLE hosted_event_claims;
      DROP TABLE hosted_poll_state;
      DROP TABLE hosted_delivery_mappings;
    `);
    prior.pragma("user_version = 1");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'hosted_%'
          ORDER BY name
        `,
        )
        .pluck()
        .all(),
    ).toEqual([
      "hosted_delivery_mappings",
      "hosted_event_acknowledgements",
      "hosted_event_claims",
      "hosted_message_updates",
      "hosted_poll_state",
    ]);
    upgraded.close();
  });

  it("migrates a version-three store to the durable topic cleanup table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();
    const prior = new Database(databasePath);
    prior.exec("DROP TABLE topic_cleanup_operations");
    prior.pragma("user_version = 3");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'topic_cleanup_operations'
        `,
        )
        .pluck()
        .get(),
    ).toBe("topic_cleanup_operations");
    upgraded.close();
  });

  it("migrates a version-four store to durable native hook ordering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();
    const prior = new Database(databasePath);
    prior.exec(`
      DROP TABLE native_hook_sequence_allocations;
      DROP TABLE native_hook_sequence_counters;
    `);
    prior.pragma("user_version = 4");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'native_hook_sequence_%'
          ORDER BY name
        `,
        )
        .pluck()
        .all(),
    ).toEqual([
      "native_hook_sequence_allocations",
      "native_hook_sequence_counters",
    ]);
    upgraded.close();
  });

  it("migrates a version-five cleanup operation to explicit selection semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();
    const prior = new Database(databasePath);
    prior
      .prepare(
        `
        INSERT INTO topic_cleanup_operations (
          operation_id, transport_name, transport_scope, selection_mode,
          inactive_before, state, eligible_count, candidates_json, created_at,
          expires_at, finished_at, updated_at
        ) VALUES (?, ?, ?, 'proven-dead', NULL, 'completed', 0, '[]', ?, ?, ?, ?)
      `,
      )
      .run(
        "cleanup_0123456789abcdef0123456789abcdef",
        "fake-telegram",
        "fake:private-chat",
        "2026-07-28T12:00:00.000Z",
        "2026-07-28T12:10:00.000Z",
        "2026-07-28T12:00:00.000Z",
        "2026-07-28T12:00:00.000Z",
      );
    prior.exec(`
      ALTER TABLE topic_cleanup_operations DROP COLUMN inactive_before;
      ALTER TABLE topic_cleanup_operations DROP COLUMN selection_mode;
    `);
    prior.pragma("user_version = 5");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare("PRAGMA table_info(topic_cleanup_operations)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(expect.arrayContaining(["selection_mode", "inactive_before"]));
    expect(
      upgraded
        .prepare(
          `
          SELECT selection_mode, inactive_before
          FROM topic_cleanup_operations
          WHERE operation_id = ?
        `,
        )
        .get("cleanup_0123456789abcdef0123456789abcdef"),
    ).toEqual({
      selection_mode: "proven-dead",
      inactive_before: null,
    });
    upgraded.close();
  });

  it("renames the retained hosted transport identity to whooshbang once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();

    const prior = new Database(databasePath);
    prior
      .prepare(
        `
        INSERT INTO topic_cleanup_operations (
          operation_id, transport_name, transport_scope, selection_mode,
          inactive_before, state, eligible_count, candidates_json, created_at,
          expires_at, finished_at, updated_at
        ) VALUES (?, 'notifications', 'hosted:stream', 'proven-dead', NULL,
          'completed', 0, '[]', ?, ?, ?, ?)
      `,
      )
      .run(
        "cleanup_fedcba9876543210fedcba9876543210",
        "2026-07-29T12:00:00.000Z",
        "2026-07-29T12:10:00.000Z",
        "2026-07-29T12:00:00.000Z",
        "2026-07-29T12:00:00.000Z",
      );
    prior.pragma("user_version = 6");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          "SELECT transport_name FROM topic_cleanup_operations WHERE operation_id = ?",
        )
        .pluck()
        .get("cleanup_fedcba9876543210fedcba9876543210"),
    ).toBe("whooshbang");
    for (const [table, column] of [
      ["session_topics", "transport_name"],
      ["events", "transport_name"],
      ["topic_cleanup_operations", "transport_name"],
      ["notification_groups", "transport_name"],
      ["hosted_delivery_mappings", "transport_name"],
      ["pending_requests", "resolved_by"],
    ]) {
      expect(
        upgraded
          .prepare(
            `SELECT COUNT(*) FROM ${String(table)} WHERE ${String(column)} = 'notifications'`,
          )
          .pluck()
          .get(),
      ).toBe(0);
    }
    upgraded.close();

    // Reopening an already-migrated database leaves the renamed value alone.
    new RelayStore(databasePath).close();
    const reopened = new Database(databasePath, { readonly: true });
    expect(schemaVersion(reopened)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      reopened
        .prepare(
          "SELECT transport_name FROM topic_cleanup_operations WHERE operation_id = ?",
        )
        .pluck()
        .get("cleanup_fedcba9876543210fedcba9876543210"),
    ).toBe("whooshbang");
    reopened.close();
  });

  it("migrates version-seven topics to durable display-title state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();

    const prior = new Database(databasePath);
    prior.exec(`
      DROP INDEX session_topics_title_status_idx;
      ALTER TABLE session_topics DROP COLUMN title_last_error_message;
      ALTER TABLE session_topics DROP COLUMN title_last_error_code;
      ALTER TABLE session_topics DROP COLUMN title_lease_started_at;
      ALTER TABLE session_topics DROP COLUMN title_next_attempt_at;
      ALTER TABLE session_topics DROP COLUMN title_attempt_count;
      ALTER TABLE session_topics DROP COLUMN title_update_status;
      ALTER TABLE session_topics DROP COLUMN desired_topic_name;
      ALTER TABLE session_topics DROP COLUMN display_topic_name;

      INSERT INTO sessions (
        machine_id, harness, session_id, bridge_session_id, surface,
        harness_version, project_json, capabilities_json, state,
        last_event_type, last_seen_at, last_sequence, updated_at
      ) VALUES (
        'machine_schema_topic_12345678', 'codex',
        'session_schema_topic_12345678', 'bridge_schema_topic_12345678',
        'cli', 'test',
        '{"displayName":"example","cwdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        '{}', 'waiting', 'turn.stopped', '2026-07-29T12:00:00.000Z', 2,
        '2026-07-29T12:00:00.000Z'
      );

      INSERT INTO session_topics (
        machine_id, harness, session_id, transport_name, transport_scope,
        provider, repository, branch, short_session_id, lifecycle_state,
        topic_name, topic_id, provisioning_status, next_attempt_at,
        created_at, updated_at
      ) VALUES (
        'machine_schema_topic_12345678', 'codex',
        'session_schema_topic_12345678', 'telegram', 'chat:synthetic',
        'codex', 'example', 'main', '12345678-a1b2c3', 'waiting',
        'Codex · example · main · 12345678-a1b2c3', '77', 'ready',
        '2026-07-29T12:00:00.000Z', '2026-07-29T12:00:00.000Z',
        '2026-07-29T12:00:00.000Z'
      );
    `);
    prior.pragma("user_version = 7");
    prior.close();

    new RelayStore(databasePath).close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          `
          SELECT
            display_topic_name, desired_topic_name, title_update_status,
            title_attempt_count, title_next_attempt_at
          FROM session_topics
        `,
        )
        .get(),
    ).toEqual({
      display_topic_name: "Codex · example · main · 12345678-a1b2c3",
      desired_topic_name: "Codex · example · main · 12345678-a1b2c3",
      title_update_status: "ready",
      title_attempt_count: 0,
      title_next_attempt_at: "2026-07-29T12:00:00.000Z",
    });
    upgraded.close();
  });

  it("migrates version-eight event activity without losing the retained baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();

    const prior = new Database(databasePath);
    prior.exec(`
      DROP TRIGGER event_activity_insert;
      DROP TRIGGER event_activity_delete;
      DROP TABLE event_activity_counters;

      INSERT INTO sessions (
        machine_id, harness, session_id, bridge_session_id, surface,
        harness_version, project_json, capabilities_json, state,
        last_seen_at, last_sequence, updated_at
      ) VALUES (
        'machine_schema_activity_12345678', 'codex',
        'session_schema_activity_12345678',
        'bridge_schema_activity_12345678', 'cli', 'test',
        '{"displayName":"example","cwdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        '{}', 'waiting', '2026-07-29T12:00:00.000Z', 1,
        '2026-07-29T12:00:00.000Z'
      );

      INSERT INTO events (
        event_id, machine_id, harness, session_id, type, payload_json,
        status, next_attempt_at, created_at
      ) VALUES (
        'event_schema_activity_12345678',
        'machine_schema_activity_12345678', 'codex',
        'session_schema_activity_12345678', 'turn.stopped', '{}',
        'delivered', '2026-07-29T12:00:00.000Z',
        '2026-07-29T12:00:00.000Z'
      );
    `);
    prior.pragma("user_version = 8");
    prior.close();

    const upgradedStore = new RelayStore(databasePath);
    expect(upgradedStore.status().eventActivity).toEqual({
      inserted: 1,
      deleted: 0,
    });
    upgradedStore.close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(schemaVersion(upgraded)).toBe(RELAY_STORE_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare(
          "SELECT inserted_count, deleted_count FROM event_activity_counters",
        )
        .get(),
    ).toEqual({ inserted_count: 1, deleted_count: 0 });
    upgraded.close();
  });

  it("refuses to open a newer schema and leaves it untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-schema-"));
    const databasePath = join(directory, "relay.sqlite");
    new RelayStore(databasePath).close();

    const future = new Database(databasePath);
    future.exec(
      "CREATE TABLE future_fixture (value TEXT NOT NULL); INSERT INTO future_fixture VALUES ('future-data');",
    );
    future.pragma(`user_version = ${String(RELAY_STORE_SCHEMA_VERSION + 1)}`);
    future.close();
    const before = await digest(databasePath);

    expect(() => new RelayStore(databasePath)).toThrow(
      `SQLite schema version ${String(RELAY_STORE_SCHEMA_VERSION + 1)} is newer than supported version ${String(RELAY_STORE_SCHEMA_VERSION)}; refusing unsafe downgrade`,
    );
    expect(await digest(databasePath)).toBe(before);

    const unchanged = new Database(databasePath, { readonly: true });
    expect(schemaVersion(unchanged)).toBe(RELAY_STORE_SCHEMA_VERSION + 1);
    expect(
      unchanged.prepare("SELECT value FROM future_fixture").pluck().get(),
    ).toBe("future-data");
    unchanged.close();
  });
});
