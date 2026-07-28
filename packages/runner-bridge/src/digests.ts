import { createHash } from "node:crypto";

import type { Sha256Digest } from "@session/contracts";
import type { RunnerCommandFrame } from "@session/protocol-runner";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not canonical JSON.");
}

export function sha256(value: string): Sha256Digest {
  return createHash("sha256").update(value).digest("hex") as Sha256Digest;
}

export function commandEffectFingerprint(
  command: RunnerCommandFrame,
): Sha256Digest {
  return sha256(
    canonicalJson({
      workspace_id: command.workspace_id,
      runner_id: command.runner_id,
      project_id: command.project_id ?? null,
      worktree_id: command.worktree_id ?? null,
      session_id: command.session_id ?? null,
      turn_id: command.turn_id ?? null,
      aggregate_revision: command.aggregate_revision ?? null,
      capability_snapshot_digest: command.capability_snapshot_digest,
      command: command.payload.command,
      required_capability: command.payload.required_capability,
      body: command.payload.body,
    }),
  );
}
