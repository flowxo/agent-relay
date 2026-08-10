import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { env, execPath, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { assertValidContractLock, EXACT_SEMVER } from "./contract-lock.mjs";
import { compileContractLockSchema } from "./json-schema.mjs";

export const CANONICAL_SCHEMA_SHA256 =
  "6b756359081039710b7a3a9f0c88ad1de033480252096fa35af529a20c00f73f";
export const CANONICAL_POLICY_SHA256 =
  "555cdfd33ef52c796928d04404b71f1d0c2567af593f1ba024a40b3949eb54e1";
export const CONTRACT_CHECK_RESULT_SCHEMA_SHA256 =
  "a28b5432904413bdef7d88af1818f0c31c210ceb1103d0391e193930700f8688";
export const WHOOSHBANG_OWNER = "whooshbang";
export const WHOOSHBANG_SOURCE_REPOSITORY = "flowxo/whooshbang";
export const WHOOSHBANG_BASE_SOURCE_COMMIT =
  "50de931fed8d819d1a70ec27201351b09f0ef251";
export const WHOOSHBANG_MOCK_SOURCE_COMMIT =
  "50de931fed8d819d1a70ec27201351b09f0ef251";
// The three artifacts no longer share one release candidate number, so each
// carries its own exact version. The mock's scenario corpus is versioned
// separately again: it is generated against a contract candidate and is not
// re-stamped when a later additive candidate ships.
export const WHOOSHBANG_CONTRACTS_VERSION = "1.0.0-rc.12";
export const WHOOSHBANG_SDK_VERSION = "1.0.0-rc.13";
export const WHOOSHBANG_MOCK_VERSION = "1.0.0-rc.15";
export const WHOOSHBANG_MOCK_SCENARIO_CONTRACT_VERSION = "1.0.0-rc.12";
export const WHOOSHBANG_CONTRACTS_ARTIFACT = "@whooshbang/contracts";
export const WHOOSHBANG_SDK_ARTIFACT = "@whooshbang/sdk";
export const WHOOSHBANG_MOCK_ARTIFACT = "@whooshbang/contract-mock";
export const WHOOSHBANG_ARTIFACT_SCOPE = "@whooshbang/";
export const WHOOSHBANG_VENDOR_DIRECTORY = "vendor/whooshbang-rc12-rc13-rc15";
export const WHOOSHBANG_VENDOR_MANIFEST_SCHEMA =
  "agent-relay.whooshbang-artifacts.v2";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const EXPECTED_DEPENDENCIES = [
  {
    artifact: WHOOSHBANG_CONTRACTS_ARTIFACT,
    version: WHOOSHBANG_CONTRACTS_VERSION,
    artifact_file: `${WHOOSHBANG_VENDOR_DIRECTORY}/whooshbang-contracts-1.0.0-rc.12.tgz`,
    source_commit: WHOOSHBANG_BASE_SOURCE_COMMIT,
    sha256: "4b428d1d9094ea78e136084d56831a4c8bdee97b1c40e569cde5787ea176c2dd",
    fixture_version: WHOOSHBANG_CONTRACTS_VERSION,
    fixture_sets: [
      "core-api-bodies",
      "core-semantic-scenarios",
      "interaction-message-api-bodies",
      "interaction-contract-bodies",
      "machine-api-bodies",
      "provider-capability-bodies",
      "interaction-machine-semantic-scenarios",
      "customer-event-bodies",
      "webhook-signing-vectors",
      "webhook-delivery-cases",
      "core-fixture-index",
    ],
  },
  {
    artifact: WHOOSHBANG_SDK_ARTIFACT,
    version: WHOOSHBANG_SDK_VERSION,
    artifact_file: `${WHOOSHBANG_VENDOR_DIRECTORY}/whooshbang-sdk-1.0.0-rc.13.tgz`,
    source_commit: WHOOSHBANG_BASE_SOURCE_COMMIT,
    sha256: "c3e67296c392f54b4d432d0bb57c70a6b8d031b1acdb17c44a2cb79626afefec",
    fixture_version: WHOOSHBANG_SDK_VERSION,
    fixture_sets: [],
  },
  {
    artifact: WHOOSHBANG_MOCK_ARTIFACT,
    version: WHOOSHBANG_MOCK_VERSION,
    artifact_file: `${WHOOSHBANG_VENDOR_DIRECTORY}/whooshbang-contract-mock-1.0.0-rc.15.tgz`,
    source_commit: WHOOSHBANG_MOCK_SOURCE_COMMIT,
    sha256: "27ce251f6dfc283bf4eecfcb782bd577eba9d13751de63d032bad7ab733918b7",
    fixture_version: WHOOSHBANG_MOCK_SCENARIO_CONTRACT_VERSION,
    fixture_sets: ["contract-mock-scenarios.v1"],
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, label) {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaErrors(validate) {
  return (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath || "/"} ${error.keyword}: ${error.message ?? "invalid"}`,
  );
}

function assertRepositoryPath(root, artifactFile) {
  const artifactPath = resolve(root, artifactFile);
  const repositoryRelative = relative(root, artifactPath);
  if (
    repositoryRelative === "" ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error("Artifact path leaves the consumer repository.");
  }
  return artifactPath;
}

function assertWhooshBangTopology(lock) {
  if (lock.repository !== "flowxo/agent-relay") {
    throw new Error("Contract lock does not identify flowxo/agent-relay.");
  }
  if (!sameJson(lock.owned_artifacts, [])) {
    throw new Error("Agent Relay must not claim a C0 owned artifact.");
  }
  if (lock.dependencies.length !== EXPECTED_DEPENDENCIES.length) {
    throw new Error("WhooshBang lock must contain exactly three artifacts.");
  }

  for (const [index, expected] of EXPECTED_DEPENDENCIES.entries()) {
    const pin = lock.dependencies[index];
    const fixtureSets = expected.fixture_sets.map((id) => ({
      id,
      version: expected.fixture_version,
    }));
    if (
      pin.owner !== WHOOSHBANG_OWNER ||
      pin.artifact !== expected.artifact ||
      pin.version !== expected.version ||
      pin.source_repository !== WHOOSHBANG_SOURCE_REPOSITORY ||
      pin.source_commit !== expected.source_commit ||
      pin.sha256 !== expected.sha256 ||
      pin.artifact_file !== expected.artifact_file ||
      !sameJson(pin.fixture_sets, fixtureSets)
    ) {
      throw new Error(
        `WhooshBang lock inventory drifted at dependency ${String(index)}.`,
      );
    }
  }
}

const PRODUCTION_IMPORT_RULES = [
  /(?:from|import)\s*["'][^"']*(?:store|sqlite|telegram|cloudflare|apps\/relay)[^"']*["']/iu,
  /(?:from|import)\s*["']node:/u,
  /(?:\.\.\/){2,}(?:whooshbang|flowxo-whooshbang|agent-relay)/u,
  /from\s*["']@agent-relay\/core["']/u,
];

export function productionBoundaryViolations(source) {
  return PRODUCTION_IMPORT_RULES.filter((rule) => rule.test(source)).map(
    (rule) => rule.source,
  );
}

async function productionSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionSourceFiles(path)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

export async function verifyWhooshBangProductionBoundary(
  root = repositoryRoot,
) {
  const sourceDirectory = resolve(root, "packages/whooshbang-transport/src");
  for (const path of await productionSourceFiles(sourceDirectory)) {
    const source = await readFile(path, "utf8");
    if (productionBoundaryViolations(source).length > 0) {
      throw new Error(
        `Production boundary import violation in ${relative(root, path)}.`,
      );
    }
  }
}

export async function loadWhooshBangContractLock(root = repositoryRoot) {
  const lockPath = resolve(root, "contracts/contract-lock.json");
  const schemaPath = resolve(root, "contracts/contract-lock.schema.json");
  const policyPath = resolve(root, "contracts/compatibility-policy.json");
  const [lockBytes, schemaBytes, policyBytes] = await Promise.all([
    readFile(lockPath),
    readFile(schemaPath),
    readFile(policyPath),
  ]);
  const schemaDigest = sha256(schemaBytes);
  const policyDigest = sha256(policyBytes);
  if (schemaDigest !== CANONICAL_SCHEMA_SHA256) {
    throw new Error("Local contract-lock schema digest is not canonical.");
  }
  if (policyDigest !== CANONICAL_POLICY_SHA256) {
    throw new Error("Local compatibility-policy digest is not canonical.");
  }

  const schema = parseJson(schemaBytes, "Contract-lock schema");
  const validateSchema = compileContractLockSchema(schema);
  const lock = parseJson(lockBytes, "Contract lock");

  // JSON Schema validation intentionally precedes the independent semantic
  // validator. This catches drift between the executable schema and helper.
  if (!validateSchema(lock)) {
    throw new Error(
      `Invalid contract lock schema:\n- ${schemaErrors(validateSchema).join("\n- ")}`,
    );
  }
  assertValidContractLock(lock, {
    expectedSchemaSha256: schemaDigest,
    expectedPolicySha256: policyDigest,
  });

  const policy = parseJson(policyBytes, "Compatibility policy");
  if (
    policy.schema !== "flowxo.compatibility-policy.v1" ||
    policy.version !== "1.0.0"
  ) {
    throw new Error("Compatibility policy identity is invalid.");
  }
  assertWhooshBangTopology(lock);
  return { lock, policy, policyDigest, schemaDigest };
}

function parseTarString(header, start, length) {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString("utf8");
}

function parseTarOctal(header, start, length, label) {
  const bytes = header.subarray(start, start + length);
  if ((bytes[0] ?? 0) >= 0x80) {
    throw new Error(`${label} uses an unsupported tar encoding.`);
  }
  const value = bytes.toString("ascii").replace(/\0.*$/u, "").trim();
  if (value === "") {
    return 0;
  }
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`${label} is not valid octal.`);
  }
  return Number.parseInt(value, 8);
}

function assertTarChecksum(header) {
  const expected = parseTarOctal(header, 148, 8, "Tar checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new Error("Archive tar checksum is invalid.");
  }
}

function normalizedArchivePath(path, directory) {
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 1024 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\\") ||
    !/^[A-Za-z0-9@+._/-]+$/u.test(normalized) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    segments[0] !== "package"
  ) {
    throw new Error("Archive contains an unsafe member path.");
  }
  return normalized;
}

export function isSecretLikeArchivePath(path) {
  return path.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    return (
      /^\.env(?:\..*)?$/u.test(lower) ||
      /^(?:\.npmrc|\.pnpmrc|\.yarnrc|credentials?\.json|secrets?\.json|tokens?\.json)$/u.test(
        lower,
      ) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(lower) ||
      /\.(?:key|pem|p12|pfx)$/u.test(lower) ||
      /(?:^|[-_.])(?:private[-_.]?key|api[-_.]?key|access[-_.]?token|auth[-_.]?token|client[-_.]?secret)(?:[-_.]|$)/u.test(
        lower,
      )
    );
  });
}

export function readSafeTarGzip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Artifact archive is missing or exceeds the size limit.");
  }
  let tar;
  try {
    tar = gunzipSync(bytes, {
      maxOutputLength: MAX_UNCOMPRESSED_ARCHIVE_BYTES,
    });
  } catch {
    throw new Error("Artifact is not a bounded gzip archive.");
  }

  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return entries;
    }
    assertTarChecksum(header);
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const type = String.fromCharCode(header[156] || 0x30);
    const directory = type === "5";
    if (type !== "0" && !directory) {
      throw new Error("Archive contains an unsupported member type.");
    }
    const path = normalizedArchivePath(
      prefix === "" ? name : `${prefix}/${name}`,
      directory,
    );
    if (isSecretLikeArchivePath(path)) {
      throw new Error("Archive contains a secret-like member path.");
    }
    if (entries.has(path)) {
      throw new Error("Archive contains a duplicate member path.");
    }
    const size = parseTarOctal(header, 124, 12, "Tar member size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length || (directory && size !== 0)) {
      throw new Error("Archive member size is invalid.");
    }
    entries.set(path, {
      data: tar.subarray(dataStart, dataEnd),
      directory,
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("Archive does not contain a complete tar terminator.");
}

function requiredFile(entries, path, label) {
  const entry = entries.get(path);
  if (entry === undefined || entry.directory) {
    throw new Error(`${label} is missing from the artifact.`);
  }
  return entry.data;
}

function fixtureIdentity(fixtureSets) {
  return fixtureSets.map(({ id, version }) => ({ id, version }));
}

function assertContractFixtures(entries, pin) {
  const manifest = parseJson(
    requiredFile(
      entries,
      "package/contract-manifest.json",
      "Contract manifest",
    ),
    "Contract manifest",
  );
  if (
    manifest.schema !== "flowxo.contract-manifest.v1" ||
    manifest.artifact !== pin.artifact ||
    manifest.version !== pin.version ||
    !sameJson(fixtureIdentity(manifest.fixture_sets ?? []), pin.fixture_sets)
  ) {
    throw new Error(
      "Contract artifact fixture identity does not match the lock.",
    );
  }
  for (const fixtureSet of manifest.fixture_sets) {
    if (
      typeof fixtureSet.schema !== "string" ||
      !entries.has(`package/${fixtureSet.schema}`) ||
      !Array.isArray(fixtureSet.fixtures)
    ) {
      throw new Error("Contract fixture manifest references missing content.");
    }
    for (const fixture of fixtureSet.fixtures) {
      if (typeof fixture !== "string" || !entries.has(`package/${fixture}`)) {
        throw new Error(
          "Contract fixture manifest references missing content.",
        );
      }
    }
  }
}

function assertMockFixtures(entries, pin) {
  const manifest = parseJson(
    requiredFile(
      entries,
      "package/scenarios/v1/manifest.json",
      "Mock scenario manifest",
    ),
    "Mock scenario manifest",
  );
  const identity = [
    {
      id: manifest.schema,
      version: manifest.contract_version,
    },
  ];
  // The mock package version and its scenario corpus version are independent.
  // The corpus records the contract candidate it was generated against, so it
  // is pinned to its own expected value rather than to the package version.
  if (
    manifest.schema !== "contract-mock-scenarios.v1" ||
    manifest.contract_version !== WHOOSHBANG_MOCK_SCENARIO_CONTRACT_VERSION ||
    !sameJson(identity, pin.fixture_sets)
  ) {
    throw new Error("Mock artifact fixture identity does not match the lock.");
  }
  if (
    !Array.isArray(manifest.scenarios) ||
    new Set(manifest.scenarios).size !== manifest.scenarios.length ||
    manifest.scenarios.some(
      (scenario) =>
        typeof scenario !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(scenario),
    ) ||
    !manifest.scenarios.includes("cross-machine-answer-origin")
  ) {
    throw new Error(
      "Mock artifact is missing the cross-machine answer-origin scenario.",
    );
  }
}

// A published tarball's devDependencies never enter a consumer's installed
// closure, so a WhooshBang-scoped one need not be in this lock; the mock
// dev-depends on `@whooshbang/mcp`, which WhooshBang deliberately keeps out of
// every consumer lock. Every other rule still applies to all four sections, and
// `assertInstalledClosure` proves after installation that nothing outside the
// locked set actually materialized.
const INSTALLED_DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const DECLARED_DEPENDENCY_SECTIONS = [
  ...INSTALLED_DEPENDENCY_SECTIONS,
  "devDependencies",
];

function assertDependencyPins(packageJson, lock) {
  const lockedVersions = new Map(
    lock.dependencies.map((pin) => [pin.artifact, pin.version]),
  );
  for (const section of DECLARED_DEPENDENCY_SECTIONS) {
    const dependencies = packageJson[section] ?? {};
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      throw new Error(`Artifact ${section} metadata is invalid.`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
        throw new Error("Artifact contains a mutable transitive dependency.");
      }
      if (
        name.startsWith(WHOOSHBANG_ARTIFACT_SCOPE) &&
        INSTALLED_DEPENDENCY_SECTIONS.includes(section)
      ) {
        const lockedVersion = lockedVersions.get(name);
        if (lockedVersion === undefined || lockedVersion !== version) {
          throw new Error(
            "Artifact contains an unpinned WhooshBang dependency.",
          );
        }
      }
      if (name.startsWith("@flowxo/")) {
        throw new Error(
          "Artifact depends on a retired FlowXO package identity.",
        );
      }
    }
  }
}

export function inspectLockedArtifact({ bytes, lock, pin }) {
  const digest = sha256(bytes);
  if (digest !== pin.sha256) {
    throw new Error(`Digest mismatch for ${pin.artifact}.`);
  }
  const entries = readSafeTarGzip(bytes);
  const packageJson = parseJson(
    requiredFile(entries, "package/package.json", "Package metadata"),
    "Package metadata",
  );
  if (
    packageJson.name !== pin.artifact ||
    packageJson.version !== pin.version
  ) {
    throw new Error(`Package identity mismatch for ${pin.artifact}.`);
  }
  if (
    ["preinstall", "install", "postinstall"].some(
      (name) => packageJson.scripts?.[name] !== undefined,
    )
  ) {
    throw new Error(`Install-time script in ${pin.artifact}.`);
  }
  assertDependencyPins(packageJson, lock);

  if (pin.artifact === WHOOSHBANG_CONTRACTS_ARTIFACT) {
    assertContractFixtures(entries, pin);
  } else if (pin.artifact === WHOOSHBANG_MOCK_ARTIFACT) {
    assertMockFixtures(entries, pin);
  } else if (!sameJson(pin.fixture_sets, [])) {
    throw new Error("SDK artifact must not claim a fixture set.");
  }
  return { bytes, packageJson, pin };
}

export async function preflightArtifactsBeforeInstall({
  artifacts,
  install,
  lock,
}) {
  const inspected = artifacts.map(({ bytes, pin }) =>
    inspectLockedArtifact({ bytes, lock, pin }),
  );
  await install(inspected);
  return inspected;
}

async function assertVendorArtifactManifest(root, lock) {
  const manifest = parseJson(
    await readFile(
      resolve(root, `${WHOOSHBANG_VENDOR_DIRECTORY}/artifacts.json`),
    ),
    "WhooshBang artifact manifest",
  );
  // The set spans three release candidate numbers, so the manifest records the
  // version and full producer commit per artifact instead of one set-wide pair.
  const expected = lock.dependencies.map((pin) => ({
    package: pin.artifact,
    version: pin.version,
    sourceCommit: pin.source_commit,
    file: basename(pin.artifact_file),
    sha256: pin.sha256,
  }));
  if (
    manifest.schema !== WHOOSHBANG_VENDOR_MANIFEST_SCHEMA ||
    manifest.sourceRepository !== WHOOSHBANG_SOURCE_REPOSITORY ||
    !sameJson(manifest.artifacts, expected)
  ) {
    throw new Error(
      "WhooshBang vendor artifact manifest drifted from the contract lock.",
    );
  }
}

// Proves the installed WhooshBang closure is exactly the locked set, so an
// unlocked WhooshBang-scoped devDependency declared by an artifact cannot reach
// a consumer without failing this gate.
async function assertInstalledClosure(directory, inspected) {
  const scopeDirectory = resolve(
    directory,
    "node_modules",
    WHOOSHBANG_ARTIFACT_SCOPE.replace(/\/$/u, ""),
  );
  const installed = (await readdir(scopeDirectory)).sort();
  const locked = inspected
    .map(({ pin }) => pin.artifact.slice(WHOOSHBANG_ARTIFACT_SCOPE.length))
    .sort();
  if (!sameJson(installed, locked)) {
    throw new Error(
      "Fresh install resolved a WhooshBang package outside the lock.",
    );
  }
}

async function freshPnpmInstall(inspected) {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-whooshbang-contract-"),
  );
  try {
    const artifactsDirectory = resolve(directory, "artifacts");
    await mkdir(artifactsDirectory);
    const dependencies = {};
    for (const artifact of inspected) {
      const file = basename(artifact.pin.artifact_file);
      await writeFile(resolve(artifactsDirectory, file), artifact.bytes);
      dependencies[artifact.pin.artifact] = `file:artifacts/${file}`;
    }
    await writeFile(
      resolve(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "agent-relay-whooshbang-contract-install",
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@11.17.0",
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    const contractsArtifact = inspected.find(
      ({ pin }) => pin.artifact === WHOOSHBANG_CONTRACTS_ARTIFACT,
    );
    if (contractsArtifact === undefined) {
      throw new Error("Fresh install is missing the contracts artifact.");
    }
    await writeFile(
      resolve(directory, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "."',
        "",
        "overrides:",
        `  "${WHOOSHBANG_CONTRACTS_ARTIFACT}@${contractsArtifact.pin.version}": "file:artifacts/${basename(
          contractsArtifact.pin.artifact_file,
        )}"`,
        "",
      ].join("\n"),
    );
    execFileSync(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--offline",
        "--lockfile=false",
        "--reporter=append-only",
      ],
      {
        cwd: directory,
        env: {
          ...env,
          npm_config_engine_strict: "false",
        },
        stdio: "pipe",
      },
    );
    await assertInstalledClosure(directory, inspected);
    for (const artifact of inspected) {
      const packageJson = parseJson(
        await readFile(
          resolve(
            directory,
            "node_modules",
            artifact.pin.artifact,
            "package.json",
          ),
        ),
        "Installed package metadata",
      );
      if (
        packageJson.name !== artifact.pin.artifact ||
        packageJson.version !== artifact.pin.version
      ) {
        throw new Error("Fresh install package identity mismatch.");
      }
    }
    execFileSync(
      execPath,
      [
        "--input-type=module",
        "--eval",
        'await Promise.all(["@whooshbang/contracts","@whooshbang/sdk","@whooshbang/contract-mock"].map((name) => import(name)));',
      ],
      { cwd: directory, stdio: "pipe" },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Fresh install package identity mismatch." ||
        error.message === "Fresh install is missing the contracts artifact." ||
        error.message ===
          "Fresh install resolved a WhooshBang package outside the lock.")
    ) {
      throw error;
    }
    throw new Error("Fresh pnpm install with scripts disabled failed.", {
      cause: error,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export function whooshbangConsumerCommit(root = repositoryRoot) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Consumer commit identity is unavailable.");
  }
  return commit;
}

