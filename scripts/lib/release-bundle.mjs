import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  assertReleaseConfiguration,
  stagedPackageIsPrivate,
} from "./release-policy.mjs";

const runFile = promisify(execFile);
const mainPackageId = "SPDXRef-Package-agent-relay";
const checksumPattern = /^([a-f0-9]{64}) {2}([A-Za-z0-9._@+-]+)$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release bundle violation: ${message}`);
  }
}

async function run(executable, args, options = {}) {
  try {
    return await runFile(executable, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stdout =
      typeof error.stdout === "string" ? error.stdout.slice(-16_000) : "";
    const stderr =
      typeof error.stderr === "string" ? error.stderr.slice(-16_000) : "";
    throw new Error(
      [`${executable} ${args.join(" ")} failed`, stdout.trim(), stderr.trim()]
        .filter((part) => part.length > 0)
        .join("\n"),
      { cause: error },
    );
  }
}

function sha(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

async function fileSha(algorithm, path) {
  return sha(algorithm, await readFile(path));
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function listRegularFiles(directory, base = directory) {
  const metadata = await lstat(directory);
  assert(
    !metadata.isSymbolicLink(),
    `${relativePath(base, directory)} is a symlink`,
  );
  assert(
    metadata.isDirectory(),
    `${relativePath(base, directory)} is not a directory`,
  );

  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), `${relativePath(base, path)} is a symlink`);
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(path, base)));
    } else {
      assert(
        entry.isFile(),
        `${relativePath(base, path)} is not a regular file`,
      );
      files.push(relativePath(base, path));
    }
  }
  return files.sort();
}

export function releaseArtifactNames(release) {
  const safeName = release.name
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    tarball: `${safeName}-${release.version}.tgz`,
    sbom: `${safeName}-${release.version}.spdx.json`,
    manifest: "agent-relay-release.json",
    checksums: "SHA256SUMS",
  };
}

export async function assertCleanGit(root) {
  const { stdout } = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  assert(
    stdout.trim().length === 0,
    "release input must be a clean checkout with no tracked or untracked changes",
  );
}

export async function readGitBuildInfo(root) {
  const [
    { stdout: commitOutput },
    { stdout: dateOutput },
    { stdout: tagsOutput },
  ] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: root }),
    run("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: root }),
    run("git", ["tag", "--points-at", "HEAD"], { cwd: root }),
  ]);
  const commit = commitOutput.trim();
  const createdAt = new Date(dateOutput.trim()).toISOString();
  assert(/^[a-f0-9]{40}$/.test(commit), "git commit must be one full SHA-1");
  assert(!Number.isNaN(Date.parse(createdAt)), "git commit date is invalid");
  return {
    commit,
    createdAt,
    tags: tagsOutput
      .trim()
      .split("\n")
      .filter((value) => value.length > 0)
      .sort(),
  };
}

async function readPackage(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert(
    typeof value.name === "string" && typeof value.version === "string",
    `${path} is not a package manifest`,
  );
  return value;
}

async function resolveInstalledDependency(root, parentManifestPath, name) {
  const resolvedParentManifest = await realpath(parentManifestPath);
  const parentPackageDirectory = dirname(resolvedParentManifest);
  const candidates = [
    resolve(parentPackageDirectory, "node_modules", name, "package.json"),
    resolve(dirname(parentPackageDirectory), name, "package.json"),
    resolve(root, "node_modules", name, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) {
        return candidate;
      }
    } catch {
      // Try the frozen install's root-level resolution next.
    }
  }
  throw new Error(
    `Release bundle violation: installed dependency ${name} is missing`,
  );
}

function dependencyId(name, version) {
  return `SPDXRef-Package-${sha("sha256", `${name}@${version}`).slice(0, 20)}`;
}

function packagePurl(name, version) {
  const encodedName = encodeURIComponent(name).replace("%2F", "/");
  return `pkg:npm/${encodedName}@${version}`;
}

function packageRepository(repository) {
  if (typeof repository === "string") {
    return repository;
  }
  if (
    repository !== null &&
    typeof repository === "object" &&
    typeof repository.url === "string"
  ) {
    return repository.url;
  }
  return "NOASSERTION";
}

export async function runtimeDependencyGraph(root, release) {
  const packages = new Map();
  const edges = new Set();
  const rootManifest = resolve(root, "package.json");

  async function visit(name, expectedVersion, parentManifest) {
    const manifestPath = await resolveInstalledDependency(
      root,
      parentManifest,
      name,
    );
    const manifest = await readPackage(manifestPath);
    assert(manifest.name === name, `${name} resolved to ${manifest.name}`);
    assert(
      manifest.version === expectedVersion,
      `${name} resolved to ${manifest.version}, expected ${expectedVersion}`,
    );
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) {
      return packages.get(key).id;
    }

    const id = dependencyId(manifest.name, manifest.version);
    const record = {
      id,
      name: manifest.name,
      version: manifest.version,
      license:
        typeof manifest.license === "string" ? manifest.license : "NOASSERTION",
      repository: packageRepository(manifest.repository),
    };
    packages.set(key, record);

    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dependencyName of Object.keys(dependencies).sort()) {
      const dependencyManifestPath = await resolveInstalledDependency(
        root,
        manifestPath,
        dependencyName,
      );
      const dependencyManifest = await readPackage(dependencyManifestPath);
      const dependencyIdValue = await visit(
        dependencyName,
        dependencyManifest.version,
        manifestPath,
      );
      edges.add(`${id}\0${dependencyIdValue}`);
    }
    return id;
  }

  const directIds = [];
  for (const [name, version] of Object.entries(release.dependencies).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    directIds.push(await visit(name, version, rootManifest));
  }

  return {
    directIds: directIds.sort(),
    packages: [...packages.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...edges]
      .sort()
      .map((edge) => edge.split("\0"))
      .map(([from, to]) => ({ from, to })),
  };
}

export async function createSpdxDocument({
  root,
  release,
  rootPackage,
  tarball,
  extractedPackage,
  git,
}) {
  const tarballSha256 = await fileSha("sha256", tarball);
  const fileRecords = [];
  for (const file of await listRegularFiles(extractedPackage)) {
    const path = resolve(extractedPackage, file);
    const sha1 = await fileSha("sha1", path);
    const sha256 = await fileSha("sha256", path);
    fileRecords.push({
      SPDXID: `SPDXRef-File-${sha("sha256", file).slice(0, 24)}`,
      fileName: `./${file}`,
      checksums: [
        { algorithm: "SHA1", checksumValue: sha1 },
        { algorithm: "SHA256", checksumValue: sha256 },
      ],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
    });
  }
  const verificationCode = sha(
    "sha1",
    fileRecords
      .map((file) => file.checksums[0].checksumValue)
      .sort()
      .join(""),
  );
  const dependencies = await runtimeDependencyGraph(root, release);

  const dependencyPackages = dependencies.packages.map((dependency) => ({
    name: dependency.name,
    SPDXID: dependency.id,
    versionInfo: dependency.version,
    downloadLocation: dependency.repository,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: dependency.license,
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: packagePurl(dependency.name, dependency.version),
      },
    ],
  }));

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${release.name}-${release.version}`,
    documentNamespace: `https://github.com/flowxo/agent-relay/spdx/${git.commit}/${release.version}`,
    creationInfo: {
      created: git.createdAt,
      creators: [
        "Organization: Flow XO, LLC",
        "Tool: agent-relay-release-builder-1",
      ],
    },
    documentDescribes: [mainPackageId],
    packages: [
      {
        name: release.name,
        SPDXID: mainPackageId,
        versionInfo: release.version,
        packageFileName: basename(tarball),
        downloadLocation: "NOASSERTION",
        filesAnalyzed: true,
        packageVerificationCode: {
          packageVerificationCodeValue: verificationCode,
        },
        checksums: [{ algorithm: "SHA256", checksumValue: tarballSha256 }],
        licenseConcluded: "NOASSERTION",
        licenseDeclared: rootPackage.license,
        copyrightText: "Copyright (c) 2026 Flow XO, LLC",
        primaryPackagePurpose: "APPLICATION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: packagePurl(release.name, release.version),
          },
        ],
      },
      ...dependencyPackages,
    ],
    files: fileRecords,
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: mainPackageId,
      },
      ...fileRecords.map((file) => ({
        spdxElementId: mainPackageId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: file.SPDXID,
      })),
      ...dependencies.directIds.map((id) => ({
        spdxElementId: mainPackageId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: id,
      })),
      ...dependencies.edges.map((edge) => ({
        spdxElementId: edge.from,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: edge.to,
      })),
    ],
  };
}

