import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  readGitBuildInfo,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, process.argv[2] ?? ".artifacts/release");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const expectedCommit =
  process.env.GITHUB_SHA ?? (await readGitBuildInfo(root)).commit;

const result = await verifyReleaseBundle({
  root,
  release,
  rootPackage,
  directory,
  expectedCommit,
});

process.stdout.write(
  `Release bundle integrity verified (${result.version}, ${result.artifact}, ${String(result.sbomPackages)} SPDX packages, ${String(result.sbomFiles)} files).\n`,
);
