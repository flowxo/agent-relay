import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runRunnerBridgeCommand } from "./runner-bridge-command.js";
import {
  readRunnerBridgeConfiguration,
  runnerBridgePaths,
  writeRunnerBridgeConfiguration,
} from "./runner-bridge-config.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-bridge-config-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runner bridge configuration", () => {
  test("is strict, private, and disabled by default", async () => {
    const stateDirectory = await temporaryDirectory();
    await expect(
      runRunnerBridgeCommand({
        args: ["status"],
        stateDirectory,
      }),
    ).resolves.toMatchObject({
      configured: false,
      enabled: false,
      state: "disabled",
      databasePresent: false,
    });

    const paths = runnerBridgePaths(stateDirectory);
    await writeRunnerBridgeConfiguration(
      paths.configuration,
      true,
      new Date("2026-07-27T12:00:00.000Z"),
    );
    expect((await lstat(paths.configuration)).mode & 0o777).toBe(0o600);
    await expect(
      readRunnerBridgeConfiguration(paths.configuration),
    ).resolves.toMatchObject({
      enabled: true,
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
  });

  test("rejects permissive and symlinked state", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerBridgePaths(stateDirectory);
    await writeRunnerBridgeConfiguration(paths.configuration, false);
    await chmod(paths.configuration, 0o644);
    await expect(
      readRunnerBridgeConfiguration(paths.configuration),
    ).rejects.toThrow("must be private");

    await rm(paths.configuration);
    const target = join(stateDirectory, "outside.json");
    await writeFile(target, "unchanged\n", { mode: 0o600 });
    await symlink(target, paths.configuration);
    await expect(
      writeRunnerBridgeConfiguration(paths.configuration, true),
    ).rejects.toThrow("not a regular file");
    await expect(readFile(target, "utf8")).resolves.toBe("unchanged\n");
  });

  test("requires disablement and confirmation before scoped erasure", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerBridgePaths(stateDirectory);
    const attentionDatabase = join(stateDirectory, "relay.sqlite");
    await writeFile(attentionDatabase, "standalone-state\n", { mode: 0o600 });
    await writeRunnerBridgeConfiguration(paths.configuration, true);

    await expect(
      runRunnerBridgeCommand({
        args: ["erase", "--confirm"],
        stateDirectory,
      }),
    ).rejects.toThrow("Disable");
    await runRunnerBridgeCommand({
      args: ["disable"],
      stateDirectory,
    });
    await expect(
      runRunnerBridgeCommand({
        args: ["erase"],
        stateDirectory,
      }),
    ).rejects.toThrow("--confirm");
    await expect(
      runRunnerBridgeCommand({
        args: ["erase", "--confirm"],
        stateDirectory,
      }),
    ).resolves.toMatchObject({
      erased: true,
      standaloneAttentionStateRetained: true,
    });
    await expect(readFile(attentionDatabase, "utf8")).resolves.toBe(
      "standalone-state\n",
    );
  });
});
