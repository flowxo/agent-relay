import type { ProjectReadSessionV1 } from "@agent-relay/core";

import type { WebAttentionItemV1 } from "../web-contract.js";

import { HELP_LINES } from "./keys.js";
import type { DashboardViewState, ListEntry } from "./store.js";
import type { Tone } from "./style.js";
import {
  actionUnavailableReason,
  expiryHint,
  formFields,
  harnessLabel,
  isActionAvailable,
  relativeTime,
  sessionTitle,
  stateExplanation,
  stateLabel,
} from "./view-model.js";

export interface LayoutLine {
  text: string;
  tone: Tone;
}

export interface LayoutPane {
  title: string;
  focused: boolean;
  lines: LayoutLine[];
}

export interface DashboardLayout {
  header: LayoutLine;
  filter?: LayoutLine;
  mode: "dashboard" | "help" | "form";
  rail: LayoutPane;
  sessions: LayoutPane;
  detail?: LayoutPane;
  body: LayoutLine[];
  pending?: LayoutLine;
  notice?: LayoutLine;
  footer: LayoutLine;
}

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 12;

export function windowAround(
  lines: LayoutLine[],
  height: number,
): LayoutLine[] {
  if (height <= 0) return [];
  if (lines.length <= height) return lines;
  const cursor = lines.findIndex((line) => line.text.startsWith(">"));
  const focus = cursor < 0 ? 0 : cursor;
  const start = Math.min(
    Math.max(0, focus - Math.floor((height - 1) / 2)),
    lines.length - height,
  );
  return lines.slice(start, start + height);
}

export interface DashboardPaneMetrics {
  tooSmall: boolean;
  railWidth: number;
  sessionWidth: number;
  splitInner: number;
  detailHeight: number;
  detailInner: number;
  bodyInner: number;
}

export function dashboardPaneMetrics(
  columns: number,
  rows: number,
  layout: DashboardLayout,
): DashboardPaneMetrics {
  const header = 1 + (layout.filter === undefined ? 0 : 1);
  const footer =
    1 +
    (layout.pending === undefined ? 0 : 1) +
    (layout.notice === undefined ? 0 : 1);
  const remaining = Math.max(3, rows - header - footer);
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const railWidth = Math.min(
    columns < 56 ? 16 : 24,
    Math.max(columns < 56 ? 12 : 14, Math.floor((columns - 3) * 0.3)),
  );
  const sessionWidth = Math.max(1, columns - 3 - railWidth);
  if (layout.mode === "help" || layout.mode === "form") {
    return {
      tooSmall,
      railWidth,
      sessionWidth,
      splitInner: 0,
      detailHeight: 0,
      detailInner: 0,
      bodyInner: Math.max(1, remaining - 2),
    };
  }
  const detailHeight =
    layout.detail === undefined
      ? 0
      : remaining < 14
        ? Math.min(5, Math.max(0, remaining - 7))
        : Math.min(8, Math.max(5, Math.floor(remaining / 3)));
  const splitHeight = remaining - detailHeight;
  return {
    tooSmall,
    railWidth,
    sessionWidth,
    splitInner: Math.max(1, splitHeight - 2),
    detailHeight,
    detailInner: layout.detail === undefined ? 0 : Math.max(1, detailHeight - 2),
    bodyInner: 0,
  };
}

function marker(
  cursor: boolean,
  selected: boolean,
  paneFocused: boolean,
): string {
  if (cursor && paneFocused) return ">";
  if (selected || cursor) return "*";
  return " ";
}

function connectionTone(
  connection: DashboardViewState["connection"],
): Tone {
  switch (connection) {
    case "online":
      return "ok";
    case "reconnecting":
    case "stale":
      return "warn";
    case "disconnected":
      return "bad";
  }
}

function stateTone(state: ProjectReadSessionV1["activity"]["state"]): Tone {
  switch (state) {
    case "needs_input":
    case "unknown":
      return "attention";
    case "failed":
      return "bad";
    case "working":
      return "ok";
    default:
      return "dim";
  }
}

function sessionFromState(
  state: DashboardViewState,
  sessionKey: string,
): ProjectReadSessionV1 | undefined {
  if (state.selectedSession?.sessionKey === sessionKey) {
    return state.selectedSession;
  }
  if (state.snapshot !== undefined) {
    for (const session of state.snapshot.needsAttention) {
      if (session.sessionKey === sessionKey) return session;
    }
    for (const group of state.snapshot.currentByHarness) {
      for (const session of group.sessions) {
        if (session.sessionKey === sessionKey) return session;
      }
    }
  }
  return state.history.find((session) => session.sessionKey === sessionKey);
}

