import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const maxFixtureBytes = 64 * 1024;

const fixtureSets = [
  {
    name: "harness",
    root: "packages/harnesses/fixtures",
    manifest: "packages/harnesses/fixtures/manifest.json",
  },
  {
    name: "Telegram",
    root: "packages/core/fixtures/telegram",
    manifest: "packages/core/fixtures/telegram/manifest.json",
  },
  {
    name: "interaction protocol",
    root: "packages/protocol/fixtures/interactions",
    manifest: "packages/protocol/fixtures/interactions/manifest.json",
  },
];

const forbiddenText = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/, "Telegram bot token"],
  [/\bgh[pousr]_[A-Za-z0-9]{12,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/, "OpenAI API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\/Users\/[^./\s"][^\s"]*/, "macOS user path"],
  [/\/home\/[^./\s"][^\s"]*/, "Linux user path"],
  [/[A-Za-z]:\\Users\\[^\\\s"]+/i, "Windows user path"],
  [
    /AGENT_RELAY_TELEGRAM_(?:CHAT_ID|OPERATOR_ID)\s*=\s*-?\d+/,
    "numeric Telegram identity",
  ],
];

const sensitiveKey =
  /(?:^|_)(?:token|secret|password|api[_-]?key|authorization|cookie)(?:$|_)/i;

function fail(message) {
  throw new Error(`Fixture boundary violation: ${message}`);
}

function displayPath(path, baseRoot = root) {
  return relative(baseRoot, path).split(sep).join("/");
}

export async function readFixtureJson(
  path,
  { baseRoot = root, maxBytes = maxFixtureBytes } = {},
) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    fail(`${displayPath(path, baseRoot)} must not be a symlink`);
  }
  if (!metadata.isFile()) {
    fail(`${displayPath(path, baseRoot)} must be a regular file`);
  }
  if (metadata.size > maxBytes) {
    fail(
      `${displayPath(path, baseRoot)} is ${String(metadata.size)} bytes; maximum is ${String(maxBytes)}`,
    );
  }

  const source = await readFile(path, "utf8");
  for (const [pattern, label] of forbiddenText) {
    if (pattern.test(source)) {
      fail(`${displayPath(path, baseRoot)} contains a forbidden ${label}`);
    }
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${displayPath(path, baseRoot)} is not valid JSON`, {
      cause: error,
    });
  }
  assertNoSensitiveValues(value, displayPath(path, baseRoot));
  return value;
}

function assertNoSensitiveValues(value, path, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoSensitiveValues(entry, path, [...segments, String(index)]);
    });
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const location = [...segments, key].join(".");
    if (
      sensitiveKey.test(key) &&
      entry !== null &&
      entry !== "" &&
      (!Array.isArray(entry) || entry.length > 0)
    ) {
      fail(`${path} contains a populated sensitive key at ${location}`);
    }
    assertNoSensitiveValues(entry, path, [...segments, key]);
  }
}

export async function collectJsonFiles(directory, fixtureRoot = directory) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) {
    fail(`${displayPath(directory)} must not be a symlink`);
  }
  if (!metadata.isDirectory()) {
    fail(`${displayPath(directory)} must be a directory`);
  }

  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`${displayPath(path)} must not be a symlink`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path, fixtureRoot)));
      continue;
    }
    if (entry.isFile()) {
      if (!entry.name.endsWith(".json")) {
        fail(`${displayPath(path)} is not a JSON fixture`);
      }
      files.push(relative(fixtureRoot, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

export function fixtureInventory(manifest, manifestPath) {
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    fail(`${manifestPath} must contain a non-empty fixtures inventory`);
  }

  const inventory = manifest.fixtures.map((entry, index) => {
    const file =
      typeof entry === "string"
        ? entry
        : entry !== null && typeof entry === "object"
          ? entry.file
          : undefined;
    if (typeof file !== "string" || file.length === 0) {
      fail(`${manifestPath} fixture ${String(index)} must name a file`);
    }
    if (
      isAbsolute(file) ||
      file.includes("\\") ||
      file === "manifest.json" ||
      file.split("/").includes("..") ||
      file.startsWith("./")
    ) {
      fail(`${manifestPath} contains an unsafe fixture path: ${file}`);
    }
    return file;
  });

  if (new Set(inventory).size !== inventory.length) {
    fail(`${manifestPath} contains a duplicate fixture entry`);
  }
  return inventory.sort();
}

export function assertManifestMetadata(manifest, manifestPath) {
  const date = manifest.recordedAt ?? manifest.capturedAt;
  if (typeof date !== "string" || Number.isNaN(Date.parse(date))) {
    fail(`${manifestPath} must record a valid observation date`);
  }

  const hasSource =
    (typeof manifest.source === "string" && manifest.source.length > 0) ||
    (manifest.sources !== null &&
      typeof manifest.sources === "object" &&
      Object.keys(manifest.sources).length > 0);
  if (!hasSource) {
    fail(`${manifestPath} must record its primary source`);
  }

  const hasVersion =
    ["sourceVersion", "contractVersion", "botApiVersion"].some(
      (key) =>
        typeof manifest[key] === "string" && manifest[key].trim().length > 0,
    ) ||
    (manifest.localObservations !== null &&
      typeof manifest.localObservations === "object" &&
      Object.keys(manifest.localObservations).length > 0);
  if (!hasVersion) {
    fail(`${manifestPath} must record an exact contract or provider version`);
  }

  const evidence = manifest.evidence ?? manifest.payloadEvidence;
  if (typeof evidence !== "string" || evidence.trim().length === 0) {
    fail(`${manifestPath} must record an evidence class`);
  }
  if (
    typeof manifest.privacy !== "string" ||
    manifest.privacy.trim().length === 0
  ) {
    fail(`${manifestPath} must record fixture privacy and sanitization`);
  }
}

export async function checkRepositoryFixtures() {
  let fixtureCount = 0;
  for (const fixtureSet of fixtureSets) {
    const fixtureRoot = resolve(root, fixtureSet.root);
    const manifestPath = resolve(root, fixtureSet.manifest);
    const manifest = await readFixtureJson(manifestPath);
    assertManifestMetadata(manifest, fixtureSet.manifest);

    const inventory = fixtureInventory(manifest, fixtureSet.manifest);
    const actual = (await collectJsonFiles(fixtureRoot)).filter(
      (path) => path !== "manifest.json",
    );
    if (JSON.stringify(inventory) !== JSON.stringify(actual)) {
      fail(
        `${fixtureSet.manifest} inventory differs from disk\nexpected: ${actual.join(", ")}\nrecorded: ${inventory.join(", ")}`,
      );
    }

    for (const path of actual) {
      await readFixtureJson(resolve(fixtureRoot, path));
    }
    fixtureCount += actual.length;
  }

  process.stdout.write(
    `Fixture boundary verified (${String(fixtureSets.length)} manifests, ${String(fixtureCount)} sanitized JSON fixtures, ${String(maxFixtureBytes)}-byte limit).\n`,
  );
  return { fixtureCount, manifestCount: fixtureSets.length };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await checkRepositoryFixtures();
}
