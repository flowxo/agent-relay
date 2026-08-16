import { render } from "ink";
import type { Instance } from "ink";

import { RESET_PRIVATE_MODES, restoreTerminal } from "./adapter.js";
import type { TerminalHost } from "./adapter.js";
import type { DashboardStore } from "./store.js";

export function createInkHost(
  options: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  } = {},
): TerminalHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let instance: Instance | undefined;
  let store: DashboardStore | undefined;
  let closed = false;

  const host: TerminalHost = {
    kind: "ink",
    async start(next) {
      store = next;
      try {
        stdout.write(RESET_PRIVATE_MODES);
      } catch {
        // leftover mouse modes are best-effort
      }
      if (instance !== undefined) {
        return;
      }
      const { renderInkApp } = await import("./app.js");
      instance = render(
        renderInkApp(next, {
          onQuit: () => {
            void host.destroy();
          },
        }),
        {
          stdin,
          stdout,
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: true,
        },
      );
    },
    resize(next) {
      stdout.columns = next.columns;
      stdout.rows = next.rows;
      stdout.emit("resize");
      void store;
    },
    restore() {
      restoreTerminal(stdout);
    },
    async destroy() {
      if (closed) {
        restoreTerminal(stdout);
        return;
      }
      closed = true;
      try {
        instance?.unmount();
      } catch {
        // unmount is best-effort
      }
      instance = undefined;
      restoreTerminal(stdout);
    },
  };
  return host;
}