function sessionLine(session: ProjectReadSessionV1): string {
  return `${sessionTitle(session)}  ${stateLabel(session)}  ${harnessLabel(session.harness)}`;
}

function listLabel(
  state: DashboardViewState,
  entry: ListEntry,
): { text: string; tone: Tone } {
  const session = sessionFromState(state, entry.sessionKey);
  const request =
    entry.requestId === undefined
      ? undefined
      : state.requests.find((item) => item.requestId === entry.requestId);
  const title =
    session === undefined
      ? entry.sessionKey.slice(0, 8)
      : sessionTitle(session);
  const tone = session === undefined ? "default" : stateTone(session.activity.state);
  if (entry.section === "attention" && request !== undefined) {
    return {
      text: `${title}  ${request.promptPreview}`,
      tone: "attention",
    };
  }
  if (session !== undefined) {
    return { text: sessionLine(session), tone };
  }
  return { text: title, tone: "default" };
}

function section(name: string): LayoutLine {
  return { text: `-- ${name}`, tone: "dim" };
}

function pushEntries(
  state: DashboardViewState,
  lines: LayoutLine[],
  entries: ListEntry[],
  listFocused: boolean,
  empty: string,
): void {
  if (entries.length === 0) {
    lines.push({ text: `   ${empty}`, tone: "dim" });
    return;
  }
  for (const entry of entries) {
    const index = state.list.indexOf(entry);
    const cursor = index === state.listIndex;
    const label = listLabel(state, entry);
    lines.push({
      text: `${marker(cursor, cursor, listFocused)} ${label.text}`,
      tone: cursor && listFocused ? "focus" : label.tone,
    });
  }
}

function detailLines(
  session: ProjectReadSessionV1,
  now: number,
  request: WebAttentionItemV1 | undefined,
  capabilities: DashboardViewState["capabilities"],
): LayoutLine[] {
  const lines: LayoutLine[] = [
    {
      text: `${sessionTitle(session)}  ${stateLabel(session)}  ${session.activity.confidence}`,
      tone: stateTone(session.activity.state),
    },
    { text: stateExplanation(session.activity.state), tone: "default" },
    { text: session.activity.reasonText, tone: "dim" },
    {
      text: `Last activity  ${relativeTime(session.activity.lastObservedAt, now)}`,
      tone: "dim",
    },
    {
      text: `In-flight ${String(session.knownInFlightWork.count)}   Pending ${session.pendingInteraction.state} ${String(session.pendingInteraction.count)}   Delivery ${session.deliveryHealth.muted ? "muted" : "live"}`,
      tone: "dim",
    },
  ];
  if (request !== undefined) {
    lines.push({
      text: `Question  ${request.requestKind}  ${request.promptPreview}`,
      tone: "attention",
    });
  }
  const capability = capabilities.get(session.sessionKey);
  const actions = (["continue", "mute", "end"] as const)
    .map((action) =>
      isActionAvailable(capability, action)
        ? action
        : `${action} (${actionUnavailableReason(capability)})`,
    )
    .join("   ");
  lines.push({ text: actions, tone: "dim" });
  return lines;
}

function formLines(state: DashboardViewState, now: number): LayoutLine[] {
  const request = state.selectedRequest;
  if (request === undefined) return [];
  const expiry = expiryHint(request.expiresAt, now);
  const lines: LayoutLine[] = [
    {
      text: `Answer  ${request.requestKind}  ${expiry.text}`,
      tone: "header",
    },
    { text: request.promptPreview, tone: "attention" },
  ];
  if (request.form === undefined) {
    lines.push({
      text: "This request is visible but cannot be answered from the terminal dashboard.",
      tone: "warn",
    });
  } else {
    if (request.form.kind === "question-set") {
      lines.push({ text: request.form.title, tone: "default" });
    }
    const fields = formFields(request.form);
    let lastHeading = "";
    for (const [index, field] of fields.entries()) {
      if (field.heading !== lastHeading) {
        lines.push({ text: field.heading, tone: "dim" });
        lastHeading = field.heading;
      }
      const cursor = index === (state.draft?.fieldIndex ?? 0);
      if (field.kind === "text") {
        lines.push({
          text: `${cursor ? ">" : " "} ${String(state.draft?.values[field.key] ?? "")}_`,
          tone: cursor ? "focus" : "default",
        });
        continue;
      }
      const selected = state.draft?.values[field.key];
      const chosen = field.multi
        ? Array.isArray(selected) && selected.includes(field.optionId)
        : selected === field.optionId;
      lines.push({
        text: `${cursor ? ">" : " "} ${chosen ? "[x]" : "[ ]"} ${field.label}`,
        tone: cursor ? "focus" : "default",
      });
    }
  }
  if (state.draft?.status) {
    lines.push({ text: state.draft.status, tone: "warn" });
  }
  lines.push({
    text: "Enter submit   Esc cancel   Space toggle   ↑↓ fields",
    tone: "dim",
  });
  return lines;
}

