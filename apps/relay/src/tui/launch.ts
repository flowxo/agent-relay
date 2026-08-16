import { DashboardLaunchError } from "../dashboard.js";

import { restoreTerminal } from "./adapter.js";
import type { TerminalHost, TerminalHostKind } from "./adapter.js";
import { createDashboardClient } from "./client.js";
import type { DashboardClient } from "./client.js";
import { createInkHost } from "./ink-host.js";
import { DashboardStore } from "./store.js";

export interface TerminalDashboardOptions {
  daemonUrl: string;
  stateDirectory: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  webCredentialPath?: string;
  host?: TerminalHostKind | "auto";
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  client?: DashboardClient;
  createHost?: (kind: TerminalHostKind) => Promise<TerminalHost>;
}

export interface TerminalDashboardResult {
  schema: "agent-relay-dashboard-tui.v1";
  opened: true;
  host: TerminalHostKind;
  networking: "loopback-only";
}

async function selectHost(
  preferred: TerminalHostKind | "auto",
  options: TerminalDashboardOptions,
): Promise<TerminalHost> {
  if (options.createHost !== undefined) {
    const kind = preferred === "auto" ? "ink" : preferred;
    return await options.createHost(kind);
  }
  if (preferred === "node-host") {
    throw new DashboardLaunchError(
      "dashboard-tui-runtime-unavailable",
      "The in-process host is test-only. The terminal dashboard requires Ink.",
    );
  }
  return createInkHost({
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
  });
}

export async function launchTerminalDashboard(
  options: TerminalDashboardOptions,
): Promise<TerminalDashboardResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new DashboardLaunchError(
      "dashboard-tty-required",
      "The terminal dashboard needs an interactive TTY. Use agent-relay dashboard --json for scripts, or agent-relay dashboard --web for the browser.",
    );
  }

  const client =
    options.client ??
    (await createDashboardClient({
      daemonUrl: options.daemonUrl,
      stateDirectory: options.stateDirectory,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.webCredentialPath === undefined
        ? {}
        : { webCredentialPath: options.webCredentialPath }),
    }));

  const host = await selectHost(options.host ?? "auto", options);
  const store = new DashboardStore({
    client,
    renderer: host.kind,
  });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      host.restore();
    } catch {
      restoreTerminal(stdout);
    }
  };

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = () => {
    restore();
    void store.close();
    void host.destroy();
  };
  const onSuspend = () => {
    restore();
    process.kill(process.pid, "SIGTSTP");
  };
  const onContinue = () => {
    restored = false;
    void host.start(store);
  };
  const onExit = () => {
    restore();
  };
  const onCrash = () => {
    restore();
    void store.close();
    void host.destroy();
  };

  for (const signal of signals) {
    process.on(signal, onSignal);
  }
  process.on("SIGTSTP", onSuspend);
  process.on("SIGCONT", onContinue);
  process.on("exit", onExit);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  try {
    await store.start();
    await host.start(store);
    await new Promise<void>((resolve) => {
      const stop = () => {
        store.subscribe(() => undefined);
        resolve();
      };
      const previousDestroy = host.destroy.bind(host);
      host.destroy = async () => {
        await previousDestroy();
        stop();
      };
    });
    return {
      schema: "agent-relay-dashboard-tui.v1",
      opened: true,
      host: host.kind,
      networking: "loopback-only",
    };
  } finally {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
    process.off("SIGTSTP", onSuspend);
    process.off("SIGCONT", onContinue);
    process.off("exit", onExit);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
    await store.close();
    await host.destroy();
    restore();
  }
}

export function dashboardEntry(daemonUrl: string): {
  schema: "agent-relay-dashboard-entry.v1";
  url: string;
  networking: "loopback-only";
  instruction: string;
} {
  return {
    schema: "agent-relay-dashboard-entry.v1",
    url: `${daemonUrl}/ui/`,
    networking: "loopback-only",
    instruction:
      "Run agent-relay dashboard for the terminal UI, agent-relay dashboard --web for a browser session, or agent-relay dashboard --json for this machine-readable entry.",
  };
}
