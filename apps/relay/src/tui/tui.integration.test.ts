import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../daemon.js";
import type { RunningDaemon } from "../daemon.js";
import { makeWebDemoEvents } from "../web-demo.js";
import { readWebCredential } from "../web-credential.js";

import { createDashboardClient } from "./client.js";
import { containsSecret, renderDashboardFrame } from "./frame.js";
import { DashboardStore } from "./store.js";

const daemons: RunningDaemon[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    daemons
      .splice(0)
      .map(async (daemon) => daemon.close().catch(() => undefined)),
  );
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("terminal dashboard integration", () => {
  it("consumes the protected project API and keeps frames secret-free", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "agent-relay-tui-"));
    directories.push(stateDirectory);
    const daemon = await startDaemon({
      databasePath: join(stateDirectory, "relay.sqlite"),
      port: 0,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    daemons.push(daemon);
    const seeded = makeWebDemoEvents({ runId: "tuiinteg01" });
    for (const event of seeded.events) {
      daemon.service.ingest(event);
    }
    await daemon.service.drain(seeded.events.length);
    const address = daemon.server.address() as AddressInfo;
    const credential = await readWebCredential(
      join(stateDirectory, "web-credential.json"),
    );
    const client = await createDashboardClient({
      daemonUrl: `http://127.0.0.1:${String(address.port)}`,
      stateDirectory,
    });
    const store = new DashboardStore({ client, pollIntervalMs: 60_000 });
    await store.start();
    const frame = renderDashboardFrame(store.state, 80, 24);
    expect(store.state.connection).toBe("online");
    expect(frame).toContain("All projects");
    expect(frame).toContain("Needs attention");
    expect(
      containsSecret(frame, [
        credential.token,
        credential.csrfToken,
        "/synthetic-agent-relay-demo",
        "webboot_",
      ]),
    ).toBe(false);
    if (store.state.selectedRequest !== undefined) {
      store.openForm(store.state.selectedRequest);
      if (store.state.selectedRequest.form?.kind === "text") {
        store.updateDraft({ value: "synthetic tui answer" });
        await store.submitForm();
        expect(store.state.status).toMatch(
          /Answer committed|already resolved|stale|could not/u,
        );
      }
    }
    await store.close();
  });

  it("keeps the last snapshot visible after the daemon disconnects", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "agent-relay-tui-"));
    directories.push(stateDirectory);
    const daemon = await startDaemon({
      databasePath: join(stateDirectory, "relay.sqlite"),
      port: 0,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    daemons.push(daemon);
    const seeded = makeWebDemoEvents({ runId: "tuidisc01" });
    for (const event of seeded.events) {
      daemon.service.ingest(event);
    }
    await daemon.service.drain(seeded.events.length);
    const address = daemon.server.address() as AddressInfo;
    const client = await createDashboardClient({
      daemonUrl: `http://127.0.0.1:${String(address.port)}`,
      stateDirectory,
    });
    const store = new DashboardStore({ client, pollIntervalMs: 40 });
    await store.start();
    expect(store.state.connection).toBe("online");
    await daemon.close();
    const started = Date.now();
    while (store.state.connection === "online") {
      if (Date.now() - started > 5_000) {
        throw new Error("store stayed online after the daemon closed");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(store.state.connection).toBe("reconnecting");
    const frame = renderDashboardFrame(store.state, 80, 24);
    expect(frame).toContain("reconnecting");
    expect(frame).toContain("All projects");
    expect(frame).toContain("last safe snapshot");
    await store.close();
  });
});
