import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertInstalledPackageIdentity,
  assertNativeRuntimeObservation,
  assertReleaseExitConfiguration,
  candidateReleaseExitSourceCommit,
  releaseExitSourceCommit,
  summarizeCapabilitiesEvidence,
  summarizeDoctorEvidence,
  summarizePublicRegistryArtifact,
} from "../lib/release-exit-policy.mjs";

function configuration() {
  return {
    schema: "agent-relay-release-exit.v1",
    recheckedAt: "2026-07-26",
    target: {
      platform: "darwin",
      architecture: "arm64",
      node: {
        version: "22.23.1",
        archive: "node-v22.23.1-darwin-arm64.tar.gz",
        url: "https://nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-arm64.tar.gz",
        sha256:
          "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
        checksumSource: "https://nodejs.org/dist/v22.23.1/SHASUMS256.txt",
        maximumBytes: 67_108_864,
      },
    },
    requiredHarnesses: ["codex", "claude", "cursor"],
    minimumVerifiedHarnesses: 1,
    evidenceOutput: ".artifacts/release-exit/agent-relay-release-exit.json",
  };
}

test("accepts the exact native minimum-runtime target", () => {
  const exit = configuration();
  assert.doesNotThrow(() =>
    assertReleaseExitConfiguration(exit, { node: ">=22" }),
  );
  assert.doesNotThrow(() =>
    assertNativeRuntimeObservation(exit, {
      platform: "darwin",
      architecture: "arm64",
      version: "v22.23.1",
    }),
  );
});

test("rejects mutable or mismatched runtime targets", () => {
  const wrongArchitecture = configuration();
  wrongArchitecture.target.architecture = "x64";
  assert.throws(
    () => assertReleaseExitConfiguration(wrongArchitecture, { node: ">=22" }),
    /native Apple-silicon/,
  );

  const mutableVersion = configuration();
  mutableVersion.target.node.version = "22.x";
  assert.throws(
    () => assertReleaseExitConfiguration(mutableVersion, { node: ">=22" }),
    /exact stable version/,
  );

  assert.throws(
    () =>
      assertNativeRuntimeObservation(configuration(), {
        platform: "darwin",
        architecture: "x64",
        version: "v22.23.1",
      }),
    /instead of arm64/,
  );
});

test("accepts the policy-derived privacy of an approved public package", () => {
  const release = {
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.2",
    publication: { approved: true },
  };
  assert.doesNotThrow(() =>
    assertInstalledPackageIdentity(release, {
      name: release.name,
      version: release.version,
      private: false,
    }),
  );
  assert.throws(
    () =>
      assertInstalledPackageIdentity(release, {
        name: release.name,
        version: release.version,
        private: true,
      }),
    /release policy/,
  );

  const blockedRelease = {
    ...release,
    publication: { approved: false },
  };
  assert.doesNotThrow(() =>
    assertInstalledPackageIdentity(blockedRelease, {
      name: release.name,
      version: release.version,
      private: true,
    }),
  );
  assert.throws(
    () =>
      assertInstalledPackageIdentity(blockedRelease, {
        name: release.name,
        version: release.version,
        private: false,
      }),
    /release policy/,
  );
});

test("anchors post-publication release exit to the immutable source tag", () => {
  const release = { gitTag: "v0.1.0-alpha.2" };
  const commit = "a".repeat(40);
  assert.equal(
    releaseExitSourceCommit(release, {
      intendedTagState: { status: "verified-at-head", commit },
    }),
    commit,
  );
  assert.equal(
    releaseExitSourceCommit(release, {
      intendedTagState: { status: "exists-elsewhere", commit },
    }),
    commit,
  );
  assert.throws(
    () =>
      releaseExitSourceCommit(release, {
        intendedTagState: { status: "not-created", commit: null },
      }),
    /must exist before post-publication release exit/,
  );
});

test("anchors pre-tag candidate release exit to HEAD without allowing tag reuse", () => {
  const release = { gitTag: "v0.1.0-alpha.3" };
  const commit = "b".repeat(40);
  for (const status of ["not-created", "verified-at-head"]) {
    assert.equal(
      candidateReleaseExitSourceCommit(release, {
        commit,
        intendedTagState: {
          status,
          commit: status === "not-created" ? null : commit,
        },
      }),
      commit,
    );
  }
  assert.throws(
    () =>
      candidateReleaseExitSourceCommit(release, {
        commit,
        intendedTagState: {
          status: "exists-elsewhere",
          commit: "c".repeat(40),
        },
      }),
    /already points at another commit/,
  );
});

