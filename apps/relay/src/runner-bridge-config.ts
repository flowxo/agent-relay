import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

const MAX_RUNNER_BRIDGE_CONFIGURATION_BYTES = 4 * 1024;

export const RunnerBridgeConfigurationSchema = z
  .object({
    schema: z.literal("agent-relay-runner-bridge-config.v1"),
    enabled: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type RunnerBridgeConfiguration = z.infer<
  typeof RunnerBridgeConfigurationSchema
>;

export interface RunnerBridgePaths {
  readonly configuration: string;
  readonly database: string;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Runner bridge state directory must be private.");
  }
}

async function inspectPrivateRegularFile(
  path: string,
  maximumBytes: number,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error("Runner bridge state path is not a regular file.");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Runner bridge state file must be private.");
    }
    if (metadata.size > maximumBytes) {
      throw new Error("Runner bridge state file exceeds its size limit.");
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function atomicWritePrivate(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await inspectPrivateRegularFile(path, MAX_RUNNER_BRIDGE_CONFIGURATION_BYTES);
  const temporary = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await inspectPrivateRegularFile(path, MAX_RUNNER_BRIDGE_CONFIGURATION_BYTES);
}

export function runnerBridgePaths(stateDirectory: string): RunnerBridgePaths {
  return {
    configuration: join(stateDirectory, "runner-bridge.json"),
    database: join(stateDirectory, "runner-bridge.sqlite"),
  };
}

export async function readRunnerBridgeConfiguration(
  path: string,
): Promise<RunnerBridgeConfiguration | undefined> {
  if (
    !(await inspectPrivateRegularFile(
      path,
      MAX_RUNNER_BRIDGE_CONFIGURATION_BYTES,
    ))
  ) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Runner bridge configuration is not valid JSON.");
  }
  return RunnerBridgeConfigurationSchema.parse(value);
}

export async function writeRunnerBridgeConfiguration(
  path: string,
  enabled: boolean,
  now = new Date(),
): Promise<RunnerBridgeConfiguration> {
  const configuration = RunnerBridgeConfigurationSchema.parse({
    schema: "agent-relay-runner-bridge-config.v1",
    enabled,
    updatedAt: now.toISOString(),
  });
  await atomicWritePrivate(path, configuration);
  return configuration;
}

export async function runnerBridgeDatabaseExists(
  path: string,
): Promise<boolean> {
  return await inspectPrivateRegularFile(path, Number.MAX_SAFE_INTEGER);
}

export async function eraseDisabledRunnerBridgeState(
  paths: RunnerBridgePaths,
): Promise<readonly string[]> {
  const configuration = await readRunnerBridgeConfiguration(
    paths.configuration,
  );
  if (configuration?.enabled === true) {
    throw new Error("Disable the runner bridge before erasing its state.");
  }
  const targets = [
    ["configuration", paths.configuration],
    ["database", paths.database],
    ["database-wal", `${paths.database}-wal`],
    ["database-shm", `${paths.database}-shm`],
  ] as const;
  const removed: string[] = [];
  for (const [label, path] of targets) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) {
        throw new Error("Runner bridge erase target is not a regular file.");
      }
      await unlink(path);
      removed.push(label);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return removed;
}
