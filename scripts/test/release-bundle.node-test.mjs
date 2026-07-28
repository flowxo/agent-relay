import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  releaseArtifactNames,
  verifyReleaseBundle,
} from "../lib/release-bundle.mjs";

const runFile = promisify(execFile);
const commit = "a".repeat(40);
const mainPackageId = "SPDXRef-Package-agent-relay";

function releaseConfiguration() {
  return {
    schema: "agent-relay-release-candidate.v1",
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.1",
    gitTag: "v0.1.0-alpha.1",
    distTag: "alpha",
    priorFixtureVersion: "0.1.0-alpha.0",
    node: ">=22",
    os: ["darwin"],
    cpu: ["arm64", "x64"],
    dependencies: {
      "better-sqlite3": "13.0.1",
      zod: "4.4.3",
    },
    publication: {
      approved: false,
      registryAction: "blocked",
      registry: "https://registry.npmjs.org/",
      workflow: "prerelease.yml",
      environment: "npm-prerelease",
      requiresPublicRepository: true,
    },
  };
}

function rootPackage() {
  return {
    name: "@flowxo/agent-relay",
    version: "0.1.0-alpha.1",
    private: true,
  };
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

async function fileDigest(algorithm, path) {
  return digest(algorithm, await readFile(path));
}

async function writeSyntheticBundle(directory, { duplicateFile = false } = {}) {
  const release = releaseConfiguration();
  const names = releaseArtifactNames(release);
  const source = join(directory, "source");
  const packageDirectory = join(source, "package");
  const bundle = join(directory, "bundle");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: release.name,
      version: release.version,
      private: true,
    })}\n`,
  );
  await writeFile(join(packageDirectory, "dist", "cli.js"), "export {};\n");

  const tarball = join(bundle, names.tarball);
  await runFile("tar", ["-czf", tarball, "-C", source, "package"]);
  const tarballSha256 = await fileDigest("sha256", tarball);
  const fileRecords = [];
  for (const file of ["dist/cli.js", "package.json"]) {
    const path = join(packageDirectory, file);
    fileRecords.push({
      SPDXID: `SPDXRef-File-${digest("sha256", file).slice(0, 24)}`,
      fileName: `./${file}`,
      checksums: [
        { algorithm: "SHA1", checksumValue: await fileDigest("sha1", path) },
        {
          algorithm: "SHA256",
          checksumValue: await fileDigest("sha256", path),
        },
      ],
    });
  }
  const verificationCode = digest(
    "sha1",
    fileRecords
      .map((file) => file.checksums[0].checksumValue)
      .sort()
      .join(""),
  );
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    documentDescribes: [mainPackageId],
    packages: [
      {
        SPDXID: mainPackageId,
        name: release.name,
        versionInfo: release.version,
        checksums: [{ algorithm: "SHA256", checksumValue: tarballSha256 }],
        packageVerificationCode: {
          packageVerificationCodeValue: verificationCode,
        },
      },
      {
        SPDXID: "SPDXRef-Package-better-sqlite3",
        name: "better-sqlite3",
        versionInfo: "13.0.1",
      },
      {
        SPDXID: "SPDXRef-Package-zod",
        name: "zod",
        versionInfo: "4.4.3",
      },
    ],
    files: duplicateFile
      ? [
          ...fileRecords,
          {
            ...fileRecords[0],
            checksums: fileRecords[0].checksums.map((checksum) => ({
              ...checksum,
            })),
          },
        ]
      : fileRecords,
    relationships: fileRecords.map((file) => ({
      spdxElementId: mainPackageId,
      relationshipType: "CONTAINS",
      relatedSpdxElement: file.SPDXID,
    })),
  };
  const sbomPath = join(bundle, names.sbom);
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const manifest = {
    schema: "agent-relay-release-bundle.v1",
    commit,
    tag: release.gitTag,
    package: {
      name: release.name,
      version: release.version,
      private: true,
    },
    artifact: {
      file: names.tarball,
      bytes: (await stat(tarball)).size,
      sha256: tarballSha256,
    },
    sbom: {
      file: names.sbom,
      bytes: (await stat(sbomPath)).size,
      sha256: await fileDigest("sha256", sbomPath),
      subjectSha256: tarballSha256,
    },
    reproducibility: {
      builds: 2,
      matched: true,
      sha256: tarballSha256,
    },
    checksumsFile: names.checksums,
  };
  const manifestPath = join(bundle, names.manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumLines = [];
  for (const file of [names.manifest, names.sbom, names.tarball].sort()) {
    checksumLines.push(
      `${await fileDigest("sha256", join(bundle, file))}  ${file}`,
    );
  }
  await writeFile(
    join(bundle, names.checksums),
    `${checksumLines.join("\n")}\n`,
  );
  return { bundle, names, release };
}

test("verifies a bound bundle and rejects a changed artifact", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, names, release } =
      await writeSyntheticBundle(temporaryRoot);
    await assert.doesNotReject(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
    );

    await appendFile(join(bundle, names.tarball), "tampered");
    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /checksum differs/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects duplicate checksum entries", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, names, release } =
      await writeSyntheticBundle(temporaryRoot);
    const checksumsPath = join(bundle, names.checksums);
    const checksums = await readFile(checksumsPath, "utf8");
    await appendFile(checksumsPath, checksums.split("\n", 1)[0] + "\n");
    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /repeats/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a cryptographically consistent duplicate SBOM file", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, release } = await writeSyntheticBundle(temporaryRoot, {
      duplicateFile: true,
    });
    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /duplicate file names or identifiers/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
