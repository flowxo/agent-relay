import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  authorizeCandidate,
  validateDogfoodEvidence,
} from "../sdlc/candidate.mjs";
import {
  changedFiles,
  classifyFiles,
  manifestDigest,
  readManifest,
  repositoryRoot,
  selectedChecks,
} from "../sdlc/lib.mjs";
import {
  createQualificationEvidence,
  verifyQualificationEvidence,
} from "../sdlc/qualification.mjs";
import {
  validateArchiveEntries,
  validateManifest as validateHarnessManifest,
} from "../sdlc/provision-harnesses.mjs";

const manifest = await readManifest();
const packageSource = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);

function groups(files) {
  return classifyFiles(manifest, files).groups;
}

test("phase manifest is deterministic, complete, and command-backed", () => {
  assert.equal(manifest.schema, "agent-relay-sdlc.v1");
  assert.equal(
    manifest.toolchain.node,
    (packageSource.engines.node.match(/\d+/) ?? [])[0],
  );
  assert.equal(
    manifest.toolchain.pnpm,
    packageSource.packageManager.split("@")[1],
  );
  const ids = manifest.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const check of manifest.checks) {
    assert.match(check.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(check.command.length >= 2);
    assert.ok(check.phases.length >= 1);
    assert.ok(
      ["core", "browser", "lifecycle", "release"].includes(check.group),
    );
    assert.ok(check.targetSeconds > 0);
    assert.ok(check.purpose.length > 20);
    assert.ok(check.credentials.length > 0);
    assert.equal(new Set(check.phases).size, check.phases.length);
    assert.equal(
      new Set(check.whenRisks ?? []).size,
      (check.whenRisks ?? []).length,
    );
    for (const superseded of check.supersedes ?? []) {
      assert.ok(ids.includes(superseded));
      assert.notEqual(superseded, check.id);
    }
    if (
      check.command[0] === "pnpm" &&
      !["exec", "audit"].includes(check.command[1])
    ) {
      assert.ok(
        packageSource.scripts[check.command[1]],
        `${check.id} references missing script ${check.command[1]}`,
      );
    }
  }
  for (const id of [
    "browser-e2e",
    "package-hosted",
    "package-lifecycle",
    "release-bundle",
    "release-evidence",
    "native-release-exit",
    "production-audit",
  ]) {
    assert.ok(
      selectedChecks(manifest, "release", []).some((check) => check.id === id),
    );
  }
  assert.equal(packageSource.scripts.check, "pnpm check:fast");
  assert.ok(
    !selectedChecks(manifest, "release", []).some(
      (check) => check.id === "security-regressions",
    ),
  );
});

