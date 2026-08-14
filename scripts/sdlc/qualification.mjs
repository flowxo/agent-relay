import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

import {
  manifestDigest,
  readManifest,
  repositoryRoot,
  selectedChecks,
  writeJson,
} from "./lib.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`Qualification evidence refused: ${message}`);
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function filesBelow(directory, base = directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await filesBelow(path, base)));
    else {
      assert(
        entry.isFile(),
        `artifact ${relative(base, path)} is not a regular file`,
      );
      paths.push(path);
    }
  }
  return paths.sort();
}

export async function createQualificationEvidence(options) {
  const [authorization, results, manifest] = await Promise.all([
    readFile(options.authorizationPath, "utf8").then(JSON.parse),
    readFile(options.resultsPath, "utf8").then(JSON.parse),
    readManifest(),
  ]);
  assert(
    authorization.schema === "agent-relay-candidate-authorization.v1",
    "candidate authorization is invalid",
  );
  assert(
    authorization.candidateSha === options.candidateSha,
    "candidate authorization SHA differs",
  );
  assert(
    /^[a-f0-9]{64}$/.test(authorization.qualificationKey),
    "candidate authorization key is invalid",
  );
  assert(
    results.schema === "agent-relay-sdlc-run.v1" &&
      results.phase === "release" &&
      results.passed === true,
    "release check results are missing or failed",
  );
  assert(
    results.manifestSha256 === manifestDigest(manifest),
    "release checks used another phase manifest",
  );
  assert(
    results.head === options.candidateSha,
    "release checks ran against another candidate SHA",
  );
  const requiredChecks = selectedChecks(manifest, "release", []).map(
    (check) => check.id,
  );
  assert(
    JSON.stringify(results.checks.map((check) => check.id)) ===
      JSON.stringify(requiredChecks) &&
      results.checks.every(
        (check) =>
          check.passed === true &&
          /^[a-f0-9]{64}$/.test(check.commandSha256) &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 0,
      ),
    "release check results are incomplete, reordered, duplicated, or failed",
  );
  const artifactRoot = options.repositoryRoot ?? repositoryRoot;
  const roots = [
    options.releaseDirectory,
    options.releaseEvidenceDirectory,
    options.releaseExitDirectory,
  ];
  const artifacts = [];
  for (const root of roots) {
    assert(
      root.startsWith(`${resolve(artifactRoot, ".artifacts")}/`),
      "qualification artifacts must stay under the repository artifact root",
    );
    for (const path of await filesBelow(root)) {
      const metadata = await stat(path);
      artifacts.push({
        path: relative(artifactRoot, path).replaceAll("\\", "/"),
        bytes: metadata.size,
        sha256: await sha256(path),
      });
    }
  }
  const releaseManifest = JSON.parse(
    await readFile(
      resolve(options.releaseDirectory, "agent-relay-release.json"),
      "utf8",
    ),
  );
  assert(
    releaseManifest.commit === options.candidateSha,
    "qualified release bundle was built from another SHA",
  );
  return {
    schema: "agent-relay-release-qualification.v1",
    candidateSha: options.candidateSha,
    baseSha: authorization.baseSha,
    repository: options.repository,
    runId: String(options.runId),
    workflow: ".github/workflows/release-candidate.yml",
    workflowRef: options.workflowRef,
    dryRun: authorization.dryRun,
    qualificationKey: authorization.qualificationKey,
    publicationEligible: authorization.dryRun === false,
    authorization: {
      actor: authorization.actor,
      actorPermission: authorization.actorPermission,
      authorizedAt: authorization.authorizedAt,
    },
    manifestSha256: manifestDigest(manifest),
    checksHeadSha: results.head,
    classification: authorization.classification,
    dogfoodEvidence: authorization.dogfoodEvidence,
    checks: results.checks,
    artifacts,
    createdAt: new Date().toISOString(),
  };
}

