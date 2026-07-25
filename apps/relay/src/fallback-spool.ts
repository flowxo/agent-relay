import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { redactText, redactValue } from "@agent-relay/core";
import {
  AgentAttentionEventV1Schema,
  RelayDiagnosticV1Schema,
  sha256,
} from "@agent-relay/protocol";
import type {
  AgentAttentionEventV1,
  RelayDiagnosticV1,
} from "@agent-relay/protocol";
import { z } from "zod";

export const DEFAULT_FALLBACK_RECORD_BYTES = 128 * 1024;
export const DEFAULT_FALLBACK_SEGMENT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_FALLBACK_REPLAY_FILE_BYTES = 16 * 1024 * 1024;

export const FallbackRecordSchema = z
  .object({
    schema: z.literal("agent-relay-fallback.v1"),
    recordedAt: z.iso.datetime({ offset: true }),
    kind: z.enum(["event", "diagnostic"]),
    payload: z.unknown(),
  })
  .strict();

export type FallbackRecord = z.infer<typeof FallbackRecordSchema>;

export interface FallbackSpoolLimits {
  maxRecordBytes?: number;
  maxSegmentBytes?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface FallbackReplayClient {
  ingest(event: AgentAttentionEventV1): Promise<unknown>;
  reportDiagnostic(diagnostic: RelayDiagnosticV1): Promise<unknown>;
}

export interface FallbackReplayFailure {
  segment: string;
  line?: number;
  code: string;
  message: string;
}

export interface FallbackReplayResult {
  filesClaimed: number;
  filesCompleted: number;
  filesPending: number;
  records: number;
  events: number;
  diagnostics: number;
  malformed: number;
  failures: FallbackReplayFailure[];
}

export interface FallbackReplayOptions {
  maxRecordBytes?: number;
  maxReplayFileBytes?: number;
  processingStaleMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => Date;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  staleLockMs: number,
): Promise<FileHandle> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > staleLockMs) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (!isErrorCode(lockError, "ENOENT")) {
          throw lockError;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error(`fallback spool lock timed out after ${timeoutMs}ms`);
}

async function withSpoolLock<T>(
  path: string,
  options: {
    lockTimeoutMs: number;
    staleLockMs: number;
  },
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const handle = await acquireLock(
    lockPath,
    options.lockTimeoutMs,
    options.staleLockMs,
  );
  const release = async (): Promise<void> => {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  };
  let result: T;
  try {
    result = await action();
  } catch (actionError) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [actionError, releaseError],
        "fallback spool action and lock cleanup both failed",
        { cause: releaseError },
      );
    }
    throw actionError;
  }
  await release();
  return result;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

export async function appendFallbackRecord(
  path: string,
  recordInput: FallbackRecord,
  limits: FallbackSpoolLimits = {},
): Promise<void> {
  const maxRecordBytes = positiveInteger(
    limits.maxRecordBytes ?? DEFAULT_FALLBACK_RECORD_BYTES,
    "maxRecordBytes",
  );
  const maxSegmentBytes = positiveInteger(
    limits.maxSegmentBytes ?? DEFAULT_FALLBACK_SEGMENT_BYTES,
    "maxSegmentBytes",
  );
  if (maxSegmentBytes < maxRecordBytes) {
    throw new Error("maxSegmentBytes cannot be smaller than maxRecordBytes");
  }
  const record = FallbackRecordSchema.parse({
    ...recordInput,
    payload: redactValue(recordInput.payload, {
      stringLimit: 4_000,
      arrayLimit: 50,
      objectLimit: 100,
    }),
  });
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > maxRecordBytes) {
    throw new Error(
      `fallback record is ${lineBytes} bytes; limit is ${maxRecordBytes}`,
    );
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withSpoolLock(
    path,
    {
      lockTimeoutMs: limits.lockTimeoutMs ?? 500,
      staleLockMs: limits.staleLockMs ?? 30_000,
    },
    async () => {
      const currentSize = await fileSize(path);
      if (currentSize > 0 && currentSize + lineBytes > maxSegmentBytes) {
        await rename(
          path,
          `${path}.segment-${String(Date.now())}-${randomUUID()}`,
        );
      }
      await appendFile(path, line, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  );
}

function fallbackPayloadFields(payload: unknown): {
  code: string;
  message: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return {
      code: "fallback.diagnostic",
      message: "Fallback diagnostic did not contain a structured payload",
    };
  }
  const record = payload as Record<string, unknown>;
  return {
    code:
      typeof record["code"] === "string"
        ? normalizeDiagnosticCode(record["code"])
        : "fallback.diagnostic",
    message:
      typeof record["message"] === "string"
        ? redactText(record["message"], 2_000)
        : "Fallback diagnostic did not contain a message",
  };
}

function normalizeDiagnosticCode(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 120);
  return normalized.length === 0 ? "fallback.diagnostic" : normalized;
}

