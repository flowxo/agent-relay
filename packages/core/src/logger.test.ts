import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CompositeLogger, MemoryLogger, RotatingFileLogger } from "./logger.js";
import { redactDiagnosticText } from "./redaction.js";

describe("bounded structured logging", () => {
  it("redacts, rotates, and applies private file modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-logger-"));
    const path = join(directory, "relay.ndjson");
    const logger = new RotatingFileLogger(path, {
      maxBytes: 1_024,
      maxFiles: 3,
    });
    for (let index = 0; index < 20; index += 1) {
      logger.log({
        level: "info",
        code: "synthetic.log",
        message: `record ${String(index)} ${"x".repeat(180)}`,
        at: new Date(1_700_000_000_000 + index).toISOString(),
      });
    }
    const secret = "sk-syntheticSecretToken123456789";
    logger.log({
      level: "error",
      code: "synthetic.secret",
      message: `failure included ${secret}`,
      at: "2026-07-24T12:00:00.000Z",
    });

    const names = (await readdir(directory)).filter((name) =>
      name.startsWith("relay.ndjson"),
    );
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names).toContain("relay.ndjson");
    const contents = await Promise.all(
      names.map(async (name) => {
        expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
        return await readFile(join(directory, name), "utf8");
      }),
    );
    expect(contents.join("")).not.toContain(secret);
    expect(contents.join("")).toContain("[REDACTED_OPENAI_KEY]");
  });

  it("surfaces file failures through a fallback logger", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-logger-failure-"),
    );
    const fallback = new MemoryLogger();
    const logger = new RotatingFileLogger(directory, {
      maxBytes: 1_024,
      maxFiles: 2,
      fallbackLogger: fallback,
    });
    const memory = new MemoryLogger();
    new CompositeLogger([memory, logger]).log({
      level: "info",
      code: "synthetic.failure",
      message: "write this record",
      at: "2026-07-24T12:00:00.000Z",
    });

    expect(memory.records).toHaveLength(1);
    expect(fallback.records).toEqual([
      expect.objectContaining({
        level: "error",
        code: "log.file-write-failed",
      }),
    ]);
  });

  it("removes secrets and machine-specific paths from diagnostic exports", () => {
    const secret = "sk-syntheticDiagnosticSecret123456";
    const value = redactDiagnosticText(
      `failed at /Users/operator/private/project/file.ts with ${secret} and C:\\Users\\operator\\private.txt`,
      500,
    );

    expect(value).not.toContain(secret);
    expect(value).not.toContain("/Users/operator");
    expect(value).not.toContain("C:\\Users\\operator");
    expect(value).toContain("[REDACTED_OPENAI_KEY]");
    expect(value.match(/\[REDACTED_PATH\]/g)).toHaveLength(2);
  });
});
