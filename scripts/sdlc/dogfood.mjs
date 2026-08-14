import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";

import { repositoryRoot } from "./lib.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`Dogfood deployment refused: ${message}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(executable, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio:
        options.quiet === true ? ["ignore", "ignore", "ignore"] : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${basename(executable)} failed (${String(code ?? signal)})`,
          ),
        );
    });
  });
}

async function output(executable, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let value = "";
    child.stdout.on("data", (chunk) => {
      value = `${value}${String(chunk)}`.slice(-16_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(value.trim());
      else reject(new Error(`${basename(executable)} failed`));
    });
  });
}

async function digestTree(directory) {
  const hash = createHash("sha256");
  async function visit(path, relativePath = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const child = resolve(path, entry.name);
      const relativeChild =
        relativePath.length === 0
          ? entry.name
          : `${relativePath}/${entry.name}`;
      assert(
        !entry.isSymbolicLink(),
        `build contains symbolic link ${relativeChild}`,
      );
      if (entry.isDirectory()) await visit(child, relativeChild);
      else {
        assert(entry.isFile(), `build contains non-file ${relativeChild}`);
        hash.update(`${relativeChild}\0`);
        hash.update(await readFile(child));
        hash.update("\0");
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

function dogfoodPaths(root) {
  const directory = resolve(root, ".agent-relay", "dogfood");
  return {
    directory,
    current: resolve(directory, "current.json"),
    deployments: resolve(directory, "deployments"),
    builds: resolve(repositoryRoot, ".artifacts", "dogfood", "builds"),
  };
}

async function readCurrent(paths) {
  if (!(await exists(paths.current))) return undefined;
  return JSON.parse(await readFile(paths.current, "utf8"));
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function serviceExists(label) {
  if (process.platform !== "darwin") return false;
  try {
    await run(
      "launchctl",
      ["print", `gui/${String(process.getuid())}/${label}`],
      { quiet: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function restartService(label, enabled) {
  if (!enabled) return "not-requested";
  if (!(await serviceExists(label))) return "not-installed";
  await run(
    "launchctl",
    ["kickstart", "-k", `gui/${String(process.getuid())}/${label}`],
    { quiet: true },
  );
  return "restarted";
}

async function installBuild(root, entryPath) {
  await run(process.execPath, [
    entryPath,
    "install",
    "--root",
    root,
    "--entry",
    entryPath,
  ]);
}

async function deploy() {
  assert(
    process.env.CI === undefined,
    "exploratory dogfood deployment cannot run in CI",
  );
  const root = resolve(argument("--root") ?? homedir());
  const paths = dogfoodPaths(root);
  const service =
    argument("--service") ??
    process.env.AGENT_RELAY_DOGFOOD_SERVICE ??
    "com.flowxo.agent-relay.dogfood";
  await run("pnpm", ["check:fast"]);
  await run("pnpm", ["package:build"]);
  const packageStage = resolve(repositoryRoot, ".artifacts/package");
  const artifactSha256 = await digestTree(packageStage);
  const commit = await output("git", ["rev-parse", "HEAD"]);
  const branch = await output("git", ["branch", "--show-current"]);
  const dirty =
    (
      await output("git", [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ])
    ).length > 0;
  const buildId = `${commit.slice(0, 12)}-${artifactSha256.slice(0, 12)}`;
  const buildDirectory = resolve(paths.builds, buildId);
  if (!(await exists(buildDirectory))) {
    await mkdir(buildDirectory, { recursive: true, mode: 0o700 });
    await cp(packageStage, buildDirectory, {
      recursive: true,
      errorOnExist: true,
    });
  }
  const entryPath = resolve(buildDirectory, "dist/cli.js");
  assert((await stat(entryPath)).isFile(), "retained build has no CLI entry");
  const previous = await readCurrent(paths);
  await installBuild(root, entryPath);
  const deployment = {
    schema: "agent-relay-exploratory-dogfood.v1",
    commit,
    branch,
    dirty,
    artifactSha256,
    buildId,
    deployedAt: new Date().toISOString(),
    previous:
      previous === undefined
        ? null
        : {
            commit: previous.commit,
            branch: previous.branch,
            dirty: previous.dirty,
            artifactSha256: previous.artifactSha256,
            buildId: previous.buildId,
          },
    formalReleaseEvidence: false,
  };
  const restart = await restartService(
    service,
    !process.argv.includes("--no-restart"),
  );
  const recordName = `${deployment.deployedAt.replaceAll(/[:.]/g, "-")}-${artifactSha256.slice(0, 12)}.json`;
  await atomicJson(resolve(paths.deployments, recordName), {
    ...deployment,
    serviceRestart: restart,
  });
  await atomicJson(paths.current, { ...deployment, serviceRestart: restart });
  process.stdout.write(
    `${JSON.stringify({ schema: deployment.schema, commit, branch, dirty, artifactSha256, serviceRestart: restart, formalReleaseEvidence: false }, null, 2)}\n`,
  );
}

async function status() {
  const root = resolve(argument("--root") ?? homedir());
  const current = await readCurrent(dogfoodPaths(root));
  if (current === undefined) {
    process.stdout.write(
      "No exploratory Agent Relay dogfood deployment is recorded. Run pnpm dogfood:deploy.\n",
    );
    return;
  }
  const paths = dogfoodPaths(root);
  const buildPresent = await exists(
    resolve(paths.builds, current.buildId, "dist/cli.js"),
  );
  process.stdout.write(
    `${JSON.stringify({ schema: current.schema, commit: current.commit, branch: current.branch, dirty: current.dirty, artifactSha256: current.artifactSha256, deployedAt: current.deployedAt, buildPresent, serviceRestart: current.serviceRestart, formalReleaseEvidence: false }, null, 2)}\n`,
  );
}

async function rollback() {
  assert(
    process.env.CI === undefined,
    "exploratory dogfood rollback cannot run in CI",
  );
  const root = resolve(argument("--root") ?? homedir());
  const paths = dogfoodPaths(root);
  const current = await readCurrent(paths);
  assert(
    current?.previous?.buildId !== undefined,
    "no previous exploratory deployment is recorded",
  );
  const previousEntry = resolve(
    paths.builds,
    current.previous.buildId,
    "dist/cli.js",
  );
  assert(
    await exists(previousEntry),
    "previous retained build is no longer present",
  );
  await installBuild(root, previousEntry);
  const deployment = {
    schema: "agent-relay-exploratory-dogfood.v1",
    commit: current.previous.commit,
    branch: current.previous.branch,
    dirty: current.previous.dirty,
    artifactSha256: current.previous.artifactSha256,
    buildId: current.previous.buildId,
    deployedAt: new Date().toISOString(),
    previous: {
      commit: current.commit,
      branch: current.branch,
      dirty: current.dirty,
      artifactSha256: current.artifactSha256,
      buildId: current.buildId,
    },
    formalReleaseEvidence: false,
  };
  const service =
    argument("--service") ??
    process.env.AGENT_RELAY_DOGFOOD_SERVICE ??
    "com.flowxo.agent-relay.dogfood";
  const restart = await restartService(
    service,
    !process.argv.includes("--no-restart"),
  );
  await atomicJson(paths.current, { ...deployment, serviceRestart: restart });
  process.stdout.write(
    `Rolled exploratory dogfood back to ${deployment.commit}; service ${restart}.\n`,
  );
}

const operation = process.argv[2];
if (operation === "deploy") await deploy();
else if (operation === "status") await status();
else if (operation === "rollback") await rollback();
else
  throw new Error(
    "usage: dogfood.mjs deploy|status|rollback [--root PATH] [--service LABEL] [--no-restart]",
  );
