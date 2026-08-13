import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";
import { startDaemon } from "./daemon.js";
import type { RunningDaemon } from "./daemon.js";
import { launchWebDashboard } from "./dashboard.js";
import { readWebCredential } from "./web-credential.js";

const temporaryDirectories: string[] = [];
const daemons: RunningDaemon[] = [];

async function runtime(options: { webEnabled?: boolean } = {}) {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "agent-relay-dashboard-"),
  );
  temporaryDirectories.push(stateDirectory);
  const daemon = await startDaemon({
    databasePath: join(stateDirectory, "relay.sqlite"),
    port: 0,
    ...(options.webEnabled === undefined
      ? {}
      : { webEnabled: options.webEnabled }),
    drainIntervalMs: 60_000,
    retentionIntervalMs: 60_000,
  });
  daemons.push(daemon);
  const address = daemon.server.address() as AddressInfo;
  return {
    daemon,
    stateDirectory,
    daemonUrl: `http://127.0.0.1:${String(address.port)}`,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    daemons.splice(0).map(async (daemon) => {
      await daemon.close().catch(() => undefined);
    }),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("authenticated local dashboard launcher", () => {
  it("verifies the protected app and opens one secret-free bootstrap URL", async () => {
    const active = await runtime();
    const credential = await readWebCredential(
      join(active.stateDirectory, "web-credential.json"),
    );
    const opened: string[] = [];
    const result = await launchWebDashboard({
      daemonUrl: active.daemonUrl,
      stateDirectory: active.stateDirectory,
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(result).toEqual({
      schema: "agent-relay-dashboard-launch.v1",
      opened: true,
      url: `${active.daemonUrl}/ui/`,
      networking: "loopback-only",
    });
    expect(opened).toHaveLength(1);
    const bootstrapUrl = opened[0] ?? "";
    expect(new URL(bootstrapUrl).searchParams.get("grant")).toMatch(
      /^webboot_/u,
    );
    expect(bootstrapUrl).not.toContain(credential.token);
    expect(bootstrapUrl).not.toContain(credential.csrfToken);
    expect(JSON.stringify(result)).not.toContain("webboot_");
    expect(JSON.stringify(result)).not.toContain(credential.token);
    expect(JSON.stringify(result)).not.toContain(credential.csrfToken);
  });

  it("reports missing daemon, disabled web, and protected-app readiness failures", async () => {
    const remoteFetch = vi.fn<typeof fetch>();
    await expect(
      launchWebDashboard({
        daemonUrl: "https://dashboard.example.test",
        stateDirectory: "/synthetic/unread",
        fetch: remoteFetch,
        openBrowser: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "dashboard-loopback-required",
    });
    expect(remoteFetch).not.toHaveBeenCalled();

    await expect(
      launchWebDashboard({
        daemonUrl: "http://127.0.0.1:1",
        stateDirectory: "/synthetic/unread",
        timeoutMs: 100,
        openBrowser: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "dashboard-daemon-unavailable",
    });

    const disabled = await runtime({ webEnabled: false });
    await expect(
      launchWebDashboard({
        daemonUrl: disabled.daemonUrl,
        stateDirectory: disabled.stateDirectory,
        openBrowser: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "dashboard-web-disabled",
    });

    const incompatible = await runtime();
    const credentialPath = join(
      incompatible.stateDirectory,
      "web-credential.json",
    );
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        schema: "agent-relay-web-credential.v1",
        token: "synthetic-replaced-token-123456789012345",
        csrfToken: "synthetic-replaced-csrf-1234567890123456",
        createdAt: "2026-08-13T21:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await chmod(credentialPath, 0o600);
    await expect(
      launchWebDashboard({
        daemonUrl: incompatible.daemonUrl,
        stateDirectory: incompatible.stateDirectory,
        openBrowser: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "dashboard-app-not-ready",
    });

    const unavailableAsset = await runtime();
    await expect(
      launchWebDashboard({
        daemonUrl: unavailableAsset.daemonUrl,
        stateDirectory: unavailableAsset.stateDirectory,
        fetch: async (input, init) =>
          String(input).endsWith("/ui/app.js")
            ? new Response("not ready", { status: 503 })
            : fetch(input, init),
        openBrowser: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "dashboard-app-not-ready",
    });
  });

  it("revokes the pending grant when the isolated browser opener fails", async () => {
    const active = await runtime();
    let captured = "";
    await expect(
      launchWebDashboard({
        daemonUrl: active.daemonUrl,
        stateDirectory: active.stateDirectory,
        openBrowser: async (url) => {
          captured = url;
          throw new Error("synthetic opener failure");
        },
      }),
    ).rejects.toMatchObject({
      code: "dashboard-browser-open-failed",
      message: expect.not.stringContaining("webboot_"),
    });
    const grant = new URL(captured).searchParams.get("grant") ?? "";
    const replay = await fetch(
      `${active.daemonUrl}/v1/web/bootstrap/exchange`,
      {
        method: "POST",
        headers: {
          origin: active.daemonUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-relay-web-bootstrap-exchange.v1",
          grant,
        }),
      },
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(grant);
  });

  it("routes the CLI --web command through the canonical launcher without printing grants", async () => {
    const active = await runtime();
    const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
    const originalDaemonUrl = process.env["AGENT_RELAY_DAEMON_URL"];
    process.env["AGENT_RELAY_STATE_DIR"] = active.stateDirectory;
    process.env["AGENT_RELAY_DAEMON_URL"] = active.daemonUrl;
    let bootstrapUrl = "";
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await main(["dashboard", "--web"], {
        openBrowser: async (url) => {
          bootstrapUrl = url;
        },
      });
      expect(bootstrapUrl).toContain("grant=webboot_");
      const output = String(stdout.mock.calls[0]?.[0]);
      expect(output).toContain('"opened": true');
      expect(output).not.toContain("webboot_");
      expect(output).not.toContain("csrfToken");
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
