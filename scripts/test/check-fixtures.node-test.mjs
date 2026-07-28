import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertManifestMetadata,
  collectJsonFiles,
  fixtureInventory,
  readFixtureJson,
} from "../check-fixtures.mjs";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-fixtures-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads a bounded synthetic JSON fixture", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "valid.json");
    await writeFile(
      path,
      `${JSON.stringify({ session_id: "session_fixture_0001", cwd: "/workspace/example" })}\n`,
    );

    await assert.doesNotReject(readFixtureJson(path, { baseRoot: directory }));
  });
});

test("rejects malformed fixture JSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "malformed.json");
    await writeFile(path, '{"incomplete":');

    await assert.rejects(
      readFixtureJson(path, { baseRoot: directory }),
      /is not valid JSON/,
    );
  });
});

test("rejects oversized fixtures at the configured bound", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "oversized.json");
    await writeFile(path, `${JSON.stringify({ value: "x".repeat(128) })}\n`);

    await assert.rejects(
      readFixtureJson(path, { baseRoot: directory, maxBytes: 64 }),
      /maximum is 64/,
    );
  });
});

test("rejects symlinked fixtures", async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, "target.json");
    const link = join(directory, "linked.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);

    await assert.rejects(
      readFixtureJson(link, { baseRoot: directory }),
      /must not be a symlink/,
    );
  });
});

test("rejects unmanifestable non-JSON files in a fixture root", async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "raw-payload.txt"), "private payload");

    await assert.rejects(collectJsonFiles(directory), /is not a JSON fixture/);
  });
});

test("rejects machine-specific user paths and populated sensitive keys", async () => {
  await withTemporaryDirectory(async (directory) => {
    const pathFixture = join(directory, "private-path.json");
    const privatePath = ["", "Users", "private-person", "project"].join("/");
    await writeFile(pathFixture, `${JSON.stringify({ cwd: privatePath })}\n`);
    await assert.rejects(
      readFixtureJson(pathFixture, { baseRoot: directory }),
      /macOS user path/,
    );

    const secretFixture = join(directory, "secret.json");
    await writeFile(
      secretFixture,
      `${JSON.stringify({ api_key: ["synthetic", "value"].join("-") })}\n`,
    );
    await assert.rejects(
      readFixtureJson(secretFixture, { baseRoot: directory }),
      /populated sensitive key/,
    );
  });
});

test("rejects duplicate inventory entries and incomplete provenance", () => {
  assert.throws(
    () =>
      fixtureInventory(
        { fixtures: ["valid.json", "valid.json"] },
        "fixtures/manifest.json",
      ),
    /duplicate fixture entry/,
  );

  assert.throws(
    () =>
      assertManifestMetadata(
        {
          recordedAt: "2026-07-26",
          source: "synthetic contract",
          contractVersion: "1",
          evidence: "synthetic",
        },
        "fixtures/manifest.json",
      ),
    /privacy and sanitization/,
  );
});
