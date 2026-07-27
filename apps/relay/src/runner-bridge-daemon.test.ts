import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DaemonRunnerBridge } from "./daemon.js";
import { startDaemon } from "./daemon.js";

const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-bridge-daemon-"));
  directories.push(directory);
  return join(directory, "relay.sqlite");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fakeRuntime(): DaemonRunnerBridge & {
  setStandaloneSessionAuthority: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    setStandaloneSessionAuthority: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    status: () => ({ enabled: true, state: "ready", bindingCount: 1 }),
  };
}

describe("runner bridge daemon composition", () => {
  test("is absent and disabled on the standalone path", async () => {
    const daemon = await startDaemon({
      databasePath: await databasePath(),
      port: 0,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("daemon address is unavailable");
    }
    const status = await (
      await fetch(`http://127.0.0.1:${String(address.port)}/v1/status`)
    ).json();
    expect(status).toMatchObject({
      runnerBridge: { enabled: false, state: "disabled" },
      transport: "fake-telegram",
    });
    await daemon.close();
  });

  test("requires explicit enablement and an injected runtime together", async () => {
    const runtime = fakeRuntime();
    await expect(
      startDaemon({
        databasePath: await databasePath(),
        port: 0,
        runnerBridge: runtime,
      }),
    ).rejects.toThrow("requires explicit enablement");
    await expect(
      startDaemon({
        databasePath: await databasePath(),
        port: 0,
        runnerBridgeEnabled: true,
      }),
    ).rejects.toThrow("no structured harness adapter");
    expect(runtime.start).not.toHaveBeenCalled();
  });

  test("starts, reports, and stops only an explicitly injected runtime", async () => {
    const runtime = fakeRuntime();
    const daemon = await startDaemon({
      databasePath: await databasePath(),
      port: 0,
      runnerBridgeEnabled: true,
      runnerBridge: runtime,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    expect(runtime.setStandaloneSessionAuthority).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(
      runtime.setStandaloneSessionAuthority.mock.invocationCallOrder[0],
    ).toBeLessThan(runtime.start.mock.invocationCallOrder[0]!);
    const address = daemon.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("daemon address is unavailable");
    }
    await expect(
      (
        await fetch(`http://127.0.0.1:${String(address.port)}/v1/status`)
      ).json(),
    ).resolves.toMatchObject({
      runnerBridge: { enabled: true, state: "ready", bindingCount: 1 },
    });
    await daemon.close();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });
});