test("binds the public registry tarball bytes and integrity to the authorized artifact", () => {
  const contents = Buffer.from("authorized public artifact");
  const sha1 = createHash("sha1").update(contents).digest("hex");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
  const release = {
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.2",
  };
  const metadata = {
    ...release,
    dist: {
      tarball:
        "https://registry.npmjs.org/@flowxo/agent-relay/-/agent-relay-0.1.0-alpha.2.tgz",
      shasum: sha1,
      integrity,
    },
  };
  const bundle = { artifactBytes: contents.length, artifactSha256: sha256 };
  assert.deepEqual(
    summarizePublicRegistryArtifact(
      release,
      bundle,
      metadata,
      contents,
      contents,
    ),
    {
      registry: "https://registry.npmjs.org/",
      packageSpec: "@flowxo/agent-relay@0.1.0-alpha.2",
      tarball: metadata.dist.tarball,
      bytes: contents.length,
      sha1,
      sha256,
      integrity,
      authorizedArtifactByteMatch: true,
    },
  );
  assert.throws(
    () =>
      summarizePublicRegistryArtifact(
        release,
        bundle,
        metadata,
        Buffer.from("different public artifact"),
        contents,
      ),
    /digest metadata|authorized artifact/,
  );
});

test("requires all harness observations and one exact verified record", () => {
  const checks = [
    {
      name: "codex",
      level: "pass",
      observedVersion: "codex-cli 0.145.0",
      verifiedVersion: "codex-cli 0.145.0",
      classification: "verified",
      evidenceId: "codex-cli-0.145.0-2026-07-25",
    },
    {
      name: "claude",
      level: "warn",
      observedVersion: "2.1.220 (Claude Code)",
      verifiedVersion: "2.1.219 (Claude Code)",
      classification: "compatible-unverified",
      evidenceId: "claude-cli-2.1.219-2026-07-25",
    },
    {
      name: "cursor",
      level: "pass",
      observedVersion: "2026.07.23-e383d2b",
      verifiedVersion: "2026.07.23-e383d2b",
      classification: "verified",
      evidenceId: "cursor-cli-2026.07.23-e383d2b-2026-07-25",
    },
  ];
  assert.equal(
    summarizeDoctorEvidence(configuration(), {
      healthy: true,
      checks,
    }).length,
    3,
  );
  assert.throws(
    () =>
      summarizeDoctorEvidence(configuration(), {
        healthy: true,
        checks: checks.map((check) => ({
          ...check,
          level: "warn",
          classification: "compatible-unverified",
        })),
      }),
    /too few exact verified harnesses/,
  );
  assert.throws(
    () =>
      summarizeDoctorEvidence(configuration(), {
        healthy: true,
        checks: checks.slice(0, 2),
      }),
    /missing the cursor/,
  );
});

test("records the installed public capability registry", () => {
  const records = [
    ["codex", "codex-cli 0.145.0"],
    ["claude", "2.1.219 (Claude Code)"],
    ["cursor", "2026.07.23-e383d2b"],
  ].map(([harness, verifiedVersion]) => ({
    harness,
    surface: "cli",
    verifiedVersion,
    classification: "verified",
    evidenceId: `${harness}-evidence`,
  }));
  assert.deepEqual(
    summarizeCapabilitiesEvidence(configuration(), {
      schema: "agent-relay-compatibility.v1",
      runtimeTarget: {
        platform: "darwin",
        architecture: "arm64",
        minimumNodeMajor: 22,
      },
      records,
    }),
    {
      schema: "agent-relay-compatibility.v1",
      recordCount: 3,
      cliRecords: records,
    },
  );
  assert.throws(
    () =>
      summarizeCapabilitiesEvidence(configuration(), {
        schema: "agent-relay-compatibility.v1",
        runtimeTarget: {
          platform: "darwin",
          architecture: "arm64",
          minimumNodeMajor: 22,
        },
        records: records.filter(({ harness }) => harness !== "cursor"),
      }),
    /missing the cursor CLI/,
  );
});