export async function verifyQualificationEvidence(options) {
  const [evidence, run, manifest] = await Promise.all([
    readFile(options.evidencePath, "utf8").then(JSON.parse),
    readFile(options.runMetadataPath, "utf8").then(JSON.parse),
    readManifest(),
  ]);
  const verificationRoot = options.repositoryRoot ?? repositoryRoot;
  assert(
    evidence.schema === "agent-relay-release-qualification.v1",
    "schema is invalid",
  );
  assert(
    evidence.candidateSha === options.candidateSha,
    "candidate SHA is stale or changed",
  );
  assert(
    evidence.repository === options.repository,
    "repository binding differs",
  );
  assert(
    evidence.workflow === ".github/workflows/release-candidate.yml",
    "workflow binding differs",
  );
  assert(
    evidence.workflowRef ===
      `${options.repository}/.github/workflows/release-candidate.yml@refs/heads/dev` ||
      evidence.workflowRef.startsWith(
        `${options.repository}/.github/workflows/release-candidate.yml@refs/heads/hotfix/`,
      ),
    "workflow ref is not the protected candidate workflow",
  );
  const now = options.now ?? new Date();
  const createdAt = new Date(evidence.createdAt);
  assert(!Number.isNaN(createdAt.valueOf()), "creation time is invalid");
  assert(
    createdAt <= new Date(now.valueOf() + 5 * 60_000),
    "qualification evidence is from the future",
  );
  assert(
    createdAt >= new Date(now.valueOf() - 30 * 24 * 60 * 60_000),
    "qualification evidence is older than its 30-day retention window",
  );
  assert(
    evidence.manifestSha256 === manifestDigest(manifest),
    "qualification inputs changed after proof",
  );
  assert(
    /^[a-f0-9]{64}$/.test(evidence.qualificationKey),
    "qualification input key is invalid",
  );
  assert(
    evidence.checksHeadSha === options.candidateSha,
    "release check results are bound to another SHA",
  );
  const requiredChecks = selectedChecks(manifest, "release", []).map(
    (check) => check.id,
  );
  assert(
    JSON.stringify(evidence.checks.map((check) => check.id)) ===
      JSON.stringify(requiredChecks) &&
      evidence.checks.every(
        (check) =>
          check.passed === true &&
          /^[a-f0-9]{64}$/.test(check.commandSha256) &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 0,
      ),
    "qualification check inventory is incomplete or failed",
  );
  assert(
    evidence.artifacts.some(
      (artifact) =>
        artifact.path === ".artifacts/release/agent-relay-release.json",
    ) &&
      evidence.artifacts.some((artifact) =>
        artifact.path.startsWith(".artifacts/release-evidence/"),
      ) &&
      evidence.artifacts.some(
        (artifact) =>
          artifact.path ===
          ".artifacts/release-exit/agent-relay-release-exit.json",
      ),
    "qualification artifact inventory is incomplete",
  );
  if (options.allowDryRun !== true) {
    assert(
      evidence.dryRun === false && evidence.publicationEligible === true,
      "non-publishing dry-run evidence cannot authorize publication",
    );
  }
  assert(String(run.id) === String(evidence.runId), "GitHub run ID differs");
  assert(
    run.event === "workflow_dispatch",
    "qualification was not explicitly dispatched",
  );
  assert(
    run.conclusion === "success",
    "qualification workflow did not succeed",
  );
  assert(
    run.head_sha === options.candidateSha,
    "qualification workflow ran on another SHA",
  );
  assert(
    run.path === ".github/workflows/release-candidate.yml",
    "qualification came from another workflow",
  );
  for (const artifact of evidence.artifacts) {
    const path = resolve(verificationRoot, artifact.path);
    assert(
      path.startsWith(`${verificationRoot}/.artifacts/`),
      `artifact ${artifact.path} escapes the evidence root`,
    );
    const metadata = await lstat(path);
    assert(
      metadata.isFile() && metadata.size === artifact.bytes,
      `artifact ${artifact.path} size changed`,
    );
    assert(
      (await sha256(path)) === artifact.sha256,
      `artifact ${artifact.path} digest changed`,
    );
  }
  const releaseManifest = JSON.parse(
    await readFile(
      resolve(verificationRoot, ".artifacts/release/agent-relay-release.json"),
      "utf8",
    ),
  );
  assert(
    releaseManifest.commit === options.candidateSha,
    "qualified release bundle was built from another SHA",
  );
  return evidence;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const operation = process.argv[2];
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename) &&
  operation === "create"
) {
  const output = argument("--output") ?? ".artifacts/sdlc/qualification.json";
  const evidence = await createQualificationEvidence({
    authorizationPath:
      argument("--authorization") ??
      ".artifacts/sdlc/candidate-authorization.json",
    resultsPath:
      argument("--results") ?? ".artifacts/sdlc/release-results.json",
    releaseDirectory: resolve(
      repositoryRoot,
      argument("--release-directory") ?? ".artifacts/release",
    ),
    releaseEvidenceDirectory: resolve(
      repositoryRoot,
      argument("--release-evidence-directory") ?? ".artifacts/release-evidence",
    ),
    releaseExitDirectory: resolve(
      repositoryRoot,
      argument("--release-exit-directory") ?? ".artifacts/release-exit",
    ),
    candidateSha: argument("--candidate") ?? "",
    repository:
      process.env.GITHUB_REPOSITORY ??
      argument("--repository") ??
      "flowxo/agent-relay",
    runId: process.env.GITHUB_RUN_ID ?? argument("--run-id") ?? "local",
    workflowRef:
      process.env.GITHUB_WORKFLOW_REF ?? argument("--workflow-ref") ?? "local",
  });
  await writeJson(output, evidence);
  process.stdout.write(
    `Qualification evidence created for ${evidence.candidateSha}; publication eligible: ${String(evidence.publicationEligible)}.\n`,
  );
} else if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename) &&
  operation === "verify"
) {
  const evidence = await verifyQualificationEvidence({
    evidencePath:
      argument("--evidence") ?? ".artifacts/sdlc/qualification.json",
    runMetadataPath:
      argument("--run-metadata") ?? ".artifacts/sdlc/qualification-run.json",
    candidateSha: argument("--candidate") ?? process.env.GITHUB_SHA ?? "",
    repository:
      process.env.GITHUB_REPOSITORY ??
      argument("--repository") ??
      "flowxo/agent-relay",
    allowDryRun: process.argv.includes("--allow-dry-run"),
  });
  process.stdout.write(
    `Qualification evidence verified for ${evidence.candidateSha} from run ${evidence.runId}.\n`,
  );
}
