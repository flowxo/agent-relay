import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import {
  assertCleanGit,
  readGitBuildInfo,
  releaseArtifactNames,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";
import {
  assertNativeRuntimeObservation,
  assertReleaseExitConfiguration,
  summarizeDoctorEvidence,
} from "./lib/release-exit-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const exit = JSON.parse(
  await readFile(resolve(root, "packaging/release-exit.json"), "utf8"),
);
assertReleaseExitConfiguration(exit, release);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release exit violation: ${message}`);
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(path) {
  return digest(await readFile(path));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Release exit violation: ${label} was not JSON`, {
      cause: error,
    });
  }
}

function redact(source, privateValues) {
  let value = source;
  for (const privateValue of privateValues) {
    if (privateValue.length > 1) {
      value = value.replaceAll(privateValue, "<private-path>");
    }
  }
  return value
    .replaceAll(/\/Users\/[^/\s]+/g, "/Users/<redacted>")
    .replaceAll(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\<redacted>");
}

async function run(
  executable,
  args,
  {
    cwd = root,
    env = process.env,
    expectedCodes = [0],
    timeoutMs = 120_000,
    privateValues = [],
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
    const captureStdout = (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-256_000);
    };
    const captureStderr = (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-256_000);
    };
    child.stdout.on("data", captureStdout);
    child.stderr.on("data", captureStderr);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Release exit violation: ${basename(executable)} exceeded ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout,
        stderr,
      };
      if (code === null || !expectedCodes.includes(code)) {
        reject(
          new Error(
            [
              `Release exit violation: ${basename(executable)} failed (${String(code ?? signal)})`,
              redact(result.stdout, privateValues),
              redact(result.stderr, privateValues),
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

async function obtainNodeArchive() {
  const node = exit.target.node;
  const cacheDirectory = resolve(root, ".artifacts/runtime-cache");
  const archivePath = resolve(cacheDirectory, node.archive);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  if (await exists(archivePath)) {
    const metadata = await stat(archivePath);
    if (
      metadata.isFile() &&
      metadata.size <= node.maximumBytes &&
      (await fileDigest(archivePath)) === node.sha256
    ) {
      return { archivePath, downloaded: false };
    }
  }

  const response = await globalThis.fetch(node.url, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  assert(response.ok, `official Node download returned ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  assert(
    Number.isFinite(declaredLength) &&
      declaredLength > 20_000_000 &&
      declaredLength <= node.maximumBytes,
    "official Node download declared an unexpected size",
  );
  const contents = Buffer.from(await response.arrayBuffer());
  assert(
    contents.length === declaredLength && contents.length <= node.maximumBytes,
    "official Node download size differs",
  );
  assert(
    digest(contents) === node.sha256,
    "official Node archive differs from the pinned SHA-256",
  );
  await writeFile(archivePath, contents, { mode: 0o600 });
  return { archivePath, downloaded: true };
}

async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "could not allocate a loopback port",
  );
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

async function waitForHealth(baseUrl, daemon, privateValues) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(
        `Release exit violation: installed daemon exited early: ${redact(
          daemon.output(),
          privateValues,
        )}`,
      );
    }
    try {
      const response = await globalThis.fetch(`${baseUrl}/v1/health`);
      if (response.ok && (await response.json()).healthy === true) {
        return;
      }
    } catch {
      // A refused connection is expected until the isolated daemon binds.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  }
  throw new Error(
    "Release exit violation: installed daemon did not become healthy",
  );
}

function spawnDaemon(executable, args, options) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captured = "";
  const capture = (chunk) => {
    captured = `${captured}${String(chunk)}`.slice(-128_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return Object.assign(child, { output: () => captured });
}

async function stopDaemon(daemon, privateValues) {
  if (daemon === undefined || daemon.exitCode !== null) {
    return;
  }
  daemon.kill("SIGTERM");
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      daemon.kill("SIGKILL");
      reject(
        new Error(
          "Release exit violation: installed daemon did not stop after SIGTERM",
        ),
      );
    }, 10_000);
    daemon.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") {
        resolvePromise();
      } else {
        reject(
          new Error(
            `Release exit violation: installed daemon exited unexpectedly: ${redact(
              daemon.output(),
              privateValues,
            )}`,
          ),
        );
      }
    });
  });
}

async function assertNoSymlinks(directory, base = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert(
      !entry.isSymbolicLink(),
      `installed package contains symlink ${relative(base, path)}`,
    );
    if (entry.isDirectory()) {
      await assertNoSymlinks(path, base);
    } else {
      assert(entry.isFile(), "installed package contains a special file");
    }
  }
}

function cleanEnvironment({
  nativeBin,
  harnessBin,
  packageBin,
  isolatedHome,
  temporaryRoot,
  npmCache,
  npmUserConfig,
}) {
  return {
    PATH: [
      nativeBin,
      harnessBin,
      packageBin,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(delimiter),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: temporaryRoot,
    SHELL: "/bin/sh",
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    AGENT_RELAY_STATE_DIR: resolve(isolatedHome, ".agent-relay"),
    AGENT_RELAY_WEB_ENABLED: "0",
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_arch: "arm64",
  };
}

async function findHarness(executable, privateValues) {
  const result = await run("/usr/bin/which", [executable], {
    env: process.env,
    privateValues,
  });
  const path = result.stdout.trim();
  assert(path.length > 0, `${executable} is not installed`);
  return await realpath(path);
}

function assertSafeEvidence(source, privateValues) {
  for (const value of privateValues) {
    assert(
      value.length <= 1 || !source.includes(value),
      "evidence contains a private path",
    );
  }
  for (const [pattern, label] of [
    [/\/Users\/[^/\s]+/, "macOS user path"],
    [/[A-Za-z]:\\Users\\[^\\\s]+/i, "Windows user path"],
    [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/, "Telegram token shape"],
    [/\bgh[pousr]_[A-Za-z0-9]{12,}\b/, "GitHub token shape"],
    [/\bsk-[A-Za-z0-9_-]{12,}\b/, "OpenAI key shape"],
    [/"(?:answer|question|summary|transcript)"\s*:/i, "message content field"],
  ]) {
    assert(!pattern.test(source), `evidence contains a ${label}`);
  }
}

await assertCleanGit(root);
const git = await readGitBuildInfo(root);
const releaseDirectory = resolve(root, ".artifacts/release");
const bundle = await verifyReleaseBundle({
  release,
  rootPackage,
  directory: releaseDirectory,
  expectedCommit: git.commit,
});
const names = releaseArtifactNames(release);
const tarball = resolve(releaseDirectory, names.tarball);

const appleSiliconCapability = (
  await run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
    privateValues: [root, homedir()],
  })
).stdout.trim();
assert(
  appleSiliconCapability === "1",
  "host does not report Apple-silicon execution support",
);
const macosVersion = (
  await run("/usr/bin/sw_vers", ["-productVersion"], {
    privateValues: [root, homedir()],
  })
).stdout.trim();
assert(/^\d+(?:\.\d+){1,2}$/.test(macosVersion), "macOS version is invalid");

const nodeArchive = await obtainNodeArchive();
const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "agent-relay-native-exit-"),
);
const privateValues = [root, homedir(), temporaryRoot, nodeArchive.archivePath];
let daemon;
try {
  const runtimeRoot = resolve(temporaryRoot, "runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await run("/usr/bin/tar", [
    "-xzf",
    nodeArchive.archivePath,
    "-C",
    runtimeRoot,
  ]);
  const nativeRuntime = resolve(
    runtimeRoot,
    `node-v${exit.target.node.version}-darwin-arm64`,
  );
  const nativeBin = resolve(nativeRuntime, "bin");
  const nativeNode = resolve(nativeBin, "node");
  const npmCli = resolve(nativeRuntime, "lib/node_modules/npm/bin/npm-cli.js");
  await access(nativeNode);
  await access(npmCli);
  privateValues.push(nativeRuntime, nativeNode, npmCli);

  await run("/usr/bin/codesign", ["--verify", "--strict", nativeNode], {
    privateValues,
  });
  const runtimeObservation = parseJson(
    (
      await run(
        nativeNode,
        [
          "-e",
          "process.stdout.write(JSON.stringify({platform:process.platform,architecture:process.arch,version:process.version}))",
        ],
        { privateValues },
      )
    ).stdout,
    "native Node observation",
  );
  assertNativeRuntimeObservation(exit, runtimeObservation);
  const npmVersion = (
    await run(nativeNode, [npmCli, "--version"], { privateValues })
  ).stdout.trim();
  assert(/^\d+\.\d+\.\d+$/.test(npmVersion), "bundled npm version is invalid");

  const isolatedHome = resolve(temporaryRoot, "clean home with ' quote");
  const consumer = resolve(temporaryRoot, "consumer");
  const harnessBin = resolve(temporaryRoot, "harness-bin");
  const packageBin = resolve(consumer, "node_modules/.bin");
  const npmCache = resolve(temporaryRoot, "npm-cache");
  const npmUserConfig = resolve(temporaryRoot, "npmrc");
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  await mkdir(consumer, { recursive: true, mode: 0o700 });
  await mkdir(harnessBin, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(consumer, "package.json"),
    `${JSON.stringify({
      name: "agent-relay-native-release-exit",
      private: true,
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    npmUserConfig,
    [
      "registry=https://registry.npmjs.org/",
      "audit=false",
      "fund=false",
      "update-notifier=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const harnessExecutables = {
    codex: "codex",
    claude: "claude",
    cursor: "cursor-agent",
  };
  for (const executable of Object.values(harnessExecutables)) {
    const target = await findHarness(executable, privateValues);
    privateValues.push(target, dirname(target));
    await symlink(target, resolve(harnessBin, executable));
  }
  const codexTarget = await realpath(resolve(harnessBin, "codex"));
  const codexFile = (
    await run("/usr/bin/file", ["-b", codexTarget], { privateValues })
  ).stdout;
  assert(
    codexFile.includes("arm64"),
    "the installed Codex evidence binary is not native arm64",
  );

  const environment = cleanEnvironment({
    nativeBin,
    harnessBin,
    packageBin,
    isolatedHome,
    temporaryRoot,
    npmCache,
    npmUserConfig,
  });
  for (const executable of Object.values(harnessExecutables)) {
    await run(executable, ["--version"], {
      cwd: isolatedHome,
      env: environment,
      privateValues,
      timeoutMs: 15_000,
    });
  }

  await run(
    nativeNode,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    {
      cwd: consumer,
      env: environment,
      privateValues,
      timeoutMs: 300_000,
    },
  );
  await run(
    nativeNode,
    [
      npmCli,
      "rebuild",
      "better-sqlite3",
      "--foreground-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: consumer,
      env: environment,
      privateValues,
      timeoutMs: 300_000,
    },
  );

  const installedPackage = resolve(
    consumer,
    "node_modules/@flowxo/agent-relay",
  );
  const installedMetadata = await lstat(installedPackage);
  assert(
    installedMetadata.isDirectory() && !installedMetadata.isSymbolicLink(),
    "Agent Relay was installed as a link instead of package contents",
  );
  const installedRealPath = await realpath(installedPackage);
  const installedRelative = relative(
    await realpath(consumer),
    installedRealPath,
  );
  assert(
    installedRelative.length > 0 &&
      installedRelative !== ".." &&
      !installedRelative.startsWith(`..${sep}`),
    "installed Agent Relay resolves outside the isolated consumer",
  );
  await assertNoSymlinks(installedPackage);
  const installedManifest = parseJson(
    await readFile(resolve(installedPackage, "package.json"), "utf8"),
    "installed package manifest",
  );
  assert(
    installedManifest.name === release.name &&
      installedManifest.version === release.version &&
      installedManifest.private === true,
    "installed package identity differs from the blocked candidate",
  );
  const dependencyTree = parseJson(
    (
      await run(nativeNode, [npmCli, "ls", "--json", "--depth=0"], {
        cwd: consumer,
        env: environment,
        privateValues,
      })
    ).stdout,
    "isolated npm dependency tree",
  );
  assert(
    dependencyTree.dependencies?.[release.name]?.version === release.version &&
      dependencyTree.dependencies?.[release.name]?.link !== true,
    "npm did not install the exact non-linked Agent Relay artifact",
  );

  const nativeAddon = resolve(
    consumer,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  const nativeAddonFile = (
    await run("/usr/bin/file", ["-b", nativeAddon], { privateValues })
  ).stdout;
  assert(
    nativeAddonFile.includes("arm64"),
    "better-sqlite3 was not rebuilt for native arm64",
  );
  await run(
    nativeNode,
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();",
    ],
    {
      cwd: consumer,
      env: environment,
      privateValues,
    },
  );

  const cli = resolve(installedPackage, "dist/cli.js");
  const version = (
    await run(nativeNode, [cli, "--version"], {
      cwd: isolatedHome,
      env: environment,
      privateValues,
    })
  ).stdout.trim();
  assert(version === release.version, "installed CLI version differs");
  const help = (
    await run(nativeNode, [cli, "--help"], {
      cwd: isolatedHome,
      env: environment,
      privateValues,
    })
  ).stdout;
  assert(
    help.includes("agent-relay install") &&
      help.includes("agent-relay canary") &&
      help.includes("agent-relay uninstall"),
    "installed CLI help is incomplete",
  );

  const installArguments = [
    cli,
    "install",
    "--root",
    isolatedHome,
    "--node",
    nativeNode,
  ];
  const dryInstall = parseJson(
    (
      await run(nativeNode, [...installArguments, "--dry-run"], {
        cwd: isolatedHome,
        env: environment,
        privateValues,
      })
    ).stdout,
    "native install dry run",
  );
  assert(
    dryInstall.changed === true && dryInstall.dryRun === true,
    "native install dry run did not report pending changes",
  );
  assert(
    !(await exists(resolve(isolatedHome, ".agent-relay/install.json"))),
    "install dry run changed the isolated home",
  );
  const installed = parseJson(
    (
      await run(nativeNode, installArguments, {
        cwd: isolatedHome,
        env: environment,
        privateValues,
      })
    ).stdout,
    "native install",
  );
  assert(
    installed.changed === true && installed.dryRun === false,
    "native install did not apply the owned configuration",
  );
  const repeatedInstall = parseJson(
    (
      await run(nativeNode, installArguments, {
        cwd: isolatedHome,
        env: environment,
        privateValues,
      })
    ).stdout,
    "native repeated install",
  );
  assert(
    repeatedInstall.changed === false,
    "native repeated install is not idempotent",
  );

  const stateDirectory = resolve(isolatedHome, ".agent-relay");
  const databasePath = resolve(stateDirectory, "relay.sqlite");
  const installManifest = parseJson(
    await readFile(resolve(stateDirectory, "install.json"), "utf8"),
    "native install manifest",
  );
  assert(
    installManifest.packageVersion === release.version &&
      (await realpath(installManifest.entryPath)) === (await realpath(cli)) &&
      (await realpath(installManifest.nodePath)) ===
        (await realpath(nativeNode)),
    "owned launcher does not bind to the exact artifact and native runtime",
  );

  const doctor = parseJson(
    (
      await run(
        nativeNode,
        [cli, "doctor", "--root", isolatedHome, "--db", databasePath],
        {
          cwd: isolatedHome,
          env: environment,
          privateValues,
        },
      )
    ).stdout,
    "native doctor",
  );
  const harnessEvidence = summarizeDoctorEvidence(exit, doctor);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const launcher = resolve(stateDirectory, "bin/agent-relay");
  daemon = spawnDaemon(launcher, ["daemon", "--port", String(port)], {
    cwd: isolatedHome,
    env: environment,
  });
  await waitForHealth(baseUrl, daemon, privateValues);
  const canary = parseJson(
    (
      await run(nativeNode, [cli, "canary"], {
        cwd: isolatedHome,
        env: {
          ...environment,
          AGENT_RELAY_DAEMON_URL: baseUrl,
        },
        privateValues,
      })
    ).stdout,
    "native fake canary",
  );
  assert(
    canary.drain?.delivered === 1 &&
      canary.drain?.retrying === 0 &&
      canary.drain?.deadLettered === 0,
    "native fake canary did not complete one clean delivery",
  );
  await stopDaemon(daemon, privateValues);
  daemon = undefined;

  const dryUninstall = parseJson(
    (
      await run(
        nativeNode,
        [cli, "uninstall", "--root", isolatedHome, "--dry-run"],
        {
          cwd: isolatedHome,
          env: environment,
          privateValues,
        },
      )
    ).stdout,
    "native uninstall dry run",
  );
  assert(
    dryUninstall.changed === true && dryUninstall.dryRun === true,
    "native uninstall dry run did not report owned changes",
  );
  const uninstalled = parseJson(
    (
      await run(nativeNode, [cli, "uninstall", "--root", isolatedHome], {
        cwd: isolatedHome,
        env: environment,
        privateValues,
      })
    ).stdout,
    "native uninstall",
  );
  assert(
    uninstalled.changed === true && uninstalled.dryRun === false,
    "native uninstall did not remove owned configuration",
  );
  assert(
    !(await exists(launcher)) &&
      !(await exists(resolve(stateDirectory, "install.json"))) &&
      (await exists(databasePath)),
    "native uninstall did not remove ownership while retaining SQLite",
  );
  for (const path of [
    resolve(isolatedHome, ".codex/hooks.json"),
    resolve(isolatedHome, ".claude/settings.json"),
    resolve(isolatedHome, ".cursor/hooks.json"),
  ]) {
    if (await exists(path)) {
      assert(
        !(await readFile(path, "utf8")).includes("AGENT_RELAY_HOOK_OWNER"),
        "native uninstall left an owned harness entry",
      );
    }
  }

  await run(
    nativeNode,
    [
      npmCli,
      "uninstall",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      release.name,
    ],
    {
      cwd: consumer,
      env: environment,
      privateValues,
      timeoutMs: 180_000,
    },
  );
  assert(
    !(await exists(installedPackage)) &&
      !(await exists(resolve(packageBin, "agent-relay"))),
    "npm removal left the package or executable",
  );

  const evidence = {
    schema: "agent-relay-release-exit-evidence.v1",
    generatedAt: new Date().toISOString(),
    release: {
      commit: bundle.commit,
      name: release.name,
      version: bundle.version,
      artifact: bundle.artifact,
      artifactBytes: bundle.artifactBytes,
      artifactSha256: bundle.artifactSha256,
      sbom: bundle.sbom,
      sbomPackages: bundle.sbomPackages,
      sbomFiles: bundle.sbomFiles,
    },
    target: {
      operatingSystem: "macOS",
      version: macosVersion,
      appleSilicon: true,
      node: runtimeObservation,
      npmVersion,
      nodeArchive: exit.target.node.archive,
      nodeArchiveSha256: exit.target.node.sha256,
      checksumSource: exit.target.node.checksumSource,
      archiveDownloadedThisRun: nodeArchive.downloaded,
      nativeAddonArchitecture: "arm64",
    },
    harnesses: harnessEvidence,
    isolation: {
      cleanHome: true,
      temporaryInstallPrefix: true,
      globallyLinkedWorkspacePackage: false,
      credentialVariablesForwarded: false,
      privatePathsRecorded: false,
      messageContentRecorded: false,
    },
    lifecycle: {
      scriptsDisabledInstall: true,
      reviewedNativeRebuild: true,
      packageIdentityVerified: true,
      packageSymlinks: 0,
      installDryRun: "changed",
      install: "changed",
      repeatedInstall: "unchanged",
      doctor: "healthy",
      fakeCanaryDelivered: 1,
      fakeCanaryRetrying: 0,
      fakeCanaryDeadLettered: 0,
      uninstallDryRun: "changed",
      uninstall: "changed",
      retainedSQLite: true,
      packageRemoval: "removed",
      ownedHooksAfterRemoval: 0,
    },
    limitations: [
      "Intel macOS is unclaimed.",
      "Windows and Linux end-user runtimes are unclaimed.",
      "This local proof does not create signed GitHub provenance.",
      "npm scope control and publication remain unapproved.",
    ],
  };
  const evidenceSource = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(evidenceSource, privateValues);
  const evidencePath = resolve(root, exit.evidenceOutput);
  await rm(dirname(evidencePath), { recursive: true, force: true });
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(evidencePath, evidenceSource, {
    encoding: "utf8",
    mode: 0o600,
  });

  process.stdout.write(
    [
      `Native release exit verified (${runtimeObservation.version} ${runtimeObservation.platform}/${runtimeObservation.architecture},`,
      `${release.name}@${release.version},`,
      `${String(harnessEvidence.filter((item) => item.classification === "verified").length)} exact harnesses,`,
      "one clean fake delivery, owned uninstall and package removal).",
      ` Evidence: ${exit.evidenceOutput}\n`,
    ].join(" "),
  );
} finally {
  await stopDaemon(daemon, privateValues);
  await rm(temporaryRoot, { recursive: true, force: true });
}
