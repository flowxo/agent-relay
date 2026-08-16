import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  ALTERNATE_SCREEN_ENTER,
  ALTERNATE_SCREEN_LEAVE,
  RESET_PRIVATE_MODES,
  enterAlternateScreen,
  restoreTerminal,
} from "./adapter.js";
import { parseKey } from "./keys.js";
import { attachDashboardInput, handleDashboardKey } from "./input.js";
import { launchTerminalDashboard } from "./launch.js";
import { DashboardStore } from "./store.js";
import type { TerminalHost } from "./adapter.js";
import type { DashboardClient } from "./client.js";

function fakeClient(): DashboardClient {
  return {
    origin: "http://127.0.0.1:4317",
    loadSnapshot: async () => {
      throw new Error("client should not load in restore tests");
    },
    pollChanges: async () => {
      throw new Error("unused");
    },
    loadEvent: async () => {
      throw new Error("unused");
    },
    resolveRequest: async () => ({ ok: false, status: 0 }),
    runSessionAction: async () => ({ ok: false, status: 0 }),
  };
}

describe("terminal restore and keys", () => {
  it("parses arrows, quit, and submit keys", () => {
    expect(parseKey("\x1b[A")).toEqual([{ name: "up" }]);
    expect(parseKey("q")).toEqual([{ name: "char", value: "q" }]);
    expect(parseKey("\r")).toEqual([{ name: "enter" }]);
    expect(parseKey("\x03")).toEqual([{ name: "quit" }]);
    expect(parseKey("\x1bOA")).toEqual([{ name: "up" }]);
    expect(parseKey("\x1b[<0;10;20M")).toEqual([]);
  });

  it("disables leftover mouse tracking before entering the alternate screen", () => {
    const writes: string[] = [];
    const output = {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    enterAlternateScreen(output);
    expect(writes.join("")).toContain(RESET_PRIVATE_MODES);
    expect(writes.join("")).toContain(ALTERNATE_SCREEN_ENTER);
  });

  it("restores alternate screen and cursor even when raw mode throws", () => {
    const writes: string[] = [];
    const output = {
      isTTY: true,
      setRawMode: () => {
        throw new Error("already closed");
      },
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    restoreTerminal(output);
    expect(writes.join("")).toContain(ALTERNATE_SCREEN_LEAVE);
    expect(writes.join("")).toContain("\x1b[?25h");
  });

  it("quits from stdin q through the shared input attachment", async () => {
    const store = new DashboardStore({
      client: fakeClient(),
      pollIntervalMs: 60_000,
    });
    const stdin = new EventEmitter();
    let quit = false;
    const detach = attachDashboardInput(
      stdin as unknown as NodeJS.ReadStream,
      () => store,
      () => {
        quit = true;
      },
    );
    stdin.emit("data", "q");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(quit).toBe(true);
    detach();
    await store.close();
  });

  it("quits from the q key without submitting an answer", async () => {
    const store = new DashboardStore({
      client: fakeClient(),
      pollIntervalMs: 60_000,
    });
    expect(await handleDashboardKey(store, { name: "char", value: "q" })).toBe(
      "quit",
    );
    await store.close();
  });

  it("leaves filter on escape and still moves the session list with arrows", async () => {
    const store = new DashboardStore({
      client: fakeClient(),
      pollIntervalMs: 60_000,
    });
    store.state.list = [
      { section: "attention", sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      { section: "current", sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb" },
    ];
    expect(await handleDashboardKey(store, { name: "char", value: "/" })).toBe(
      "continue",
    );
    expect(store.state.pane).toBe("filter");
    expect(await handleDashboardKey(store, { name: "down" })).toBe("continue");
    expect(store.state.listIndex).toBe(1);
    store.state.query = "c";
    expect(await handleDashboardKey(store, { name: "escape" })).toBe(
      "continue",
    );
    expect(store.state.pane).toBe("list");
    expect(store.state.query).toBe("");
    await store.close();
  });

  it("moves focus to the project rail and back to the session list", async () => {
    const store = new DashboardStore({
      client: fakeClient(),
      pollIntervalMs: 60_000,
    });
    store.state.rail = [
      {
        projectKey: "all",
        label: "All projects",
        attentionCount: 0,
        currentCount: 0,
        recentCount: 0,
        totalCount: 0,
        selected: true,
      },
      {
        projectKey: `prj_${"c".repeat(48)}`,
        label: "checkout-service",
        attentionCount: 0,
        currentCount: 1,
        recentCount: 0,
        totalCount: 1,
        selected: false,
      },
    ];
    expect(await handleDashboardKey(store, { name: "left" })).toBe("continue");
    expect(store.state.pane).toBe("rail");
    expect(await handleDashboardKey(store, { name: "down" })).toBe("continue");
    expect(store.state.railIndex).toBe(1);
    expect(await handleDashboardKey(store, { name: "right" })).toBe("continue");
    expect(store.state.pane).toBe("list");
    expect(await handleDashboardKey(store, { name: "right" })).toBe("continue");
    expect(store.state.pane).toBe("detail");
    expect(store.state.detailOpen).toBe(true);
    expect(await handleDashboardKey(store, { name: "left" })).toBe("continue");
    expect(store.state.pane).toBe("list");
    await store.close();
  });

  it("always quits on Ctrl-C even while an answer form is open", async () => {
    const store = new DashboardStore({
      client: fakeClient(),
      pollIntervalMs: 60_000,
    });
    store.state.pane = "form";
    expect(await handleDashboardKey(store, { name: "quit" })).toBe("quit");
    await store.close();
  });

  it("does not open the test-only node host as a production fallback", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    await expect(
      launchTerminalDashboard({
        daemonUrl: "http://127.0.0.1:4317",
        stateDirectory: "/synthetic/unread",
        host: "node-host",
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        client: fakeClient(),
      }),
    ).rejects.toMatchObject({ code: "dashboard-tui-runtime-unavailable" });
  });

  it("refuses to open the TUI without a TTY", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const stdout = Object.assign(new PassThrough(), { isTTY: false });
    await expect(
      launchTerminalDashboard({
        daemonUrl: "http://127.0.0.1:4317",
        stateDirectory: "/synthetic/unread",
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        client: fakeClient(),
      }),
    ).rejects.toMatchObject({ code: "dashboard-tty-required" });
  });

  it("restores the terminal on the injected host destroy path", async () => {
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
    let host: TerminalHost | undefined;
    const result = launchTerminalDashboard({
      daemonUrl: "http://127.0.0.1:4317",
      stateDirectory: "/synthetic/unread",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      client: {
        ...fakeClient(),
        loadSnapshot: async () => ({
          snapshot: {
            schema: "agent-relay-project-read.v1",
            generatedAt: "2026-08-14T12:00:00.000Z",
            selectedProjectKey: "all",
            filters: {},
            changeCursor: "cursor_tui_empty_0001",
            projects: {
              all: {
                schema: "agent-relay-project-summary.v1",
                projectKey: "all",
                label: "All projects",
                currentCount: 0,
                needsAttentionCount: 0,
                needsInputCount: 0,
                failedOrUnknownCount: 0,
                recentCount: 0,
                totalCount: 0,
              },
              items: [],
              totalCount: 0,
              truncated: false,
            },
            needsAttention: [],
            currentByHarness: [],
            recent: { items: [] },
            empty: true,
            limits: {
              historyPageSize: 25,
              historyPageSizeMax: 100,
              completeSetMax: 1_000,
              projectSummaryMax: 200,
              changeBatchMax: 200,
            },
          },
          requests: [],
          capabilities: new Map(),
        }),
        pollChanges: async () => ({
          schema: "agent-relay-project-changes.v1",
          cursor: "cursor_tui_empty_0001",
          invalidations: [],
          hasMore: false,
        }),
      },
      createHost: async () => {
        host = {
          kind: "node-host",
          start: async () => undefined,
          resize: () => undefined,
          restore: () => {
            writes.push(ALTERNATE_SCREEN_LEAVE);
          },
          destroy: async () => {
            host?.restore();
          },
        };
        return host;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host?.destroy();
    const opened = await result;
    expect(opened.host).toBe("node-host");
    expect(writes.join("")).toContain(ALTERNATE_SCREEN_LEAVE);
    expect(writes.join("")).not.toContain(ALTERNATE_SCREEN_ENTER);
  });
});