test("release qualification harnesses are immutable, bounded, and archive-safe", async () => {
  const harnessManifest = validateHarnessManifest(
    JSON.parse(
      await readFile(
        resolve(repositoryRoot, "sdlc/qualification-harnesses.json"),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    harnessManifest.harnesses.map(({ id, versionOutput }) => ({
      id,
      versionOutput,
    })),
    [
      { id: "codex", versionOutput: "codex-cli 0.145.0" },
      { id: "claude", versionOutput: "2.1.219 (Claude Code)" },
      { id: "cursor", versionOutput: "2026.07.23-e383d2b" },
    ],
  );
  assert.throws(
    () => validateArchiveEntries(["package/../../private"], "package"),
    /unsafe path/,
  );
  assert.throws(
    () => validateArchiveEntries(["another-root/tool"], "package"),
    /declared root/,
  );
});

test("documentation-only changes avoid native, browser, lifecycle, and release work", () => {
  const classification = classifyFiles(manifest, [
    "docs/onboarding.md",
    "README.md",
  ]);
  assert.equal(classification.documentationOnly, true);
  assert.deepEqual(classification.risks, ["docs"]);
  assert.deepEqual(classification.groups, ["core"]);
  assert.deepEqual(
    selectedChecks(manifest, "pr", classification.risks).map(
      (check) => check.id,
    ),
    [
      "sdlc-integrity",
      "format",
      "governance",
      "repository-secrets",
      "public-docs",
    ],
  );
});

test("web authentication and session changes select focused security and browser proof", () => {
  const classification = classifyFiles(manifest, [
    "apps/relay/src/web-session.ts",
  ]);
  assert.deepEqual(classification.groups, ["browser", "core"]);
  assert.equal(classification.uxEvidenceRequired, true);
  assert.ok(classification.risks.includes("security"));
  assert.ok(
    selectedChecks(manifest, "pr", classification.risks).some(
      (check) => check.id === "browser-e2e",
    ),
  );
});

test("persistence, installer, package, shared, and unknown paths broaden safely", () => {
  assert.deepEqual(groups(["packages/core/src/store.ts"]), [
    "core",
    "lifecycle",
  ]);
  assert.deepEqual(groups(["apps/relay/src/installer.ts"]), [
    "core",
    "lifecycle",
  ]);
  assert.deepEqual(groups(["packaging/release.json"]), ["core", "lifecycle"]);
  assert.deepEqual(groups(["packages/protocol/src/index.ts"]), ["core"]);
  const unknown = classifyFiles(manifest, ["future-surface/new.file"]);
  assert.deepEqual(unknown.groups, ["browser", "core", "lifecycle"]);
  assert.deepEqual(unknown.unrecognized, ["future-surface/new.file"]);
  assert.ok(unknown.risks.includes("unknown"));
  assert.ok(
    classifyFiles(manifest, [
      "scripts/test/safe-packed-environment.node-test.mjs",
    ]).risks.includes("security"),
  );
});

test("broad fast feedback supersedes overlapping focused unit suites", () => {
  const checks = selectedChecks(manifest, "fast", ["control", "relay"]);
  const ids = checks.map((check) => check.id);
  assert.ok(ids.includes("unit-all-fast-fallback"));
  assert.ok(!ids.includes("unit-relay"));
  assert.ok(!ids.includes("unit-core"));
});

test("changed path classification rejects traversal and control characters", () => {
  for (const path of ["../outside", "/absolute", "line\nbreak", ""]) {
    assert.throws(
      () => classifyFiles(manifest, [path]),
      /refused unsafe changed path/,
    );
  }
});

test("changed-file discovery classifies deleted paths instead of silently skipping them", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-diff-test-"),
  );
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
    execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], {
      cwd: temporaryRoot,
    });
    execFileSync("git", ["config", "user.name", "Synthetic Test"], {
      cwd: temporaryRoot,
    });
    const deleted = resolve(temporaryRoot, "apps/relay/web/deleted.js");
    await mkdir(resolve(deleted, ".."), { recursive: true });
    await writeFile(deleted, "export {};\n");
    execFileSync("git", ["add", "."], { cwd: temporaryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: temporaryRoot,
    });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temporaryRoot,
      encoding: "utf8",
    }).trim();
    await rm(deleted);
    execFileSync("git", ["add", "-u"], { cwd: temporaryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "delete fixture"], {
      cwd: temporaryRoot,
    });
    const comparison = await changedFiles({
      base,
      head: "HEAD",
      includeWorkingTree: false,
      root: temporaryRoot,
    });
    assert.deepEqual(comparison.files, ["apps/relay/web/deleted.js"]);
    assert.equal(
      classifyFiles(manifest, comparison.files).uxEvidenceRequired,
      true,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("dogfood evidence is conditional, exact-SHA bound, fresh, and secret-free", () => {
  const candidateSha = "a".repeat(40);
  const now = new Date("2026-08-13T12:00:00.000Z");
  const evidence = {
    schema: "agent-relay-dogfood-evidence.v1",
    candidateSha,
    result: "pass",
    testedAt: "2026-08-13T11:00:00.000Z",
    tester: "release operator",
    environment: "local macOS dogfood",
    flows: [
      "opened the dashboard from a real coding session",
      "refreshed and reopened the browser",
    ],
    limitations: ["No live-provider traffic exercised"],
  };
  assert.deepEqual(
    validateDogfoodEvidence(evidence, candidateSha, true, now),
    evidence,
  );
  assert.equal(
    validateDogfoodEvidence(
      { ...evidence, result: "fail" },
      candidateSha,
      true,
      now,
    ).result,
    "fail",
  );
  assert.throws(
    () => validateDogfoodEvidence(undefined, candidateSha, true, now),
    /requires dogfood evidence/,
  );
  assert.throws(
    () =>
      validateDogfoodEvidence(
        { ...evidence, candidateSha: "b".repeat(40) },
        candidateSha,
        true,
        now,
      ),
    /stale or bound to another/,
  );
  assert.throws(
    () =>
      validateDogfoodEvidence(
        { ...evidence, testedAt: "2026-07-01T00:00:00.000Z" },
        candidateSha,
        true,
        now,
      ),
    /older than 14 days/,
  );
  assert.throws(
    () =>
      validateDogfoodEvidence(
        { ...evidence, token: "not-allowed" },
        candidateSha,
        true,
        now,
      ),
    /field token is not allowed/,
  );
  assert.equal(
    validateDogfoodEvidence(undefined, candidateSha, false, now),
    undefined,
  );
});

test("candidate authorization rejects automation, weak permissions, wrong refs, and stale confirmations", async () => {
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const mainSha = execFileSync(
    "git",
    ["rev-parse", "refs/remotes/origin/main^{commit}"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  const now = new Date("2026-08-13T12:00:00.000Z");
  const base = {
    candidateSha,
    baseSha: mainSha,
    githubSha: candidateSha,
    eventName: "workflow_dispatch",
    actorPermission: "write",
    actor: "synthetic-operator",
    confirmation: `QUALIFY ${candidateSha}`,
    ref: "refs/heads/dev",
    dryRun: true,
    now,
    dogfoodEvidence: {
      schema: "agent-relay-dogfood-evidence.v1",
      candidateSha,
      result: "pass",
      testedAt: "2026-08-13T11:00:00.000Z",
      tester: "synthetic operator",
      environment: "isolated test environment",
      flows: ["exercised the synthetic candidate authorization boundary"],
      limitations: [],
    },
  };
  const accepted = await authorizeCandidate(base);
  assert.equal(accepted.candidateSha, candidateSha);
  assert.match(accepted.qualificationKey, /^[a-f0-9]{64}$/);
  for (const override of [
    { eventName: "pull_request" },
    { actorPermission: "read" },
    { githubSha: "b".repeat(40) },
    { confirmation: `QUALIFY ${"b".repeat(40)}` },
    { ref: "refs/pull/1/merge" },
    { baseSha: "b".repeat(40) },
  ]) {
    await assert.rejects(
      authorizeCandidate({ ...base, ...override }),
      /Candidate promotion refused/,
    );
  }
});

test("exploratory dogfood status and rollback are bounded to an isolated home", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-dogfood-test-"),
  );
  try {
    const dogfoodEnvironment = {
      HOME: temporaryRoot,
      PATH: process.env.PATH ?? "",
    };
    const status = execFileSync(
      process.execPath,
      ["scripts/sdlc/dogfood.mjs", "status", "--root", temporaryRoot],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: dogfoodEnvironment,
      },
    );
    assert.match(status, /No exploratory Agent Relay dogfood deployment/);
    const rollback = spawnSync(
      process.execPath,
      ["scripts/sdlc/dogfood.mjs", "rollback", "--root", temporaryRoot],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: dogfoodEnvironment,
      },
    );
    assert.notEqual(rollback.status, 0);
    assert.match(
      rollback.stderr,
      /no previous exploratory deployment is recorded/,
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("exploratory dogfood deployment remains inert in CI", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-dogfood-ci-test-"),
  );
  try {
    const deployment = spawnSync(
      process.execPath,
      ["scripts/sdlc/dogfood.mjs", "deploy", "--root", temporaryRoot],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          CI: "1",
          HOME: temporaryRoot,
          PATH: process.env.PATH ?? "",
        },
      },
    );
    assert.notEqual(deployment.status, 0);
    assert.match(deployment.stderr, /cannot run in CI/);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("qualification creation binds complete release results and bundle to the candidate SHA", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-qualification-create-test-"),
  );
  try {
    const candidateSha = "a".repeat(40);
    const artifactRoot = resolve(temporaryRoot, ".artifacts");
    const releaseDirectory = resolve(artifactRoot, "release");
    const releaseEvidenceDirectory = resolve(artifactRoot, "release-evidence");
    const releaseExitDirectory = resolve(artifactRoot, "release-exit");
    await Promise.all(
      [releaseDirectory, releaseEvidenceDirectory, releaseExitDirectory].map(
        async (directory) => await mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(
      resolve(releaseDirectory, "agent-relay-release.json"),
      `${JSON.stringify({ commit: candidateSha })}\n`,
    );
    await writeFile(resolve(releaseEvidenceDirectory, "proof.json"), "{}\n");
    await writeFile(
      resolve(releaseExitDirectory, "agent-relay-release-exit.json"),
      "{}\n",
    );
    const authorizationPath = resolve(artifactRoot, "authorization.json");
    const resultsPath = resolve(artifactRoot, "results.json");
    await writeFile(
      authorizationPath,
      JSON.stringify({
        schema: "agent-relay-candidate-authorization.v1",
        candidateSha,
        baseSha: "b".repeat(40),
        actor: "synthetic-operator",
        actorPermission: "write",
        authorizedAt: "2026-08-13T12:00:00.000Z",
        dryRun: true,
        qualificationKey: "c".repeat(64),
        classification: { uxEvidenceRequired: false },
      }),
    );
    const results = {
      schema: "agent-relay-sdlc-run.v1",
      phase: "release",
      head: candidateSha,
      passed: true,
      manifestSha256: manifestDigest(manifest),
      checks: selectedChecks(manifest, "release", []).map((check) => ({
        id: check.id,
        passed: true,
        commandSha256: "d".repeat(64),
        durationMs: 1,
      })),
    };
    await writeFile(resultsPath, JSON.stringify(results));
    const options = {
      authorizationPath,
      resultsPath,
      releaseDirectory,
      releaseEvidenceDirectory,
      releaseExitDirectory,
      repositoryRoot: temporaryRoot,
      candidateSha,
      repository: "flowxo/agent-relay",
      runId: "123",
      workflowRef:
        "flowxo/agent-relay/.github/workflows/release-candidate.yml@refs/heads/dev",
    };
    assert.equal(
      (await createQualificationEvidence(options)).checksHeadSha,
      candidateSha,
    );
    await writeFile(
      resultsPath,
      JSON.stringify({ ...results, head: "e".repeat(40) }),
    );
    await assert.rejects(
      createQualificationEvidence(options),
      /release checks ran against another candidate SHA/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("qualification evidence is reusable only for the exact successful workflow and candidate", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-qualification-test-"),
  );
  try {
    const releaseManifestPath = resolve(
      temporaryRoot,
      ".artifacts/release/agent-relay-release.json",
    );
    const releaseEvidencePath = resolve(
      temporaryRoot,
      ".artifacts/release-evidence/proof.json",
    );
    const releaseExitPath = resolve(
      temporaryRoot,
      ".artifacts/release-exit/agent-relay-release-exit.json",
    );
    await mkdir(resolve(releaseManifestPath, ".."), { recursive: true });
    await mkdir(resolve(releaseEvidencePath, ".."), { recursive: true });
    await mkdir(resolve(releaseExitPath, ".."), { recursive: true });
    const candidateSha = "c".repeat(40);
    await writeFile(
      releaseManifestPath,
      `${JSON.stringify({ commit: candidateSha })}\n`,
    );
    await writeFile(releaseEvidencePath, "{}\n");
    await writeFile(releaseExitPath, "{}\n");
    const artifact = async (path, relativePath) => ({
      path: relativePath,
      bytes: (await readFile(path)).length,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
    const runId = "12345";
    const evidence = {
      schema: "agent-relay-release-qualification.v1",
      candidateSha,
      baseSha: "b".repeat(40),
      repository: "flowxo/agent-relay",
      runId,
      workflow: ".github/workflows/release-candidate.yml",
      workflowRef:
        "flowxo/agent-relay/.github/workflows/release-candidate.yml@refs/heads/dev",
      dryRun: false,
      publicationEligible: true,
      qualificationKey: "d".repeat(64),
      manifestSha256: manifestDigest(manifest),
      checksHeadSha: candidateSha,
      classification: { uxEvidenceRequired: false },
      checks: selectedChecks(manifest, "release", []).map((check) => ({
        id: check.id,
        passed: true,
        commandSha256: "f".repeat(64),
        durationMs: 1,
      })),
      artifacts: [
        await artifact(
          releaseManifestPath,
          ".artifacts/release/agent-relay-release.json",
        ),
        await artifact(
          releaseEvidencePath,
          ".artifacts/release-evidence/proof.json",
        ),
        await artifact(
          releaseExitPath,
          ".artifacts/release-exit/agent-relay-release-exit.json",
        ),
      ],
      createdAt: "2026-08-13T12:00:00.000Z",
    };
    const evidencePath = resolve(temporaryRoot, "qualification.json");
    const runPath = resolve(temporaryRoot, "run.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    await writeFile(
      runPath,
      JSON.stringify({
        id: Number(runId),
        event: "workflow_dispatch",
        conclusion: "success",
        head_sha: candidateSha,
        path: ".github/workflows/release-candidate.yml",
      }),
    );
    const options = {
      evidencePath,
      runMetadataPath: runPath,
      candidateSha,
      repository: "flowxo/agent-relay",
      repositoryRoot: temporaryRoot,
      now: new Date("2026-08-13T12:01:00.000Z"),
    };
    assert.equal(
      (await verifyQualificationEvidence(options)).candidateSha,
      candidateSha,
    );
    await assert.rejects(
      verifyQualificationEvidence({
        ...options,
        candidateSha: "e".repeat(40),
      }),
      /candidate SHA is stale or changed/,
    );
    await writeFile(releaseEvidencePath, '{"changed":true}\n');
    await assert.rejects(
      verifyQualificationEvidence(options),
      /size changed|digest changed/,
    );
    await writeFile(
      evidencePath,
      JSON.stringify({
        ...evidence,
        dryRun: true,
        publicationEligible: false,
      }),
    );
    await assert.rejects(
      verifyQualificationEvidence(options),
      /dry-run evidence cannot authorize publication/,
    );
    await writeFile(
      evidencePath,
      JSON.stringify({
        ...evidence,
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await assert.rejects(
      verifyQualificationEvidence(options),
      /older than its 30-day retention window/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("real workflows preserve PR, fork, candidate, promotion, and publication boundaries", async () => {
  const read = async (name) =>
    await readFile(resolve(repositoryRoot, ".github/workflows", name), "utf8");
  const [ci, validation, codeql, candidate, promotion, publication] =
    await Promise.all([
      read("ci.yml"),
      read("validate.yml"),
      read("codeql.yml"),
      read("release-candidate.yml"),
      read("promote-main.yml"),
      read("prerelease.yml"),
    ]);
  assert.match(ci, /pull_request:[\s\S]*- dev[\s\S]*- main/);
  assert.doesNotMatch(ci, /\npush:/);
  assert.match(
    ci,
    /flowxo\/agent-relay\/\.github\/workflows\/validate\.yml@dev/,
  );
  assert.match(
    validation,
    /Check out the protected dev check manifest and runner[\s\S]*ref: dev[\s\S]*mv \.trusted-sdlc[\s\S]*RUNNER_TEMP\/agent-relay-trusted-sdlc\/scripts\/sdlc\/run\.mjs[\s\S]*--groups core/,
  );
  assert.match(validation, /if: inputs\.rebuild_native[\s\S]*pnpm rebuild/);
  assert.doesNotMatch(
    `${ci}\n${validation}`,
    /secrets\.|id-token: write|contents: write|check:release|npm publish/,
  );
  assert.match(
    codeql,
    /\.trusted-sdlc\/scripts\/sdlc\/classify\.mjs[\s\S]*documentation_only != 'true'/,
  );
  assert.doesNotMatch(codeql, /\npush:|contents: write|secrets\./);
  assert.match(
    candidate,
    /workflow_dispatch:[\s\S]*environment: release-candidate[\s\S]*provision-harnesses\.mjs[\s\S]*pnpm check:release/,
  );
  assert.doesNotMatch(
    candidate,
    /pull_request:|\npush:|contents: write|id-token: write|secrets\./,
  );
  assert.match(promotion, /statuses: write/);
  assert.match(
    promotion,
    /qualification\.mjs verify[\s\S]*context=release-qualified[\s\S]*force=false/,
  );
  assert.doesNotMatch(promotion, /pnpm check|npm publish|id-token: write/);
  for (const workflow of [ci, validation, codeql, candidate, publication]) {
    assert.doesNotMatch(workflow, /statuses: write|context=release-qualified/);
  }
  assert.match(
    publication,
    /refs\/remotes\/origin\/main\^\{commit\}[\s\S]*qualification\.mjs verify[\s\S]*environment: npm-prerelease[\s\S]*id-token: write/,
  );
  assert.doesNotMatch(
    publication,
    /pnpm check|test:e2e|pnpm audit|build-release\.mjs|secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/,
  );
});
