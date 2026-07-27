import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  buildReleaseBundle,
  releaseArtifactNames,
} from "./lib/release-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

let expectedTag;
if (process.argv.length > 2) {
  if (process.argv.length !== 4 || process.argv[2] !== "--expected-tag") {
    throw new Error(
      "Usage: node scripts/build-release.mjs [--expected-tag TAG]",
    );
  }
  expectedTag = process.argv[3];
}

const outputDirectory = resolve(root, ".artifacts/release");
const result = await buildReleaseBundle({
  root,
  release,
  rootPackage,
  outputDirectory,
  expectedTag,
});
const names = releaseArtifactNames(release);

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `version=${release.version}`,
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
  `Release bundle verified (${result.version}, ${String(result.artifactBytes)} bytes, ${String(result.sbomPackages)} SPDX packages, ${String(result.sbomFiles)} files, two identical builds).\n`,
);
