import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

import { verifyRunnerProtocolArtifacts } from "./runner-protocol-preflight.mjs";

const maximumManifestBytes = 1024 * 1024;
const maximumArtifactBytes = 16 * 1024 * 1024;
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const expectedArtifacts = [
  {
    package: "@session/contracts",
    version: "0.0.0",
    filename: "session-contracts-0.0.0.tgz",
  },
  {
    package: "@session/protocol-runner",
    version: "0.0.0",
    filename: "session-protocol-runner-0.0.0.tgz",
  },
];

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
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
    throw new Error("Runner protocol update path leaves the repository.");
  }
  return resolved;
}

async function readRegularFile(path, maximumBytes, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error(`${label} is unsafe or too large.`);
  }
  return await readFile(path);
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Runner protocol candidate manifest is not valid JSON.");
  }
  if (
    !exactKeys(manifest, [
      "schema",
      "schema_version",
      "protocol_family",
      "compatibility_commitment",
      "source_commit",
      "source_tree_state",
      "release_eligible",
      "fixture_count",
      "artifacts",
    ]) ||
    manifest.schema !== "runner.protocol/artifact-manifest" ||
    manifest.schema_version !== 1 ||
    manifest.protocol_family !== "runner.protocol/v1" ||
    manifest.compatibility_commitment !== "internal-until-gate-5" ||
    !commitPattern.test(manifest.source_commit) ||
    manifest.source_tree_state !== "clean" ||
    manifest.release_eligible !== true ||
    manifest.fixture_count !== 33 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== expectedArtifacts.length
  ) {
    throw new Error("Runner protocol candidate manifest is invalid.");
  }
  for (const [index, expected] of expectedArtifacts.entries()) {
    const artifact = manifest.artifacts[index];
    if (
      !exactKeys(artifact, ["package", "version", "file", "sha256", "bytes"]) ||
      artifact.package !== expected.package ||
      artifact.version !== expected.version ||
      artifact.file !== expected.filename ||
      basename(artifact.file) !== artifact.file ||
      typeof artifact.sha256 !== "string" ||
      !sha256Pattern.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > maximumArtifactBytes
    ) {
      throw new Error(
        `Runner protocol candidate artifact ${String(index)} is invalid.`,
      );
    }
  }
  return manifest;
}

function candidateLock(manifest) {
  return {
    schema: "agent-relay.runner-protocol-lock/v1",
    schema_version: 1,
    protocol_family: manifest.protocol_family,
    compatibility_commitment: manifest.compatibility_commitment,
    source_repository: "flowxo/code-sidecar",
    source_commit: manifest.source_commit,
    source_tree_state: manifest.source_tree_state,
    release_eligible: manifest.release_eligible,
    fixture_file: "package/fixtures/runner-protocol-v1.json",
    fixture_count: manifest.fixture_count,
    artifacts: manifest.artifacts.map((artifact) => ({
      package: artifact.package,
      version: artifact.version,
      file: `vendor/runner-protocol-v1/${artifact.file}`,
      sha256: artifact.sha256,
    })),
  };
}

