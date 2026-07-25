import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  observeHarnessVersions,
  runDoctor,
  TESTED_HARNESS_VERSIONS,
} from "./doctor.js";
import { installAgentRelay } from "./installer.js";

async function executable(directory: string, name: string, version: string) {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' '${version.replaceAll("'", "")}'\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

describe("doctor version and installation checks", () => {
  it("distinguishes compatible versions, drift, and missing harnesses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const codex = await executable(
      directory,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(directory, "claude", "2.2.0 (Claude Code)");
    const missingCursor = join(directory, "missing-cursor");

    expect(
      observeHarnessVersions({
        codex,
        claude,
        cursor: missingCursor,
      }),
    ).toMatchObject([
      { harness: "codex", available: true, drifted: false },
      { harness: "claude", available: true, drifted: true },
      { harness: "cursor", available: false, drifted: false },
    ]);
    const report = await runDoctor({
      executables: { codex, claude, cursor: missingCursor },
    });
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "codex", level: "pass" }),
        expect.objectContaining({ name: "claude", level: "warn" }),
        expect.objectContaining({ name: "cursor", level: "fail" }),
      ]),
    );
  });

  it("reports a complete tested-version installation as healthy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const entryPath = join(rootDir, "entry.js");
    await writeFile(entryPath, "process.exitCode = 0;\n", "utf8");
    const codex = await executable(
      rootDir,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(
      rootDir,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    );
    const cursor = await executable(
      rootDir,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    );
    await installAgentRelay({
      rootDir,
      entryPath,
      harnessVersions: TESTED_HARNESS_VERSIONS,
    });

    const report = await runDoctor({
      rootDir,
      executables: { codex, claude, cursor },
    });
    expect(report.healthy).toBe(true);
    expect(report.checks.every((check) => check.level === "pass")).toBe(true);
  });

  it("turns an unreadable installation shape into a failed diagnostic", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-relay-doctor-bad-"));
    const oversizedConfig = join(rootDir, ".codex", "hooks.json");
    await mkdir(dirname(oversizedConfig), { recursive: true });
    await writeFile(oversizedConfig, "x".repeat(1024 * 1024 + 1), "utf8");
    const codex = await executable(
      rootDir,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(
      rootDir,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    );
    const cursor = await executable(
      rootDir,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    );

    const report = await runDoctor({
      rootDir,
      executables: { codex, claude, cursor },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "installation-inspection",
        level: "fail",
        detail: expect.stringContaining("installer limit"),
      }),
    );
  });
});
