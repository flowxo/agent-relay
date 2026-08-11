import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import {
  assertReleaseConfiguration,
  currentReleaseRuntime,
  isSupportedReleaseRuntime,
  stagedPackageIsPrivate,
} from "./lib/release-policy.mjs";
import {
  packageProofToolEnvironment,
  packedRuntimePathEntries,
  safePackedRuntimeEnvironment,
} from "./lib/safe-packed-environment.mjs";
import {
  assertCleanGit,
  readGitBuildInfo,
  releaseArtifactNames,
  runtimeDependencyGraph,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const packageSnapshot = JSON.parse(
  await readFile(resolve(root, "packaging/package-files.json"), "utf8"),
);
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
assertReleaseConfiguration(release, rootPackage);
let packageToolEnvironment = {};

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const releaseBundleArgument = flag("--release-bundle");
const evidenceOutputArgument = flag("--evidence-output");
const knownArguments = new Set([
  "--release-bundle",
  releaseBundleArgument,
  "--evidence-output",
  evidenceOutputArgument,
]);
for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) {
    throw new Error(`unknown package-check argument: ${argument}`);
  }
}
if (
  (releaseBundleArgument === undefined) !==
  (evidenceOutputArgument === undefined)
) {
  throw new Error(
    "--release-bundle and --evidence-output must be provided together",
  );
}
const expectedReleaseBundlePath = resolve(root, ".artifacts/release");
const expectedEvidencePath = resolve(
  root,
  ".artifacts/release-evidence/agent-relay-public-candidate-evidence.json",
);
if (
  releaseBundleArgument !== undefined &&
  (resolve(root, releaseBundleArgument) !== expectedReleaseBundlePath ||
    resolve(root, evidenceOutputArgument) !== expectedEvidencePath)
) {
  throw new Error(
    "release evidence is constrained to the repository's exact ignored artifact paths",
  );
}

let exactBundle;
let exactGit;
let inputTarball;
if (releaseBundleArgument !== undefined) {
  await assertCleanGit(root);
  exactGit = await readGitBuildInfo(root);
  const bundleDirectory = resolve(root, releaseBundleArgument);
  exactBundle = await verifyReleaseBundle({
    root,
    release,
    rootPackage,
    directory: bundleDirectory,
    expectedCommit: exactGit.commit,
  });
  inputTarball = resolve(
    bundleDirectory,
    releaseArtifactNames(release).tarball,
  );
}

function sanitized(value, temporaryRoot) {
  return value
    .replaceAll(temporaryRoot, "<isolated-package-check>")
    .replaceAll(process.env.HOME ?? "\0", "<package-store-home>");
}

async function run(
  executable,
  args,
  {
    cwd = root,
    env = packageToolEnvironment,
    timeoutMs = 120_000,
    temporaryRoot = "",
  } = {},
) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-256_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-256_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `${sanitized(`${executable} ${args.join(" ")}`, temporaryRoot)} exceeded ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const command = sanitized(
        `${executable} ${args.join(" ")}`,
        temporaryRoot,
      );
      const result = {
        code,
        signal,
        stdout: sanitized(stdout, temporaryRoot),
        stderr: sanitized(stderr, temporaryRoot),
      };
      if (code !== 0) {
        reject(
          new Error(
            [
              `${command} failed (${String(code ?? signal)})`,
              sanitized(stdout, temporaryRoot),
              sanitized(stderr, temporaryRoot),
            ]
              .filter((part) => part.length > 0)
              .join("\n"),
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative =
      prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(resolve(directory, entry.name), relative)),
      );
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(
        `package contains unsupported filesystem entry: ${relative}`,
      );
    }
  }
  return files.sort();
}

async function directoryBytes(directory) {
  let size = 0;
  for (const file of await listFiles(directory)) {
    size += (await stat(resolve(directory, file))).size;
  }
  return size;
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected, null, 2)}\nactual: ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return one JSON document`, {
      cause: error,
    });
  }
}

async function fileSha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a loopback port");
  }
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
  return address.port;
}

async function waitForHealth(baseUrl, daemon, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error("packed daemon exited before becoming healthy");
    }
    try {
      const response = await globalThis.fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.healthy === true) {
          return;
        }
      }
    } catch {
      // A refused connection is expected until the daemon has bound its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  }
  throw new Error("packed daemon did not become healthy within 15 seconds");
}

