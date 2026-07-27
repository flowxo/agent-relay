import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadOrCreateWebCredential,
  WebCredentialSchema,
} from "./web-credential.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-web-credential-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("web credential", () => {
  it("generates a private credential once and reuses it", async () => {
    const path = join(await temporaryDirectory(), "state", "web.json");
    const first = await loadOrCreateWebCredential(
      path,
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const second = await loadOrCreateWebCredential(
      path,
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(WebCredentialSchema.parse(first)).toEqual(first);
    expect(second).toEqual(first);
    expect(first.token).not.toBe(first.csrfToken);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects credentials exposed to group or other users", async () => {
    const path = join(await temporaryDirectory(), "web.json");
    await loadOrCreateWebCredential(path);
    await chmod(path, 0o644);

    await expect(loadOrCreateWebCredential(path)).rejects.toThrow(
      "must not be readable or writable by group or others",
    );
  });

  it("rejects symlinks and malformed credential files", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, link);

    await expect(loadOrCreateWebCredential(link)).rejects.toThrow(
      "not a regular file",
    );
    await expect(loadOrCreateWebCredential(target)).rejects.toThrow();
  });
});