const RESULT_KEYS = new Set([
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
const RESULT_ARTIFACT_KEYS = new Set([
  "owner",
  "artifact",
  "version",
  "source_repository",
  "source_commit",
  "sha256",
  "fixture_sets",
]);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

export function assertWhooshBangCheckResult(result) {
  if (!exactKeys(result, RESULT_KEYS)) {
    throw new Error("Contract check result fields are invalid.");
  }
  if (
    result.schema !== "flowxo.contract-check-result.v1" ||
    result.result_schema_sha256 !== CONTRACT_CHECK_RESULT_SCHEMA_SHA256 ||
    result.repository !== "flowxo/agent-relay" ||
    !/^[0-9a-f]{40}$/u.test(result.consumer_commit) ||
    result.command !== "pnpm contracts:whooshbang" ||
    result.status !== "pass" ||
    result.lock_schema_sha256 !== CANONICAL_SCHEMA_SHA256 ||
    result.compatibility_policy_sha256 !== CANONICAL_POLICY_SHA256
  ) {
    throw new Error("Contract check result identity is invalid.");
  }
  if (
    !Array.isArray(result.artifacts) ||
    result.artifacts.length !== EXPECTED_DEPENDENCIES.length ||
    result.artifacts.some(
      (artifact) =>
        !exactKeys(artifact, RESULT_ARTIFACT_KEYS) ||
        !Array.isArray(artifact.fixture_sets),
    )
  ) {
    throw new Error("Contract check result artifacts are invalid.");
  }
  if (
    !Array.isArray(result.checks) ||
    result.checks.length === 0 ||
    new Set(result.checks).size !== result.checks.length ||
    result.checks.some(
      (check) =>
        typeof check !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(check),
    )
  ) {
    throw new Error("Contract check result checks are invalid.");
  }
}

export function buildWhooshBangCheckResult({
  consumerCommit,
  lock,
  policyDigest,
  schemaDigest,
}) {
  const result = {
    schema: "flowxo.contract-check-result.v1",
    result_schema_sha256: CONTRACT_CHECK_RESULT_SCHEMA_SHA256,
    repository: "flowxo/agent-relay",
    consumer_commit: consumerCommit,
    command: "pnpm contracts:whooshbang",
    status: "pass",
    lock_schema_sha256: schemaDigest,
    compatibility_policy_sha256: policyDigest,
    artifacts: lock.dependencies.map((pin) => ({
      owner: pin.owner,
      artifact: pin.artifact,
      version: pin.version,
      source_repository: pin.source_repository,
      source_commit: pin.source_commit,
      sha256: pin.sha256,
      fixture_sets: pin.fixture_sets,
    })),
    checks: [
      "ajv-lock-schema",
      "semantic-lock-validator",
      "canonical-schema-policy-digests",
      "exact-whooshbang-topology",
      "vendor-provenance-manifest",
      "no-retired-flowxo-package-identity",
      "artifact-digests",
      "safe-archive-members",
      "package-identity-transitive-pins",
      "no-install-lifecycle",
      "no-secret-like-paths",
      "fresh-pnpm-install-ignore-scripts",
      "installed-closure-is-exactly-locked",
      "production-import-boundary",
      "whooshbang-consumer",
      "acknowledged-event-omission",
      "acknowledgement-replay-existing",
      "consumer-mapping-temporal-behavior",
      "cross-machine-answer-origin",
      "unknown-additive-tolerance",
    ],
  };
  assertWhooshBangCheckResult(result);
  return result;
}

export async function writeWhooshBangCheckResult(root = repositoryRoot) {
  const { lock, policyDigest, schemaDigest } =
    await loadWhooshBangContractLock(root);
  const result = buildWhooshBangCheckResult({
    consumerCommit: whooshbangConsumerCommit(root),
    lock,
    policyDigest,
    schemaDigest,
  });
  const resultSchemaBytes = await readFile(
    resolve(root, "contracts/contract-check-result.schema.json"),
  );
  if (sha256(resultSchemaBytes) !== CONTRACT_CHECK_RESULT_SCHEMA_SHA256) {
    throw new Error(
      "Local contract-check result schema digest is not canonical.",
    );
  }
  const validateResult = compileContractLockSchema(
    parseJson(resultSchemaBytes, "Contract-check result schema"),
  );
  if (!validateResult(result)) {
    throw new Error(
      `Invalid contract check result schema:\n- ${schemaErrors(validateResult).join("\n- ")}`,
    );
  }
  const resultDirectory = resolve(root, ".contract-results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = resolve(resultDirectory, "c0-08.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return resultPath;
}

export async function verifyWhooshBangContract({
  root = repositoryRoot,
  write = (value) => stdout.write(value),
} = {}) {
  const { lock, policyDigest, schemaDigest } =
    await loadWhooshBangContractLock(root);
  await verifyWhooshBangProductionBoundary(root);
  await assertVendorArtifactManifest(root, lock);
  const artifacts = await Promise.all(
    lock.dependencies.map(async (pin) => {
      const path = assertRepositoryPath(root, pin.artifact_file);
      return { bytes: await readFile(path), pin };
    }),
  );
  const inspected = await preflightArtifactsBeforeInstall({
    artifacts,
    install: freshPnpmInstall,
    lock,
  });
  const commit = whooshbangConsumerCommit(root);
  write(
    `consumer=flowxo/agent-relay@${commit} schema_sha256=${schemaDigest} policy_sha256=${policyDigest}\n`,
  );
  for (const { pin } of inspected) {
    const fixtures =
      pin.fixture_sets.length === 0
        ? "none"
        : pin.fixture_sets
            .map(({ id, version }) => `${id}@${version}`)
            .join(",");
    write(
      `producer=${pin.source_repository}@${pin.source_commit} artifact=${pin.artifact}@${pin.version} sha256=${pin.sha256} fixtures=${fixtures}\n`,
    );
  }
  write(
    "fresh_install=pnpm@11.17.0 ignore_scripts=true packages=3 status=passed\n",
  );
}
