import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeNotificationTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

import {
  makeWebDemoEvents,
  resetWebDemoDatabase,
  seedWebDemo,
} from "./web-demo.js";
import { startDaemon } from "./daemon.js";
import { fakeOnlyTransportReadiness } from "./transport-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("credential-free local web demo data", () => {
  it("creates concurrent sanitized lanes without transcript content", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    const seed = await seedWebDemo(service, {
      now: new Date("2026-07-25T12:00:00.000Z"),
      runId: "synthetic123",
    });

    expect(seed.sessionIds).toHaveLength(5);
    expect(store.listSessions()).toHaveLength(5);
    expect(store.listPendingRequests()).toHaveLength(3);
    expect(transport.deliveries).toHaveLength(5);
    expect(
      new Set(
        store
          .listSessions(undefined, "2026-07-25T12:00:00.000Z")
          .map((session) => session.activity.state),
      ),
    ).toEqual(new Set(["working", "needs_input", "idle", "failed"]));
    const serializedDemo = JSON.stringify(
      makeWebDemoEvents({ runId: "synthetic123" }),
    );
    expect(serializedDemo).not.toContain("lastAssistantMessage");
    expect(serializedDemo).not.toContain("/synthetic-agent-relay-demo/");
    for (const forbidden of [
      "AGENT_RELAY_",
      "private transcript",
      "source code",
      "username",
      "hostname",
      "@example",
    ]) {
      expect(serializedDemo).not.toContain(forbidden);
    }
    expect(
      JSON.stringify(
        seed.eventIds.map((eventId) => store.getEvent(eventId)?.event),
      ),
    ).not.toContain("private transcript");
    store.close();
  });

  it("rejects unsafe caller-provided run identifiers", () => {
    expect(() => makeWebDemoEvents({ runId: "../../private" })).toThrow(
      "web demo run ID",
    );
  });

  it("removes a previous demo database so a restart is a fresh board", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-web-demo-reset-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "relay.sqlite");
    await writeFile(databasePath, "stale-demo");
    await writeFile(`${databasePath}-wal`, "stale-wal");
    await resetWebDemoDatabase(databasePath);
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await resetWebDemoDatabase(databasePath);
  });

  it("keeps provider configuration out of demo status, UI, and logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-web-demo-"));
    temporaryDirectories.push(root);
    const hostileEnvironment = {
      AGENT_RELAY_TELEGRAM_TOKEN: "synthetic-demo-private-token",
      AGENT_RELAY_WEBHOOK_URL: "https://private-demo-host.example.test/events",
      AGENT_RELAY_WEBHOOK_SECRET: "synthetic-demo-private-secret",
      AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL:
        "synthetic-demo-private-credential",
    };
    const originalEnvironment = Object.fromEntries(
      Object.keys(hostileEnvironment).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, hostileEnvironment);
    const selection = {
      configured: true as const,
      selected: "fake" as const,
      source: "command-line" as const,
    };
    const logger = new MemoryLogger();
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        databasePath: join(root, "relay.sqlite"),
        port: 0,
        selectedTransport: "fake",
        transportSelection: selection,
        transportReadiness: fakeOnlyTransportReadiness(selection),
        logger,
      });
      await seedWebDemo(daemon.service, { runId: "synthetic123" });
      const address = daemon.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("synthetic demo daemon did not bind");
      }
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      const status = await (await fetch(`${baseUrl}/v1/status`)).text();
      const ui = await (await fetch(`${baseUrl}/ui/`)).text();
      const serialized = JSON.stringify({ status, ui, logs: logger.records });
      expect(status).toContain('"selectedTransport":"fake"');
      for (const sentinel of Object.values(hostileEnvironment)) {
        expect(serialized).not.toContain(sentinel);
      }
      expect(serialized).not.toContain("private-demo-host.example.test");
    } finally {
      await daemon?.close();
      for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