export function buildDashboardLayout(
  state: DashboardViewState,
  now = Date.now(),
): DashboardLayout {
  const selected = state.rail.find((item) => item.selected);
  const listFocused = state.pane === "list" || state.pane === "filter";
  const header: LayoutLine = {
    text: `Agent Relay   ${selected?.label ?? "All projects"}   ${state.connection}`,
    tone: connectionTone(state.connection),
  };
  const filter: LayoutLine | undefined =
    state.pane === "filter" || state.query.length > 0
      ? {
          text:
            state.pane === "filter"
              ? `Filter  ${state.query}_   Esc leave  Enter keep`
              : `Filter  ${state.query}`,
          tone: "focus",
        }
      : undefined;

  const railLines: LayoutLine[] = [];
  for (const [index, item] of state.rail.entries()) {
    const cursor = index === state.railIndex;
    railLines.push({
      text: `${marker(cursor, item.selected, state.pane === "rail")} ${item.label}  ${String(item.attentionCount)}/${String(item.currentCount)}`,
      tone:
        cursor && state.pane === "rail"
          ? "focus"
          : item.selected
            ? "ok"
            : "default",
    });
  }
  if (state.rail.length === 0) {
    railLines.push({ text: "  No projects", tone: "dim" });
  }

  const sessions: LayoutLine[] = [];
  sessions.push(section("Needs attention"));
  pushEntries(
    state,
    sessions,
    state.list.filter((entry) => entry.section === "attention"),
    listFocused,
    "None",
  );
  sessions.push(section("Current"));
  pushEntries(
    state,
    sessions,
    state.list.filter((entry) => entry.section === "current"),
    listFocused,
    "None",
  );
  sessions.push(section("Recent"));
  pushEntries(
    state,
    sessions,
    state.list.filter((entry) => entry.section === "recent"),
    listFocused,
    "None",
  );

  const showDetail =
    state.selectedSession !== undefined &&
    (state.detailOpen || state.pane === "detail");
  const detail: LayoutPane | undefined = showDetail
    ? {
        title: state.pane === "detail" ? "[Detail]" : "Detail",
        focused: state.pane === "detail",
        lines: detailLines(
          state.selectedSession!,
          now,
          state.selectedRequest,
          state.capabilities,
        ),
      }
    : undefined;

  const footer: LayoutLine = {
    text:
      state.pane === "filter"
        ? `${state.status}   Esc leave  Enter keep`
        : `${state.status}   ? help  q quit  r refresh  / filter  ←→ panes`,
    tone: "dim",
  };

  const mode: DashboardLayout["mode"] =
    state.helpOpen || state.pane === "help"
      ? "help"
      : state.pane === "form"
        ? "form"
        : "dashboard";

  return {
    header,
    ...(filter === undefined ? {} : { filter }),
    mode,
    rail: {
      title: state.pane === "rail" ? "[Projects]" : "Projects",
      focused: state.pane === "rail",
      lines: railLines,
    },
    sessions: {
      title: listFocused ? "[Sessions]" : "Sessions",
      focused: listFocused,
      lines: sessions,
    },
    ...(detail === undefined ? {} : { detail }),
    body:
      mode === "help"
        ? HELP_LINES.map((line) => ({ text: line, tone: "default" as const }))
        : mode === "form"
          ? formLines(state, now)
          : [],
    ...(state.pendingUpdates > 0
      ? {
          pending: {
            text: `${String(state.pendingUpdates)} updates waiting. ${state.pendingReason} Press u to apply.`,
            tone: "warn" as const,
          },
        }
      : {}),
    ...(state.connection === "reconnecting" || state.connection === "stale"
      ? {
          notice: {
            text:
              state.connection === "stale"
                ? "No successful update for 30 seconds. Last safe snapshot is still shown."
                : "Showing the last safe snapshot while Agent Relay reconnects.",
            tone: "warn" as const,
          },
        }
      : state.notice.length > 0
        ? { notice: { text: state.notice, tone: "warn" as const } }
        : {}),
    footer,
  };
}
