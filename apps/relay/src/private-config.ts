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
import { dirname } from "node:path";

export interface PrivateConfigurationFileOptions {
  description: string;
  maximumBytes: number;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function ensurePrivateDirectory(
  path: string,
  description: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`${description} parent is not a directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `${description} parent must not be accessible by group or others`,
    );
  }
}

export async function inspectPrivateConfigurationFile(
  path: string,
  options: PrivateConfigurationFileOptions,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error(`${options.description} path is not a regular file`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        `${options.description} must not be accessible by group or others`,
      );
    }
    if (metadata.size > options.maximumBytes) {
      throw new Error(`${options.description} exceeds its size limit`);
    }
    return metadata;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function readPrivateJson(
  path: string,
  options: PrivateConfigurationFileOptions,
): Promise<unknown | undefined> {
  const metadata = await inspectPrivateConfigurationFile(path, options);
  if (metadata === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${options.description} is not valid JSON`);
  }
}

export async function atomicWritePrivateJson(
  path: string,
  value: unknown,
  options: PrivateConfigurationFileOptions,
): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, options.description);
  await inspectPrivateConfigurationFile(path, options);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The original write failure remains authoritative.
    }
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          `${options.description} write and cleanup both failed`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  await inspectPrivateConfigurationFile(path, options);
}

export async function removePrivateConfigurationFile(
  path: string,
  options: PrivateConfigurationFileOptions,
): Promise<boolean> {
  const metadata = await inspectPrivateConfigurationFile(path, options);
  if (metadata === undefined) {
    return false;
  }
  await unlink(path);
  return true;
}
