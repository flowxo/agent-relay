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
        : { details: redactValue(record.details) }),
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