async function extractTarball(tarball, destination) {
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", destination]);
  const extractedPackage = resolve(destination, "package");
  const metadata = await stat(extractedPackage);
  assert(metadata.isDirectory(), "tarball does not contain package/");
  return extractedPackage;
}

export async function buildReleaseBundle({
  root,
  release,
  rootPackage,
  outputDirectory,
  expectedTag,
}) {
  assertReleaseConfiguration(release, rootPackage);
  await assertCleanGit(root);
  const git = await readGitBuildInfo(root);
  if (expectedTag !== undefined) {
    assert(
      expectedTag === release.gitTag,
      "workflow tag differs from release metadata",
    );
    assert(
      git.tags.includes(expectedTag),
      "the expected release tag does not point at HEAD",
    );
  }

  const names = releaseArtifactNames(release);
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-release-build-"),
  );
  try {
    const first = resolve(temporaryRoot, "first.tgz");
    const second = resolve(temporaryRoot, "second.tgz");
    const buildEnvironment = {
      ...process.env,
      SOURCE_DATE_EPOCH: String(
        Math.floor(new Date(git.createdAt).getTime() / 1000),
      ),
    };

    await run("pnpm", ["pack", "--out", first], {
      cwd: root,
      env: buildEnvironment,
    });
    await run("pnpm", ["pack", "--out", second], {
      cwd: root,
      env: buildEnvironment,
    });

    const firstSha256 = await fileSha("sha256", first);
    const secondSha256 = await fileSha("sha256", second);
    assert(
      firstSha256 === secondSha256,
      "two clean builds from the same commit produced different tarballs",
    );

    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    const tarball = resolve(outputDirectory, names.tarball);
    await copyFile(second, tarball);
    const extractedPackage = await extractTarball(
      tarball,
      resolve(temporaryRoot, "extracted"),
    );
    const sbom = await createSpdxDocument({
      root,
      release,
      rootPackage,
      tarball,
      extractedPackage,
      git,
    });
    const sbomPath = resolve(outputDirectory, names.sbom);
    await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

    const tarballMetadata = await stat(tarball);
    const sbomMetadata = await stat(sbomPath);
    const manifest = {
      schema: "agent-relay-release-bundle.v1",
      sourceRepository: "https://github.com/flowxo/agent-relay",
      commit: git.commit,
      createdAt: git.createdAt,
      tag: release.gitTag,
      package: {
        name: release.name,
        version: release.version,
        private: stagedPackageIsPrivate(release),
        distTag: release.distTag,
      },
      artifact: {
        file: names.tarball,
        bytes: tarballMetadata.size,
        sha256: secondSha256,
      },
      sbom: {
        file: names.sbom,
        format: "SPDX-2.3",
        bytes: sbomMetadata.size,
        sha256: await fileSha("sha256", sbomPath),
        subjectSha256: secondSha256,
      },
      reproducibility: {
        builds: 2,
        matched: true,
        sha256: secondSha256,
      },
      checksumsFile: names.checksums,
      provenance:
        "GitHub Actions attaches signed build and SBOM attestations to the tarball when repository support is available.",
    };
    const manifestPath = resolve(outputDirectory, names.manifest);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const checksummedFiles = [names.manifest, names.sbom, names.tarball].sort();
    const checksumLines = [];
    for (const file of checksummedFiles) {
      checksumLines.push(
        `${await fileSha("sha256", resolve(outputDirectory, file))}  ${file}`,
      );
    }
    await writeFile(
      resolve(outputDirectory, names.checksums),
      `${checksumLines.join("\n")}\n`,
      "utf8",
    );

    return await verifyReleaseBundle({
      root,
      release,
      rootPackage,
      directory: outputDirectory,
      expectedCommit: git.commit,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseChecksums(source) {
  const entries = new Map();
  const lines = source
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const match = checksumPattern.exec(line);
    assert(match !== null, "SHA256SUMS contains an invalid line");
    const [, digest, file] = match;
    assert(!entries.has(file), `SHA256SUMS repeats ${file}`);
    entries.set(file, digest);
  }
  return entries;
}

export async function verifyReleaseBundle({
  release,
  rootPackage,
  directory,
  expectedCommit,
}) {
  assertReleaseConfiguration(release, rootPackage);
  const names = releaseArtifactNames(release);
  const expectedFiles = [
    names.checksums,
    names.manifest,
    names.sbom,
    names.tarball,
  ].sort();
  assert(
    JSON.stringify(await listRegularFiles(directory)) ===
      JSON.stringify(expectedFiles),
    "release directory differs from the four-file bundle contract",
  );

  const manifest = JSON.parse(
    await readFile(resolve(directory, names.manifest), "utf8"),
  );
  assert(
    manifest.schema === "agent-relay-release-bundle.v1",
    "release manifest schema differs",
  );
  assert(manifest.tag === release.gitTag, "release manifest tag differs");
  assert(
    manifest.package?.name === release.name &&
      manifest.package?.version === release.version,
    "release manifest package identity differs",
  );
  assert(
    manifest.package?.private === stagedPackageIsPrivate(release),
    "release manifest publication state differs",
  );
  assert(
    /^[a-f0-9]{40}$/.test(manifest.commit),
    "release manifest commit is not full",
  );
  if (expectedCommit !== undefined) {
    assert(
      manifest.commit === expectedCommit,
      "release manifest commit differs",
    );
  }
  assert(
    manifest.reproducibility?.matched === true &&
      manifest.reproducibility?.builds === 2,
    "release manifest lacks two-build reproducibility evidence",
  );

  const checksums = parseChecksums(
    await readFile(resolve(directory, names.checksums), "utf8"),
  );
  const expectedChecksummed = [
    names.manifest,
    names.sbom,
    names.tarball,
  ].sort();
  assert(
    JSON.stringify([...checksums.keys()].sort()) ===
      JSON.stringify(expectedChecksummed),
    "SHA256SUMS inventory differs",
  );
  for (const [file, expected] of checksums) {
    assert(
      (await fileSha("sha256", resolve(directory, file))) === expected,
      `${file} checksum differs`,
    );
  }

  const tarball = resolve(directory, names.tarball);
  const tarballSha256 = await fileSha("sha256", tarball);
  assert(
    manifest.artifact?.file === names.tarball &&
      manifest.artifact?.sha256 === tarballSha256 &&
      manifest.artifact?.bytes === (await stat(tarball)).size,
    "release manifest artifact evidence differs",
  );
  assert(
    manifest.reproducibility?.sha256 === tarballSha256,
    "reproducibility digest differs from the tarball",
  );

  const sbomPath = resolve(directory, names.sbom);
  const sbom = JSON.parse(await readFile(sbomPath, "utf8"));
  assert(sbom.spdxVersion === "SPDX-2.3", "SBOM version differs");
  assert(sbom.dataLicense === "CC0-1.0", "SBOM data license differs");
  assert(
    Array.isArray(sbom.documentDescribes) &&
      sbom.documentDescribes.includes(mainPackageId),
    "SBOM does not describe the Agent Relay package",
  );
  const mainPackage = sbom.packages?.find(
    (entry) => entry.SPDXID === mainPackageId,
  );
  assert(
    Array.isArray(sbom.packages) &&
      new Set(sbom.packages.map((entry) => entry.SPDXID)).size ===
        sbom.packages.length,
    "SBOM contains duplicate package identifiers",
  );
  assert(
    mainPackage?.name === release.name &&
      mainPackage?.versionInfo === release.version,
    "SBOM package identity differs",
  );
  assert(
    mainPackage.checksums?.some(
      (checksum) =>
        checksum.algorithm === "SHA256" &&
        checksum.checksumValue === tarballSha256,
    ),
    "SBOM does not bind to the tarball SHA-256",
  );
  for (const [name, version] of Object.entries(release.dependencies)) {
    assert(
      sbom.packages?.some(
        (entry) => entry.name === name && entry.versionInfo === version,
      ),
      `SBOM is missing runtime dependency ${name}@${version}`,
    );
  }
  assert(
    manifest.sbom?.file === names.sbom &&
      manifest.sbom?.sha256 === (await fileSha("sha256", sbomPath)) &&
      manifest.sbom?.bytes === (await stat(sbomPath)).size &&
      manifest.sbom?.subjectSha256 === tarballSha256,
    "release manifest SBOM evidence differs",
  );
  assert(
    manifest.checksumsFile === names.checksums,
    "release manifest checksum filename differs",
  );

  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-release-verify-"),
  );
  try {
    const extractedPackage = await extractTarball(tarball, temporaryRoot);
    const packageManifest = await readPackage(
      resolve(extractedPackage, "package.json"),
    );
    assert(
      packageManifest.name === release.name &&
        packageManifest.version === release.version &&
        packageManifest.private === stagedPackageIsPrivate(release),
      "tarball package manifest differs from release policy",
    );
    const extractedFiles = await listRegularFiles(extractedPackage);
    assert(
      Array.isArray(sbom.files) &&
        new Set(sbom.files.map((file) => file.fileName)).size ===
          sbom.files.length &&
        new Set(sbom.files.map((file) => file.SPDXID)).size ===
          sbom.files.length,
      "SBOM contains duplicate file names or identifiers",
    );
    const sbomFiles = new Map(
      (sbom.files ?? []).map((file) => [
        file.fileName.replace(/^\.\//, ""),
        file,
      ]),
    );
    assert(
      JSON.stringify([...sbomFiles.keys()].sort()) ===
        JSON.stringify(extractedFiles),
      "SBOM file inventory differs from the tarball",
    );
    const verificationHashes = [];
    for (const file of extractedFiles) {
      const record = sbomFiles.get(file);
      const expected = await fileSha("sha256", resolve(extractedPackage, file));
      const expectedSha1 = await fileSha(
        "sha1",
        resolve(extractedPackage, file),
      );
      verificationHashes.push(expectedSha1);
      assert(
        record.checksums?.some(
          (checksum) =>
            checksum.algorithm === "SHA256" &&
            checksum.checksumValue === expected,
        ),
        `SBOM checksum differs for ${file}`,
      );
      assert(
        sbom.relationships?.some(
          (relationship) =>
            relationship.spdxElementId === mainPackageId &&
            relationship.relationshipType === "CONTAINS" &&
            relationship.relatedSpdxElement === record.SPDXID,
        ),
        `SBOM package relationship is missing for ${file}`,
      );
    }
    assert(
      mainPackage.packageVerificationCode?.packageVerificationCodeValue ===
        sha("sha1", verificationHashes.sort().join("")),
      "SBOM package verification code differs",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    commit: manifest.commit,
    version: release.version,
    artifact: names.tarball,
    artifactBytes: manifest.artifact.bytes,
    artifactSha256: tarballSha256,
    sbom: names.sbom,
    sbomPackages: sbom.packages.length,
    sbomFiles: sbom.files.length,
  };
}
