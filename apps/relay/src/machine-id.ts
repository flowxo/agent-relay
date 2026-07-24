import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MACHINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export async function loadOrCreateMachineId(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!MACHINE_ID_PATTERN.test(existing)) {
      throw new Error(`machine id file ${path} is malformed`);
    }
    return existing;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const created = `machine_${randomUUID()}`;
  try {
    await writeFile(path, `${created}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return created;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const raced = (await readFile(path, "utf8")).trim();
      if (MACHINE_ID_PATTERN.test(raced)) {
        return raced;
      }
    }
    throw error;
  }
}
