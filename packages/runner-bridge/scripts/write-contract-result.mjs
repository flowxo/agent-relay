import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  decodeRunnerFrame,
  encodeRunnerFrame,
  runRunnerProtocolCodecConformance,
} from "@session/protocol-runner";

import { verifyRunnerProtocolArtifacts } from "../../../contracts/lib/runner-protocol-preflight.mjs";

const root = resolve(import.meta.dirname, "../../..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const { fixtures, lock } = await verifyRunnerProtocolArtifacts(root);
const report = runRunnerProtocolCodecConformance(
  {
    name: "@agent-relay/runner-bridge",
    decode: decodeRunnerFrame,
    encode: encodeRunnerFrame,
  },
  fixtures.fixtures,
);
if (!report.ok || report.total !== 33) {
  throw new Error("Runner protocol consumer conformance did not pass.");
}

const packageManifest = JSON.parse(
  await readFile(resolve(root, "packages/runner-bridge/package.json"), "utf8"),
);
const lockBytes = await readFile(
  resolve(root, "contracts/runner-protocol-lock.json"),
);
const sourceTreeState =
  git(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0
    ? "clean"
    : "dirty";
const result = {
  schema: "agent-relay.runner-protocol-conformance/v1",
  schema_version: 1,
  consumer_repository: "flowxo/agent-relay",
  consumer_commit: git(["rev-parse", "HEAD"]),
  consumer_tree_state: sourceTreeState,
  consumer_package: {
    name: packageManifest.name,
    version: packageManifest.version,
  },
  protocol_family: lock.protocol_family,
  compatibility_commitment: lock.compatibility_commitment,
  protocol_source_commit: lock.source_commit,
  release_eligible: lock.release_eligible && sourceTreeState === "clean",
  protocol_lock_sha256: sha256(lockBytes),
  artifacts: lock.artifacts.map((artifact) => ({
    package: artifact.package,
    version: artifact.version,
    sha256: artifact.sha256,
  })),
  conformance: report,
};
const output = resolve(root, ".contract-results/runner-protocol-v1.json");
await mkdir(resolve(root, ".contract-results"), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(
  `runner_contract_result=.contract-results/runner-protocol-v1.json cases=${String(report.passed)}/${String(report.total)} release_eligible=${String(result.release_eligible)}\n`,
);
