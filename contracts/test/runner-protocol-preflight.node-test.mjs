import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { verifyRunnerProtocolArtifacts } from "../lib/runner-protocol-preflight.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function isolatedRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "runner-protocol-preflight-"));
  await mkdir(resolve(root, "contracts"), { recursive: true });
  await mkdir(resolve(root, "vendor/runner-protocol-v1"), {
    recursive: true,
  });
  await cp(
    resolve(repositoryRoot, "contracts/runner-protocol-lock.json"),
    resolve(root, "contracts/runner-protocol-lock.json"),
  );
  return root;
}

async function copyArtifacts(root) {
  for (const file of [
    "session-contracts-0.0.0.tgz",
    "session-protocol-runner-0.0.0.tgz",
  ]) {
    await cp(
      resolve(repositoryRoot, "vendor/runner-protocol-v1", file),
      resolve(root, "vendor/runner-protocol-v1", file),
    );
  }
}

async function mutateLock(root, mutate) {
  const path = resolve(root, "contracts/runner-protocol-lock.json");
  const lock = JSON.parse(await readFile(path, "utf8"));
  mutate(lock);
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

test("pinned runner protocol artifacts and 33-case corpus verify", async () => {
  const result = await verifyRunnerProtocolArtifacts(repositoryRoot);
  assert.equal(result.fixtures.fixtures.length, 33);
  assert.equal(result.lock.release_eligible, true);
  assert.match(result.lock.source_commit, /^[a-f0-9]{40}$/u);
});

test("changed digest and incomplete provenance fail closed", async (context) => {
  const root = await isolatedRoot();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await copyArtifacts(root);
  await mutateLock(root, (lock) => {
    lock.artifacts[0].sha256 = "0".repeat(64);
  });
  await assert.rejects(
    verifyRunnerProtocolArtifacts(root),
    /artifact digest does not match/u,
  );

  await cp(
    resolve(repositoryRoot, "contracts/runner-protocol-lock.json"),
    resolve(root, "contracts/runner-protocol-lock.json"),
  );
  await mutateLock(root, (lock) => {
    lock.source_commit = null;
    lock.source_tree_state = "uncommitted-development";
    lock.release_eligible = false;
  });
  await assert.rejects(
    verifyRunnerProtocolArtifacts(root),
    /lock metadata is invalid/u,
  );
});

test("artifact filesystem symlinks are rejected before archive parsing", async (context) => {
  const root = await isolatedRoot();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const first = "vendor/runner-protocol-v1/session-contracts-0.0.0.tgz";
  await mkdir(dirname(resolve(root, first)), { recursive: true });
  await symlink(resolve(repositoryRoot, first), resolve(root, first));
  await cp(
    resolve(
      repositoryRoot,
      "vendor/runner-protocol-v1/session-protocol-runner-0.0.0.tgz",
    ),
    resolve(
      root,
      "vendor/runner-protocol-v1/session-protocol-runner-0.0.0.tgz",
    ),
  );
  await assert.rejects(
    verifyRunnerProtocolArtifacts(root),
    /artifact path is unsafe/u,
  );
});
