import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface FallbackRecord {
  schema: "agent-relay-fallback.v1";
  recordedAt: string;
  kind: "event" | "diagnostic";
  payload: unknown;
}

export async function appendFallbackRecord(
  path: string,
  record: FallbackRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
