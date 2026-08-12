import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInstalledPackageIdentity,
  assertNativeRuntimeObservation,
  assertReleaseExitConfiguration,
  releaseExitSourceCommit,
  summarizeDoctorEvidence,
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
