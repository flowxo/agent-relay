export type Tone =
  | "default"
  | "dim"
  | "focus"
  | "header"
  | "ok"
  | "warn"
  | "bad"
  | "attention"
  | "border";

const RESET = "\x1b[0m";
const CODES: Record<Tone, string> = {
  default: "",
  dim: "\x1b[2m",
  focus: "\x1b[1;36m",
  header: "\x1b[1;36m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  bad: "\x1b[31m",
  attention: "\x1b[33m",
  border: "\x1b[2m",
};

export function colorEnabled(explicit?: boolean): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  if (process.env["NO_COLOR"] === "1" || process.env["NO_COLOR"] === "true") {
    return false;
  }
  return true;
}

export function paint(value: string, tone: Tone, enabled: boolean): string {
  if (!enabled || tone === "default" || value.length === 0) return value;
  const code = CODES[tone];
  if (code.length === 0) return value;
  return `${code}${value}${RESET}`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
