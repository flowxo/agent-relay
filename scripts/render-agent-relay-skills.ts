import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalAgentRelaySkillContractJson,
  officialAgentRelaySkillArtifacts,
} from "../apps/relay/src/agent-skills.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const files = [
  {
    path: resolve(root, "skills/agent-relay/contract.v1.json"),
    content: canonicalAgentRelaySkillContractJson(),
  },
  ...officialAgentRelaySkillArtifacts().map((artifact) => ({
    path: resolve(
      root,
      `skills/agent-relay/rendered/${artifact.harness}/SKILL.md`,
    ),
    content: artifact.content,
  })),
];

for (const file of files) {
  if (check) {
    let current: string | undefined;
    try {
      current = await readFile(file.path, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== file.content) {
      throw new Error(
        `${file.path.slice(root.length + 1)} drifted; run pnpm skills:generate`,
      );
    }
    continue;
  }
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content, "utf8");
}

process.stdout.write(
  check
    ? `Verified ${String(files.length)} canonical Agent Relay skill artifacts.\n`
    : `Rendered ${String(files.length)} canonical Agent Relay skill artifacts.\n`,
);
