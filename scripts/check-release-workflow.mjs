import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { runtimeDependencyGraph } from "./lib/release-bundle.mjs";
import { assertReleaseExitConfiguration } from "./lib/release-exit-policy.mjs";
import { assertReleaseConfiguration } from "./lib/release-policy.mjs";
import { selectedChecks } from "./sdlc/lib.mjs";

const root = resolve(import.meta.dirname, "..");

async function text(path) {
  return await readFile(resolve(root, path), "utf8");
}

function requireText(source, pattern, message) {
  if (!pattern.test(source))
    throw new Error(`Release workflow violation: ${message}`);
}

function forbidText(source, pattern, message) {
  if (pattern.test(source))
    throw new Error(`Release workflow violation: ${message}`);
}

const workflowNames = (await readdir(resolve(root, ".github/workflows")))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();
const workflows = new Map(
  await Promise.all(
    workflowNames.map(async (name) => [
      `.github/workflows/${name}`,
      await text(`.github/workflows/${name}`),
    ]),
  ),
);
const source = (path) => {
  const value = workflows.get(path);
  if (value === undefined)
    throw new Error(`Release workflow violation: missing ${path}`);
  return value;
};

const rootPackage = JSON.parse(await text("package.json"));
const release = JSON.parse(await text("packaging/release.json"));
const releaseExit = JSON.parse(await text("packaging/release-exit.json"));
const actionLock = JSON.parse(await text("packaging/actions-lock.json"));
const manifest = JSON.parse(await text("sdlc/checks.json"));
const thirdPartyNotices = await text("THIRD_PARTY_NOTICES.md");
const bootstrapPublish = await text("scripts/bootstrap-publish-release.mjs");
const releasePolicy = await text("scripts/lib/release-policy.mjs");
const releasing = await text("docs/releasing.md");

