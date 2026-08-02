import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { URL } from "node:url";

import { EXACT_SEMVER, validateContractLock } from "../lib/contract-lock.mjs";
import { compileContractLockSchema } from "../lib/json-schema.mjs";
import {
  CANONICAL_POLICY_SHA256,
  CANONICAL_SCHEMA_SHA256,
  loadWhooshBangContractLock,
  WHOOSHBANG_BASE_SOURCE_COMMIT,
  WHOOSHBANG_MOCK_SOURCE_COMMIT,
} from "../lib/whooshbang-preflight.mjs";

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const schema = JSON.parse(
  await readFile(
    new URL("../contract-lock.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = compileContractLockSchema(schema);

function artifactPin(overrides = {}) {
  return {
    owner: "whooshbang",
    artifact: "@whooshbang/contracts",
    version: "1.0.0-draft.1",
    source_repository: "flowxo/whooshbang",
    source_commit: commit,
    sha256: digest,
    artifact_file:
      "vendor/whooshbang-rc5/whooshbang-contracts-1.0.0-draft.1.tgz",
    fixture_sets: [
      {
        id: "core-api-bodies",
        version: "1.0.0-draft.1",
      },
    ],
    ...overrides,
  };
}

function validLock() {
  return {
    schema: "flowxo.contract-lock.v1",
    schema_sha256: digest,
    policy_sha256: digest,
    repository: "flowxo/agent-relay",
    dependencies: [artifactPin()],
    owned_artifacts: [],
  };
}

function assertAccepted(lock, name) {
  assert.equal(
    validateSchema(lock),
    true,
    `${name}: schema ${JSON.stringify(validateSchema.errors)}`,
  );
  assert.deepEqual(validateContractLock(lock), [], `${name}: semantic`);
}

function assertRejected(lock, name) {
  assert.equal(validateSchema(lock), false, `${name}: schema`);
  assert.notEqual(
    validateContractLock(lock).length,
    0,
    `${name}: semantic validator`,
  );
}

describe("exact SemVer locks", () => {
  it("accepts stable and prerelease versions", () => {
    for (const version of ["1.0.0", "1.0.0-draft.1", "1.0.0-rc.1+build.9"]) {
      assert.equal(EXACT_SEMVER.test(version), true, version);
      assertAccepted(
        {
          ...validLock(),
          dependencies: [artifactPin({ version })],
        },
        version,
      );
    }
  });

  it("rejects mutable ranges, tags, branches, and malformed versions", () => {
    for (const version of [
      "^1.0.0",
      "~1.0.0",
      ">=1.0.0",
      "latest",
      "main",
      "v1.0.0",
      "1.0",
      "01.0.0",
      "1.0.0-01",
    ]) {
      assert.equal(EXACT_SEMVER.test(version), false, version);
      assertRejected(
        {
          ...validLock(),
          dependencies: [artifactPin({ version })],
        },
        version,
      );
    }
  });
});

describe("flowxo.contract-lock.v1", () => {
  it("strictly compiles and validates the checked-in Agent Relay lock", async () => {
    const { lock, policyDigest, schemaDigest } =
      await loadWhooshBangContractLock();
    assert.equal(schemaDigest, CANONICAL_SCHEMA_SHA256);
    assert.equal(policyDigest, CANONICAL_POLICY_SHA256);
    assert.equal(lock.repository, "flowxo/agent-relay");
    assert.equal(lock.dependencies.length, 3);
    assert.equal(lock.owned_artifacts.length, 0);
    assert.deepEqual(
      lock.dependencies.map(({ artifact, source_commit: sourceCommit }) => ({
        artifact,
        sourceCommit,
      })),
      [
        {
          artifact: "@whooshbang/contracts",
          sourceCommit: WHOOSHBANG_BASE_SOURCE_COMMIT,
        },
        {
          artifact: "@whooshbang/sdk",
          sourceCommit: WHOOSHBANG_BASE_SOURCE_COMMIT,
        },
        {
          artifact: "@whooshbang/contract-mock",
          sourceCommit: WHOOSHBANG_MOCK_SOURCE_COMMIT,
        },
      ],
    );
  });

  it("rejects missing pins and sibling or absolute artifact paths", () => {
    const missing = validLock();
    delete missing.dependencies[0].sha256;
    assertRejected(missing, "missing digest pin");

    for (const artifact_file of [
      "../whooshbang/artifact.tgz",
      "/tmp/artifact.tgz",
      "file:vendor/artifact.tgz",
      "vendor\\artifact.tgz",
    ]) {
      assertRejected(
        {
          ...validLock(),
          dependencies: [artifactPin({ artifact_file })],
        },
        artifact_file,
      );
    }
  });

  it("rejects empty, self-dependent, duplicate, and drifted lock metadata", () => {
    const empty = validLock();
    empty.dependencies = [];
    assertRejected(empty, "empty lock");

    const selfDependency = validLock();
    selfDependency.repository = "flowxo/whooshbang";
    assert.equal(validateSchema(selfDependency), true);
    assert.match(
      validateContractLock(selfDependency).join("\n"),
      /self-dependency/u,
    );

    const duplicate = validLock();
    duplicate.dependencies.push(artifactPin());
    assert.match(
      validateContractLock(duplicate).join("\n"),
      /pinned more than once/u,
    );

    assert.match(
      validateContractLock(validLock(), {
        expectedSchemaSha256: "c".repeat(64),
      }).join("\n"),
      /canonical schema/u,
    );
  });

  it("keeps artifact name schema and semantic boundaries in parity", () => {
    for (const artifact of ["a", `@a/${"b".repeat(211)}`]) {
      assertAccepted(
        {
          ...validLock(),
          dependencies: [artifactPin({ artifact })],
        },
        `valid artifact ${artifact.length}`,
      );
    }
    for (const artifact of [
      "",
      `@a/${"b".repeat(212)}`,
      "@whooshbang/Contracts",
      7,
    ]) {
      assertRejected(
        {
          ...validLock(),
          dependencies: [artifactPin({ artifact })],
        },
        `invalid artifact ${String(artifact)}`,
      );
    }
  });

  it("keeps artifact path schema and semantic boundaries in parity", () => {
    for (const artifact_file of ["a.tgz", `${"a".repeat(508)}.tgz`]) {
      assertAccepted(
        {
          ...validLock(),
          dependencies: [artifactPin({ artifact_file })],
        },
        `valid artifact path ${artifact_file.length}`,
      );
    }
    for (const artifact_file of [
      ".tgz",
      `${"a".repeat(509)}.tgz`,
      "vendor/a package.tgz",
      7,
    ]) {
      assertRejected(
        {
          ...validLock(),
          dependencies: [artifactPin({ artifact_file })],
        },
        `invalid artifact path ${String(artifact_file)}`,
      );
    }
  });

  it("keeps fixture ID schema and semantic boundaries in parity", () => {
    for (const id of ["a", `f${"i".repeat(127)}`]) {
      assertAccepted(
        {
          ...validLock(),
          dependencies: [
            artifactPin({
              fixture_sets: [{ id, version: "1.0.0" }],
            }),
          ],
        },
        `valid fixture ID ${id.length}`,
      );
    }
    for (const id of ["", `f${"i".repeat(128)}`, "fixture set", 7]) {
      assertRejected(
        {
          ...validLock(),
          dependencies: [
            artifactPin({
              fixture_sets: [{ id, version: "1.0.0" }],
            }),
          ],
        },
        `invalid fixture ID ${String(id)}`,
      );
    }
  });
});
