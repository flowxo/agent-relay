import {
  MIN_COLUMNS,
  MIN_ROWS,
  buildDashboardLayout,
  dashboardPaneMetrics,
  windowAround,
} from "./layout.js";
import type { DashboardLayout, LayoutLine } from "./layout.js";
import { colorEnabled, paint, stripAnsi } from "./style.js";
import type { DashboardViewState } from "./store.js";

export function displayWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const code = character.codePointAt(0) ?? 0;
    width +=
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? 0 : isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

export function pad(value: string, width: number): string {
  const visible = displayWidth(value);
  if (visible >= width) return truncate(value, width);
  return `${value}${" ".repeat(width - visible)}`;
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  let result = "";
  let used = 0;
  for (const character of stripAnsi(value)) {
    const next = displayWidth(character);
    if (used + next > width - 1) break;
    result += character;
    used += next;
  }
  return `${result}…`;
}

function titledBar(title: string, width: number): string {
  const label = ` ${title} `;
  const rest = Math.max(0, width - displayWidth(label));
  return truncate(`${label}${"─".repeat(rest)}`, width);
}

function cell(
  line: LayoutLine | undefined,
  width: number,
  enabled: boolean,
): string {
  const text = pad(truncate(line?.text ?? "", width), width);
  return paint(text, line?.tone ?? "default", enabled);
}

function splitTop(
  leftTitle: string,
  rightTitle: string,
  leftWidth: number,
  rightWidth: number,
  enabled: boolean,
  leftFocus: boolean,
  rightFocus: boolean,
): string {
  const left = paint(
    titledBar(leftTitle, leftWidth),
    leftFocus ? "focus" : "border",
    enabled,
  );
  const right = paint(
    titledBar(rightTitle, rightWidth),
    rightFocus ? "focus" : "border",
    enabled,
  );
  return `┌${left}┬${right}┐`;
}

function splitRow(
  left: LayoutLine | undefined,
  right: LayoutLine | undefined,
  leftWidth: number,
  rightWidth: number,
  enabled: boolean,
): string {
  return `│${cell(left, leftWidth, enabled)}│${cell(right, rightWidth, enabled)}│`;
}

function splitJoin(
  leftWidth: number,
  rightWidth: number,
  enabled: boolean,
): string {
  return paint(
    `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`,
    "border",
    enabled,
  );
}

function splitBottom(
  leftWidth: number,
  rightWidth: number,
  enabled: boolean,
): string {
  return paint(
    `└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`,
    "border",
    enabled,
  );
}

function fullTop(
  title: string,
  width: number,
  enabled: boolean,
  focused: boolean,
): string {
  return `┌${paint(titledBar(title, Math.max(0, width - 2)), focused ? "focus" : "border", enabled)}┐`;
}

function fullRow(
  line: LayoutLine | undefined,
  width: number,
  enabled: boolean,
): string {
  return `│${cell(line, Math.max(0, width - 2), enabled)}│`;
}

function fullBottom(width: number, enabled: boolean): string {
  return paint(`└${"─".repeat(Math.max(0, width - 2))}┘`, "border", enabled);
}

function paintLine(line: LayoutLine, width: number, enabled: boolean): string {
  return paint(pad(truncate(line.text, width), width), line.tone, enabled);
}

function renderDashboard(
  layout: DashboardLayout,
  width: number,
  height: number,
  enabled: boolean,
): string[] {
  const lines: string[] = [paintLine(layout.header, width, enabled)];
  if (layout.filter !== undefined) {
    lines.push(paintLine(layout.filter, width, enabled));
  }
  const metrics = dashboardPaneMetrics(width, height, layout);

  if (layout.mode === "help" || layout.mode === "form") {
    const title = layout.mode === "help" ? "Help" : "Answer";
    const inner = metrics.bodyInner;
    const body = windowAround(layout.body, inner);
    lines.push(fullTop(title, width, enabled, true));
    for (let index = 0; index < inner; index += 1) {
      lines.push(fullRow(body[index], width, enabled));
    }
    lines.push(fullBottom(width, enabled));
  } else {
    const railWidth = metrics.railWidth;
    const bodyWidth = metrics.sessionWidth;
    const innerRows = metrics.splitInner;
    const rail = windowAround(layout.rail.lines, innerRows);
    const sessions = windowAround(layout.sessions.lines, innerRows);
    lines.push(
      splitTop(
        layout.rail.title,
        layout.sessions.title,
        railWidth,
        bodyWidth,
        enabled,
        layout.rail.focused,
        layout.sessions.focused,
      ),
    );
    for (let index = 0; index < innerRows; index += 1) {
      lines.push(
        splitRow(rail[index], sessions[index], railWidth, bodyWidth, enabled),
      );
    }
    if (layout.detail === undefined || metrics.detailHeight === 0) {
      lines.push(splitBottom(railWidth, bodyWidth, enabled));
    } else {
      lines.push(splitJoin(railWidth, bodyWidth, enabled));
      const detailInner = metrics.detailInner;
      const detail = windowAround(layout.detail.lines, detailInner);
      lines.push(
        fullTop(layout.detail.title, width, enabled, layout.detail.focused),
      );
      for (let index = 0; index < detailInner; index += 1) {
        lines.push(fullRow(detail[index], width, enabled));
      }
      lines.push(fullBottom(width, enabled));
    }
  }

  if (layout.pending !== undefined) {
    lines.push(paintLine(layout.pending, width, enabled));
  }
  if (layout.notice !== undefined) {
    lines.push(paintLine(layout.notice, width, enabled));
  }
  lines.push(paintLine(layout.footer, width, enabled));
  return lines.slice(0, height);
}

export function renderDashboardFrame(
  state: DashboardViewState,
  columns: number,
  rows: number,
  now = Date.now(),
  options: { color?: boolean } = {},
): string {
  const enabled = colorEnabled(options.color);
  const layout = buildDashboardLayout(state, now);
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const width = Math.max(1, columns);
    const height = Math.max(1, rows);
    const message = `Need 40x12, have ${String(columns)}x${String(rows)}.`;
    const out = [
      paintLine({ text: message, tone: "warn" }, width, enabled),
      paintLine({ text: "q quit", tone: "dim" }, width, enabled),
    ];
    while (out.length < height) {
      out.push(paintLine({ text: "", tone: "default" }, width, enabled));
    }
    return out.slice(0, height).join("\n");
  }
  return renderDashboard(layout, columns, rows, enabled).join("\n");
}

export function containsSecret(frame: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && frame.includes(secret));
}
