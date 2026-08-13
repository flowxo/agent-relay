import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import {
  currentReleaseRuntime,
  isSupportedReleaseRuntime,
} from "./lib/release-policy.mjs";
import {
  packageProofToolEnvironment,
  packedRuntimePathEntries,
  safePackedRuntimeEnvironment,
} from "./lib/safe-packed-environment.mjs";
import { runtimeDependencyGraph } from "./lib/release-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
let packageToolEnvironment = {};

function sanitized(value, temporaryRoot) {
  return value
    .replaceAll(temporaryRoot, "<isolated-lifecycle-check>")
    .replaceAll(process.env.HOME ?? "\0", "<package-store-home>");
}

async function run(
  executable,
  args,
  {
    cwd = root,
    env = packageToolEnvironment,
    expectedCodes = [0],
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
      if (code === null || !expectedCodes.includes(code)) {
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

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return one JSON document`, {
      cause: error,
    });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function jsonRequest(url, init = {}) {
  const response = await globalThis.fetch(url, {
    ...init,
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `isolated daemon request failed (${String(response.status)}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function freePort() {
  const { createServer } = await import("node:net");
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

let activeDaemon;
let daemonOutput = "";

async function startDaemon(binary, isolatedHome, environment) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  activeDaemon = spawn(
    binary,
    ["daemon", "--transport", "fake", "--port", String(port)],
    {
      cwd: isolatedHome,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk) => {
    daemonOutput = `${daemonOutput}${String(chunk)}`.slice(-128_000);
  };
  activeDaemon.stdout.on("data", capture);
  activeDaemon.stderr.on("data", capture);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (activeDaemon.exitCode !== null) {
      throw new Error("packed daemon exited before becoming healthy");
    }
    try {
      const health = await jsonRequest(`${baseUrl}/v1/health`);
      if (health.healthy === true) {
        return baseUrl;
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  }
  throw new Error("packed daemon did not become healthy within 15 seconds");
}

async function stopDaemon(temporaryRoot) {
  if (activeDaemon === undefined || activeDaemon.exitCode !== null) {
    activeDaemon = undefined;
    return;
  }
  const daemon = activeDaemon;
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
  activeDaemon = undefined;
}

async function installTarball(prefix, tarball, temporaryRoot) {
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
}

function ownerMarkerCount(value) {
  return JSON.stringify(value).split("AGENT_RELAY_HOOK_OWNER").length - 1;
}

if (!isSupportedReleaseRuntime(release, currentReleaseRuntime())) {
  process.stdout.write(
    `Packed lifecycle skipped outside the frozen ${process.platform}/${process.arch} Node.js ${process.versions.node} boundary; package content checks remain mandatory.\n`,
  );
} else {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-lifecycle-check-"),
  );
  const packageToolHome = resolve(temporaryRoot, "package-tool-home");
  const packageUserConfig = resolve(packageToolHome, "empty-npmrc");
  await mkdir(packageToolHome, { recursive: true, mode: 0o700 });
  await writeFile(packageUserConfig, "", {
    encoding: "utf8",
    mode: 0o600,
  });
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
  try {
    const runtimeDependencies = await runtimeDependencyGraph(root, release);
    const dependencyOverrides = {};
    for (const dependency of runtimeDependencies.packages) {
      const dependencyTarball = resolve(
        temporaryRoot,
        `dependency-${dependency.name.replaceAll("/", "-").replace(/^@/, "")}-${dependency.version}.tgz`,
      );
      await run(
        "pnpm",
        [
          "--dir",
          dirname(dependency.manifestPath),
          "pack",
          "--out",
          dependencyTarball,
        ],
        { temporaryRoot, timeoutMs: 180_000 },
      );
      dependencyOverrides[dependency.name] = `file:${dependencyTarball}`;
    }
    const currentTarball = resolve(temporaryRoot, "current.tgz");
    await run("pnpm", ["pack", "--out", currentTarball], {
      temporaryRoot,
      timeoutMs: 180_000,
    });

    const extracted = resolve(temporaryRoot, "current-extracted");
    await mkdir(extracted, { recursive: true });
    await run("tar", ["-xzf", currentTarball, "-C", extracted], {
      temporaryRoot,
    });
    const priorStage = resolve(temporaryRoot, "prior-package");
    await cp(resolve(extracted, "package"), priorStage, { recursive: true });
    const priorManifestPath = resolve(priorStage, "package.json");
    const priorManifest = parseJson(
      await readFile(priorManifestPath, "utf8"),
      "current packed manifest",
    );
    priorManifest.version = release.priorFixtureVersion;
    await writeJson(priorManifestPath, priorManifest);
    for (const relativePath of ["dist/cli.js", "README.md", "CHANGELOG.md"]) {
      const path = resolve(priorStage, relativePath);
      const source = await readFile(path, "utf8");
      if (relativePath === "dist/cli.js") {
        assert(
          source.includes(release.version),
          "prior fixture cannot find the current runtime version",
        );
      }
      await writeFile(
        path,
        source.replaceAll(release.version, release.priorFixtureVersion),
        "utf8",
      );
    }
    await chmod(resolve(priorStage, "dist/cli.js"), 0o755);
    const priorTarball = resolve(temporaryRoot, "prior.tgz");
    await run("pnpm", ["--dir", priorStage, "pack", "--out", priorTarball], {
      temporaryRoot,
      timeoutMs: 180_000,
    });

    const prefix = resolve(temporaryRoot, "consumer");
    const isolatedHome = resolve(temporaryRoot, "home with ' quote");
    const harnessBin = resolve(prefix, "harness-bin");
    const stateDir = resolve(isolatedHome, ".agent-relay");
    await mkdir(prefix, { recursive: true });
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await mkdir(harnessBin, { recursive: true, mode: 0o700 });
    await writeJson(resolve(prefix, "package.json"), {
      name: "agent-relay-lifecycle-check",
      private: true,
    });
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

    for (const [name, version] of [
      ["codex", "codex-cli 0.145.0"],
      ["claude", "2.1.219 (Claude Code)"],
      ["cursor-agent", "2026.07.23-e383d2b"],
    ]) {
      const path = resolve(harnessBin, name);
      await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
        encoding: "utf8",
        mode: 0o700,
      });
      await chmod(path, 0o700);
    }

    const environment = safePackedRuntimeEnvironment({
      home: isolatedHome,
      pathEntries: packedRuntimePathEntries({
        prefix,
        harnessBin,
        systemPath: process.env.PATH ?? "/usr/bin:/bin",
      }),
      stateDirectory: stateDir,
      temporaryRoot,
      webEnabled: true,
    });

    const codexConfig = resolve(isolatedHome, ".codex/hooks.json");
    const claudeConfig = resolve(isolatedHome, ".claude/settings.json");
    const cursorConfig = resolve(isolatedHome, ".cursor/hooks.json");
    await writeJson(codexConfig, {
      userSetting: "preserve-codex",
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "user-stop-hook" }],
          },
        ],
      },
    });
    await writeJson(claudeConfig, {
      permissions: { allow: ["Read"] },
    });
    await writeJson(cursorConfig, {
      version: 1,
      hooks: {
        stop: [{ command: "user-cursor-hook" }],
      },
    });

    await installTarball(prefix, priorTarball, temporaryRoot);
    const binary = resolve(prefix, "node_modules/.bin/agent-relay");
    const priorVersion = await run(binary, ["--version"], {
      env: environment,
      temporaryRoot,
    });
    assert(
      priorVersion.stdout.trim() === release.priorFixtureVersion,
      "prior packed fixture reports the wrong version",
    );

    const dryInstall = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome, "--dry-run"], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "prior install dry run",
    );
    assert(
      dryInstall.changed === true && dryInstall.dryRun === true,
      "clean-home install dry run did not report pending changes",
    );
    assert(
      ownerMarkerCount(
        parseJson(await readFile(codexConfig, "utf8"), "Codex config"),
      ) === 0,
      "install dry run mutated user configuration",
    );

    const installed = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "prior install",
    );
    assert(installed.changed === true, "prior install made no changes");
    const priorInstallManifest = parseJson(
      await readFile(resolve(stateDir, "install.json"), "utf8"),
      "prior install manifest",
    );
    assert(
      priorInstallManifest.packageVersion === release.priorFixtureVersion,
      "prior install manifest version is wrong",
    );

    const backupPaths = [];
    for (const configPath of [codexConfig, claudeConfig, cursorConfig]) {
      for (const entry of await readdir(dirname(configPath))) {
        if (entry.startsWith(`${basename(configPath)}.agent-relay-backup-`)) {
          backupPaths.push(resolve(dirname(configPath), entry));
        }
      }
    }
    assert(
      backupPaths.length === 3,
      "initial install did not retain three backups",
    );
    const backupContents = new Map(
      await Promise.all(
        backupPaths.map(async (path) => [path, await readFile(path, "utf8")]),
      ),
    );

    const priorDoctor = parseJson(
      (
        await run(
          binary,
          [
            "doctor",
            "--root",
            isolatedHome,
            "--db",
            resolve(stateDir, "relay.sqlite"),
          ],
          {
            env: environment,
            temporaryRoot,
          },
        )
      ).stdout,
      "prior doctor",
    );
    assert(
      priorDoctor.healthy === true,
      "prior packed install doctor is unhealthy",
    );

    let baseUrl = await startDaemon(binary, isolatedHome, environment);
    const now = new Date();
    const questionEvent = {
      schema: "agent-attention.v1",
      eventId: "evt_upgrade_fixture_12345678",
      occurredAt: now.toISOString(),
      sequence: 100,
      machineId: "machine_upgrade_fixture_12345678",
      bridgeSessionId: "bridge_upgrade_fixture_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "fixture",
      sessionId: "session_upgrade_fixture_12345678",
      turnId: "turn_upgrade_fixture_12345678",
      project: {
        displayName: "upgrade-fixture",
        cwdHash: `sha256:${"a".repeat(64)}`,
      },
      type: "input.required",
      summary: "Sanitized lifecycle preservation question",
      request: {
        correlationId: "correlation_upgrade_fixture_12345678",
        kind: "input",
        question: "Preserve this synthetic answer?",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      },
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    };
    await jsonRequest(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(questionEvent),
    });
    await jsonRequest(`${baseUrl}/v1/deliveries/drain`, {
      method: "POST",
      body: JSON.stringify({ limit: 50 }),
    });
    const resolution = await jsonRequest(
      `${baseUrl}/v1/requests/${questionEvent.request.correlationId}/resolve-terminal`,
      {
        method: "POST",
        body: JSON.stringify({
          answer: "synthetic preserved answer",
          expected: {
            machineId: questionEvent.machineId,
            harness: questionEvent.harness,
            sessionId: questionEvent.sessionId,
            turnId: questionEvent.turnId,
          },
        }),
      },
    );
    assert(resolution.outcome === "answered", "prior answer was not committed");

    const priorCanary = parseJson(
      (
        await run(binary, ["canary"], {
          env: { ...environment, AGENT_RELAY_DAEMON_URL: baseUrl },
          cwd: isolatedHome,
          temporaryRoot,
        })
      ).stdout,
      "prior fake canary",
    );
    assert(
      priorCanary.ingest?.inserted === true &&
        priorCanary.outcome === "delivered" &&
        priorCanary.verification?.status === "delivered" &&
        priorCanary.drain.retrying === 0 &&
        priorCanary.drain.deadLettered === 0,
      "prior fake canary did not deliver cleanly",
    );
    await stopDaemon(temporaryRoot);

    const databasePath = resolve(stateDir, "relay.sqlite");
    const webCredentialPath = resolve(stateDir, "web-credential.json");
    const relayLogPath = resolve(stateDir, "relay.ndjson");
    const preservedCredentialPath = resolve(
      stateDir,
      "operator-credential.fixture.json",
    );
    const preservedLogPath = resolve(stateDir, "operator-preserved.log");
    await writeJson(preservedCredentialPath, {
      schema: "synthetic-credential-preservation.v1",
      value: "not-a-real-secret",
    });
    await writeFile(preservedLogPath, "synthetic retained log\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const webCredentialBefore = await readFile(webCredentialPath, "utf8");
    const relayLogBefore = await readFile(relayLogPath, "utf8");

    const { default: Database } = await import("better-sqlite3");
    const priorDatabase = new Database(databasePath);
    assert(
      priorDatabase.pragma("user_version", { simple: true }) === 11,
      "prior fixture database did not start at the known schema",
    );
    priorDatabase.exec(`
      ALTER TABLE topic_cleanup_operations DROP COLUMN inactive_before;
      ALTER TABLE topic_cleanup_operations DROP COLUMN selection_mode;
    `);
    priorDatabase.pragma("user_version = 5");
    priorDatabase.close();

    await installTarball(prefix, currentTarball, temporaryRoot);
    const currentVersion = await run(binary, ["--version"], {
      env: environment,
      temporaryRoot,
    });
    assert(
      currentVersion.stdout.trim() === release.version,
      "upgraded executable reports the wrong version",
    );

    const mismatchDoctor = parseJson(
      (
        await run(
          binary,
          ["doctor", "--root", isolatedHome, "--db", databasePath],
          {
            env: environment,
            expectedCodes: [1],
            temporaryRoot,
          },
        )
      ).stdout,
      "upgrade mismatch doctor",
    );
    assert(
      mismatchDoctor.checks.some(
        (check) => check.name === "package-version" && check.level === "fail",
      ),
      "doctor did not identify the stale install package version",
    );
    assert(
      mismatchDoctor.checks.some(
        (check) => check.name === "runtime-entry" && check.level === "fail",
      ),
      "doctor did not identify the stale launcher runtime entry",
    );

    const upgradeDryRun = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome, "--dry-run"], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "upgrade install dry run",
    );
    assert(
      upgradeDryRun.changed === true && upgradeDryRun.dryRun === true,
      "upgrade dry run did not diagnose reconciliation",
    );
    const upgraded = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "upgrade install",
    );
    assert(upgraded.changed === true, "upgrade install made no changes");
    const repeated = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "idempotent reinstall",
    );
    assert(repeated.changed === false, "repeated install is not idempotent");

    const currentDoctor = parseJson(
      (
        await run(
          binary,
          ["doctor", "--root", isolatedHome, "--db", databasePath],
          {
            env: environment,
            temporaryRoot,
          },
        )
      ).stdout,
      "current doctor",
    );
    assert(
      currentDoctor.healthy === true,
      "upgraded packed install doctor is unhealthy",
    );

    baseUrl = await startDaemon(binary, isolatedHome, environment);
    const retainedRequest = await jsonRequest(
      `${baseUrl}/v1/requests/${questionEvent.request.correlationId}`,
    );
    assert(
      retainedRequest.request?.state === "answered" &&
        retainedRequest.request?.resolvedBy === "terminal" &&
        retainedRequest.request?.answer === "synthetic preserved answer",
      "upgrade did not preserve the committed answer",
    );
    const currentCanary = parseJson(
      (
        await run(binary, ["canary"], {
          env: { ...environment, AGENT_RELAY_DAEMON_URL: baseUrl },
          cwd: isolatedHome,
          temporaryRoot,
        })
      ).stdout,
      "current fake canary",
    );
    assert(
      currentCanary.ingest?.inserted === true &&
        currentCanary.outcome === "delivered" &&
        currentCanary.verification?.status === "delivered" &&
        currentCanary.drain.retrying === 0 &&
        currentCanary.drain.deadLettered === 0,
      "upgraded fake canary did not deliver cleanly",
    );
    await stopDaemon(temporaryRoot);

    const migratedDatabase = new Database(databasePath);
    assert(
      migratedDatabase.pragma("user_version", { simple: true }) === 11,
      "current package did not migrate the prior schema forward",
    );
    migratedDatabase.pragma("wal_checkpoint(TRUNCATE)");
    migratedDatabase.close();

    const futureDatabasePath = resolve(stateDir, "future.sqlite");
    await copyFile(databasePath, futureDatabasePath);
    const futureDatabase = new Database(futureDatabasePath);
    futureDatabase.pragma("user_version = 12");
    futureDatabase.close();
    const downgradeDoctor = parseJson(
      (
        await run(
          binary,
          ["doctor", "--root", isolatedHome, "--db", futureDatabasePath],
          {
            env: environment,
            expectedCodes: [1],
            temporaryRoot,
          },
        )
      ).stdout,
      "unsafe downgrade doctor",
    );
    assert(
      downgradeDoctor.checks.some(
        (check) =>
          check.name === "sqlite-spool" &&
          check.level === "fail" &&
          check.detail.includes("refusing unsafe downgrade"),
      ),
      "doctor did not expose the unsafe schema downgrade refusal",
    );
    const futureUnchanged = new Database(futureDatabasePath, {
      readonly: true,
    });
    assert(
      futureUnchanged.pragma("user_version", { simple: true }) === 12,
      "downgrade refusal changed the future schema",
    );
    futureUnchanged.close();

    assert(
      (await readFile(webCredentialPath, "utf8")) === webCredentialBefore,
      "upgrade changed the local web credential",
    );
    assert(
      (await readFile(relayLogPath, "utf8")).startsWith(relayLogBefore),
      "upgrade replaced prior diagnostic log content",
    );
    assert(
      (await readFile(preservedCredentialPath, "utf8")).includes(
        "not-a-real-secret",
      ) &&
        (await readFile(preservedLogPath, "utf8")) ===
          "synthetic retained log\n",
      "upgrade changed retained credential/log fixtures",
    );
    for (const [path, content] of backupContents) {
      assert(
        (await readFile(path, "utf8")) === content,
        "upgrade changed an existing installer backup",
      );
    }

    for (const configPath of [codexConfig, claudeConfig, cursorConfig]) {
      assert(
        ownerMarkerCount(
          parseJson(await readFile(configPath, "utf8"), "installed config"),
        ) > 0,
        "upgraded config lost its owned hook before uninstall",
      );
    }
    const uninstallDryRun = parseJson(
      (
        await run(binary, ["uninstall", "--root", isolatedHome, "--dry-run"], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "uninstall dry run",
    );
    assert(
      uninstallDryRun.changed === true && uninstallDryRun.dryRun === true,
      "uninstall dry run did not report owned changes",
    );
    const uninstall = parseJson(
      (
        await run(binary, ["uninstall", "--root", isolatedHome], {
          env: environment,
          temporaryRoot,
        })
      ).stdout,
      "uninstall",
    );
    assert(uninstall.changed === true, "uninstall removed nothing");

    const finalCodex = parseJson(
      await readFile(codexConfig, "utf8"),
      "uninstalled Codex config",
    );
    const finalClaude = parseJson(
      await readFile(claudeConfig, "utf8"),
      "uninstalled Claude config",
    );
    const finalCursor = parseJson(
      await readFile(cursorConfig, "utf8"),
      "uninstalled Cursor config",
    );
    assert(
      finalCodex.userSetting === "preserve-codex" &&
        JSON.stringify(finalCodex).includes("user-stop-hook") &&
        ownerMarkerCount(finalCodex) === 0,
      "uninstall did not preserve the unrelated Codex configuration",
    );
    assert(
      finalClaude.permissions?.allow?.[0] === "Read" &&
        ownerMarkerCount(finalClaude) === 0,
      "uninstall did not preserve the unrelated Claude configuration",
    );
    assert(
      JSON.stringify(finalCursor).includes("user-cursor-hook") &&
        ownerMarkerCount(finalCursor) === 0,
      "uninstall did not preserve the unrelated Cursor configuration",
    );
    assert(
      !(await exists(resolve(stateDir, "bin/agent-relay"))) &&
        !(await exists(resolve(stateDir, "install.json"))),
      "owned launcher or install manifest survived uninstall",
    );
    assert(
      (await exists(databasePath)) &&
        (await exists(webCredentialPath)) &&
        (await exists(preservedCredentialPath)) &&
        (await exists(preservedLogPath)),
      "uninstall removed retained state",
    );
    for (const path of backupPaths) {
      assert(await exists(path), "uninstall removed an installer backup");
    }

    await run("pnpm", ["--dir", prefix, "remove", release.name], {
      temporaryRoot,
      timeoutMs: 180_000,
    });
    assert(
      !(await exists(binary)) &&
        !(await exists(resolve(prefix, "node_modules/@flowxo/agent-relay"))),
      "package-manager removal left the installed package or executable",
    );
    for (const configPath of [codexConfig, claudeConfig, cursorConfig]) {
      assert(
        ownerMarkerCount(
          parseJson(await readFile(configPath, "utf8"), "post-removal config"),
        ) === 0,
        "package removal left an Agent Relay-owned hook",
      );
    }

    const retainedDatabase = new Database(databasePath, { readonly: true });
    const retainedAnswer = retainedDatabase
      .prepare(
        "SELECT state, resolved_by, answer FROM pending_requests WHERE correlation_id = ?",
      )
      .get(questionEvent.request.correlationId);
    retainedDatabase.close();
    assert(
      retainedAnswer?.state === "answered" &&
        retainedAnswer?.resolved_by === "terminal" &&
        retainedAnswer?.answer === "synthetic preserved answer",
      "package removal changed the retained answer",
    );

    process.stdout.write(
      `Packed lifecycle verified (${release.priorFixtureVersion} -> ${release.version}): dry-run, install, doctor mismatch, schema migration/refusal, answer/state preservation, idempotent reconciliation, owned uninstall, and package removal passed.\n`,
    );
  } finally {
    if (activeDaemon !== undefined && activeDaemon.exitCode === null) {
      activeDaemon.kill("SIGTERM");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
