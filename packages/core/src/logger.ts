import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname } from "node:path";

import { redactText, redactValue } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  code: string;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface RelayLogger {
  log(record: LogRecord): void;
}

export function serializeLogRecord(record: LogRecord): string {
  const safeRecord = {
    ...record,
    message: redactText(record.message, 2_000),
    ...(record.details === undefined
      ? {}
      : { details: redactValue(record.details) }),
  };
  return `${JSON.stringify(safeRecord)}\n`;
}

export class JsonLineLogger implements RelayLogger {
  public constructor(
    private readonly stream: Pick<
      NodeJS.WritableStream,
      "write"
    > = process.stderr,
  ) {}

  public log(record: LogRecord): void {
    this.stream.write(serializeLogRecord(record));
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export interface RotatingFileLoggerOptions {
  maxBytes?: number;
  maxFiles?: number;
  fallbackLogger?: RelayLogger;
}

export class RotatingFileLogger implements RelayLogger {
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly fallbackLogger: RelayLogger;

  public constructor(
    private readonly path: string,
    options: RotatingFileLoggerOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.fallbackLogger = options.fallbackLogger ?? new JsonLineLogger();
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1_024) {
      throw new Error("rotating log maxBytes must be at least 1024");
    }
    if (
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 100
    ) {
      throw new Error("rotating log maxFiles must be between 1 and 100");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  private rotate(): void {
    if (this.maxFiles === 1) {
      try {
        unlinkSync(this.path);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
      return;
    }
    try {
      unlinkSync(`${this.path}.${String(this.maxFiles - 1)}`);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      try {
        renameSync(
          `${this.path}.${String(index)}`,
          `${this.path}.${String(index + 1)}`,
        );
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  public log(record: LogRecord): void {
    const line = serializeLogRecord(record);
    try {
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.path, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.fallbackLogger.log({
        level: "error",
        code: "log.file-write-failed",
        message:
          error instanceof Error ? error.message : "rotating log write failed",
        at: new Date().toISOString(),
        details: { file: basename(this.path) },
      });
    }
  }
}

export class CompositeLogger implements RelayLogger {
  public constructor(private readonly loggers: readonly RelayLogger[]) {
    if (loggers.length === 0) {
      throw new Error("composite logger requires at least one logger");
    }
  }

  public log(record: LogRecord): void {
    for (const logger of this.loggers) {
      logger.log(record);
    }
  }
}

export class MemoryLogger implements RelayLogger {
  public readonly records: LogRecord[] = [];

  public log(record: LogRecord): void {
    this.records.push(record);
  }
}

export const NOOP_LOGGER: RelayLogger = {
  log: () => undefined,
};