function replayDiagnostic(
  rawIdentity: string,
  recordedAt: string,
  code: string,
  message: string,
): RelayDiagnosticV1 {
  return RelayDiagnosticV1Schema.parse({
    schema: "agent-relay-diagnostic.v1",
    diagnosticId: `diag_${sha256(rawIdentity).slice(0, 40)}`,
    recordedAt,
    source: "fallback-spool",
    level: "error",
    code: normalizeDiagnosticCode(code),
    message: redactText(message, 2_000),
  });
}

async function claimReplayFiles(
  path: string,
  runId: string,
  now: Date,
  options: Required<
    Pick<
      FallbackReplayOptions,
      "processingStaleMs" | "lockTimeoutMs" | "staleLockMs"
    >
  >,
): Promise<string[]> {
  const directory = dirname(path);
  const spoolName = basename(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return await withSpoolLock(path, options, async () => {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const isReady =
        entry.name === spoolName ||
        entry.name.startsWith(`${spoolName}.segment-`) ||
        entry.name.startsWith(`${spoolName}.pending-`);
      if (isReady) {
        candidates.push(entry.name);
        continue;
      }
      if (entry.name.startsWith(`${spoolName}.processing-`)) {
        const metadata = await stat(join(directory, entry.name));
        if (now.getTime() - metadata.mtimeMs > options.processingStaleMs) {
          candidates.push(entry.name);
        }
      }
    }

    const claimed: string[] = [];
    for (const [index, name] of candidates.sort().entries()) {
      const source = join(directory, name);
      const target = `${path}.processing-${String(now.getTime())}-${runId}-${String(index)}`;
      try {
        await rename(source, target);
        claimed.push(target);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    return claimed;
  });
}

function addFailure(
  result: FallbackReplayResult,
  failure: FallbackReplayFailure,
): void {
  result.filesPending += 1;
  if (result.failures.length < 20) {
    result.failures.push({
      ...failure,
      message: redactText(failure.message, 500),
    });
  }
}

async function retainPendingFile(
  path: string,
  processingPath: string,
  runId: string,
  fileIndex: number,
  failedLines?: string[],
): Promise<void> {
  const pendingPath = `${path}.pending-${String(Date.now())}-${runId}-${String(fileIndex)}`;
  if (failedLines === undefined) {
    await rename(processingPath, pendingPath);
    return;
  }
  const temporaryPath = `${pendingPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${failedLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, pendingPath);
  await unlink(processingPath);
}

export async function replayFallbackSpool(
  path: string,
  client: FallbackReplayClient,
  options: FallbackReplayOptions = {},
): Promise<FallbackReplayResult> {
  const now = options.now ?? (() => new Date());
  const currentTime = now();
  const runId = randomUUID();
  const maxRecordBytes = positiveInteger(
    options.maxRecordBytes ?? DEFAULT_FALLBACK_RECORD_BYTES,
    "maxRecordBytes",
  );
  const maxReplayFileBytes = positiveInteger(
    options.maxReplayFileBytes ?? DEFAULT_FALLBACK_REPLAY_FILE_BYTES,
    "maxReplayFileBytes",
  );
  const claimed = await claimReplayFiles(path, runId, currentTime, {
    processingStaleMs: options.processingStaleMs ?? 5 * 60_000,
    lockTimeoutMs: options.lockTimeoutMs ?? 1_000,
    staleLockMs: options.staleLockMs ?? 30_000,
  });
  const result: FallbackReplayResult = {
    filesClaimed: claimed.length,
    filesCompleted: 0,
    filesPending: 0,
    records: 0,
    events: 0,
    diagnostics: 0,
    malformed: 0,
    failures: [],
  };

  for (const [fileIndex, processingPath] of claimed.entries()) {
    const segment = basename(processingPath);
    try {
      const metadata = await stat(processingPath);
      if (metadata.size > maxReplayFileBytes) {
        await retainPendingFile(path, processingPath, runId, fileIndex);
        addFailure(result, {
          segment,
          code: "replay-file-too-large",
          message: `fallback segment is ${metadata.size} bytes; replay limit is ${maxReplayFileBytes}`,
        });
        continue;
      }
      const content = await readFile(processingPath, "utf8");
      const failedLines: string[] = [];
      const lines = content.split("\n");
      for (const [lineIndex, rawLine] of lines.entries()) {
        if (rawLine.trim().length === 0) {
          continue;
        }
        result.records += 1;
        const lineNumber = lineIndex + 1;
        try {
          const rawBytes = Buffer.byteLength(rawLine);
          if (rawBytes > maxRecordBytes) {
            await client.reportDiagnostic(
              replayDiagnostic(
                rawLine,
                currentTime.toISOString(),
                "fallback.record-too-large",
                `fallback record exceeded the ${maxRecordBytes} byte replay limit`,
              ),
            );
            result.diagnostics += 1;
            result.malformed += 1;
            continue;
          }

          let untrustedRecord: unknown;
          try {
            untrustedRecord = JSON.parse(rawLine) as unknown;
          } catch {
            await client.reportDiagnostic(
              replayDiagnostic(
                rawLine,
                currentTime.toISOString(),
                "fallback.invalid-json",
                "fallback record was not valid JSON",
              ),
            );
            result.diagnostics += 1;
            result.malformed += 1;
            continue;
          }
          const parsedRecord = FallbackRecordSchema.safeParse(untrustedRecord);
          if (!parsedRecord.success) {
            await client.reportDiagnostic(
              replayDiagnostic(
                rawLine,
                currentTime.toISOString(),
                "fallback.invalid-record",
                "fallback record failed envelope validation",
              ),
            );
            result.diagnostics += 1;
            result.malformed += 1;
            continue;
          }
          const record = parsedRecord.data;
          if (record.kind === "event") {
            const parsedEvent = AgentAttentionEventV1Schema.safeParse(
              record.payload,
            );
            if (!parsedEvent.success) {
              await client.reportDiagnostic(
                replayDiagnostic(
                  rawLine,
                  record.recordedAt,
                  "fallback.invalid-event",
                  "fallback event failed protocol validation",
                ),
              );
              result.diagnostics += 1;
              result.malformed += 1;
              continue;
            }
            await client.ingest(parsedEvent.data);
            result.events += 1;
            continue;
          }

          const payload = fallbackPayloadFields(record.payload);
          await client.reportDiagnostic(
            replayDiagnostic(
              rawLine,
              record.recordedAt,
              payload.code,
              payload.message,
            ),
          );
          result.diagnostics += 1;
        } catch (error) {
          failedLines.push(rawLine);
          if (result.failures.length < 20) {
            result.failures.push({
              segment,
              line: lineNumber,
              code: "replay-send-failed",
              message: redactText(
                error instanceof Error
                  ? error.message
                  : "fallback replay failed",
                500,
              ),
            });
          }
        }
      }

      if (failedLines.length === 0) {
        await unlink(processingPath);
        result.filesCompleted += 1;
      } else {
        await retainPendingFile(
          path,
          processingPath,
          runId,
          fileIndex,
          failedLines,
        );
        result.filesPending += 1;
      }
    } catch (error) {
      try {
        await retainPendingFile(path, processingPath, runId, fileIndex);
      } catch {
        // The processing segment remains recoverable by the stale-file path.
      }
      addFailure(result, {
        segment,
        code: "replay-file-failed",
        message:
          error instanceof Error
            ? error.message
            : "fallback file replay failed",
      });
    }
  }

  return result;
}
