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

const [
  ci,
  prerelease,
  bootstrapPublish,
  releasePolicy,
  releasing,
  thirdPartyNotices,
  packageSource,
] = await Promise.all([
  text(".github/workflows/ci.yml"),
  text(".github/workflows/prerelease.yml"),
  text("scripts/bootstrap-publish-release.mjs"),
  text("scripts/lib/release-policy.mjs"),
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
for (const component of release.bundledComponents) {
  requireText(
    thirdPartyNotices,
    new RegExp(
      `\\| \\\`${component.name.replaceAll("/", "\\/")}\\\`\\s*\\|\\s*${component.version.replaceAll(".", "\\.")}\\s*\\|`,
    ),
    `THIRD_PARTY_NOTICES.md is missing bundled ${component.name}@${component.version}`,
  );
}
requireText(
  thirdPartyNotices,
  /WhooshBang[\s\S]*MIT[\s\S]*Copyright \(c\) 2026 Flow XO, LLC/i,
  "bundled component licensing must preserve the approved MIT notice",
);

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
  /pnpm release:bundle/,
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
  "contracts:whooshbang",
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
  /AGENT_RELAY_TRUSTED_PUBLISHER_CONFIGURED/,
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
  release.publication.initialPublish?.mode !== "interactive-2fa-bootstrap" ||
  (release.publication.approved === true
    ? release.publication.registryAction !== "publish"
    : release.publication.registryAction !== "blocked")
) {
  throw new Error(
    "Release workflow violation: prerelease publication decision differs",
  );
}

for (const pattern of [
  /assertBootstrapPublishContext/,
  /assertCleanGit/,
  /verifyReleaseBundle/,
  /--resume-after-publish/,
  /process\.stdin\.isTTY/,
  /api\.github\.com\/repos/,
  /repository\.private === false/,
  /registryCredentialEnvironmentPresent/,
  /"trust",\s*"github"/,
  /"trust",\s*"list"/,
  /"logout"/,
  /--allow-publish/,
]) {
  requireText(
    bootstrapPublish,
    pattern,
    `interactive bootstrap is missing ${String(pattern)}`,
  );
}

for (const pattern of [
  /registryCredentialEnvironmentPresent/,
  /name\.toUpperCase\(\)/,
  /NPM_TOKEN/,
  /NODE_AUTH_TOKEN/,
  /NPM_CONFIG_/,
  /AUTH\|TOKEN/,
]) {
  requireText(
    releasePolicy,
    pattern,
    `registry credential environment refusal is missing ${String(pattern)}`,
  );
}

for (const pattern of [
  /FXO-1574/i,
  /FXO-1164/i,
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
  /interactive[\s\S]*2FA/i,
  /package[\s\S]*already exist/i,
  /no (?:long-lived|retained)[\s\S]*token/i,
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
  `Release workflow boundary verified (${String(usedActions.size)} immutable actions, ${String(runtimeGraph.packages.length)} runtime dependency packages, ${String(release.bundledComponents.length)} MIT-approved bundled components, publication ${release.publication.approved === true ? "approved" : "blocked pending renewed approval"}, interactive bootstrap and OIDC/attestation gates present).\n`,
);
