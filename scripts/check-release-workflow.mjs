import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { runtimeDependencyGraph } from "./lib/release-bundle.mjs";
import { assertReleaseExitConfiguration } from "./lib/release-exit-policy.mjs";
import { assertReleaseConfiguration } from "./lib/release-policy.mjs";

const root = resolve(import.meta.dirname, "..");

async function text(path) {
  return await readFile(resolve(root, path), "utf8");
}

function requireText(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(`Release workflow violation: ${message}`);
  }
}

const [ci, prerelease, releasing, thirdPartyNotices, packageSource] =
  await Promise.all([
    text(".github/workflows/ci.yml"),
    text(".github/workflows/prerelease.yml"),
    text("docs/releasing.md"),
    text("THIRD_PARTY_NOTICES.md"),
    text("package.json"),
  ]);
const rootPackage = JSON.parse(packageSource);
const release = JSON.parse(await text("packaging/release.json"));
const releaseExit = JSON.parse(await text("packaging/release-exit.json"));
const actionLock = JSON.parse(await text("packaging/actions-lock.json"));
assertReleaseConfiguration(release, rootPackage);
assertReleaseExitConfiguration(releaseExit, release);
const runtimeGraph = await runtimeDependencyGraph(root, release);
for (const dependency of runtimeGraph.packages) {
  requireText(
    thirdPartyNotices,
    new RegExp(
      `\\| \\\`${dependency.name.replaceAll("/", "\\/")}\\\`\\s*\\|\\s*${dependency.version.replaceAll(".", "\\.")}\\s*\\|`,
    ),
    `THIRD_PARTY_NOTICES.md is missing ${dependency.name}@${dependency.version}`,
  );
}

if (
  actionLock.schema !== "agent-relay-actions-lock.v1" ||
  Number.isNaN(Date.parse(actionLock.recheckedAt)) ||
  typeof actionLock.source !== "string"
) {
  throw new Error(
    "Release workflow violation: action lock metadata is invalid",
  );
}

const workflows = [
  [".github/workflows/ci.yml", ci],
  [".github/workflows/prerelease.yml", prerelease],
];
const usedActions = new Set();
for (const [path, source] of workflows) {
  const matches = source.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g);
  for (const match of matches) {
    const [, name, reference] = match;
    const locked = actionLock.actions[name];
    if (locked === undefined) {
      throw new Error(
        `Release workflow violation: ${path} uses unlocked action ${name}`,
      );
    }
    if (!/^[a-f0-9]{40}$/.test(reference) || reference !== locked.sha) {
      throw new Error(
        `Release workflow violation: ${path} does not use the locked ${name} SHA`,
      );
    }
    requireText(
      source,
      new RegExp(
        `${name.replaceAll("/", "\\/")}@${reference} # ${locked.version}`,
      ),
      `${path} must annotate ${name} with ${locked.version}`,
    );
    usedActions.add(name);
  }
}
for (const name of Object.keys(actionLock.actions)) {
  if (!usedActions.has(name)) {
    throw new Error(
      `Release workflow violation: locked action ${name} is unused`,
    );
  }
}

for (const pattern of [
  /permissions:\s*\n\s+contents: read/,
  /persist-credentials: false/,
  /pnpm install --frozen-lockfile --ignore-scripts/,
  /pnpm contracts:preinstall/,
  /pnpm rebuild/,
  /pnpm check/,
  /pnpm audit --prod/,
  /pnpm test:e2e/,
  /timeout-minutes:/,
]) {
  requireText(ci, pattern, `CI is missing ${String(pattern)}`);
}

const checkCommand = rootPackage.scripts.check;
for (const command of [
  "format:check",
  "governance:check",
  "docs:check",
  "fixtures:check",
  "secrets:check",
  "release:policy:check",
  "lint",
  "typecheck",
  "test",
  "capabilities:check",
  "contracts:notifications",
  "dist:check",
  "package:check",
  "package:hosted:check",
  "package:lifecycle:check",
]) {
  requireText(
    checkCommand,
    new RegExp(`pnpm ${command.replaceAll(":", "\\:")}`),
    `pnpm check does not include ${command}`,
  );
}

for (const pattern of [
  /workflow_dispatch:/,
  /publish:/,
  /type: boolean/,
  /default: false/,
  /tags:/,
  /pnpm install --frozen-lockfile --ignore-scripts/,
  /pnpm check/,
  /pnpm test:e2e/,
  /pnpm audit --prod/,
  /build-release\.mjs --expected-tag/,
  /actions\/upload-artifact@/,
  /actions\/download-artifact@/,
  /actions\/attest@/,
  /subject-path:/,
  /sbom-path:/,
  /attestations: write/,
  /id-token: write/,
  /environment: npm-prerelease/,
  /needs: \[build, attest\]/,
  /github\.event_name == 'workflow_dispatch' && inputs\.publish == true/,
  /publish-release\.mjs \.artifacts\/release --execute/,
  /AGENT_RELAY_REPOSITORY_VISIBILITY/,
  /persist-credentials: false/,
]) {
  requireText(
    prerelease,
    pattern,
    `prerelease workflow is missing ${String(pattern)}`,
  );
}

for (const forbidden of [
  /\bNPM_TOKEN\b/,
  /\bNODE_AUTH_TOKEN\b/,
  /\bsecrets\./,
  /npm publish/,
  /npm stage publish/,
]) {
  if (forbidden.test(prerelease)) {
    throw new Error(
      `Release workflow violation: prerelease workflow contains forbidden credential or inline registry command ${String(forbidden)}`,
    );
  }
}

if (
  release.publication.approved !== false ||
  release.publication.registryAction !== "blocked"
) {
  throw new Error(
    "Release workflow violation: first prerelease publication must remain blocked",
  );
}

for (const pattern of [
  /This story does not authorize publication/i,
  /SHA256SUMS/,
  /SPDX/,
  /gh attestation verify/,
  /exact commit/i,
  /known limitations/i,
  /upgrade/i,
  /rollback/i,
  /deprecat/i,
  /npm-prerelease/,
  /trusted publisher/i,
  /stage-only/i,
  /two-factor|2FA/i,
]) {
  requireText(
    releasing,
    pattern,
    `release guide is missing ${String(pattern)}`,
  );
}

process.stdout.write(
  `Release workflow boundary verified (${String(usedActions.size)} immutable actions, ${String(runtimeGraph.packages.length)} runtime SBOM packages, publication blocked, OIDC/attestation gates present).\n`,
);
