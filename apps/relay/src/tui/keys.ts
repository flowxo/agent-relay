export type DashboardKey =
  | { name: "up" }
  | { name: "down" }
  | { name: "left" }
  | { name: "right" }
  | { name: "tab" }
  | { name: "enter" }
  | { name: "escape" }
  | { name: "backspace" }
  | { name: "space" }
  | { name: "quit" }
  | { name: "char"; value: string };

export const HELP_LINES = [
  "Keyboard",
  "Screen readers are an explicit current limitation.",
  "  ↑↓ / j k     Move in the focused list",
  "  ←→ / h l     Move between projects, list, and detail",
  "  Tab          Cycle focus",
  "  Enter        Select project, open detail, or submit",
  "  /            Search sessions; Esc leaves and clears",
  "  p            Focus the project list",
  "  r            Refresh or reconnect",
  "  n            Load more recent history",
  "  a            Answer the selected question",
  "  c / m / e    Continue, mute, or end when proven",
  "  u            Apply waiting updates",
  "  ?            Toggle this help",
  "  Esc          Leave help, detail, or an unsent answer; clear filter",
  "  q            Quit, except while typing an answer or filter",
  "  Ctrl-C       Always quit and restore the terminal",
  "Answers bind to the exact pending interaction and session.",
  "A second submit is ignored while one is in flight.",
  "Native permission authorization stays on the protected path.",
  "Screen readers are an explicit current limitation.",
] as const;

export function mapInkKey(
  input: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    eventType?: "press" | "repeat" | "release";
  },
): DashboardKey | undefined {
  if (key.eventType === "release") {
    return undefined;
  }
  if (key.ctrl === true && input === "c") {
    return { name: "quit" };
  }
  if (key.upArrow === true) return { name: "up" };
  if (key.downArrow === true) return { name: "down" };
  if (key.leftArrow === true) return { name: "left" };
  if (key.rightArrow === true) return { name: "right" };
  if (key.return === true) return { name: "enter" };
  if (key.escape === true) return { name: "escape" };
  if (key.tab === true) return { name: "tab" };
  if (key.backspace === true || key.delete === true) {
    return { name: "backspace" };
  }
  if (input === " ") return { name: "space" };
  if (input.length === 1) return { name: "char", value: input };
  return undefined;
}

export function parseKey(chunk: Buffer | string): DashboardKey[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: DashboardKey[] = [];
  let index = 0;
  while (index < text.length) {
    const current = text[index] ?? "";
    if (current === "\x1b") {
      const sequence = text.slice(index, index + 3);
      if (sequence === "\x1b[A" || sequence === "\x1bOA") {
        keys.push({ name: "up" });
        index += 3;
        continue;
      }
      if (sequence === "\x1b[B" || sequence === "\x1bOB") {
        keys.push({ name: "down" });
        index += 3;
        continue;
      }
      if (sequence === "\x1b[C" || sequence === "\x1bOC") {
        keys.push({ name: "right" });
        index += 3;
        continue;
      }
      if (sequence === "\x1b[D" || sequence === "\x1bOD") {
        keys.push({ name: "left" });
        index += 3;
        continue;
      }
      if (text[index + 1] === "[") {
        let end = index + 2;
        while (end < text.length && !/[@-~]/.test(text[end] ?? "")) {
          end += 1;
        }
        if (end >= text.length) break;
        index = end + 1;
        continue;
      }
      keys.push({ name: "escape" });
      index += 1;
      continue;
    }
    if (current === "\r" || current === "\n") keys.push({ name: "enter" });
    else if (current === "\t") keys.push({ name: "tab" });
    else if (current === "\x7f" || current === "\b")
      keys.push({ name: "backspace" });
    else if (current === " ") keys.push({ name: "space" });
    else if (current === "\x03") keys.push({ name: "quit" });
    else if (current.length > 0) keys.push({ name: "char", value: current });
    index += 1;
  }
  return keys;
}