const supportedRuntime = isSupportedReleaseRuntime(
  release,
  currentReleaseRuntime(),
);
if (evidenceOutputArgument !== undefined && !supportedRuntime) {
  throw new Error(
    "public candidate evidence requires the frozen supported runtime; no partial evidence was written",
  );
}
const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "agent-relay-package-check-"),
);
const packageToolHome = resolve(temporaryRoot, "package-tool-home");
const packageUserConfig = resolve(packageToolHome, "empty-npmrc");
await mkdir(packageToolHome, { recursive: true, mode: 0o700 });
await writeFile(packageUserConfig, "", { encoding: "utf8", mode: 0o600 });
packageToolEnvironment = packageProofToolEnvironment({
  ambientEnvironment: process.env,
  home: packageToolHome,
  temporaryRoot,
  userConfigPath: packageUserConfig,
  overrides: {
    npm_config_nodedir: resolve(dirname(process.execPath), ".."),
    npm_config_offline: "true",
  },
});
let daemon;
let daemonOutput = "";
try {
  const runtimeDependencies = await runtimeDependencyGraph(root, release);
  const dependencyOverrides = {};
  for (const dependency of runtimeDependencies.packages) {
    const tarball = resolve(
      temporaryRoot,
      `dependency-${dependency.name.replaceAll("/", "-").replace(/^@/, "")}-${dependency.version}.tgz`,
    );
    await run(
      "pnpm",
      ["--dir", dirname(dependency.manifestPath), "pack", "--out", tarball],
      { temporaryRoot, timeoutMs: 180_000 },
    );
    dependencyOverrides[dependency.name] = `file:${tarball}`;
  }
  const tarball = inputTarball ?? resolve(temporaryRoot, "agent-relay.tgz");
  if (inputTarball === undefined) {
    await run("pnpm", ["pack", "--out", tarball], {
      temporaryRoot,
      timeoutMs: 180_000,
    });
  }

  const tarballSize = (await stat(tarball)).size;
  if (tarballSize > packageSnapshot.maxTarballBytes) {
    throw new Error(
      `package tarball is ${String(tarballSize)} bytes; budget is ${String(packageSnapshot.maxTarballBytes)}`,
    );
  }

  const archive = await run("tar", ["-tzf", tarball], { temporaryRoot });
  const archivedFiles = archive.stdout
    .trim()
    .split("\n")
    .filter((path) => path.length > 0 && !path.endsWith("/"))
    .map((path) => path.replace(/^package\//, ""))
    .sort();
  assertEqual(
    archivedFiles,
    [...packageSnapshot.files].sort(),
    "packed file list differs from the reviewed snapshot",
  );

  const extracted = resolve(temporaryRoot, "extracted");
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", extracted], { temporaryRoot });
  const extractedPackage = resolve(extracted, "package");
  const unpackedSize = await directoryBytes(extractedPackage);
  if (unpackedSize > packageSnapshot.maxUnpackedBytes) {
    throw new Error(
      `unpacked package is ${String(unpackedSize)} bytes; budget is ${String(packageSnapshot.maxUnpackedBytes)}`,
    );
  }

  const manifest = JSON.parse(
    await readFile(resolve(extractedPackage, "package.json"), "utf8"),
  );
  assertEqual(
    {
      name: manifest.name,
      version: manifest.version,
      private: manifest.private,
      type: manifest.type,
      bin: manifest.bin,
      os: manifest.os,
      cpu: manifest.cpu,
      engines: manifest.engines,
      dependencies: manifest.dependencies,
    },
    {
      name: release.name,
      version: release.version,
      private: stagedPackageIsPrivate(release),
      type: "module",
      bin: { "agent-relay": "./dist/cli.js" },
      os: release.os,
      cpu: release.cpu,
      engines: { node: release.node },
      dependencies: release.dependencies,
    },
    "packed manifest differs from the reviewed runtime boundary",
  );
  if (
    manifest.scripts !== undefined ||
    manifest.devDependencies !== undefined ||
    manifest.exports !== undefined
  ) {
    throw new Error(
      "CLI-only package must not expose lifecycle scripts, dev dependencies, or a programmatic export",
    );
  }

  const textualFiles = packageSnapshot.files.filter(
    (path) =>
      path.endsWith(".js") ||
      path.endsWith(".json") ||
      path.endsWith(".md") ||
      path.endsWith(".html") ||
      path.endsWith(".css"),
  );
  const combined = (
    await Promise.all(
      textualFiles.map(async (path) => {
        return await readFile(resolve(extractedPackage, path), "utf8");
      }),
    )
  ).join("\n");
  for (const [pattern, label] of [
    [/workspace:(?:\*|\^|~|\.\.?\/)/, "workspace dependency"],
    [/@agent-relay\//, "private workspace package import"],
    [
      /(?:apps\/relay|packages\/(?:core|protocol|runner-bridge)|packages\/harnesses\/(?!fixtures\/))/,
      "repository implementation path",
    ],
    [/\/Users\/[^/\s]+/, "machine-specific macOS path"],
    [/[A-Za-z]:\\Users\\[^\\\s]+/i, "machine-specific Windows path"],
    [/sourceMappingURL=/, "source map reference"],
    [/\.env\.activation/, "private activation filename"],
    [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/, "Telegram token shape"],
    [
      /AGENT_RELAY_(?:WEBHOOK_(?:URL|SECRET)|WHOOSHBANG_(?:BASE_URL|PROJECT_CREDENTIAL|PROJECT_SELECTOR|SUBSCRIBER_ID|NOTIFIER_ID))\s*=(?!=)\s*(?!["']?<)[^\s#]+/,
      "populated private transport assignment",
    ],
  ]) {
    if (pattern.test(combined)) {
      throw new Error(`packed content contains a forbidden ${label}`);
    }
  }

  let cleanHomeEvidence = {
    status: "skipped-unsupported-runtime",
    isolatedInstall: false,
    cliHelp: false,
    version: false,
    capabilities: false,
    fakeCanaryDelivered: 0,
    fakeCanaryRetrying: 0,
    fakeCanaryDeadLettered: 0,
    webAssets: false,
    authenticatedWebApi: false,
  };

  if (!supportedRuntime) {
    process.stdout.write(
      `Package content verified (${String(archivedFiles.length)} files, ${String(tarballSize)} packed bytes, ${String(unpackedSize)} unpacked bytes). Isolated runtime skipped outside the frozen ${process.platform}/${process.arch} Node.js ${process.versions.node} boundary.\n`,
    );
    process.exitCode = 0;
  } else {
    const prefix = resolve(temporaryRoot, "consumer");
    const isolatedHome = resolve(temporaryRoot, "home");
    await mkdir(prefix, { recursive: true });
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(prefix, "package.json"),
      `${JSON.stringify({
        name: "agent-relay-package-check",
        private: true,
      })}\n`,
      "utf8",
    );
    await writeFile(
      resolve(prefix, "pnpm-workspace.yaml"),
      [
        "packages: []",
        "overrides:",
        ...Object.entries(dependencyOverrides).map(
          ([name, value]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
        ),
        "",
      ].join("\n"),
      "utf8",
    );
    await run(
      "pnpm",
      ["--dir", prefix, "add", "--ignore-scripts", "--offline", tarball],
      {
        temporaryRoot,
        timeoutMs: 180_000,
      },
    );
    await run("pnpm", ["--dir", prefix, "rebuild", "better-sqlite3"], {
      temporaryRoot,
      timeoutMs: 180_000,
    });

    const binary = resolve(prefix, "node_modules/.bin/agent-relay");
    const stateDir = resolve(isolatedHome, ".agent-relay");
    const packedEnvironment = safePackedRuntimeEnvironment({
      home: isolatedHome,
      pathEntries: packedRuntimePathEntries({
        prefix,
        systemPath: process.env.PATH ?? "/usr/bin:/bin",
      }),
      stateDirectory: stateDir,
      temporaryRoot,
      webEnabled: true,
    });
    const help = await run(binary, ["--help"], {
      env: packedEnvironment,
      temporaryRoot,
    });
    if (
      !help.stdout.includes("Usage:") ||
      !help.stdout.includes("agent-relay <command>") ||
      !help.stdout.includes("daemon")
    ) {
      throw new Error("packed executable help output is incomplete");
    }
    const version = await run(binary, ["--version"], {
      env: packedEnvironment,
      temporaryRoot,
    });
    if (version.stdout.trim() !== release.version) {
      throw new Error("packed executable version differs from its manifest");
    }
    const compatibility = parseJsonOutput(
      (
        await run(binary, ["capabilities"], {
          env: packedEnvironment,
          temporaryRoot,
        })
      ).stdout,
      "packed compatibility record",
    );
    if (
      compatibility.schema !== "agent-relay-compatibility.v1" ||
      !Array.isArray(compatibility.records) ||
      compatibility.records.length !== 6 ||
      compatibility.records.some(
        (record) =>
          typeof record.evidenceId !== "string" ||
          record.evidenceId.length === 0,
      ) ||
      compatibility.records.find(
        (record) => record.harness === "cursor" && record.surface === "cli",
      )?.capabilities?.permissionDecision !== "disabled"
    ) {
      throw new Error(
        "packed executable compatibility record is incomplete or unsafe",
      );
    }

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const daemonEnvironment = packedEnvironment;

    daemon = spawn(
      binary,
      ["daemon", "--transport", "fake", "--port", String(port)],
      {
        cwd: isolatedHome,
        env: daemonEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const captureDaemon = (chunk) => {
      daemonOutput = `${daemonOutput}${String(chunk)}`.slice(-128_000);
    };
    daemon.stdout.on("data", captureDaemon);
    daemon.stderr.on("data", captureDaemon);
    await waitForHealth(baseUrl, daemon);

    const canary = await run(binary, ["canary"], {
      cwd: isolatedHome,
      env: {
        ...daemonEnvironment,
        AGENT_RELAY_DAEMON_URL: baseUrl,
      },
      temporaryRoot,
    });
    const canaryResult = parseJsonOutput(canary.stdout, "packed canary");
    assertEqual(
      canaryResult.ingest?.inserted === true &&
        canaryResult.outcome === "delivered" &&
        canaryResult.verification?.status === "delivered" &&
        canaryResult.drain?.retrying === 0 &&
        canaryResult.drain?.deadLettered === 0,
      true,
      "packed fake canary did not reach one clean durable delivery",
    );

    const ui = await globalThis.fetch(`${baseUrl}/ui/`);
    if (!ui.ok || !(await ui.text()).includes("Agent Relay")) {
      throw new Error("packed daemon did not serve the web application");
    }
    const credential = JSON.parse(
      await readFile(resolve(stateDir, "web-credential.json"), "utf8"),
    );
    const metaResponse = await globalThis.fetch(`${baseUrl}/v1/web/meta`, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        origin: baseUrl,
      },
    });
    const meta = await metaResponse.json();
    assertEqual(
      {
        status: metaResponse.status,
        schema: meta.schema,
        apiVersion: meta.apiVersion,
        assetVersion: meta.assetVersion,
      },
      {
        status: 200,
        schema: "agent-relay-web-meta.v1",
        apiVersion: "1",
        assetVersion: "2",
      },
      "packed web API/assets are not version-compatible",
    );

    cleanHomeEvidence = {
      status: "passed",
      isolatedInstall: true,
      cliHelp: true,
      version: true,
      capabilities: true,
      fakeCanaryDelivered: 1,
      fakeCanaryRetrying: canaryResult.drain.retrying,
      fakeCanaryDeadLettered: canaryResult.drain.deadLettered,
      webAssets: true,
      authenticatedWebApi: true,
    };

    daemon.kill("SIGTERM");
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        daemon.kill("SIGKILL");
        reject(new Error("packed daemon did not stop after SIGTERM"));
      }, 10_000);
      daemon.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0 || signal === "SIGTERM") {
          resolvePromise();
        } else {
          reject(
            new Error(
              `packed daemon exited unexpectedly (${String(code ?? signal)}): ${sanitized(daemonOutput, temporaryRoot)}`,
            ),
          );
        }
      });
    });
    daemon = undefined;

    process.stdout.write(
      `Package verified (${String(archivedFiles.length)} files, ${String(tarballSize)} packed bytes, ${String(unpackedSize)} unpacked bytes): isolated install, CLI help, fake canary, web assets, and authenticated API passed.\n`,
    );
  }

  if (
    evidenceOutputArgument !== undefined &&
    exactBundle !== undefined &&
    exactGit !== undefined
  ) {
    const contentFiles = [];
    let exactUnpackedBytes = 0;
    for (const path of archivedFiles) {
      const extractedPath = resolve(extractedPackage, path);
      const metadata = await stat(extractedPath);
      exactUnpackedBytes += metadata.size;
      contentFiles.push({
        path,
        bytes: metadata.size,
        sha256: await fileSha256(extractedPath),
      });
    }
    const evidence = {
      schema: "agent-relay-public-candidate-evidence.v1",
      source: {
        repository: "https://github.com/flowxo/agent-relay",
        commit: exactGit.commit,
        commitCreatedAt: exactGit.createdAt,
        intendedTag: release.gitTag,
        tagStatus: exactBundle.tagStatus,
      },
      package: {
        name: release.name,
        version: release.version,
        artifact: exactBundle.artifact,
        bytes: exactBundle.artifactBytes,
        sha256: exactBundle.artifactSha256,
        files: contentFiles.length,
        unpackedBytes: exactUnpackedBytes,
      },
      releaseBundle: {
        checksums: "SHA256SUMS",
        sbom: exactBundle.sbom,
        sbomPackages: exactBundle.sbomPackages,
        sbomFiles: exactBundle.sbomFiles,
        packageContents: exactBundle.packageContents,
        releaseNotes: exactBundle.releaseNotes,
        twoBuildsMatched: true,
      },
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      isolation: {
        cleanHome: true,
        temporaryInstallPrefix: true,
        credentialVariablesForwardedToPackedRuntime: false,
        tarballDependencyResolution: "offline",
        selectedTransport: "fake",
        liveProviderTraffic: false,
        liveTested: false,
      },
      cleanHome: cleanHomeEvidence,
      provenance: {
        localBundle: "unsigned-clean-commit",
        signedGitHubAttestations: "not-produced-by-this-proof",
      },
      nativeReleaseExit: {
        credited: false,
        status: "not-run-by-this-proof",
      },
      limitations: [
        "This credential-free proof is not a live-provider test.",
        "This proof does not create a tag or signed GitHub provenance.",
        "Native release-exit remains a separate exact-runtime and exact-harness gate.",
        "FXO-1568 approved the bundled WhooshBang MIT license/notices and a bounded future FXO-1164 publication; this proof performs neither publication nor repository mutation.",
        "The accepted non-green native release-exit and Low ambient-hook isolation residuals remain explicit and are not credited as green.",
      ],
    };
    const evidenceSource = `${JSON.stringify(evidence, null, 2)}\n`;
    for (const [pattern, label] of [
      [/\/Users\/[^/\s]+/, "machine-specific macOS path"],
      [/[A-Za-z]:\\Users\\[^\\\s]+/i, "machine-specific Windows path"],
      [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/, "Telegram token shape"],
      [/\bgh[pousr]_[A-Za-z0-9]{12,}\b/, "GitHub token shape"],
      [
        /"(?:answer|question|summary|transcript)"\s*:/i,
        "message content field",
      ],
    ]) {
      if (pattern.test(evidenceSource)) {
        throw new Error(`public candidate evidence contains a ${label}`);
      }
    }
    const evidencePath = expectedEvidencePath;
    const evidenceDirectory = dirname(evidencePath);
    const artifactsDirectory = resolve(root, ".artifacts");
    try {
      const artifactsMetadata = await lstat(artifactsDirectory);
      if (
        artifactsMetadata.isSymbolicLink() ||
        !artifactsMetadata.isDirectory()
      ) {
        throw new Error(".artifacts must be a real directory");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await mkdir(artifactsDirectory, { mode: 0o700 });
    }
    await rm(evidenceDirectory, { recursive: true, force: true });
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await chmod(evidenceDirectory, 0o700);
    await writeFile(evidencePath, evidenceSource, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(evidencePath, 0o600);
    const evidenceChecksum = await fileSha256(evidencePath);
    const evidenceChecksumsPath = resolve(evidenceDirectory, "SHA256SUMS");
    await writeFile(
      evidenceChecksumsPath,
      `${evidenceChecksum}  ${basename(evidencePath)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(evidenceChecksumsPath, 0o600);
    const evidenceFiles = (await readdir(evidenceDirectory)).sort();
    if (
      JSON.stringify(evidenceFiles) !==
      JSON.stringify([basename(evidencePath), "SHA256SUMS"].sort())
    ) {
      throw new Error("public candidate evidence directory is not exact");
    }
    for (const path of [evidencePath, evidenceChecksumsPath]) {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new Error("public candidate evidence file mode is not 0600");
      }
    }
    if (((await lstat(evidenceDirectory)).mode & 0o777) !== 0o700) {
      throw new Error("public candidate evidence directory mode is not 0700");
    }
    process.stdout.write(
      `Public candidate evidence recorded (${cleanHomeEvidence.status}, fake transport, ${exactBundle.tagStatus}).\n`,
    );
  }
} finally {
  if (daemon !== undefined && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
