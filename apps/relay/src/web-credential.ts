import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

export const WebCredentialSchema = z
  .object({
    schema: z.literal("agent-relay-web-credential.v1"),
    token: z.string().min(32).max(128),
    csrfToken: z.string().min(32).max(128),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type WebCredential = z.infer<typeof WebCredentialSchema>;

function createCredential(now: Date): WebCredential {
  return WebCredentialSchema.parse({
    schema: "agent-relay-web-credential.v1",
    token: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
    createdAt: now.toISOString(),
  });
}

async function readCredential(path: string): Promise<WebCredential> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error("web credential path is not a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "web credential file must not be readable or writable by group or others",
    );
  }
  return WebCredentialSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

export async function loadOrCreateWebCredential(
  path: string,
  now = new Date(),
): Promise<WebCredential> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return await readCredential(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const credential = createCredential(now);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(credential)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return await readCredential(path);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return await readCredential(path);
}