assertReleaseConfiguration(release, rootPackage);
assertReleaseExitConfiguration(releaseExit, release);
const runtimeGraph = await runtimeDependencyGraph(root, release);
for (const dependency of runtimeGraph.packages) {
  requireText(
    thirdPartyNotices,
    new RegExp(
      "\\| `" +
        dependency.name.replaceAll("/", "\\/") +
        "`\\s*\\|\\s*" +
        dependency.version.replaceAll(".", "\\.") +
        "\\s*\\|",
    ),
    `THIRD_PARTY_NOTICES.md is missing ${dependency.name}@${dependency.version}`,
  );
}
for (const component of release.bundledComponents) {
  requireText(
    thirdPartyNotices,
    new RegExp(
      "\\| `" +
        component.name.replaceAll("/", "\\/") +
        "`\\s*\\|\\s*" +
        component.version.replaceAll(".", "\\.") +
        "\\s*\\|",
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
  Number.isNaN(Date.parse(actionLock.recheckedAt))
) {
  throw new Error(
    "Release workflow violation: action lock metadata is invalid",
  );
}
const usedActions = new Set();
for (const [path, workflow] of workflows) {
  for (const match of workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
    const [, name, reference] = match;
    if (name === "flowxo/agent-relay/.github/workflows/validate.yml") {
      if (reference !== "dev") {
        throw new Error(
          `Release workflow violation: ${path} must consume reusable validation from protected dev`,
        );
      }
      continue;
    }
    const locked = actionLock.actions[name];
    if (locked === undefined)
      throw new Error(
        `Release workflow violation: ${path} uses unlocked action ${name}`,
      );
    if (!/^[a-f0-9]{40}$/.test(reference) || reference !== locked.sha) {
      throw new Error(
        `Release workflow violation: ${path} does not use locked ${name} SHA`,
      );
    }
    requireText(
      workflow,
      new RegExp(
        `${name.replaceAll("/", "\\/")}@${reference} # ${locked.version}`,
      ),
      `${path} must annotate ${name} with ${locked.version}`,
    );
    usedActions.add(name);
  }
}
for (const name of Object.keys(actionLock.actions)) {
  if (!usedActions.has(name))
    throw new Error(
      `Release workflow violation: locked action ${name} is unused`,
    );
}

if (manifest.schema !== "agent-relay-sdlc.v1" || manifest.version !== 1) {
  throw new Error("Release workflow violation: SDLC phase manifest is invalid");
}
const releaseChecks = selectedChecks(manifest, "release", []);
for (const required of [
  "browser-e2e",
  "package-hosted",
  "package-lifecycle",
  "release-bundle",
  "release-evidence",
  "native-release-exit",
  "production-audit",
]) {
  if (!releaseChecks.some((check) => check.id === required)) {
    throw new Error(
      `Release workflow violation: release phase omits ${required}`,
    );
  }
}
requireText(
  rootPackage.scripts.check,
  /pnpm check:fast/,
  "pnpm check is not the explicit fast alias",
);
for (const [name, phase] of [
  ["check:fast", "fast"],
  ["check:pr", "pr"],
  ["check:release", "release"],
]) {
  requireText(
    rootPackage.scripts[name] ?? "",
    new RegExp(`scripts/sdlc/run\\.mjs --phase ${phase}`),
    `${name} does not use the central phase runner`,
  );
}

const ci = source(".github/workflows/ci.yml");
for (const pattern of [
  /pull_request:/,
  /- dev/,
  /- main/,
  /scripts\/sdlc\/classify\.mjs/,
  /uses: flowxo\/agent-relay\/\.github\/workflows\/validate\.yml@dev/,
  /pr-gate:/,
]) {
  requireText(ci, pattern, `PR CI is missing ${String(pattern)}`);
}
for (const forbidden of [
  /\npush:/,
  /check:release/,
  /release:bundle/,
  /pnpm audit/,
  /test:e2e/,
  /secrets\./,
  /id-token: write/,
]) {
  forbidText(
    ci,
    forbidden,
    `PR CI contains release or privileged behavior ${String(forbidden)}`,
  );
}

const validation = source(".github/workflows/validate.yml");
for (const pattern of [
  /workflow_call:/,
  /--groups core/,
  /--groups browser/,
  /--groups lifecycle/,
  /RUNNER_TEMP\/agent-relay-trusted-sdlc\/scripts\/sdlc\/run\.mjs/,
  /mv \.trusted-sdlc/,
  /--repository/,
  /--phase pr/,
  /node-version-file: \.trusted-sdlc\/\.node-version/,
  /ref: dev/,
  /persist-credentials: false/,
]) {
  requireText(
    validation,
    pattern,
    `reusable PR validation is missing ${String(pattern)}`,
  );
}
for (const forbidden of [
  /check:release/,
  /release:bundle/,
  /pnpm audit/,
  /secrets\./,
  /contents: write/,
  /id-token: write/,
]) {
  forbidText(
    validation,
    forbidden,
    `reusable PR validation contains release or privileged behavior ${String(forbidden)}`,
  );
}

const candidate = source(".github/workflows/release-candidate.yml");
for (const pattern of [
  /workflow_dispatch:/,
  /candidate_sha:/,
  /base_sha:/,
  /confirmation:/,
  /dogfood_evidence:/,
  /dry_run:/,
  /environment: release-candidate/,
  /collaborators\/\$\{GITHUB_ACTOR\}\/permission/,
  /candidate\.mjs/,
  /Reject redundant qualification/,
  /pnpm check:release/,
  /qualification\.mjs create/,
  /actions\/upload-artifact@/,
]) {
  requireText(
    candidate,
    pattern,
    `candidate qualification is missing ${String(pattern)}`,
  );
}
for (const forbidden of [
  /pull_request:/,
  /\npush:/,
  /contents: write/,
  /id-token: write/,
  /npm publish/,
  /secrets\./,
]) {
  forbidText(
    candidate,
    forbidden,
    `candidate qualification contains unauthorized behavior ${String(forbidden)}`,
  );
}

const promotion = source(".github/workflows/promote-main.yml");
for (const pattern of [
  /workflow_dispatch:/,
  /environment: release-candidate/,
  /qualification\.mjs verify/,
  /merge-base --is-ancestor origin\/main/,
  /git\/refs\/heads\/main/,
  /force=false/,
  /contents: write/,
]) {
  requireText(
    promotion,
    pattern,
    `main promotion is missing ${String(pattern)}`,
  );
}
for (const forbidden of [
  /pull_request:/,
  /\npush:/,
  /pnpm check/,
  /release:bundle/,
  /npm publish/,
  /id-token: write/,
  /secrets\./,
]) {
  forbidText(
    promotion,
    forbidden,
    `main promotion can rerun or publish ${String(forbidden)}`,
  );
}

const prerelease = source(".github/workflows/prerelease.yml");
const verifyReleaseBundle = await text("scripts/verify-release-bundle.mjs");
for (const pattern of [
  /workflow_dispatch:/,
  /qualification_run_id:/,
  /github\.ref_type == 'tag'/,
  /gh run download/,
  /refs\/remotes\/origin\/main\^\{commit\}/,
  /qualification\.mjs verify/,
  /verify-release-bundle\.mjs[\s\S]*--allow-tag-promotion/,
  /actions\/attest@/,
  /attestations: write/,
  /id-token: write/,
  /environment: npm-prerelease/,
  /publish-release\.mjs \.artifacts\/release --execute/,
]) {
  requireText(
    prerelease,
    pattern,
    `publication workflow is missing ${String(pattern)}`,
  );
}
for (const forbidden of [
  /pull_request:/,
  /\npush:/,
  /pnpm check/,
  /test:e2e/,
  /pnpm audit/,
  /build-release\.mjs/,
  /\bNPM_TOKEN\b/,
  /\bNODE_AUTH_TOKEN\b/,
  /secrets\./,
  /npm publish/,
]) {
  forbidText(
    prerelease,
    forbidden,
    `publication rebuilds qualification or embeds credentials ${String(forbidden)}`,
  );
}
for (const pattern of [
  /process\.env\.GITHUB_OUTPUT/,
  /version=\$\{result\.version\}/,
  /artifact=\.artifacts\/release\//,
  /sbom=\.artifacts\/release\//,
]) {
  requireText(
    verifyReleaseBundle,
    pattern,
    `qualified bundle verifier does not emit publication output ${String(pattern)}`,
  );
}

const regression = source(".github/workflows/regression.yml");
for (const pattern of [
  /workflow_dispatch:/,
  /schedule:/,
  /ref: dev/,
  /pnpm check:pr/,
]) {
  requireText(
    regression,
    pattern,
    `scheduled regression is missing ${String(pattern)}`,
  );
}

const codeql = source(".github/workflows/codeql.yml");
for (const pattern of [
  /pull_request:[\s\S]*- dev[\s\S]*- main/,
  /schedule:/,
  /\.trusted-sdlc\/scripts\/sdlc\/classify\.mjs/,
  /documentation_only != 'true'/,
  /security-events: write/,
  /github\/codeql-action\/init@/,
  /github\/codeql-action\/analyze@/,
]) {
  requireText(
    codeql,
    pattern,
    `CodeQL selection is missing ${String(pattern)}`,
  );
}
for (const forbidden of [/\npush:/, /contents: write/, /secrets\./]) {
  forbidText(
    codeql,
    forbidden,
    `CodeQL contains unsafe behavior ${String(forbidden)}`,
  );
}
for (const forbidden of [
  /check:release/,
  /release:bundle/,
  /npm publish/,
  /contents: write/,
  /id-token: write/,
  /secrets\./,
]) {
  forbidText(
    regression,
    forbidden,
    `scheduled regression contains release or privileged behavior ${String(forbidden)}`,
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
  /NPM_TOKEN/,
  /NODE_AUTH_TOKEN/,
  /NPM_CONFIG_/,
  /AUTH\|TOKEN/,
]) {
  requireText(
    releasePolicy,
    pattern,
    `registry credential refusal is missing ${String(pattern)}`,
  );
}
for (const pattern of [
  /SHA256SUMS/,
  /SPDX/,
  /gh attestation verify/,
  /exact commit/i,
  /upgrade/i,
  /rollback/i,
  /npm-prerelease/,
  /trusted publisher/i,
  /qualification/i,
  /dogfood/i,
  /OIDC/i,
]) {
  requireText(
    releasing,
    pattern,
    `release guide is missing ${String(pattern)}`,
  );
}

process.stdout.write(
  `Release workflow boundary verified (${String(workflows.size)} workflows, ${String(usedActions.size)} immutable actions, ${String(releaseChecks.length)} release checks, explicit candidate qualification and evidence-consuming publication).\n`,
);
