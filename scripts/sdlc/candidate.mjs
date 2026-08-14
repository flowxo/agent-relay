import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  changedFiles,
  classifyFiles,
  manifestDigest,
  readManifest,
  repositoryRoot,
  writeJson,
} from "./lib.mjs";

const runFile = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const allowedPermissions = new Set(["admin", "maintain", "write"]);
const forbiddenKey =
  /(?:authorization|bearer|cookie|credential|csrf|password|prompt|private|secret|session|token|transcript|answer|content)/i;
const forbiddenValue =
  /(?:-----BEGIN [A-Z ]+ PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\b\d{6,}:[A-Za-z0-9_-]{20,}\b|\/Users\/[^/<\s]+|[A-Za-z]:\\Users\\[^\\<\s]+)/;

function assert(condition, message) {
  if (!condition) throw new Error(`Candidate promotion refused: ${message}`);
}

function boundedText(value, label) {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= 200,
    `${label} must be 1-200 characters`,
  );
  assert(!/[\r\n\0]/.test(value), `${label} must be one line`);
  assert(
    !forbiddenValue.test(value),
    `${label} resembles private or credential material`,
  );
  return value;
}

export function validateDogfoodEvidence(
  evidence,
  candidateSha,
  required,
  now = new Date(),
) {
  if (!required && evidence === undefined) return undefined;
  assert(
    evidence !== undefined &&
      typeof evidence === "object" &&
      !Array.isArray(evidence),
    required
      ? "UX risk requires dogfood evidence"
      : "dogfood evidence must be an object",
  );
  for (const key of Object.keys(evidence)) {
    assert(
      !forbiddenKey.test(key),
      `dogfood evidence field ${key} is not allowed`,
    );
  }
  assert(
    evidence.schema === "agent-relay-dogfood-evidence.v1",
    "dogfood evidence schema is invalid",
  );
  assert(
    evidence.candidateSha === candidateSha,
    "dogfood evidence is stale or bound to another candidate SHA",
  );
  assert(
    evidence.result === "pass" || evidence.result === "fail",
    "dogfood result must be pass or fail",
  );
  const testedAt = new Date(evidence.testedAt);
  assert(!Number.isNaN(testedAt.valueOf()), "dogfood testedAt is invalid");
  assert(
    testedAt <= new Date(now.valueOf() + 5 * 60_000),
    "dogfood evidence is from the future",
  );
  assert(
    testedAt >= new Date(now.valueOf() - 14 * 24 * 60 * 60_000),
    "dogfood evidence is older than 14 days",
  );
  boundedText(evidence.tester, "dogfood tester");
  boundedText(evidence.environment, "dogfood environment");
  assert(
    Array.isArray(evidence.flows) &&
      evidence.flows.length > 0 &&
      evidence.flows.length <= 20,
    "dogfood evidence needs 1-20 tested flows",
  );
  for (const [index, flow] of evidence.flows.entries())
    boundedText(flow, `dogfood flow ${String(index + 1)}`);
  assert(
    Array.isArray(evidence.limitations) && evidence.limitations.length <= 20,
    "dogfood limitations must be an array of at most 20 items",
  );
  for (const [index, limitation] of evidence.limitations.entries())
    boundedText(limitation, `dogfood limitation ${String(index + 1)}`);
  const serialized = JSON.stringify(evidence);
  assert(serialized.length <= 6000, "dogfood evidence exceeds 6000 bytes");
  assert(
    !forbiddenValue.test(serialized),
    "dogfood evidence resembles private or credential material",
  );
  return evidence;
}

export async function authorizeCandidate(input) {
  assert(
    shaPattern.test(input.candidateSha),
    "candidate SHA must be one full lowercase commit SHA",
  );
  assert(
    shaPattern.test(input.baseSha),
    "base SHA must be one full lowercase commit SHA",
  );
  assert(
    input.githubSha === input.candidateSha,
    "workflow ref is not the requested immutable candidate SHA",
  );
  assert(
    input.eventName === "workflow_dispatch",
    "qualification is manual workflow-dispatch only",
  );
  assert(
    allowedPermissions.has(input.actorPermission),
    "actor needs write, maintain, or admin repository permission",
  );
  assert(
    input.confirmation === `QUALIFY ${input.candidateSha}`,
    "confirmation must name the exact candidate SHA",
  );
  assert(
    input.ref === "refs/heads/dev" ||
      input.ref.startsWith("refs/heads/hotfix/"),
    "candidate must be the dev head or a named hotfix branch",
  );
  const { stdout: mainOutput } = await runFile(
    "git",
    ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert(
    mainOutput.trim() === input.baseSha,
    "base SHA must be the exact current origin/main commit",
  );
  try {
    await runFile(
      "git",
      ["merge-base", "--is-ancestor", input.baseSha, input.candidateSha],
      { cwd: repositoryRoot },
    );
  } catch {
    throw new Error(
      "Candidate promotion refused: base SHA is not an ancestor of the candidate",
    );
  }
  const manifest = await readManifest();
  const comparison = await changedFiles({
    base: input.baseSha,
    head: input.candidateSha,
    includeWorkingTree: false,
  });
  const classification = classifyFiles(manifest, comparison.files);
  const evidence = validateDogfoodEvidence(
    input.dogfoodEvidence,
    input.candidateSha,
    classification.uxEvidenceRequired,
    input.now,
  );
  assert(
    evidence === undefined || evidence.result === "pass",
    "dogfood evidence records a failed checkpoint",
  );
  const qualificationKey = createHash("sha256")
    .update(
      `${JSON.stringify({
        candidateSha: input.candidateSha,
        baseSha: input.baseSha,
        manifestSha256: manifestDigest(manifest),
        dryRun: input.dryRun,
        classification,
        evidence: evidence ?? null,
      })}\n`,
    )
    .digest("hex");
  return {
    schema: "agent-relay-candidate-authorization.v1",
    candidateSha: input.candidateSha,
    baseSha: input.baseSha,
    ref: input.ref,
    actor: input.actor,
    actorPermission: input.actorPermission,
    dryRun: input.dryRun,
    qualificationKey,
    classification,
    dogfoodEvidence: evidence,
    authorizedAt: (input.now ?? new Date()).toISOString(),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const evidenceSource = argument("--dogfood-evidence");
  const authorization = await authorizeCandidate({
    candidateSha: argument("--candidate") ?? "",
    baseSha: argument("--base") ?? "",
    githubSha: process.env.GITHUB_SHA ?? argument("--github-sha") ?? "",
    eventName: process.env.GITHUB_EVENT_NAME ?? argument("--event") ?? "",
    actorPermission: argument("--actor-permission") ?? "",
    actor: process.env.GITHUB_ACTOR ?? argument("--actor") ?? "unknown",
    confirmation: argument("--confirmation") ?? "",
    ref: process.env.GITHUB_REF ?? argument("--ref") ?? "",
    dryRun: argument("--dry-run") === "true",
    dogfoodEvidence:
      evidenceSource === undefined || evidenceSource.trim().length === 0
        ? undefined
        : JSON.parse(evidenceSource),
  });
  const output =
    argument("--output") ?? ".artifacts/sdlc/candidate-authorization.json";
  await writeJson(output, authorization);
  process.stdout.write(
    `Candidate ${authorization.candidateSha} authorized for ${authorization.dryRun ? "non-publishing dry-run" : "release qualification"}; UX evidence ${authorization.classification.uxEvidenceRequired ? "verified" : "not required"}.\n`,
  );
}
