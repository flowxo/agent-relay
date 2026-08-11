import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repositoryRoot = resolve(dirname(cliPath), "../../..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("canary CLI help boundary", () => {
  for (const command of [
    "canary",
    "telegram-canary",
    "whooshbang-canary",
    "webhook-canary",
  ]) {
    for (const helpFlag of ["--help", "-h"]) {
      it(`keeps ${command} ${helpFlag} inert`, async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-relay-help-"));
        temporaryDirectories.push(root);
        const stateDirectory = join(root, "state");
        const result = spawnSync(
          process.execPath,
          [
            "--conditions=development",
            "--import",
            "tsx",
            cliPath,
            command,
            helpFlag,
          ],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              AGENT_RELAY_DAEMON_URL: "http://127.0.0.1:1",
              AGENT_RELAY_STATE_DIR: stateDirectory,
              NO_COLOR: "1",
            },
            timeout: 10_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Agent Relay");
        expect(result.stdout).toContain("Usage:");
        expect(result.stderr).toBe("");
        expect(existsSync(stateDirectory)).toBe(false);
      });
    }
  }
});
