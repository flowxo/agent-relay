import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, posix, relative, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

import { repositoryRoot } from "./lib.mjs";

const manifestPath = resolve(
  repositoryRoot,
  "sdlc/qualification-harnesses.json",
);
const allowedOrigins = new Set([
  "https://downloads.cursor.com",
  "https://registry.npmjs.org",
]);
const { AbortSignal, fetch } = globalThis;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Qualified harness provisioning refused: ${message}`);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function validateArchiveEntries(entries, archiveRoot) {
  assert(entries.length > 0, "archive inventory is empty");
  for (const entry of entries) {
    const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const containsControlCharacter = [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
    assert(path.length > 0, "archive contains an empty path");
    assert(
      !path.startsWith("/") &&
        !path.includes("\\") &&
        !containsControlCharacter &&
        posix.normalize(path) === path &&
        path !== ".." &&
        !path.startsWith("../"),
      "archive contains an unsafe path",
    );
    assert(
      path === archiveRoot || path.startsWith(`${archiveRoot}/`),
      "archive path escapes its declared root",
    );
  }
}

export function validateManifest(manifest) {
  assert(
    manifest.schema === "agent-relay-qualified-harnesses.v1",
    "manifest schema is invalid",
  );
  assert(
    manifest.platform === "darwin" && manifest.architecture === "arm64",
    "only the frozen darwin/arm64 qualification target is supported",
  );
  assert(
    Array.isArray(manifest.harnesses) && manifest.harnesses.length === 3,
    "manifest must declare exactly three harnesses",
  );
  assert(
    JSON.stringify(manifest.harnesses.map((entry) => entry.id)) ===
      JSON.stringify(["codex", "claude", "cursor"]),
    "harness inventory is incomplete or reordered",
  );
  for (const harness of manifest.harnesses) {
    const url = new URL(harness.url);
    assert(
      allowedOrigins.has(url.origin) &&
        url.username === "" &&
        url.password === "",
      `${harness.id} download origin is not approved`,
    );
    assert(
      /^[a-f0-9]{64}$/u.test(harness.sha256),
      `${harness.id} digest is invalid`,
    );
    assert(
      Number.isSafeInteger(harness.maximumBytes) &&
        harness.maximumBytes >= 1024 &&
        harness.maximumBytes <= 256 * 1024 * 1024,
      `${harness.id} download bound is invalid`,
    );
    assert(
      /^[a-z][a-z0-9-]*$/u.test(harness.executable) &&
        harness.versionOutput.length > 0 &&
        /^[a-z0-9][a-z0-9._-]*$/u.test(harness.archiveRoot),
      `${harness.id} executable contract is invalid`,
    );
    validateArchiveEntries([harness.binary], harness.archiveRoot);
  }
  return manifest;
}

async function run(executable, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${options.label ?? "bounded command"} timed out`));
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-256_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-256_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `${options.label ?? "bounded command"} failed (${String(code ?? signal)}): ${stderr.trim()}`,
          ),
        );
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

async function download(harness, destination) {
  const response = await fetch(harness.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
  });
  assert(
    response.ok,
    `${harness.id} download returned ${String(response.status)}`,
  );
  assert(
    allowedOrigins.has(new URL(response.url).origin),
    `${harness.id} download redirected outside approved origins`,
  );
  const declaredLength = Number(response.headers.get("content-length"));
  assert(
    Number.isSafeInteger(declaredLength) &&
      declaredLength > 0 &&
      declaredLength <= harness.maximumBytes,
    `${harness.id} declared size is missing or out of bounds`,
  );
  assert(response.body !== null, `${harness.id} response has no body`);
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    assert(
      receivedBytes <= harness.maximumBytes,
      `${harness.id} download exceeded its bound`,
    );
    chunks.push(bytes);
  }
  const contents = Buffer.concat(chunks, receivedBytes);
  assert(
    contents.byteLength === declaredLength &&
      contents.byteLength <= harness.maximumBytes,
    `${harness.id} download size differs or exceeds its bound`,
  );
  assert(
    createHash("sha256").update(contents).digest("hex") === harness.sha256,
    `${harness.id} download digest differs from the reviewed artifact`,
  );
  await writeFile(destination, contents, { mode: 0o600 });
}

