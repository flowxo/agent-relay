import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../daemon.js";
import type { RunningDaemon } from "../daemon.js";
import { makeWebDemoEvents } from "../web-demo.js";
import { readWebCredential } from "../web-credential.js";

import { ALTERNATE_SCREEN_ENTER, ALTERNATE_SCREEN_LEAVE } from "./adapter.js";
import { createDashboardClient } from "./client.js";
import { createNodeHost } from "./node-host.js";
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

function ttyPair() {
  const writes: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    resume: () => undefined,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (value: string) => {
      writes.push(String(value));
      return true;
    },
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    writes,
    emit(data: string) {
      stdin.emit("data", data);
    },
  };
}

describe("terminal dashboard host restore", () => {
  it("enters and leaves the alternate screen without leaking the credential", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "agent-relay-tui-pty-"),
    );
    directories.push(stateDirectory);
    const daemon = await startDaemon({
      databasePath: join(stateDirectory, "relay.sqlite"),
      port: 0,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    daemons.push(daemon);
    const seeded = makeWebDemoEvents({ runId: "tuiptry01" });
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
    const pair = ttyPair();
    const host = createNodeHost({ stdin: pair.stdin, stdout: pair.stdout });
    await store.start();
    await host.start(store);
    pair.emit("q");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.destroy();
    await store.close();
    const output = pair.writes.join("");
    expect(output).toContain(ALTERNATE_SCREEN_ENTER);
    expect(output).toContain(ALTERNATE_SCREEN_LEAVE);
    expect(output).toMatch(/All projects|Needs attention|online/u);
    expect(output).not.toContain(credential.token);
    expect(output).not.toContain(credential.csrfToken);
  });
});
