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
        "mcp",
        "status",
        "dashboard",
        "drain",
        "replay-fallback",
        "maintain",
        "install",
        "uninstall",
        "integrations",
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

  it("rejects malformed integration lifecycle options before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-options-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "state");
    const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
    process.env["AGENT_RELAY_STATE_DIR"] = stateDirectory;
    try {
      for (const args of [
        ["integrations", "install", "--root"],
        [
          "integrations",
          "install",
          "--harness",
          "codex",
          "--harness",
          "cursor",
        ],
        ["integrations", "repair", "--unknown"],
      ]) {
        await expect(main(args)).rejects.toThrow();
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

  it("keeps version, dashboard inspection, and dashboard help credential-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-inert-info-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "state");
    const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
    const originalDaemonUrl = process.env["AGENT_RELAY_DAEMON_URL"];
    process.env["AGENT_RELAY_STATE_DIR"] = stateDirectory;
    process.env["AGENT_RELAY_DAEMON_URL"] = "http://127.0.0.1:4317";
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const openBrowser = vi.fn(async () => {
      throw new Error("informational command attempted browser launch");
    });
    try {
      await main(["--version"], { openBrowser });
      await main(["dashboard", "--json"], { openBrowser });
      await main(["dashboard", "--web", "--help"], { openBrowser });
      expect(
        output.mock.calls.map(([value]) => String(value)).join("\n"),
      ).toContain("agent-relay dashboard --web");
      expect(openBrowser).not.toHaveBeenCalled();
      expect(existsSync(stateDirectory)).toBe(false);
    } finally {
      if (originalStateDirectory === undefined) {
        delete process.env["AGENT_RELAY_STATE_DIR"];
      } else {
        process.env["AGENT_RELAY_STATE_DIR"] = originalStateDirectory;
      }
      if (originalDaemonUrl === undefined) {
        delete process.env["AGENT_RELAY_DAEMON_URL"];
      } else {
        process.env["AGENT_RELAY_DAEMON_URL"] = originalDaemonUrl;
      }
    }
  });
});
