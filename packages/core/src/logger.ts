import { redactText } from "./redaction.js";

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

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value, 2_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/token|secret|credential|authorization/i.test(key))
        .slice(0, 40)
        .map(([key, child]) => [key, sanitizeValue(child)]),
    );
  }
  return value;
}

export class JsonLineLogger implements RelayLogger {
  public constructor(
    private readonly stream: Pick<
      NodeJS.WritableStream,
      "write"
    > = process.stderr,
  ) {}

  public log(record: LogRecord): void {
    const safeRecord = {
      ...record,
      message: redactText(record.message, 2_000),
      ...(record.details === undefined
        ? {}
        : { details: sanitizeValue(record.details) }),
    };
    this.stream.write(`${JSON.stringify(safeRecord)}\n`);
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
