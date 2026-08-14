import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  readGitBuildInfo,
  releaseArtifactNames,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const arguments_ = process.argv.slice(2);
const allowTagPromotion = arguments_.includes("--allow-tag-promotion");
const directoryArgument = arguments_.find((value) => !value.startsWith("--"));
const directory = resolve(root, directoryArgument ?? ".artifacts/release");
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
  allowTagPromotion,
});

if (process.env.GITHUB_OUTPUT !== undefined) {
  const names = releaseArtifactNames(release);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `version=${result.version}`,
      `tag=${release.gitTag}`,
      `artifact=.artifacts/release/${names.tarball}`,
      `sbom=.artifacts/release/${names.sbom}`,
      `bundle=.artifacts/release`,
      "",
    ].join("\n"),
    "utf8",
  );
}

process.stdout.write(
  `Release bundle integrity verified (${result.version}, ${result.artifact}, ${String(result.sbomPackages)} SPDX packages, ${String(result.sbomFiles)} files).\n`,
);
