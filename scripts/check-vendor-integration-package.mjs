import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const stage = resolve(root, ".artifacts/package");
const cli = resolve(stage, "dist/cli.js");
const isolatedHome = await mkdtemp(
  resolve(tmpdir(), "agent-relay-vendor-package-"),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: isolatedHome,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: isolatedHome,
      AGENT_RELAY_STATE_DIR: resolve(isolatedHome, ".agent-relay"),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `packaged vendor lifecycle failed: ${result.stderr.replaceAll(isolatedHome, "<isolated-home>")}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function exists(path) {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

const packageManifest = JSON.parse(
  await readFile(resolve(stage, "package.json"), "utf8"),
);
assert(
  JSON.stringify(Object.keys(packageManifest.dependencies).sort()) ===
    JSON.stringify(["better-sqlite3", "zod"]),
  "vendor integration introduced an unexpected runtime dependency",
);

const unrelated = resolve(isolatedHome, "unrelated-vendor-material.txt");
await writeFile(unrelated, "preserve exactly\n", "utf8");
const installed = run(["integrations", "install", "--root", isolatedHome]);
assert(installed.changed === true, "packaged vendor install made no change");
const dashboard = run(["dashboard"]);
assert(
  dashboard.schema === "agent-relay-dashboard-entry.v1" &&
    dashboard.url === "http://127.0.0.1:4317/ui/" &&
    dashboard.networking === "loopback-only",
  "packaged dashboard entry point is not the canonical loopback UI",
);
const targets = {
  codex: resolve(
    isolatedHome,
    ".agent-relay/vendor/codex-marketplace/plugins/agent-relay",
  ),
  claude: resolve(isolatedHome, ".agent-relay/vendor/claude/agent-relay"),
  cursor: resolve(isolatedHome, ".cursor/plugins/local/agent-relay"),
};
for (const [harness, target] of Object.entries(targets)) {
  const metadata = JSON.parse(
    await readFile(resolve(target, "agent-relay.integration.json"), "utf8"),
  );
  assert(
    metadata.owner === "flowxo/agent-relay" &&
      metadata.schema === "agent-relay-integration.v1" &&
      metadata.harness === harness,
    `packaged ${harness} provenance or ownership metadata is invalid`,
  );
  assert(
    ((await stat(resolve(target, "bin/agent-relay-plugin"))).mode & 0o777) ===
      0o700,
    `packaged ${harness} wrapper is not executable and private`,
  );
}

assert(
  run(["integrations", "install", "--root", isolatedHome]).changed === false,
  "packaged repeat install was not idempotent",
);
await writeFile(
  resolve(targets.cursor, "commands/agent-relay-doctor.md"),
  "drift\n",
  "utf8",
);
assert(
  run(["integrations", "status", "--root", isolatedHome]).harnesses.some(
    (entry) => entry.harness === "cursor" && entry.state === "drifted",
  ),
  "packaged status did not detect owned drift",
);
run(["integrations", "repair", "--root", isolatedHome]);
run(["integrations", "disable", "--root", isolatedHome]);
run(["integrations", "enable", "--root", isolatedHome]);
run(["integrations", "reinstall", "--root", isolatedHome]);
const lifecycle = JSON.parse(
  await readFile(
    resolve(isolatedHome, ".agent-relay/integrations.json"),
    "utf8",
  ),
);
assert(
  lifecycle.harnesses.every(
    (entry) => Array.isArray(entry.rollback) && entry.rollback.length > 0,
  ),
  "packaged reinstall did not retain bounded rollback inventory",
);
run(["integrations", "rollback", "--root", isolatedHome]);
assert(
  run(["integrations", "status", "--root", isolatedHome]).harnesses.every(
    (entry) => entry.state === "installed",
  ),
  "packaged rollback was not retained as healthy owned state",
);
run(["integrations", "uninstall", "--root", isolatedHome]);
assert(
  !(await exists(targets.codex)) &&
    !(await exists(targets.claude)) &&
    !(await exists(targets.cursor)),
  "packaged uninstall left an owned plugin target",
);
assert(
  (await readFile(unrelated, "utf8")) === "preserve exactly\n",
  "packaged lifecycle changed unrelated material",
);

process.stdout.write(
  "Packaged vendor integration inventory, provenance, executable modes, dependency footprint, lifecycle, preservation, and rollback verified in an isolated home.\n",
);
