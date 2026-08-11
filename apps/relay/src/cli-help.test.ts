import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("CLI help boundary", () => {
  it("keeps every top-level help flag inert", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-help-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "state");
    const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
    process.env["AGENT_RELAY_STATE_DIR"] = stateDirectory;
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      for (const command of [
        "daemon",
        "web-demo",
        "hook",
        "run",
        "status",
        "drain",
        "replay-fallback",
        "maintain",
        "install",
        "uninstall",
        "doctor",
        "capabilities",
        "canary",
        "telegram-canary",
        "whooshbang-canary",
        "webhook-canary",
        "webhook",
        "whooshbang",
        "runner-bridge",
        "transport",
      ]) {
        for (const helpFlag of ["--help", "-h"]) {
          output.mockClear();
          await main([command, helpFlag]);
          expect(output).toHaveBeenCalledTimes(1);
          expect(String(output.mock.calls[0]?.[0])).toContain("Usage:");
          expect(existsSync(stateDirectory)).toBe(false);
        }
      }

      for (const helpFlag of ["--help", "-h"]) {
        output.mockClear();
        await main([helpFlag]);
        expect(String(output.mock.calls[0]?.[0])).toContain("Usage:");
        expect(existsSync(stateDirectory)).toBe(false);
      }
    } finally {
      if (originalStateDirectory === undefined) {
        delete process.env["AGENT_RELAY_STATE_DIR"];
      } else {
        process.env["AGENT_RELAY_STATE_DIR"] = originalStateDirectory;
      }
    }
  });
});