async function writeCandidateRoot(root, lock, artifactBytes) {
  await mkdir(resolve(root, "contracts"), { recursive: true });
  await mkdir(resolve(root, "vendor/runner-protocol-v1"), {
    recursive: true,
  });
  await writeFile(
    resolve(root, "contracts/runner-protocol-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
  for (const [filename, bytes] of artifactBytes) {
    await writeFile(
      resolve(root, "vendor/runner-protocol-v1", filename),
      bytes,
    );
  }
}

export async function validateRunnerProtocolCandidate(artifactDirectory) {
  const directoryMetadata = await lstat(artifactDirectory);
  if (!directoryMetadata.isDirectory()) {
    throw new Error("Runner protocol candidate path is not a directory.");
  }
  const manifestBytes = await readRegularFile(
    resolve(artifactDirectory, "runner-protocol-artifacts.json"),
    maximumManifestBytes,
    "Runner protocol candidate manifest",
  );
  const manifest = parseManifest(manifestBytes);
  const artifactBytes = new Map();
  for (const artifact of manifest.artifacts) {
    const bytes = await readRegularFile(
      resolve(artifactDirectory, artifact.file),
      maximumArtifactBytes,
      `Runner protocol candidate ${artifact.package}`,
    );
    if (bytes.length !== artifact.bytes) {
      throw new Error(
        `Runner protocol candidate ${artifact.package} byte count differs.`,
      );
    }
    artifactBytes.set(artifact.file, bytes);
  }
  const lock = candidateLock(manifest);
  const isolated = await mkdtemp(resolve(tmpdir(), "runner-candidate-check-"));
  try {
    await writeCandidateRoot(isolated, lock, artifactBytes);
    const verified = await verifyRunnerProtocolArtifacts(isolated);
    return {
      manifest,
      lock,
      artifactBytes,
      fixtureCount: verified.fixtures.fixtures.length,
    };
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

function lockIdentity(lock) {
  return JSON.stringify({
    protocol_family: lock.protocol_family,
    compatibility_commitment: lock.compatibility_commitment,
    source_commit: lock.source_commit,
    fixture_count: lock.fixture_count,
    artifacts: lock.artifacts.map(
      ({ package: packageName, version, sha256 }) => ({
        package: packageName,
        version,
        sha256,
      }),
    ),
  });
}

export async function inspectRunnerProtocolCandidate(options) {
  const candidate = await validateRunnerProtocolCandidate(
    resolve(options.artifactDirectory),
  );
  const current = await verifyRunnerProtocolArtifacts(
    resolve(options.repositoryRoot),
  );
  return {
    ...candidate,
    changed: lockIdentity(candidate.lock) !== lockIdentity(current.lock),
  };
}

async function replaceFile(path, bytes) {
  const temporary = `${path}.candidate-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyRunnerProtocolCandidate(options) {
  if (options.targetIsClean !== true) {
    throw new Error(
      "Runner protocol lock and vendored targets must be clean before apply.",
    );
  }
  const repositoryRoot = resolve(options.repositoryRoot);
  const candidate = await inspectRunnerProtocolCandidate(options);
  if (!candidate.changed) {
    return {
      changed: false,
      lock: candidate.lock,
      fixtureCount: candidate.fixtureCount,
    };
  }

  const targets = [
    {
      path: repositoryPath(
        repositoryRoot,
        "vendor/runner-protocol-v1/session-contracts-0.0.0.tgz",
      ),
      bytes: candidate.artifactBytes.get("session-contracts-0.0.0.tgz"),
    },
    {
      path: repositoryPath(
        repositoryRoot,
        "vendor/runner-protocol-v1/session-protocol-runner-0.0.0.tgz",
      ),
      bytes: candidate.artifactBytes.get("session-protocol-runner-0.0.0.tgz"),
    },
    {
      path: repositoryPath(
        repositoryRoot,
        "contracts/runner-protocol-lock.json",
      ),
      bytes: Buffer.from(`${JSON.stringify(candidate.lock, null, 2)}\n`),
    },
  ];
  if (targets.some(({ bytes }) => bytes === undefined)) {
    throw new Error("Runner protocol candidate artifact set is incomplete.");
  }
  const previous = await Promise.all(
    targets.map(async ({ path }) => ({
      path,
      bytes: await readRegularFile(
        path,
        maximumArtifactBytes,
        "Runner protocol update target",
      ),
    })),
  );

  try {
    for (const [index, target] of targets.entries()) {
      await replaceFile(target.path, target.bytes);
      await options.afterReplace?.(index);
    }
    await verifyRunnerProtocolArtifacts(repositoryRoot);
  } catch (error) {
    for (const target of previous) {
      await replaceFile(target.path, target.bytes);
    }
    await verifyRunnerProtocolArtifacts(repositoryRoot);
    throw new Error(
      "Runner protocol candidate apply failed; prior set restored.",
      {
        cause: error,
      },
    );
  }
  return {
    changed: true,
    lock: candidate.lock,
    fixtureCount: candidate.fixtureCount,
  };
}
