import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

import {
  applyRunnerProtocolCandidate,
  inspectRunnerProtocolCandidate,
} from "../lib/runner-protocol-candidate.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const rawArguments = process.argv.slice(2);
const argumentsList =
  rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const artifactIndex = argumentsList.indexOf("--artifacts");
const artifactDirectory =
  artifactIndex === -1 ? undefined : argumentsList[artifactIndex + 1];
const apply = argumentsList.includes("--apply");
const known = new Set(["--artifacts", "--apply"]);
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (!known.has(argument)) {
    throw new Error(`Unknown runner protocol update argument: ${argument}`);
  }
  if (argument === "--artifacts") {
    index += 1;
  }
}
if (
  artifactDirectory === undefined ||
  artifactDirectory.length === 0 ||
  artifactDirectory.startsWith("-")
) {
  throw new Error("--artifacts requires an explicit producer directory.");
}

function targetIsClean() {
  return (
    execFileSync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        "contracts/runner-protocol-lock.json",
        "vendor/runner-protocol-v1",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim().length === 0
  );
}

const options = {
  repositoryRoot,
  artifactDirectory: resolve(artifactDirectory),
};
const result = apply
  ? await applyRunnerProtocolCandidate({
      ...options,
      targetIsClean: targetIsClean(),
    })
  : await inspectRunnerProtocolCandidate(options);
process.stdout.write(
  `${JSON.stringify(
    {
      schema: "agent-relay.runner-protocol-update/v1",
      schema_version: 1,
      mode: apply ? "apply" : "check",
      changed: result.changed,
      protocol_family: result.lock.protocol_family,
      compatibility_commitment: result.lock.compatibility_commitment,
      source_commit: result.lock.source_commit,
      fixture_count: result.fixtureCount,
      artifacts: result.lock.artifacts.map(
        ({ package: packageName, version, sha256 }) => ({
          package: packageName,
          version,
          sha256,
        }),
      ),
    },
    null,
    2,
  )}\n`,
);
