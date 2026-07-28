import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertCleanGit,
  releaseArtifactNames,
} from "../lib/release-bundle.mjs";
import {
  assertPublishContext,
  assertReleaseConfiguration,
  stagedPackageIsPrivate,
} from "../lib/release-policy.mjs";

const runFile = promisify(execFile);

function configuration() {
  return {
    schema: "agent-relay-release-candidate.v1",
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.1",
    gitTag: "v0.1.0-alpha.1",
    distTag: "alpha",
    priorFixtureVersion: "0.1.0-alpha.0",
    node: ">=22",
    os: ["darwin"],
    cpu: ["arm64", "x64"],
    dependencies: {
      "better-sqlite3": "13.0.1",
      zod: "4.4.3",
    },
    publication: {
      approved: false,
      registryAction: "blocked",
      registry: "https://registry.npmjs.org/",
      workflow: "prerelease.yml",
      environment: "npm-prerelease",
      requiresPublicRepository: true,
    },
  };
}

function rootPackage() {
  return {
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.1",
    private: true,
  };
}

function publishContext(overrides = {}) {
  return {
    githubActions: "true",
    eventName: "workflow_dispatch",
    publishInput: "true",
    refType: "tag",
    refName: "v0.1.0-alpha.1",
    repositoryVisibility: "public",
    repository: "flowxo/agent-relay",
    workflow: "prerelease.yml",
    workflowRef:
      "flowxo/agent-relay/.github/workflows/prerelease.yml@refs/tags/v0.1.0-alpha.1",
    environment: "npm-prerelease",
    npmVersion: "11.18.0",
    ...overrides,
  };
}

test("accepts an exact blocked prerelease configuration", () => {
  const release = configuration();
  assert.doesNotThrow(() => assertReleaseConfiguration(release, rootPackage()));
  assert.equal(stagedPackageIsPrivate(release), true);
  assert.deepEqual(releaseArtifactNames(release), {
    tarball: "flowxo-agent-relay-0.1.0-alpha.1.tgz",
    sbom: "flowxo-agent-relay-0.1.0-alpha.1.spdx.json",
    manifest: "agent-relay-release.json",
    checksums: "SHA256SUMS",
  });
});

test("rejects mutable runtime dependencies and non-prerelease versions", () => {
  const mutable = configuration();
  mutable.dependencies.zod = "^4.4.3";
  assert.throws(
    () => assertReleaseConfiguration(mutable, rootPackage()),
    /one exact semantic version/,
  );

  const stable = configuration();
  stable.version = "1.0.0";
  stable.gitTag = "v1.0.0";
  const root = rootPackage();
  root.version = "1.0.0";
  assert.throws(
    () => assertReleaseConfiguration(stable, root),
    /must include a semantic prerelease/,
  );
});

test("keeps registry mutation blocked until a reviewed approval change", () => {
  assert.throws(
    () => assertPublishContext(configuration(), publishContext()),
    /owner publication approval is false/,
  );
});

test("accepts only the exact public OIDC publish context", () => {
  const release = configuration();
  release.publication.approved = true;
  release.publication.registryAction = "publish";
  assert.equal(assertPublishContext(release, publishContext()), "publish");
  assert.equal(stagedPackageIsPrivate(release), false);

  for (const [field, value] of [
    ["eventName", "push"],
    ["publishInput", "false"],
    ["refType", "branch"],
    ["refName", "v0.1.0-alpha.2"],
    ["repositoryVisibility", "private"],
    ["repository", "example/agent-relay"],
    ["workflow", "other.yml"],
    [
      "workflowRef",
      "example/agent-relay/.github/workflows/prerelease.yml@refs/tags/v0.1.0-alpha.1",
    ],
    [
      "workflowRef",
      "flowxo/agent-relay/.github/workflows/prerelease.yml@refs/heads/main",
    ],
    ["environment", "unprotected"],
  ]) {
    assert.throws(() =>
      assertPublishContext(release, publishContext({ [field]: value })),
    );
  }
});

test("enforces current npm minimums for publish and staged publishing", () => {
  const release = configuration();
  release.publication.approved = true;
  release.publication.registryAction = "publish";
  assert.throws(
    () =>
      assertPublishContext(release, publishContext({ npmVersion: "11.5.0" })),
    /npm 11\.5\.1 or newer/,
  );

  release.publication.registryAction = "stage";
  assert.throws(
    () =>
      assertPublishContext(release, publishContext({ npmVersion: "11.14.9" })),
    /npm 11\.15\.0 or newer/,
  );
  assert.equal(
    assertPublishContext(release, publishContext({ npmVersion: "11.15.0" })),
    "stage",
  );
});

test("refuses tracked or untracked release input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-release-git-"));
  try {
    await runFile("git", ["init", "--quiet"], { cwd: directory });
    await runFile("git", ["config", "user.name", "Synthetic Test"], {
      cwd: directory,
    });
    await runFile("git", ["config", "user.email", "test@example.invalid"], {
      cwd: directory,
    });
    await writeFile(join(directory, "tracked.txt"), "synthetic\n");
    await runFile("git", ["add", "tracked.txt"], { cwd: directory });
    await runFile("git", ["commit", "--quiet", "-m", "synthetic"], {
      cwd: directory,
    });
    await assert.doesNotReject(assertCleanGit(directory));

    await writeFile(join(directory, "untracked.txt"), "synthetic\n");
    await assert.rejects(assertCleanGit(directory), /clean checkout/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
