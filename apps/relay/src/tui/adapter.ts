import type { DashboardStore } from "./store.js";

export type TerminalHostKind = "ink" | "node-host";

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalHost {
  kind: TerminalHostKind;
  start(store: DashboardStore): Promise<void>;
  resize(size: TerminalSize): void;
  restore(): void;
  destroy(): Promise<void>;
}

export const ALTERNATE_SCREEN_ENTER = "\x1b[?1049h";
export const ALTERNATE_SCREEN_LEAVE = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const RESET_PRIVATE_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b[<u";

export function restoreTerminal(
  output: NodeJS.WriteStream = process.stdout,
): void {
  try {
    if (
      process.stdin.isTTY === true &&
      typeof process.stdin.setRawMode === "function"
    ) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // stdin may already be closed.
  }
  try {
    output.write(
      `${SHOW_CURSOR}${RESET_PRIVATE_MODES}${ALTERNATE_SCREEN_LEAVE}`,
    );
  } catch {
    // Best-effort restore on the crash path.
  }
}

export function enterAlternateScreen(
  output: NodeJS.WriteStream = process.stdout,
): void {
  output.write(
    `${RESET_PRIVATE_MODES}${ALTERNATE_SCREEN_ENTER}${HIDE_CURSOR}`,
  );
}
