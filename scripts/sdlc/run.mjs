import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { resolve } from "node:path";

import {
  changedFiles,
  classifyFiles,
  manifestDigest,
  readManifest,
  repositoryRoot,
  selectedChecks,
  writeJson,
} from "./lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function listArgument(name) {
  const value = argument(name);
  return value === undefined
    ? undefined
    : value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

async function execute(check, checkoutRoot) {
  const [executable, ...args] = check.command;
  const started = Date.now();
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        AGENT_RELAY_SDLC_CHECK_ID: check.id,
        AGENT_RELAY_SDLC_PHASE: phase,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (exitCode === null) {
        reject(new Error(`${check.id} ended by signal ${signal ?? "unknown"}`));
      } else {
        resolvePromise(exitCode);
      }
    });
  });
  return { code, durationMs: Date.now() - started };
}

const phase = argument("--phase");
if (!["fast", "pr", "release"].includes(phase)) {
  throw new Error(
    "usage: run.mjs --phase fast|pr|release [--base REF] [--head REF] [--groups a,b] [--only check-id] [--dry-run]",
  );
}
const checkoutRoot = resolve(argument("--repository") ?? repositoryRoot);
const manifest = await readManifest();
const explicitFiles = argument("--files-json");
const comparison =
  phase === "release"
    ? {
        ...(await changedFiles({
          base: "HEAD",
          head: "HEAD",
          includeWorkingTree: false,
          root: checkoutRoot,
        })),
        files: [],
      }
    : explicitFiles === undefined
      ? await changedFiles({
          base: argument("--base"),
          head: argument("--head") ?? "HEAD",
          includeWorkingTree:
            process.argv.includes("--include-working-tree") ||
            (argument("--head") === undefined && process.env.CI === undefined),
          root: checkoutRoot,
        })
      : {
          base: argument("--base") ?? "explicit-files",
          head: argument("--head") ?? "explicit-files",
          files: JSON.parse(explicitFiles),
        };
const classification = classifyFiles(manifest, comparison.files);
const checks = selectedChecks(manifest, phase, classification.risks, {
  groups: listArgument("--groups"),
  only: listArgument("--only"),
});
if (checks.length === 0) {
  throw new Error(
    `SDLC ${phase} selected no checks; inspect with pnpm sdlc:classify and verify sdlc/checks.json`,
  );
}

process.stdout.write(
  [
    `SDLC ${phase}: ${classification.risks.join(", ") || "release qualification"}`,
    `Changed files: ${String(comparison.files.length)}`,
    `Checks: ${checks.map((check) => check.id).join(", ")}`,
    "",
  ].join("\n"),
);

const result = {
  schema: "agent-relay-sdlc-run.v1",
  phase,
  base: comparison.base,
  head: comparison.head,
  manifestSha256: manifestDigest(manifest),
  classification,
  startedAt: new Date().toISOString(),
  checks: [],
};

if (process.argv.includes("--dry-run")) {
  for (const check of checks) {
    process.stdout.write(`${check.id}: ${check.command.join(" ")}\n`);
  }
  process.exit(0);
}

for (const check of checks) {
  process.stdout.write(`\n[${check.id}] ${check.title}\n`);
  const execution = await execute(check, checkoutRoot);
  result.checks.push({
    id: check.id,
    commandSha256: createHash("sha256")
      .update(`${JSON.stringify(check.command)}\n`)
      .digest("hex"),
    durationMs: execution.durationMs,
    passed: execution.code === 0,
  });
  if (execution.code !== 0) {
    result.completedAt = new Date().toISOString();
    result.passed = false;
    await writeJson(
      resolve(checkoutRoot, `.artifacts/sdlc/${phase}-results.json`),
      result,
    );
    process.stderr.write(
      `\nSDLC ${phase} failed at ${check.id}. Reproduce with: pnpm check:${phase} -- --only ${check.id}${phase === "release" ? "" : ` --base ${comparison.base} --head ${comparison.head}`}\n`,
    );
    process.exit(execution.code);
  }
}

result.completedAt = new Date().toISOString();
result.passed = true;
result.durationMs = result.checks.reduce(
  (sum, check) => sum + check.durationMs,
  0,
);
await writeJson(
  resolve(checkoutRoot, `.artifacts/sdlc/${phase}-results.json`),
  result,
);
process.stdout.write(
  `\nSDLC ${phase} passed ${String(checks.length)} checks in ${String(Math.ceil(result.durationMs / 1000))}s.\n`,
);
