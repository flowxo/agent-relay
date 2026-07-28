import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import {
  assertReleaseConfiguration,
  stagedPackageIsPrivate,
} from "./lib/release-policy.mjs";

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

function sanitized(value, temporaryRoot) {
  return value.replaceAll(temporaryRoot, "<isolated-package-check>");
}

async function run(
  executable,
  args,
  {
    cwd = root,
    env = process.env,
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
          `${executable} ${args.join(" ")} exceeded ${String(timeoutMs)}ms`,
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
        stdout: sanitized(stdout, temporaryRoot),
        stderr: sanitized(stderr, temporaryRoot),
      };
      if (code !== 0) {
        reject(
          new Error(
            [
              `${executable} ${args.join(" ")} failed (${String(code ?? signal)})`,
              result.stdout,
              result.stderr,
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

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "agent-relay-package-check-"),
);
let daemon;
let daemonOutput = "";
try {
  const tarball = resolve(temporaryRoot, "agent-relay.tgz");
  await run("pnpm", ["pack", "--out", tarball], {
    temporaryRoot,
    timeoutMs: 180_000,
  });

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
  ]) {
    if (pattern.test(combined)) {
      throw new Error(`packed content contains a forbidden ${label}`);
    }
  }

  if (process.platform !== "darwin") {
    process.stdout.write(
      `Package content verified (${String(archivedFiles.length)} files, ${String(tarballSize)} packed bytes, ${String(unpackedSize)} unpacked bytes). Isolated runtime skipped on unsupported ${process.platform}/${process.arch}.\n`,
    );
    process.exitCode = 0;
  } else {
    const prefix = resolve(temporaryRoot, "consumer");
    const isolatedHome = resolve(temporaryRoot, "home");
    await mkdir(prefix, { recursive: true });
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(prefix, "package.json"),
      `${JSON.stringify({ name: "agent-relay-package-check", private: true })}\n`,
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
    const help = await run(binary, ["--help"], {
      env: { ...process.env, HOME: isolatedHome },
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
      env: { ...process.env, HOME: isolatedHome },
      temporaryRoot,
    });
    if (version.stdout.trim() !== release.version) {
      throw new Error("packed executable version differs from its manifest");
    }
    const compatibility = parseJsonOutput(
      (
        await run(binary, ["capabilities"], {
          env: { ...process.env, HOME: isolatedHome },
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
    const stateDir = resolve(isolatedHome, ".agent-relay");
    const daemonEnvironment = {
      ...process.env,
      HOME: isolatedHome,
      PATH: `${resolve(prefix, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
      AGENT_RELAY_STATE_DIR: stateDir,
      AGENT_RELAY_WEB_ENABLED: "1",
    };
    for (const name of [
      "AGENT_RELAY_DAEMON_TOKEN",
      "AGENT_RELAY_TELEGRAM_TOKEN",
      "AGENT_RELAY_TELEGRAM_CHAT_ID",
      "AGENT_RELAY_TELEGRAM_OPERATOR_ID",
      "AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
      "AGENT_RELAY_TELEGRAM_UPDATE_MODE",
    ]) {
      delete daemonEnvironment[name];
    }

    daemon = spawn(binary, ["daemon", "--port", String(port)], {
      cwd: isolatedHome,
      env: daemonEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        assetVersion: "1",
      },
      "packed web API/assets are not version-compatible",
    );

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
} finally {
  if (daemon !== undefined && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
