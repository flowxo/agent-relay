import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  applyRunnerProtocolCandidate,
  inspectRunnerProtocolCandidate,
  validateRunnerProtocolCandidate,
} from "../lib/runner-protocol-candidate.mjs";
import { verifyRunnerProtocolArtifacts } from "../lib/runner-protocol-preflight.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const artifactNames = [
  "session-contracts-0.0.0.tgz",
  "session-protocol-runner-0.0.0.tgz",
];

async function createCandidate(root, sourceCommit) {
  const directory = resolve(root, "candidate");
  await mkdir(directory, { recursive: true });
  const lock = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "contracts/runner-protocol-lock.json"),
      "utf8",
    ),
  );
  const artifacts = [];
  for (const [index, filename] of artifactNames.entries()) {
    const source = resolve(
      repositoryRoot,
      "vendor/runner-protocol-v1",
      filename,
    );
    const bytes = await readFile(source);
    await writeFile(resolve(directory, filename), bytes);
    artifacts.push({
      package: lock.artifacts[index].package,
      version: lock.artifacts[index].version,
      file: filename,
      sha256: lock.artifacts[index].sha256,
      bytes: bytes.length,
    });
  }
  await writeFile(
    resolve(directory, "runner-protocol-artifacts.json"),
    `${JSON.stringify(
      {
        schema: "runner.protocol/artifact-manifest",
        schema_version: 1,
        protocol_family: "runner.protocol/v1",
        compatibility_commitment: "internal-until-gate-5",
        source_commit: sourceCommit,
        source_tree_state: "clean",
        release_eligible: true,
        fixture_count: 33,
        artifacts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return directory;
}

async function createTarget(root) {
  await mkdir(resolve(root, "contracts"), { recursive: true });
  await mkdir(resolve(root, "vendor/runner-protocol-v1"), {
    recursive: true,
  });
  await cp(
    resolve(repositoryRoot, "contracts/runner-protocol-lock.json"),
    resolve(root, "contracts/runner-protocol-lock.json"),
  );
  for (const filename of artifactNames) {
    await cp(
      resolve(repositoryRoot, "vendor/runner-protocol-v1", filename),
      resolve(root, "vendor/runner-protocol-v1", filename),
    );
  }
}

test("current candidate validates and reports no update", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "runner-update-current-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const current = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "contracts/runner-protocol-lock.json"),
      "utf8",
    ),
  );
  const candidate = await createCandidate(root, current.source_commit);
  const result = await inspectRunnerProtocolCandidate({
    repositoryRoot,
    artifactDirectory: candidate,
  });
  assert.equal(result.changed, false);
  assert.equal(result.fixtureCount, 33);
});

test("a validated changed commit applies as one recoverable set", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "runner-update-apply-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const target = resolve(root, "target");
  await createTarget(target);
  const sourceCommit = "a".repeat(40);
  const candidate = await createCandidate(root, sourceCommit);
  const result = await applyRunnerProtocolCandidate({
    repositoryRoot: target,
    artifactDirectory: candidate,
    targetIsClean: true,
  });
  assert.equal(result.changed, true);
  const verified = await verifyRunnerProtocolArtifacts(target);
  assert.equal(verified.lock.source_commit, sourceCommit);
  const repeated = await applyRunnerProtocolCandidate({
    repositoryRoot: target,
    artifactDirectory: candidate,
    targetIsClean: true,
  });
  assert.equal(repeated.changed, false);
});

test("apply refuses dirty targets and restores an interrupted replacement", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "runner-update-restore-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const target = resolve(root, "target");
  await createTarget(target);
  const candidate = await createCandidate(root, "b".repeat(40));
  await assert.rejects(
    applyRunnerProtocolCandidate({
      repositoryRoot: target,
      artifactDirectory: candidate,
      targetIsClean: false,
    }),
    /must be clean/u,
  );
  const priorLock = await readFile(
    resolve(target, "contracts/runner-protocol-lock.json"),
  );
  await assert.rejects(
    applyRunnerProtocolCandidate({
      repositoryRoot: target,
      artifactDirectory: candidate,
      targetIsClean: true,
      afterReplace: (index) => {
        if (index === 2) {
          throw new Error("injected replacement interruption");
        }
      },
    }),
    /prior set restored/u,
  );
  assert.deepEqual(
    await readFile(resolve(target, "contracts/runner-protocol-lock.json")),
    priorLock,
  );
  await verifyRunnerProtocolArtifacts(target);
});

test("unsafe, incomplete, or ineligible candidates fail before apply", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "runner-update-reject-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const candidate = await createCandidate(root, "c".repeat(40));
  const manifestPath = resolve(candidate, "runner-protocol-artifacts.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.release_eligible = false;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    validateRunnerProtocolCandidate(candidate),
    /manifest is invalid/u,
  );

  await rm(candidate, { recursive: true, force: true });
  const symlinkCandidate = await createCandidate(root, "d".repeat(40));
  const artifactPath = resolve(symlinkCandidate, artifactNames[0]);
  await rm(artifactPath);
  await symlink(
    resolve(repositoryRoot, "vendor/runner-protocol-v1", artifactNames[0]),
    artifactPath,
  );
  await assert.rejects(
    validateRunnerProtocolCandidate(symlinkCandidate),
    /unsafe or too large/u,
  );
});
