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
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import {
  readGitBuildInfo,
  releaseArtifactNames,
  run as runReleaseCommand,
  verifyReleaseBundle,
} from "../lib/release-bundle.mjs";

const runFile = promisify(execFile);
const commit = "a".repeat(40);
const mainPackageId = "SPDXRef-Package-agent-relay";

function bundledComponentId(component) {
  return `SPDXRef-Bundled-${digest("sha256", `${component.name}@${component.version}`).slice(0, 20)}`;
}

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
    bundledComponents: [
      {
        name: "@whooshbang/contracts",
        version: "1.0.0-rc.12",
        sourceRepository: "https://github.com/flowxo/whooshbang",
        sourceCommit: "a".repeat(40),
        artifactSha256: "b".repeat(64),
        licenseDeclared: "NOASSERTION",
      },
      {
        name: "@whooshbang/sdk",
        version: "1.0.0-rc.13",
        sourceRepository: "https://github.com/flowxo/whooshbang",
        sourceCommit: "a".repeat(40),
        artifactSha256: "c".repeat(64),
        licenseDeclared: "NOASSERTION",
      },
    ],
    bundledComponentLicenseReview: {
      status: "required-before-publication",
      ownerApproved: false,
      noticeApproved: false,
      decisionReference: null,
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

async function rewriteChecksums(bundle, names) {
  const checksumLines = [];
  for (const file of [
    names.manifest,
    names.packageContents,
    names.releaseNotes,
    names.sbom,
    names.tarball,
  ].sort()) {
    checksumLines.push(
      `${await fileDigest("sha256", join(bundle, file))}  ${file}`,
    );
  }
  await writeFile(
    join(bundle, names.checksums),
    `${checksumLines.join("\n")}\n`,
  );
}

async function rewriteSbom(bundle, names, mutate) {
  const sbomPath = join(bundle, names.sbom);
  const sbom = JSON.parse(await readFile(sbomPath, "utf8"));
  mutate(sbom);
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const manifestPath = join(bundle, names.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sbom.bytes = (await stat(sbomPath)).size;
  manifest.sbom.sha256 = await fileDigest("sha256", sbomPath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rewriteChecksums(bundle, names);
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
      ...release.bundledComponents.map((component) => ({
        SPDXID: bundledComponentId(component),
        name: component.name,
        versionInfo: component.version,
        downloadLocation: `${component.sourceRepository}/tree/${component.sourceCommit}`,
        licenseDeclared: component.licenseDeclared,
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: component.artifactSha256,
          },
        ],
      })),
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
    relationships: [
      ...fileRecords.map((file) => ({
        spdxElementId: mainPackageId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: file.SPDXID,
      })),
      ...release.bundledComponents.map((component) => ({
        spdxElementId: mainPackageId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: bundledComponentId(component),
      })),
    ],
  };
  const sbomPath = join(bundle, names.sbom);
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const packageContentFiles = [];
  let unpackedBytes = 0;
  for (const file of ["dist/cli.js", "package.json"]) {
    const path = join(packageDirectory, file);
    const bytes = (await stat(path)).size;
    unpackedBytes += bytes;
    packageContentFiles.push({
      path: file,
      bytes,
      sha256: await fileDigest("sha256", path),
    });
  }
  const packageContents = {
    schema: "agent-relay-package-content-evidence.v1",
    package: {
      name: release.name,
      version: release.version,
    },
    artifactSha256: tarballSha256,
    fileCount: packageContentFiles.length,
    unpackedBytes,
    files: packageContentFiles,
  };
  const packageContentsPath = join(bundle, names.packageContents);
  await writeFile(
    packageContentsPath,
    `${JSON.stringify(packageContents, null, 2)}\n`,
  );
  const releaseNotesPath = join(bundle, names.releaseNotes);
  await writeFile(
    releaseNotesPath,
    `# Agent Relay ${release.version} release candidate\n\nFXO-1162 candidate freeze created or authorized no tag. Consult the manifest's build-time \`tagStatus\`.\n`,
  );
  const manifest = {
    schema: "agent-relay-release-bundle.v1",
    sourceRepository: "https://github.com/flowxo/agent-relay",
    commit,
    createdAt: "2026-08-11T12:00:00.000Z",
    intendedTag: release.gitTag,
    tagStatus: "not-created",
    package: {
      name: release.name,
      version: release.version,
      private: true,
      distTag: release.distTag,
    },
    sourceInputs: {
      packageManager: "pnpm@11.17.0",
      files: [],
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
    packageContents: {
      file: names.packageContents,
      format: packageContents.schema,
      bytes: (await stat(packageContentsPath)).size,
      sha256: await fileDigest("sha256", packageContentsPath),
      subjectSha256: tarballSha256,
      fileCount: packageContents.fileCount,
      unpackedBytes: packageContents.unpackedBytes,
    },
    releaseNotes: {
      file: names.releaseNotes,
      bytes: (await stat(releaseNotesPath)).size,
      sha256: await fileDigest("sha256", releaseNotesPath),
      status: "candidate-without-tag",
    },
    reproducibility: {
      builds: 2,
      matched: true,
      sha256: tarballSha256,
    },
    checksumsFile: names.checksums,
    provenance: {
      source: "clean-git-commit",
      localBuild: "unsigned",
      signedAttestations: "not-produced-by-this-local-bundle",
      taggedWorkflow:
        "GitHub Actions may attach signed build and SBOM attestations only after the intended tag exists and the separately authorized workflow succeeds.",
    },
  };
  const manifestPath = join(bundle, names.manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumLines = [];
  for (const file of [
    names.manifest,
    names.packageContents,
    names.releaseNotes,
    names.sbom,
    names.tarball,
  ].sort()) {
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

test("resolves an immutable intended tag as absent, at HEAD, or elsewhere", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-git-tag-test-"),
  );
  try {
    await runFile("git", ["init", "--object-format=sha1"], {
      cwd: temporaryRoot,
    });
    await writeFile(join(temporaryRoot, "candidate.txt"), "candidate\n");
    await runFile("git", ["add", "candidate.txt"], { cwd: temporaryRoot });
    const commitArguments = [
      "-c",
      "user.name=Agent Relay Test",
      "-c",
      "user.email=agent-relay@example.test",
      "commit",
      "-m",
      "candidate",
    ];
    await runFile("git", commitArguments, { cwd: temporaryRoot });

    const intendedTag = "v0.1.0-alpha.1";
    const absent = await readGitBuildInfo(temporaryRoot, intendedTag);
    assert.deepEqual(absent.intendedTagState, {
      status: "not-created",
      commit: null,
    });

    await runFile("git", ["tag", intendedTag], { cwd: temporaryRoot });
    const atHead = await readGitBuildInfo(temporaryRoot, intendedTag);
    assert.deepEqual(atHead.intendedTagState, {
      status: "verified-at-head",
      commit: atHead.commit,
    });

    await runFile(
      "git",
      [
        "-c",
        "user.name=Agent Relay Test",
        "-c",
        "user.email=agent-relay@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "later",
      ],
      { cwd: temporaryRoot },
    );
    const elsewhere = await readGitBuildInfo(temporaryRoot, intendedTag);
    assert.deepEqual(elsewhere.intendedTagState, {
      status: "exists-elsewhere",
      commit: atHead.commit,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("redacts machine paths from release-command failures", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-release-failure-test-"),
  );
  try {
    const privateHome = join(temporaryRoot, "synthetic-home");
    const privateArgument = join(temporaryRoot, "synthetic-artifact.tgz");
    let failure;
    try {
      await runReleaseCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write(process.cwd()); process.stderr.write(process.env.HOME ?? ''); process.exit(9)",
          privateArgument,
        ],
        {
          cwd: temporaryRoot,
          env: { ...process.env, HOME: privateHome },
        },
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
    assert.equal(failure.message.includes(temporaryRoot), false);
    assert.equal(failure.message.includes(privateHome), false);
    assert.equal(failure.message.includes(privateArgument), false);
    assert.match(failure.message, /<path:synthetic-artifact\.tgz>/u);
    assert.match(failure.message, /<checkout>/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

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

test("rejects changed manifest source provenance with consistent checksums", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, names, release } =
      await writeSyntheticBundle(temporaryRoot);
    const manifestPath = join(bundle, names.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.sourceRepository = "https://example.invalid/agent-relay";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rewriteChecksums(bundle, names);

    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /source repository differs/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a missing bundled component with consistent SBOM metadata", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, names, release } =
      await writeSyntheticBundle(temporaryRoot);
    await rewriteSbom(bundle, names, (sbom) => {
      sbom.packages = sbom.packages.filter(
        (entry) => entry.name !== "@whooshbang/contracts",
      );
      sbom.relationships = sbom.relationships.filter(
        (entry) =>
          entry.relatedSpdxElement !==
          bundledComponentId(release.bundledComponents[0]),
      );
    });

    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /bundled component differs/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a changed SBOM SHA-1 even when its verification code agrees", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-bundle-test-"),
  );
  try {
    const { bundle, names, release } =
      await writeSyntheticBundle(temporaryRoot);
    await rewriteSbom(bundle, names, (sbom) => {
      const firstFile = sbom.files[0];
      const sha1 = firstFile.checksums.find(
        (checksum) => checksum.algorithm === "SHA1",
      );
      sha1.checksumValue = "f".repeat(40);
      const verificationHashes = sbom.files
        .map(
          (file) =>
            file.checksums.find((checksum) => checksum.algorithm === "SHA1")
              .checksumValue,
        )
        .sort();
      sbom.packages.find(
        (entry) => entry.SPDXID === mainPackageId,
      ).packageVerificationCode.packageVerificationCodeValue = digest(
        "sha1",
        verificationHashes.join(""),
      );
    });

    await assert.rejects(
      verifyReleaseBundle({
        release,
        rootPackage: rootPackage(),
        directory: bundle,
        expectedCommit: commit,
      }),
      /SHA-1 checksum differs/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
