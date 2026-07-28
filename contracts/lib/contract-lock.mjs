import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const SHA256 = /^[0-9a-f]{64}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OWNER = /^[a-z0-9][a-z0-9-]*$/u;
const ARTIFACT =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const FIXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "schema_sha256",
  "policy_sha256",
  "repository",
  "dependencies",
  "owned_artifacts",
]);
const PIN_KEYS = new Set([
  "owner",
  "artifact",
  "version",
  "source_repository",
  "source_commit",
  "sha256",
  "artifact_file",
  "fixture_sets",
]);
const FIXTURE_KEYS = new Set(["id", "version"]);

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function unexpectedKeys(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateArtifactFile(value) {
  return (
    typeof value === "string" &&
    value.length >= 5 &&
    value.endsWith(".tgz") &&
    /^[A-Za-z0-9@+._/-]+$/u.test(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/(?:file|link|workspace):/u.test(value)
  );
}

function validatePin(pin, section, repository, index, errors) {
  const path = `${section}[${String(index)}]`;
  if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of unexpectedKeys(pin, PIN_KEYS)) {
    errors.push(`${path} has unknown field ${key}`);
  }
  for (const key of PIN_KEYS) {
    if (!(key in pin)) {
      errors.push(`${path} is missing ${key}`);
    }
  }
  if (typeof pin.owner !== "string" || !OWNER.test(pin.owner)) {
    errors.push(`${path}.owner is invalid`);
  }
  if (
    typeof pin.artifact !== "string" ||
    !ARTIFACT.test(pin.artifact) ||
    pin.artifact.length > 214
  ) {
    errors.push(`${path}.artifact is invalid`);
  }
  if (
    typeof pin.version !== "string" ||
    !EXACT_SEMVER.test(pin.version)
  ) {
    errors.push(`${path}.version must be an exact SemVer`);
  }
  if (
    typeof pin.source_repository !== "string" ||
    !REPOSITORY.test(pin.source_repository)
  ) {
    errors.push(`${path}.source_repository is invalid`);
  }
  if (
    typeof pin.source_commit !== "string" ||
    !FULL_COMMIT.test(pin.source_commit)
  ) {
    errors.push(`${path}.source_commit must be a full 40-hex commit`);
  }
  if (typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) {
    errors.push(`${path}.sha256 is invalid`);
  }
  if (
    !validateArtifactFile(pin.artifact_file) ||
    pin.artifact_file.length > 512
  ) {
    errors.push(`${path}.artifact_file must be a safe repository-relative tgz`);
  }
  if (!Array.isArray(pin.fixture_sets)) {
    errors.push(`${path}.fixture_sets must be an array`);
  } else {
    const fixtureIds = new Set();
    for (const [fixtureIndex, fixture] of pin.fixture_sets.entries()) {
      const fixturePath = `${path}.fixture_sets[${String(fixtureIndex)}]`;
      if (
        fixture === null ||
        typeof fixture !== "object" ||
        Array.isArray(fixture)
      ) {
        errors.push(`${fixturePath} must be an object`);
        continue;
      }
      for (const key of unexpectedKeys(fixture, FIXTURE_KEYS)) {
        errors.push(`${fixturePath} has unknown field ${key}`);
      }
      if (
        typeof fixture.id !== "string" ||
        !FIXTURE_ID.test(fixture.id) ||
        fixture.id.length > 128
      ) {
        errors.push(`${fixturePath}.id is invalid`);
      } else if (fixtureIds.has(fixture.id)) {
        errors.push(`${path} repeats fixture set ${fixture.id}`);
      } else {
        fixtureIds.add(fixture.id);
      }
      if (
        typeof fixture.version !== "string" ||
        !EXACT_SEMVER.test(fixture.version)
      ) {
        errors.push(`${fixturePath}.version must be an exact SemVer`);
      }
    }
  }
  if (
    section === "dependencies" &&
    pin.source_repository === repository
  ) {
    errors.push(`${path} is a self-dependency; use owned_artifacts evidence`);
  }
  if (
    section === "owned_artifacts" &&
    pin.source_repository !== repository
  ) {
    errors.push(`${path} must be owned by ${repository}`);
  }
}

export function validateContractLock(
  lock,
  { expectedSchemaSha256, expectedPolicySha256 } = {},
) {
  const errors = [];
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    return ["contract lock must be an object"];
  }
  for (const key of unexpectedKeys(lock, TOP_LEVEL_KEYS)) {
    errors.push(`contract lock has unknown field ${key}`);
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in lock)) {
      errors.push(`contract lock is missing ${key}`);
    }
  }
  if (lock.schema !== "flowxo.contract-lock.v1") {
    errors.push("contract lock schema is not flowxo.contract-lock.v1");
  }
  if (
    typeof lock.schema_sha256 !== "string" ||
    !SHA256.test(lock.schema_sha256)
  ) {
    errors.push("schema_sha256 is invalid");
  } else if (
    expectedSchemaSha256 !== undefined &&
    lock.schema_sha256 !== expectedSchemaSha256
  ) {
    errors.push("schema_sha256 does not match the canonical schema");
  }
  if (
    typeof lock.policy_sha256 !== "string" ||
    !SHA256.test(lock.policy_sha256)
  ) {
    errors.push("policy_sha256 is invalid");
  } else if (
    expectedPolicySha256 !== undefined &&
    lock.policy_sha256 !== expectedPolicySha256
  ) {
    errors.push("policy_sha256 does not match the canonical policy");
  }
  if (
    typeof lock.repository !== "string" ||
    !REPOSITORY.test(lock.repository)
  ) {
    errors.push("repository is invalid");
  }
  if (!Array.isArray(lock.dependencies)) {
    errors.push("dependencies must be an array");
  }
  if (!Array.isArray(lock.owned_artifacts)) {
    errors.push("owned_artifacts must be an array");
  }
  if (
    Array.isArray(lock.dependencies) &&
    Array.isArray(lock.owned_artifacts) &&
    lock.dependencies.length + lock.owned_artifacts.length === 0
  ) {
    errors.push("at least one dependency or owned artifact is required");
  }
  const seenArtifacts = new Set();
  for (const section of ["dependencies", "owned_artifacts"]) {
    const pins = lock[section];
    if (!Array.isArray(pins)) {
      continue;
    }
    for (const [index, pin] of pins.entries()) {
      validatePin(pin, section, lock.repository, index, errors);
      if (
        pin !== null &&
        typeof pin === "object" &&
        typeof pin.artifact === "string"
      ) {
        if (seenArtifacts.has(pin.artifact)) {
          errors.push(`artifact ${pin.artifact} is pinned more than once`);
        }
        seenArtifacts.add(pin.artifact);
      }
    }
  }
  return errors;
}

export function assertValidContractLock(lock, options) {
  const errors = validateContractLock(lock, options);
  if (errors.length > 0) {
    throw new Error(`Invalid contract lock:\n- ${errors.join("\n- ")}`);
  }
}
