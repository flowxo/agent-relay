import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";

import { compileContractLockSchema } from "../lib/json-schema.mjs";
import {
  assertWhooshBangCheckResult,
  buildWhooshBangCheckResult,
  inspectLockedArtifact,
  isSecretLikeArchivePath,
  loadWhooshBangContractLock,
  preflightArtifactsBeforeInstall,
  productionBoundaryViolations,
  readSafeTarGzip,
  verifyWhooshBangProductionBoundary,
} from "../lib/whooshbang-preflight.mjs";

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  writeString(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
  );
}

function tarFile(path, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

function archive(packageJson, extraFiles = []) {
  const members = [
    ...tarFile(
      "package/package.json",
      `${JSON.stringify(packageJson, null, 2)}\n`,
    ),
  ];
  for (const file of extraFiles) {
    members.push(...tarFile(file.path, file.content));
  }
  members.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(members));
}

function sdkPin(bytes, overrides = {}) {
  return {
    owner: "whooshbang",
    artifact: "@whooshbang/sdk",
    version: "1.0.0-draft.1",
    source_repository: "flowxo/whooshbang",
    source_commit: "b".repeat(40),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    artifact_file: "vendor/whooshbang-sdk.tgz",
    fixture_sets: [],
    ...overrides,
  };
}

function syntheticLock(pin) {
  return {
    schema: "flowxo.contract-lock.v1",
    schema_sha256: "a".repeat(64),
    policy_sha256: "a".repeat(64),
    repository: "flowxo/agent-relay",
    dependencies: [pin],
    owned_artifacts: [],
  };
}

describe("WhooshBang artifact preflight", () => {
  it("accepts the three exact vendored artifacts and fixture identities", async () => {
    const { lock } = await loadWhooshBangContractLock();
    for (const pin of lock.dependencies) {
      const bytes = await readFile(
        new URL(`../../${pin.artifact_file}`, import.meta.url),
      );
      const inspected = inspectLockedArtifact({ bytes, lock, pin });
      assert.equal(inspected.packageJson.name, pin.artifact);
      assert.equal(inspected.packageJson.version, pin.version);
    }
  });

  it("rejects a tampered artifact digest", async () => {
    const { lock } = await loadWhooshBangContractLock();
    const pin = lock.dependencies[0];
    const original = await readFile(
      new URL(`../../${pin.artifact_file}`, import.meta.url),
    );
    const tampered = Buffer.concat([original, Buffer.from("tampered")]);
    assert.throws(
      () => inspectLockedArtifact({ bytes: tampered, lock, pin }),
      /Digest mismatch/u,
    );
  });

  it("rejects lifecycle scripts before invoking the installer", async () => {
    const bytes = archive({
      name: "@whooshbang/sdk",
      version: "1.0.0-draft.1",
      scripts: {
        postinstall: "node malicious-lifecycle.js",
      },
    });
    const pin = sdkPin(bytes);
    const lock = syntheticLock(pin);
    let installInvoked = false;
    await assert.rejects(
      preflightArtifactsBeforeInstall({
        artifacts: [{ bytes, pin }],
        install: async () => {
          installInvoked = true;
        },
        lock,
      }),
      /Install-time script/u,
    );
    assert.equal(installInvoked, false);
  });

  it("rejects secret-like archive paths without reflecting their contents", () => {
    const marker = "synthetic-secret-value-that-must-not-be-logged";
    const bytes = archive(
      {
        name: "@whooshbang/sdk",
        version: "1.0.0-draft.1",
      },
      [{ path: "package/.env.production", content: marker }],
    );
    const pin = sdkPin(bytes);
    assert.throws(
      () => inspectLockedArtifact({ bytes, lock: syntheticLock(pin), pin }),
      (error) => {
        assert.match(error.message, /secret-like/u);
        assert.doesNotMatch(error.message, new RegExp(marker, "u"));
        return true;
      },
    );
  });

  it("rejects mutable transitive dependency pins", () => {
    const bytes = archive({
      name: "@whooshbang/sdk",
      version: "1.0.0-draft.1",
      dependencies: {
        hono: "latest",
      },
    });
    const pin = sdkPin(bytes);
    assert.throws(
      () => inspectLockedArtifact({ bytes, lock: syntheticLock(pin), pin }),
      /mutable transitive dependency/u,
    );
  });

  it("rejects a retired FlowXO WhooshBang transitive dependency", () => {
    const bytes = archive({
      name: "@whooshbang/sdk",
      version: "1.0.0-draft.1",
      dependencies: {
        "@flowxo/whooshbang-contracts": "1.0.0-rc.1",
      },
    });
    const pin = sdkPin(bytes);
    assert.throws(
      () => inspectLockedArtifact({ bytes, lock: syntheticLock(pin), pin }),
      /retired FlowXO package identity/u,
    );
  });

  it("rejects an unpinned WhooshBang transitive dependency", () => {
    const bytes = archive({
      name: "@whooshbang/sdk",
      version: "1.0.0-draft.1",
      dependencies: {
        "@whooshbang/contracts": "1.0.0-rc.3",
      },
    });
    const pin = sdkPin(bytes);
    assert.throws(
      () => inspectLockedArtifact({ bytes, lock: syntheticLock(pin), pin }),
      /unpinned WhooshBang dependency/u,
    );
  });

  it("recognizes bounded secret-like names without false positives", () => {
    for (const path of [
      "package/.env",
      "package/.env.local",
      "package/.npmrc",
      "package/credentials.json",
      "package/private-key.pem",
      "package/id_ed25519",
    ]) {
      assert.equal(isSecretLikeArchivePath(path), true, path);
    }
    for (const path of [
      "package/dist/machine-credential.js",
      "package/fixtures/tokens/callback-token.json",
      "package/schemas/webhook-signature.json",
    ]) {
      assert.equal(isSecretLikeArchivePath(path), false, path);
    }
  });

  it("rejects unsafe absolute and traversal archive members", () => {
    for (const path of ["/package/absolute.json", "package/../sibling.json"]) {
      const bytes = gzipSync(
        Buffer.concat([...tarFile(path, "{}"), Buffer.alloc(1024)]),
      );
      assert.throws(() => readSafeTarGzip(bytes), /unsafe member path/u);
    }
  });
});

