import { resolve } from "node:path";
import process from "node:process";

import {
  appendGithubOutput,
  changedFiles,
  classifyFiles,
  readManifest,
} from "./lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const manifest = await readManifest();
const explicitFiles = argument("--files-json");
const comparison =
  explicitFiles === undefined
    ? await changedFiles({
        base: argument("--base"),
        head: argument("--head") ?? "HEAD",
        root: resolve(argument("--repository") ?? process.cwd()),
        includeWorkingTree: process.argv.includes("--include-working-tree"),
      })
    : {
        base: argument("--base") ?? "explicit-files",
        head: argument("--head") ?? "explicit-files",
        files: JSON.parse(explicitFiles),
      };
const classification = {
  ...classifyFiles(manifest, comparison.files),
  base: comparison.base,
  head: comparison.head,
};

const githubOutput = argument("--github-output");
if (githubOutput !== undefined) {
  await appendGithubOutput(githubOutput, {
    core: classification.groups.includes("core"),
    browser: classification.groups.includes("browser"),
    lifecycle: classification.groups.includes("lifecycle"),
    release: classification.groups.includes("release"),
    ux_evidence_required: classification.uxEvidenceRequired,
    documentation_only: classification.documentationOnly,
    classification: JSON.stringify(classification),
  });
}

process.stdout.write(`${JSON.stringify(classification, null, 2)}\n`);