async function assertExtractedTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    assert(
      metadata.isDirectory() || metadata.isFile(),
      "archive extracted a link or special file",
    );
    if (metadata.isDirectory()) {
      await assertExtractedTree(path);
    }
  }
}

async function provisionHarness(harness, outputRoot, binDirectory) {
  const harnessRoot = resolve(outputRoot, harness.id);
  const archive = resolve(outputRoot, `${harness.id}.tgz`);
  await mkdir(harnessRoot, { recursive: true, mode: 0o700 });
  await download(harness, archive);
  const inventory = await run("/usr/bin/tar", ["-tzf", archive], {
    label: `${harness.id} archive inventory`,
  });
  validateArchiveEntries(
    inventory.stdout.split("\n").filter((entry) => entry.length > 0),
    harness.archiveRoot,
  );
  await run("/usr/bin/tar", ["-xzf", archive, "-C", harnessRoot], {
    label: `${harness.id} archive extraction`,
  });
  await assertExtractedTree(harnessRoot);
  const binary = resolve(harnessRoot, harness.binary);
  assert(
    relative(harnessRoot, binary).length > 0 &&
      !relative(harnessRoot, binary).startsWith(".."),
    `${harness.id} binary escapes its extraction root`,
  );
  const binaryMetadata = await lstat(binary);
  assert(binaryMetadata.isFile(), `${harness.id} binary is missing`);
  await chmod(binary, 0o700);
  await symlink(binary, resolve(binDirectory, harness.executable));
  return await realpath(binary);
}

export async function provisionQualifiedHarnesses(options = {}) {
  const manifest = validateManifest(
    JSON.parse(await readFile(options.manifestPath ?? manifestPath, "utf8")),
  );
  assert(
    process.platform === manifest.platform &&
      process.arch === manifest.architecture,
    `host is ${process.platform}/${process.arch}, expected ${manifest.platform}/${manifest.architecture}`,
  );
  const outputRoot = resolve(
    options.outputRoot ??
      resolve(repositoryRoot, ".artifacts/qualified-harnesses"),
  );
  const binDirectory = resolve(outputRoot, "bin");
  const verificationHome = resolve(outputRoot, "verification-home");
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await mkdir(verificationHome, { recursive: true, mode: 0o700 });

  const results = [];
  for (const harness of manifest.harnesses) {
    const binary = await provisionHarness(harness, outputRoot, binDirectory);
    const version = (
      await run(resolve(binDirectory, harness.executable), ["--version"], {
        cwd: verificationHome,
        env: {
          HOME: verificationHome,
          USERPROFILE: verificationHome,
          PATH: [binDirectory, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
            delimiter,
          ),
          LANG: "C",
          LC_ALL: "C",
          CI: "1",
          NO_COLOR: "1",
        },
        label: `${harness.id} inert version check`,
        timeoutMs: 15_000,
      })
    ).stdout.trim();
    assert(
      version === harness.versionOutput,
      `${harness.id} version differs from the frozen evidence record`,
    );
    results.push({ id: harness.id, version, binary });
  }

  if (options.githubPath !== undefined) {
    await writeFile(options.githubPath, `${binDirectory}\n`, { flag: "a" });
  }
  return { binDirectory, results };
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const outputRoot = argument("--output");
  assert(outputRoot !== undefined, "--output is required");
  const result = await provisionQualifiedHarnesses({
    outputRoot,
    githubPath: argument("--github-path"),
  });
  process.stdout.write(
    `${JSON.stringify({
      schema: "agent-relay-qualified-harness-provision.v1",
      target: "darwin/arm64",
      harnesses: result.results.map(({ id, version }) => ({ id, version })),
    })}\n`,
  );
}
