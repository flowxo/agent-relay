import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readSafeTarGzip } from "./notifications-preflight.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const maximumArtifactBytes = 16 * 1024 * 1024;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryPath(root, localPath) {
  const resolved = resolve(root, localPath);
  const local = relative(root, resolved);
  if (
    local === "" ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  ) {
    throw new Error("Runner protocol artifact path leaves the repository.");
  }
  return resolved;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

function assertLock(lock) {
  if (
    lock?.schema !== "agent-relay.runner-protocol-lock/v1" ||
    lock.schema_version !== 1 ||
    lock.protocol_family !== "runner.protocol/v1" ||
    lock.compatibility_commitment !== "internal-until-gate-5" ||
    lock.source_repository !== "flowxo/code-sidecar" ||
    typeof lock.source_commit !== "string" ||
    !commitPattern.test(lock.source_commit) ||
    lock.source_tree_state !== "clean" ||
    lock.release_eligible !== true ||
    lock.fixture_file !== "package/fixtures/runner-protocol-v1.json" ||
    lock.fixture_count !== 33 ||
    !Array.isArray(lock.artifacts) ||
    lock.artifacts.length !== 2
  ) {
    throw new Error("Runner protocol lock metadata is invalid.");
  }
  const expectedNames = ["@session/contracts", "@session/protocol-runner"];
  for (const [index, artifact] of lock.artifacts.entries()) {
    if (
      artifact?.package !== expectedNames[index] ||
      typeof artifact.file !== "string" ||
      !artifact.file.startsWith("vendor/runner-protocol-v1/") ||
      typeof artifact.version !== "string" ||
      !exactVersionPattern.test(artifact.version) ||
      typeof artifact.sha256 !== "string" ||
      !sha256Pattern.test(artifact.sha256)
    ) {
      throw new Error(
        `Runner protocol lock artifact ${String(index)} is invalid.`,
      );
    }
  }
}

function assertPackage(entries, pin) {
  const packageEntry = entries.get("package/package.json");
  if (!packageEntry || packageEntry.directory) {
    throw new Error(`${pin.package} archive has no package manifest.`);
  }
  const manifest = parseJson(packageEntry.data, `${pin.package} package`);
  if (
    manifest.name !== pin.package ||
    manifest.version !== pin.version ||
    manifest.private !== true ||
    manifest.license !== "MIT" ||
    manifest.scripts?.preinstall !== undefined ||
    manifest.scripts?.install !== undefined ||
    manifest.scripts?.postinstall !== undefined ||
    manifest.scripts?.prepare !== undefined
  ) {
    throw new Error(`${pin.package} package identity or lifecycle is unsafe.`);
  }
  const expectedDependencies =
    pin.package === "@session/protocol-runner"
      ? { "@session/contracts": "0.0.0" }
      : undefined;
  if (
    JSON.stringify(manifest.dependencies) !==
    JSON.stringify(expectedDependencies)
  ) {
    throw new Error(`${pin.package} dependency inventory is invalid.`);
  }
}

export async function verifyRunnerProtocolArtifacts(root = repositoryRoot) {
  const lock = parseJson(
    await readFile(resolve(root, "contracts/runner-protocol-lock.json")),
    "Runner protocol lock",
  );
  assertLock(lock);

  let fixtures;
  for (const pin of lock.artifacts) {
    const path = repositoryPath(root, pin.file);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > maximumArtifactBytes) {
      throw new Error(`${pin.package} artifact path is unsafe.`);
    }
    const bytes = await readFile(path);
    if (digest(bytes) !== pin.sha256) {
      throw new Error(`${pin.package} artifact digest does not match.`);
    }
    const entries = readSafeTarGzip(bytes);
    assertPackage(entries, pin);
    if (pin.package === "@session/protocol-runner") {
      const fixtureEntry = entries.get(lock.fixture_file);
      if (!fixtureEntry || fixtureEntry.directory) {
        throw new Error("Runner protocol fixture corpus is missing.");
      }
      fixtures = parseJson(fixtureEntry.data, "Runner protocol fixtures");
    }
  }

  if (
    fixtures?.schema !== "runner.protocol/conformance-fixtures" ||
    fixtures.schema_version !== 1 ||
    fixtures.protocol_family !== lock.protocol_family ||
    !Array.isArray(fixtures.fixtures) ||
    fixtures.fixtures.length !== lock.fixture_count ||
    new Set(fixtures.fixtures.map(({ id }) => id)).size !== lock.fixture_count
  ) {
    throw new Error("Runner protocol fixture inventory does not match.");
  }
  return { lock, fixtures };
}