describe("Agent Relay contract evidence", () => {
  it("preserves the production transport import boundary", async () => {
    await assert.doesNotReject(verifyWhooshBangProductionBoundary());
    for (const source of [
      'import { RelayStore } from "@agent-relay/core";',
      'import { open } from "node:fs";',
      'import { adapter } from "../../whooshbang/src/adapter.js";',
      'import { adapter } from "../../flowxo-whooshbang/src/adapter.js";',
      'import { poll } from "./telegram-poller.js";',
      'import { query } from "./sqlite-store.js";',
      'import { binding } from "./cloudflare-binding.js";',
    ]) {
      assert.notEqual(productionBoundaryViolations(source).length, 0, source);
    }
    assert.deepEqual(
      productionBoundaryViolations(
        'import { TransportError } from "@agent-relay/notification-contracts";',
      ),
      [],
    );
  });

  it("builds the deterministic aggregate result envelope", async () => {
    const { lock, policyDigest, schemaDigest } =
      await loadWhooshBangContractLock();
    const result = buildWhooshBangCheckResult({
      consumerCommit: "c".repeat(40),
      lock,
      policyDigest,
      schemaDigest,
    });
    const resultSchema = JSON.parse(
      await readFile(
        new URL("../contract-check-result.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validateResult = compileContractLockSchema(resultSchema);
    assert.equal(
      validateResult(result),
      true,
      JSON.stringify(validateResult.errors),
    );
    assert.doesNotThrow(() => assertWhooshBangCheckResult(result));
    assert.deepEqual(Object.keys(result), [
      "schema",
      "result_schema_sha256",
      "repository",
      "consumer_commit",
      "command",
      "status",
      "lock_schema_sha256",
      "compatibility_policy_sha256",
      "artifacts",
      "checks",
    ]);
    assert.equal(result.status, "pass");
    assert.equal(result.artifacts.length, 3);
    assert.equal(
      result.artifacts.some((artifact) =>
        Object.hasOwn(artifact, "artifact_file"),
      ),
      false,
    );
    assert.equal(new Set(result.checks).size, result.checks.length);
    assert.equal(result.checks.includes("cross-machine-answer-origin"), true);

    const invalidResults = [
      {
        ...result,
        passed_at: "2026-07-25T00:00:00Z",
      },
      {
        ...result,
        status: "fail",
      },
      {
        ...result,
        result_schema_sha256: "not-a-digest",
      },
      {
        ...result,
        checks: [...result.checks, result.checks[0]],
      },
    ];
    for (const invalid of invalidResults) {
      assert.equal(validateResult(invalid), false);
      assert.throws(() => assertWhooshBangCheckResult(invalid));
    }
  });
});
