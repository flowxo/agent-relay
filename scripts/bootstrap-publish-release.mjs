import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertCleanGit,
  readGitBuildInfo,
  releaseArtifactNames,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";
import {
  assertBootstrapPublishContext,
  registryCredentialEnvironmentPresent,
} from "./lib/release-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const releaseBundleArgument = flag("--release-bundle") ?? ".artifacts/release";
const confirmation = flag("--confirm");
const execute = process.argv.includes("--execute");
const resumeAfterPublish = process.argv.includes("--resume-after-publish");
const knownArguments = new Set([
  "--release-bundle",
  releaseBundleArgument,
  "--confirm",
  confirmation,
  "--execute",
  "--resume-after-publish",
]);
for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) {
    throw new Error(`unknown bootstrap-publish argument: ${argument}`);
  }
}

const directory = resolve(root, releaseBundleArgument);
const expectedDirectory = resolve(root, ".artifacts/release");
if (directory !== expectedDirectory) {
  throw new Error(
    "bootstrap publication is constrained to the repository's exact ignored release-bundle path",
  );
}

function runNpm(args, { interactive = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", args, {
      cwd: root,
      env: process.env,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!interactive) {
      child.stdout.on("data", (chunk) => {
        stdout = `${stdout}${String(chunk)}`.slice(-64_000);
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-64_000);
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function npmVersion() {
  const result = await runNpm(["--version"]);
  if (result.code !== 0) {
    throw new Error("npm --version failed");
  }
  return result.stdout.trim();
}

async function packageVersionState(tarball) {
  const result = await runNpm([
    "view",
    `${release.name}@${release.version}`,
    "dist.integrity",
    "--json",
    "--registry",
    release.publication.registry,
  ]);
  if (result.code !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (/\bE404\b|\b404\b/u.test(diagnostic)) {
      return "absent";
    }
    throw new Error("npm registry package-state lookup failed closed");
  }

  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("npm registry returned an invalid integrity document", {
      cause: error,
    });
  }
  const values = Array.isArray(observed) ? observed : [observed];
  const expected = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  return values.includes(expected)
    ? "exact-artifact-present"
    : "different-artifact-present";
}

async function repositoryVisibility() {
  const response = await globalThis.fetch(
    `https://api.github.com/repos/${release.publication.trustedPublisher.repository}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "agent-relay-release-bootstrap",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error("GitHub repository-visibility lookup failed closed");
  }
  const repository = await response.json();
  return repository.full_name ===
    release.publication.trustedPublisher.repository &&
    repository.private === false
    ? "public"
    : "not-public";
}

async function requireNpmSuccess(args, label, { interactive = false } = {}) {
  const result = await runNpm(args, { interactive });
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (${String(result.code ?? result.signal)})`,
    );
  }
}

await assertCleanGit(root);
const git = await readGitBuildInfo(root, release.gitTag);
const names = releaseArtifactNames(release);
const tarball = resolve(directory, names.tarball);
await verifyReleaseBundle({
  root,
  release,
  rootPackage,
  directory,
  expectedCommit: git.commit,
});

if (!execute) {
  process.stdout.write(
    `Validated the exact ${release.name}@${release.version} bootstrap bundle without registry mutation.\n`,
  );
  process.exit(0);
}

const observedPackageState = await packageVersionState(tarball);
const action = assertBootstrapPublishContext(release, {
  githubActions: process.env.GITHUB_ACTIONS,
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirmation,
  repositoryVisibility: await repositoryVisibility(),
  tagStatus: git.intendedTagState?.status,
  nodeVersion: process.versions.node,
  npmVersion: await npmVersion(),
  credentialEnvironmentPresent: registryCredentialEnvironmentPresent(
    process.env,
  ),
  packageVersionState: observedPackageState,
  resumeAfterPublish,
});

let primaryError;
try {
  if (action === "publish-and-trust") {
    await requireNpmSuccess(
      [
        "publish",
        tarball,
        "--tag",
        release.distTag,
        "--access",
        "public",
        "--registry",
        release.publication.registry,
      ],
      "interactive initial npm publish",
      { interactive: true },
    );
  }

  await requireNpmSuccess(
    [
      "trust",
      "github",
      release.name,
      "--file",
      release.publication.trustedPublisher.workflow,
      "--repository",
      release.publication.trustedPublisher.repository,
      "--environment",
      release.publication.trustedPublisher.environment,
      "--allow-publish",
      "--registry",
      release.publication.registry,
    ],
    "npm trusted-publisher configuration",
    { interactive: true },
  );
  await requireNpmSuccess(
    [
      "trust",
      "list",
      release.name,
      "--json",
      "--registry",
      release.publication.registry,
    ],
    "npm trusted-publisher verification",
  );
} catch (error) {
  primaryError = error;
}

let logoutError;
try {
  await requireNpmSuccess(
    ["logout", "--registry", release.publication.registry],
    "npm session cleanup",
    { interactive: true },
  );
} catch (error) {
  logoutError = error;
}

if (primaryError !== undefined || logoutError !== undefined) {
  const recovery =
    observedPackageState === "absent"
      ? " If the package was created, rerun with --resume-after-publish after restoring an interactive 2FA session."
      : "";
  throw new Error(
    `${primaryError?.message ?? "Registry bootstrap completed"}; ${logoutError?.message ?? "npm session cleanup completed"}.${recovery}`,
  );
}

process.stdout.write(
  `Published or recovered ${release.name}@${release.version}, configured its exact trusted publisher, verified the relationship, and ended the npm session.\n`,
);
