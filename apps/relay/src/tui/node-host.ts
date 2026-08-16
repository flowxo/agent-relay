import { renderDashboardFrame } from "./frame.js";
import { attachDashboardInput } from "./input.js";
import { enterAlternateScreen, restoreTerminal } from "./adapter.js";
import type { TerminalHost, TerminalSize } from "./adapter.js";
import type { DashboardStore } from "./store.js";

/** Test-only host. Production dashboard uses Ink. */

export function createNodeHost(
  options: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  } = {},
): TerminalHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let store: DashboardStore | undefined;
  let size: TerminalSize = {
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  };
  let raw = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;

  const paint = () => {
    if (store === undefined || closed) return;
    stdout.write("\x1b[H\x1b[J");
    stdout.write(renderDashboardFrame(store.state, size.columns, size.rows));
  };

  const onResize = () => {
    size = {
      columns: stdout.columns ?? size.columns,
      rows: stdout.rows ?? size.rows,
    };
    paint();
  };

  const host: TerminalHost = {
    kind: "node-host",
    async start(next) {
      store = next;
      enterAlternateScreen(stdout);
      if (stdin.isTTY === true && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
        raw = true;
      }
      stdin.resume();
      unsubscribe = next.subscribe(paint);
      const detachInput = attachDashboardInput(
        stdin,
        () => (closed ? undefined : store),
        () => {
          void host.destroy();
        },
      );
      const previousUnsubscribe = unsubscribe;
      unsubscribe = () => {
        detachInput();
        previousUnsubscribe?.();
      };
      stdout.on("resize", onResize);
      paint();
    },
    resize(next) {
      size = next;
      paint();
    },
    restore() {
      if (raw && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          // already restored
        }
        raw = false;
      }
      restoreTerminal(stdout);
    },
    async destroy() {
      if (closed) {
        this.restore();
        return;
      }
      closed = true;
      unsubscribe?.();
      stdout.off("resize", onResize);
      this.restore();
    },
  };
  return host;
}
