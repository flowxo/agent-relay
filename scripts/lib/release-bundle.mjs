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
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  assertReleaseConfiguration,
  stagedPackageIsPrivate,
} from "./release-policy.mjs";
import { packageProofToolEnvironment } from "./safe-packed-environment.mjs";

const runFile = promisify(execFile);
const mainPackageId = "SPDXRef-Package-agent-relay";
const checksumPattern = /^([a-f0-9]{64}) {2}([A-Za-z0-9._@+-]+)$/;

function sanitizedReleaseOutput(value, cwd) {
  let sanitized = value;
  for (const [privatePath, replacement] of [
    [cwd, "<checkout>"],
    [process.cwd(), "<checkout>"],
    [process.env.HOME, "<home>"],
    [tmpdir(), "<temporary-root>"],
  ]) {
    if (privatePath !== undefined && privatePath.length > 0) {
      sanitized = sanitized.replaceAll(privatePath, replacement);
    }
  }
  return sanitized;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release bundle violation: ${message}`);
  }
}

export async function run(executable, args, options = {}) {
  try {
    return await runFile(executable, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
    const stdout =
      typeof error.stdout === "string"
        ? sanitizedReleaseOutput(error.stdout.slice(-16_000), cwd)
        : "";
    const stderr =
      typeof error.stderr === "string"
        ? sanitizedReleaseOutput(error.stderr.slice(-16_000), cwd)
        : "";
    const command = [
      executable,
      ...args.map((argument) =>
        isAbsolute(argument)
          ? `<path:${basename(argument)}>`
          : sanitizedReleaseOutput(argument, cwd),
      ),
    ].join(" ");
    throw new Error(
      [`${command} failed`, stdout.trim(), stderr.trim()]
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
    packageContents: "package-contents.json",
    releaseNotes: "RELEASE_NOTES.md",
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

export async function readGitBuildInfo(root, intendedTag) {
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
  let intendedTagState;
  if (intendedTag !== undefined) {
    const { stdout: matchingTagsOutput } = await run(
      "git",
      ["tag", "--list", "--format=%(refname:short)", intendedTag],
      { cwd: root },
    );
    const matchingTags = matchingTagsOutput
      .trim()
      .split("\n")
      .filter((value) => value.length > 0);
    const exists = matchingTags.includes(intendedTag);
    if (!exists) {
      intendedTagState = { status: "not-created", commit: null };
    } else {
      const { stdout: tagCommitOutput } = await run(
        "git",
        ["rev-list", "-n", "1", `refs/tags/${intendedTag}`],
        { cwd: root },
      );
      const tagCommit = tagCommitOutput.trim();
      assert(
        /^[a-f0-9]{40}$/.test(tagCommit),
        "intended git tag does not resolve to one full commit",
      );
      intendedTagState = {
        status: tagCommit === commit ? "verified-at-head" : "exists-elsewhere",
        commit: tagCommit,
      };
    }
  }
  return {
    commit,
    createdAt,
    tags: tagsOutput
      .trim()
      .split("\n")
      .filter((value) => value.length > 0)
      .sort(),
    ...(intendedTagState === undefined ? {} : { intendedTagState }),
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

function bundledComponentId(component) {
  return `SPDXRef-Bundled-${sha("sha256", `${component.name}@${component.version}`).slice(0, 20)}`;
}

async function sourceInputRecords(root, rootPackage) {
  const paths = [
    "pnpm-lock.yaml",
    "packaging/release.json",
    "packaging/package-files.json",
    "packaging/actions-lock.json",
    "packaging/release-notes.md",
    "contracts/contract-lock.json",
    "packaging/v1-release-boundary.json",
  ];
  return {
    packageManager: rootPackage.packageManager,
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: await fileSha("sha256", resolve(root, path)),
      })),
    ),
  };
}

async function createPackageContentSnapshot({
  release,
  tarball,
  extractedPackage,
}) {
  const files = [];
  let unpackedBytes = 0;
  for (const path of await listRegularFiles(extractedPackage)) {
    const metadata = await stat(resolve(extractedPackage, path));
    unpackedBytes += metadata.size;
    files.push({
      path,
      bytes: metadata.size,
      sha256: await fileSha("sha256", resolve(extractedPackage, path)),
    });
  }
  return {
    schema: "agent-relay-package-content-evidence.v1",
    package: {
      name: release.name,
      version: release.version,
    },
    artifactSha256: await fileSha("sha256", tarball),
    fileCount: files.length,
    unpackedBytes,
    files,
  };
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
      manifestPath,
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
  const bundledPackages = release.bundledComponents.map((component) => ({
    name: component.name,
    SPDXID: bundledComponentId(component),
    versionInfo: component.version,
    downloadLocation: `${component.sourceRepository}/tree/${component.sourceCommit}`,
    filesAnalyzed: false,
    checksums: [
      { algorithm: "SHA256", checksumValue: component.artifactSha256 },
    ],
    licenseConcluded: component.licenseDeclared,
    licenseDeclared: component.licenseDeclared,
    copyrightText: component.copyrightText,
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: packagePurl(component.name, component.version),
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
        licenseConcluded: rootPackage.license,
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
      ...bundledPackages,
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
      ...release.bundledComponents.map((component) => ({
        spdxElementId: mainPackageId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: bundledComponentId(component),
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
  const git = await readGitBuildInfo(root, release.gitTag);
  assert(
    git.intendedTagState?.status !== "exists-elsewhere",
    "the immutable intended release tag already points at another commit",
  );
  if (expectedTag !== undefined) {
    assert(
      expectedTag === release.gitTag,
      "workflow tag differs from release metadata",
    );
    assert(
      git.intendedTagState?.status === "verified-at-head",
      "the expected release tag does not point at HEAD",
    );
  }
  const tagStatus =
    git.intendedTagState?.status === "verified-at-head"
      ? "verified-at-head"
      : "not-created";

  const names = releaseArtifactNames(release);
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-release-build-"),
  );
  try {
    const packageToolHome = resolve(temporaryRoot, "package-tool-home");
    const packageUserConfig = resolve(packageToolHome, "empty-npmrc");
    await mkdir(packageToolHome, { recursive: true, mode: 0o700 });
    await writeFile(packageUserConfig, "", {
      encoding: "utf8",
      mode: 0o600,
    });
    const first = resolve(temporaryRoot, "first.tgz");
    const second = resolve(temporaryRoot, "second.tgz");
    const buildEnvironment = packageProofToolEnvironment({
      ambientEnvironment: process.env,
      home: packageToolHome,
      temporaryRoot,
      userConfigPath: packageUserConfig,
      overrides: {
        SOURCE_DATE_EPOCH: String(
          Math.floor(new Date(git.createdAt).getTime() / 1000),
        ),
      },
    });

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

    const packageContents = await createPackageContentSnapshot({
      release,
      tarball,
      extractedPackage,
    });
    const packageContentsPath = resolve(outputDirectory, names.packageContents);
    await writeFile(
      packageContentsPath,
      `${JSON.stringify(packageContents, null, 2)}\n`,
      "utf8",
    );
    const releaseNotesPath = resolve(outputDirectory, names.releaseNotes);
    await copyFile(
      resolve(root, "packaging/release-notes.md"),
      releaseNotesPath,
    );

    const tarballMetadata = await stat(tarball);
    const sbomMetadata = await stat(sbomPath);
    const packageContentsMetadata = await stat(packageContentsPath);
    const releaseNotesMetadata = await stat(releaseNotesPath);
    const manifest = {
      schema: "agent-relay-release-bundle.v1",
      sourceRepository: "https://github.com/flowxo/agent-relay",
      commit: git.commit,
      createdAt: git.createdAt,
      intendedTag: release.gitTag,
      tagStatus,
      package: {
        name: release.name,
        version: release.version,
        private: stagedPackageIsPrivate(release),
        distTag: release.distTag,
      },
      sourceInputs: await sourceInputRecords(root, rootPackage),
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
      packageContents: {
        file: names.packageContents,
        format: packageContents.schema,
        bytes: packageContentsMetadata.size,
        sha256: await fileSha("sha256", packageContentsPath),
        subjectSha256: secondSha256,
        fileCount: packageContents.fileCount,
        unpackedBytes: packageContents.unpackedBytes,
      },
      releaseNotes: {
        file: names.releaseNotes,
        bytes: releaseNotesMetadata.size,
        sha256: await fileSha("sha256", releaseNotesPath),
        status:
          tagStatus === "verified-at-head"
            ? "tagged-candidate"
            : "candidate-without-tag",
      },
      reproducibility: {
        builds: 2,
        matched: true,
        sha256: secondSha256,
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
    const manifestPath = resolve(outputDirectory, names.manifest);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const checksummedFiles = [
      names.manifest,
      names.packageContents,
      names.releaseNotes,
      names.sbom,
      names.tarball,
    ].sort();
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
  root,
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
    names.packageContents,
    names.releaseNotes,
    names.sbom,
    names.tarball,
  ].sort();
  assert(
    JSON.stringify(await listRegularFiles(directory)) ===
      JSON.stringify(expectedFiles),
    "release directory differs from the six-file bundle contract",
  );

  const manifest = JSON.parse(
    await readFile(resolve(directory, names.manifest), "utf8"),
  );
  assert(
    manifest.schema === "agent-relay-release-bundle.v1",
    "release manifest schema differs",
  );
  assert(
    manifest.intendedTag === release.gitTag,
    "release manifest intended tag differs",
  );
  assert(
    ["verified-at-head", "not-created"].includes(manifest.tagStatus),
    "release manifest tag-status evidence differs",
  );
  assert(
    manifest.sourceRepository === "https://github.com/flowxo/agent-relay",
    "release manifest source repository differs",
  );
  assert(
    typeof manifest.createdAt === "string" &&
      !Number.isNaN(Date.parse(manifest.createdAt)),
    "release manifest creation time differs",
  );
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
    manifest.package?.distTag === release.distTag,
    "release manifest dist-tag differs",
  );
  assert(
    manifest.provenance?.source === "clean-git-commit" &&
      manifest.provenance?.localBuild === "unsigned" &&
      manifest.provenance?.signedAttestations ===
        "not-produced-by-this-local-bundle" &&
      /only after the intended tag exists/.test(
        manifest.provenance?.taggedWorkflow ?? "",
      ),
    "release manifest provenance statement differs",
  );
  assert(
    typeof manifest.sourceInputs?.packageManager === "string" &&
      Array.isArray(manifest.sourceInputs?.files),
    "release manifest source inputs are missing",
  );
  if (root !== undefined) {
    assert(
      JSON.stringify(manifest.sourceInputs) ===
        JSON.stringify(await sourceInputRecords(root, rootPackage)),
      "release manifest source inputs differ",
    );
    const currentGit = await readGitBuildInfo(root, release.gitTag);
    assert(
      currentGit.intendedTagState?.status !== "exists-elsewhere",
      "the immutable intended release tag already points at another commit",
    );
    assert(
      manifest.commit === currentGit.commit,
      "release manifest commit differs from the checked source",
    );
    assert(
      manifest.tagStatus ===
        (currentGit.intendedTagState?.status === "verified-at-head"
          ? "verified-at-head"
          : "not-created"),
      "release manifest tag status differs from the checked source",
    );
  }
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
    names.packageContents,
    names.releaseNotes,
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
      mainPackage?.versionInfo === release.version &&
      mainPackage?.licenseConcluded === rootPackage.license &&
      mainPackage?.licenseDeclared === rootPackage.license &&
      mainPackage?.copyrightText === "Copyright (c) 2026 Flow XO, LLC",
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
  for (const component of release.bundledComponents) {
    const record = sbom.packages?.find(
      (entry) => entry.SPDXID === bundledComponentId(component),
    );
    assert(
      record?.name === component.name &&
        record?.versionInfo === component.version &&
        record?.licenseConcluded === component.licenseDeclared &&
        record?.licenseDeclared === component.licenseDeclared &&
        record?.copyrightText === component.copyrightText &&
        record?.downloadLocation ===
          `${component.sourceRepository}/tree/${component.sourceCommit}` &&
        record?.checksums?.some(
          (checksum) =>
            checksum.algorithm === "SHA256" &&
            checksum.checksumValue === component.artifactSha256,
        ),
      `SBOM bundled component differs for ${component.name}`,
    );
    assert(
      sbom.relationships?.some(
        (relationship) =>
          relationship.spdxElementId === mainPackageId &&
          relationship.relationshipType === "CONTAINS" &&
          relationship.relatedSpdxElement === bundledComponentId(component),
      ),
      `SBOM bundled relationship is missing for ${component.name}`,
    );
  }
  if (root !== undefined) {
    const runtime = await runtimeDependencyGraph(root, release);
    const expectedPackageIds = new Set([
      mainPackageId,
      ...runtime.packages.map((entry) => entry.id),
      ...release.bundledComponents.map(bundledComponentId),
    ]);
    assert(
      sbom.packages.length === expectedPackageIds.size &&
        sbom.packages.every((entry) => expectedPackageIds.has(entry.SPDXID)),
      "SBOM package inventory differs from the exact runtime and bundled closure",
    );
    for (const dependency of runtime.packages) {
      const record = sbom.packages.find(
        (entry) => entry.SPDXID === dependency.id,
      );
      assert(
        record?.name === dependency.name &&
          record?.versionInfo === dependency.version &&
          record?.licenseDeclared === dependency.license &&
          record?.downloadLocation === dependency.repository,
        `SBOM runtime dependency differs for ${dependency.name}`,
      );
    }
    for (const id of runtime.directIds) {
      assert(
        sbom.relationships?.some(
          (relationship) =>
            relationship.spdxElementId === mainPackageId &&
            relationship.relationshipType === "DEPENDS_ON" &&
            relationship.relatedSpdxElement === id,
        ),
        `SBOM direct runtime relationship is missing for ${id}`,
      );
    }
    for (const edge of runtime.edges) {
      assert(
        sbom.relationships?.some(
          (relationship) =>
            relationship.spdxElementId === edge.from &&
            relationship.relationshipType === "DEPENDS_ON" &&
            relationship.relatedSpdxElement === edge.to,
        ),
        `SBOM transitive runtime relationship is missing for ${edge.from}`,
      );
    }
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

  const packageContentsPath = resolve(directory, names.packageContents);
  const packageContents = JSON.parse(
    await readFile(packageContentsPath, "utf8"),
  );
  assert(
    packageContents.schema === "agent-relay-package-content-evidence.v1" &&
      packageContents.package?.name === release.name &&
      packageContents.package?.version === release.version &&
      packageContents.artifactSha256 === tarballSha256 &&
      Array.isArray(packageContents.files),
    "package-content snapshot boundary differs",
  );
  assert(
    manifest.packageContents?.file === names.packageContents &&
      manifest.packageContents?.format === packageContents.schema &&
      manifest.packageContents?.sha256 ===
        (await fileSha("sha256", packageContentsPath)) &&
      manifest.packageContents?.bytes ===
        (await stat(packageContentsPath)).size &&
      manifest.packageContents?.subjectSha256 === tarballSha256 &&
      manifest.packageContents?.fileCount === packageContents.fileCount &&
      manifest.packageContents?.unpackedBytes === packageContents.unpackedBytes,
    "release manifest package-content evidence differs",
  );

  const releaseNotesPath = resolve(directory, names.releaseNotes);
  const releaseNotes = await readFile(releaseNotesPath, "utf8");
  assert(
    releaseNotes.includes(`${release.version} release candidate`) &&
      /FXO-1568 approved one bounded[\s\S]*future FXO-1164 publication/.test(
        releaseNotes,
      ) &&
      /manifest's build-time[\s\S]*`tagStatus`/.test(releaseNotes),
    "release notes do not preserve the candidate publication boundary",
  );
  if (root !== undefined) {
    assert(
      releaseNotes ===
        (await readFile(resolve(root, "packaging/release-notes.md"), "utf8")),
      "release notes differ from the reviewed source input",
    );
  }
  assert(
    manifest.releaseNotes?.file === names.releaseNotes &&
      manifest.releaseNotes?.sha256 ===
        (await fileSha("sha256", releaseNotesPath)) &&
      manifest.releaseNotes?.bytes === (await stat(releaseNotesPath)).size &&
      manifest.releaseNotes?.status ===
        (manifest.tagStatus === "verified-at-head"
          ? "tagged-candidate"
          : "candidate-without-tag"),
    "release manifest release-note evidence differs",
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
    const contentFiles = new Map(
      packageContents.files.map((file) => [file.path, file]),
    );
    assert(
      packageContents.fileCount === extractedFiles.length &&
        contentFiles.size === extractedFiles.length &&
        JSON.stringify([...contentFiles.keys()].sort()) ===
          JSON.stringify(extractedFiles),
      "package-content snapshot inventory differs from the tarball",
    );
    let unpackedBytes = 0;
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
      const metadata = await stat(resolve(extractedPackage, file));
      unpackedBytes += metadata.size;
      assert(
        contentFiles.get(file)?.bytes === metadata.size &&
          contentFiles.get(file)?.sha256 === expected,
        `package-content snapshot differs for ${file}`,
      );
      assert(
        record.checksums?.some(
          (checksum) =>
            checksum.algorithm === "SHA256" &&
            checksum.checksumValue === expected,
        ),
        `SBOM checksum differs for ${file}`,
      );
      assert(
        record.checksums?.some(
          (checksum) =>
            checksum.algorithm === "SHA1" &&
            checksum.checksumValue === expectedSha1,
        ),
        `SBOM SHA-1 checksum differs for ${file}`,
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
    assert(
      packageContents.unpackedBytes === unpackedBytes,
      "package-content snapshot unpacked size differs",
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
    packageContents: names.packageContents,
    releaseNotes: names.releaseNotes,
    tagStatus: manifest.tagStatus,
  };
}
