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
