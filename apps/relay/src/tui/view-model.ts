import type {
  ProjectKey,
  ProjectReadSessionV1,
  ProjectReadSnapshotV1,
} from "@agent-relay/core";

import type { WebAttentionItemV1, WebSessionAction } from "../web-contract.js";

export const HARNESS_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
} as const;

export const STATE_LABELS = {
  working: "Working",
  needs_input: "Needs input",
  background_work: "Background work",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
  ended: "Ended",
} as const;

export const HISTORY_PAGE_SIZE = 25;
export const HISTORY_VIEW_MAX = 1_000;

export const STATE_EXPLANATIONS = {
  working: "Work was recently observed or is known to remain in flight.",
  needs_input: "One unresolved operator question or permission is open.",
  background_work: "Foreground work stopped while durable async work remains.",
  idle: "The session is available but no work was observed recently.",
  done: "The latest turn appears complete.",
  failed: "Work explicitly failed.",
  unknown: "Evidence is stale, incomplete, or contradictory.",
  ended: "The durable relay lane was explicitly closed.",
} as const;

const NAME_ADJECTIVES = [
  "amber",
  "bright",
  "brisk",
  "calm",
  "clear",
  "clever",
  "coastal",
  "copper",
  "crisp",
  "curious",
  "daring",
  "dawn",
  "deft",
  "dusty",
  "eager",
  "early",
  "easy",
  "fair",
  "fleet",
  "fond",
  "frosty",
  "gentle",
  "glad",
  "golden",
  "grand",
  "green",
  "hardy",
  "hazel",
  "humble",
  "ivory",
  "jolly",
  "keen",
  "kind",
  "level",
  "lively",
  "lucid",
  "lunar",
  "mellow",
  "merry",
  "mild",
  "misty",
  "neat",
  "nimble",
  "noble",
  "olive",
  "patient",
  "plain",
  "prime",
  "quiet",
  "rapid",
  "ready",
  "rustic",
  "sage",
  "sandy",
  "sharp",
  "silver",
  "smooth",
  "solar",
  "spry",
  "steady",
  "sunny",
  "tidy",
  "vivid",
  "warm",
] as const;

const NAME_NOUNS = [
  "acorn",
  "alder",
  "anchor",
  "arbor",
  "aspen",
  "badger",
  "basin",
  "beacon",
  "birch",
  "bluff",
  "bramble",
  "breeze",
  "brook",
  "canyon",
  "cedar",
  "cobble",
  "compass",
  "coral",
  "cove",
  "crane",
  "delta",
  "dune",
  "elder",
  "ember",
  "fjord",
  "forest",
  "fossil",
  "garnet",
  "glade",
  "grove",
  "harbor",
  "heron",
  "hollow",
  "island",
  "juniper",
  "kestrel",
  "lantern",
  "ledge",
  "lichen",
  "maple",
  "meadow",
  "mesa",
  "moss",
  "otter",
  "pebble",
  "pine",
  "prairie",
  "quarry",
  "reef",
  "ridge",
  "river",
  "sequoia",
  "shale",
  "shore",
  "sparrow",
  "spruce",
  "summit",
  "thicket",
  "thistle",
  "trail",
  "tundra",
  "valley",
  "willow",
  "wren",
] as const;

export type SessionCapability = {
  supportedActions: WebSessionAction[];
  latestEventId?: string;
};

export type RailItem = {
  projectKey: ProjectKey;
  label: string;
  attentionCount: number;
  currentCount: number;
  recentCount: number;
  totalCount: number;
  selected: boolean;
};

export type AttentionRow = {
  session: ProjectReadSessionV1;
  requests: WebAttentionItemV1[];
};

export type CurrentGroupView = {
  harness: ProjectReadSessionV1["harness"];
  sessions: Array<{
    session: ProjectReadSessionV1;
    needsAttention: boolean;
  }>;
};

function keySlice(sessionKey: string, start: number, length: number): number {
  const value = Number.parseInt(sessionKey.slice(start, start + length), 16);
  return Number.isFinite(value) ? value : 0;
}

export function sessionName(sessionKey: string): string {
  const adjective =
    NAME_ADJECTIVES[keySlice(sessionKey, 0, 4) % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[keySlice(sessionKey, 4, 4) % NAME_NOUNS.length];
  const number = String(keySlice(sessionKey, 8, 4) % 100).padStart(2, "0");
  return `${adjective}-${noun}-${number}`;
}

export function sessionTitle(session: { sessionKey: string }): string {
  return sessionName(session.sessionKey);
}

export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness as keyof typeof HARNESS_LABELS] ?? harness;
}

export function stateLabel(session: ProjectReadSessionV1): string {
  return session.activity.stateLabel ?? STATE_LABELS[session.activity.state];
}

export function stateExplanation(
  state: ProjectReadSessionV1["activity"]["state"],
): string {
  return STATE_EXPLANATIONS[state] ?? STATE_EXPLANATIONS.unknown;
}

export function relativeTime(timestamp: string, now: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.floor((now - parsed) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

export function expiryHint(
  timestamp: string,
  now: number,
): { text: string; elapsed: boolean } {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return { text: "expiry unknown", elapsed: false };
  }
  const seconds = Math.floor((parsed - now) / 1000);
  if (seconds <= 0) {
    return { text: "past its expiry on this clock", elapsed: true };
  }
  if (seconds < 60) return { text: `${String(seconds)}s left`, elapsed: false };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { text: `${String(minutes)}m left`, elapsed: false };
  return { text: `${String(Math.floor(minutes / 60))}h left`, elapsed: false };
}

export function indexSnapshotSessions(
  snapshot: ProjectReadSnapshotV1,
): Map<string, ProjectReadSessionV1> {
  const index = new Map<string, ProjectReadSessionV1>();
  const add = (session: ProjectReadSessionV1) => {
    if (!index.has(session.sessionKey)) index.set(session.sessionKey, session);
  };
  for (const session of snapshot.needsAttention) add(session);
  for (const group of snapshot.currentByHarness) {
    for (const session of group.sessions) add(session);
  }
  for (const session of snapshot.recent.items) add(session);
  return index;
}

export function buildRail(snapshot: ProjectReadSnapshotV1): {
  items: RailItem[];
  truncated: boolean;
  totalCount: number;
  shownCount: number;
  selectedProjectKey: ProjectKey;
  selectedMissing: boolean;
} {
  const selected = snapshot.selectedProjectKey;
  const toItem = (
    summary: ProjectReadSnapshotV1["projects"]["all"],
  ): RailItem => ({
    projectKey: summary.projectKey,
    label: summary.label,
    attentionCount: summary.needsAttentionCount,
    currentCount: summary.currentCount,
    recentCount: summary.recentCount,
    totalCount: summary.totalCount,
    selected: summary.projectKey === selected,
  });
  const items = [
    toItem(snapshot.projects.all),
    ...snapshot.projects.items.map(toItem),
  ];
  return {
    items,
    truncated: snapshot.projects.truncated,
    totalCount: snapshot.projects.totalCount,
    shownCount: snapshot.projects.items.length,
    selectedProjectKey: selected,
    selectedMissing: !items.some((item) => item.selected),
  };
}

export function buildAttention(
  snapshot: ProjectReadSnapshotV1,
  requests: WebAttentionItemV1[],
  knownSessions?: Map<string, ProjectReadSessionV1>,
): { items: AttentionRow[]; outOfScopeRequestCount: number } {
  const known = knownSessions ?? indexSnapshotSessions(snapshot);
  const scoped = requests.filter((request) => known.has(request.sessionKey));
  const bySession = new Map<string, WebAttentionItemV1[]>();
  for (const request of scoped) {
    const list = bySession.get(request.sessionKey) ?? [];
    list.push(request);
    bySession.set(request.sessionKey, list);
  }
  for (const list of bySession.values()) {
    list.sort(
      (left, right) =>
        Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
        left.requestId.localeCompare(right.requestId),
    );
  }
  const seen = new Set<string>();
  const items = snapshot.needsAttention.map((session) => {
    seen.add(session.sessionKey);
    return {
      session,
      requests: bySession.get(session.sessionKey) ?? [],
    };
  });
  const strays = [...bySession.entries()]
    .filter(([sessionKey]) => !seen.has(sessionKey))
    .flatMap(([sessionKey, list]) => {
      const session = known.get(sessionKey);
      return session === undefined ? [] : [{ session, requests: list }];
    })
    .sort(
      (left, right) =>
        Date.parse(left.requests[0]?.expiresAt ?? "") -
          Date.parse(right.requests[0]?.expiresAt ?? "") ||
        left.session.sessionKey.localeCompare(right.session.sessionKey),
    );
  return {
    items: [...items, ...strays],
    outOfScopeRequestCount: requests.length - scoped.length,
  };
}

export function buildCurrentGroups(
  snapshot: ProjectReadSnapshotV1,
): CurrentGroupView[] {
  const attention = new Set(
    snapshot.needsAttention.map((session) => session.sessionKey),
  );
  return snapshot.currentByHarness.map((group) => ({
    harness: group.harness,
    sessions: group.sessions.map((session) => ({
      session,
      needsAttention: attention.has(session.sessionKey),
    })),
  }));
}

export function appendHistoryPage(
  existing: ProjectReadSessionV1[],
  incoming: ProjectReadSessionV1[],
): {
  items: ProjectReadSessionV1[];
  added: number;
  duplicates: number;
  capped: boolean;
} {
  const seen = new Set(existing.map((session) => session.sessionKey));
  const added: ProjectReadSessionV1[] = [];
  let duplicates = 0;
  for (const session of incoming) {
    if (seen.has(session.sessionKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(session.sessionKey);
    added.push(session);
  }
  const items = [...existing, ...added];
  const capped = items.length > HISTORY_VIEW_MAX;
  return {
    items: capped ? items.slice(0, HISTORY_VIEW_MAX) : items,
    added: added.length,
    duplicates,
    capped,
  };
}

export function matchesLoadedQuery(
  session: ProjectReadSessionV1 | undefined,
  query: string,
  extra: string[] = [],
): boolean {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = [
    ...(session === undefined
      ? []
      : [
          sessionTitle(session),
          session.projectLabel,
          harnessLabel(session.harness),
          stateLabel(session),
          session.sessionKey,
        ]),
    ...extra,
  ]
    .map((value) => value.toLocaleLowerCase())
    .join(" ");
  return terms.every((term) => haystack.includes(term));
}

export function filterLoadedSessions(
  sessions: ProjectReadSessionV1[],
  query: string,
): ProjectReadSessionV1[] {
  return sessions.filter((session) => matchesLoadedQuery(session, query));
}

export function shouldHoldUpdates(context: {
  focusInLiveRegion?: boolean;
  hasUnsentDraft?: boolean;
  drawerOpen?: boolean;
}): boolean {
  return (
    context.focusInLiveRegion === true ||
    context.hasUnsentDraft === true ||
    context.drawerOpen === true
  );
}

export function describeHoldReason(context: {
  focusInLiveRegion?: boolean;
  hasUnsentDraft?: boolean;
  drawerOpen?: boolean;
}): string {
  if (context.hasUnsentDraft === true) {
    return "Updates are waiting so your unsent answer is not cleared.";
  }
  if (context.drawerOpen === true) {
    return "Updates are waiting while the evidence view is open.";
  }
  return "Updates are waiting so nothing moves under your keyboard focus.";
}

export function describeTerminalRequest(
  session: ProjectReadSessionV1 | undefined,
  state: string,
  resolvedBy?: string,
): string {
  const where =
    resolvedBy === undefined
      ? ""
      : ` in ${resolvedBy === "web" ? "the browser" : resolvedBy === "tui" ? "this terminal" : resolvedBy}`;
  const title = session === undefined ? "A session" : sessionTitle(session);
  const outcome: Record<string, string> = {
    answered: `was answered${where}`,
    expired: "expired before it was answered",
    cancelled: "was cancelled by the agent",
    failed: "could not be completed",
    unverified: "is no longer open; the daemon did not report how it ended",
  };
  return `${title}: the open question ${outcome[state] ?? `is now ${state}`}.`;
}

export function historySummary(
  loaded: number,
  exhausted: boolean,
  capped: boolean,
  filtered?: number,
): string {
  if (loaded === 0) return "No recent sessions loaded.";
  const shown =
    filtered === undefined || filtered === loaded
      ? `${String(loaded)} loaded`
      : `${String(filtered)} of ${String(loaded)} loaded`;
  if (capped) {
    return `${shown}; the view stops at ${String(HISTORY_VIEW_MAX)} rows. Narrow the state or harness filter to see further back.`;
  }
  return exhausted
    ? `${shown}; that is the end of retained history.`
    : `${shown}; more history is available.`;
}

export type FormField =
  | { kind: "text"; key: string; heading: string }
  | {
      kind: "option";
      key: string;
      optionId: string;
      label: string;
      multi: boolean;
      heading: string;
    };

type ResponseForm = NonNullable<WebAttentionItemV1["form"]>;

function questionOptions(
  question: Extract<
    ResponseForm,
    { kind: "question-set" }
  >["questions"][number],
): Array<{ optionId: string; label: string }> {
  if (question.kind === "confirm") {
    return [question.confirm, question.decline];
  }
  if (question.kind === "free-text") {
    return [];
  }
  return question.options;
}

export function formFields(form: WebAttentionItemV1["form"]): FormField[] {
  if (form === undefined) {
    return [];
  }
  if (form.kind === "text") {
    return [{ kind: "text", key: "value", heading: "Response" }];
  }
  if (form.kind === "single-select" || form.kind === "multi-select") {
    return form.options.map((option) => ({
      kind: "option" as const,
      key: "value",
      optionId: option.optionId,
      label: option.label,
      multi: form.kind === "multi-select",
      heading:
        form.kind === "multi-select" ? "Choose one or more" : "Choose one",
    }));
  }
  const fields: FormField[] = [];
  for (const question of form.questions) {
    if (question.kind === "free-text") {
      fields.push({
        kind: "text",
        key: question.questionId,
        heading: question.prompt,
      });
      continue;
    }
    const multi = question.kind === "multi-select";
    for (const option of questionOptions(question)) {
      fields.push({
        kind: "option",
        key: question.questionId,
        optionId: option.optionId,
        label: option.label,
        multi,
        heading: question.prompt,
      });
    }
  }
  return fields;
}

export function applyFormToggle(
  values: Record<string, string | string[]>,
  field: Extract<FormField, { kind: "option" }>,
): Record<string, string | string[]> {
  if (!field.multi) {
    return { ...values, [field.key]: field.optionId };
  }
  const current = new Set(
    Array.isArray(values[field.key]) ? values[field.key] : [],
  );
  if (current.has(field.optionId)) {
    current.delete(field.optionId);
  } else {
    current.add(field.optionId);
  }
  return { ...values, [field.key]: [...current] };
}

export function withFocusedChoice(
  form: WebAttentionItemV1["form"],
  values: Record<string, string | string[]>,
  fieldIndex: number,
): Record<string, string | string[]> {
  const field = formFields(form)[fieldIndex];
  if (field?.kind !== "option" || field.multi) {
    return values;
  }
  const current = values[field.key];
  if (typeof current === "string" && current.length > 0) {
    return values;
  }
  return { ...values, [field.key]: field.optionId };
}

export function incompleteFormStatus(
  form: WebAttentionItemV1["form"],
  values: Record<string, string | string[]>,
): { fieldIndex: number; message: string } | undefined {
  if (form === undefined) {
    return undefined;
  }
  const fields = formFields(form);
  const indexFor = (key: string): number =>
    Math.max(
      0,
      fields.findIndex((field) => field.key === key),
    );
  if (form.kind === "text") {
    const text = String(values["value"] ?? "").trim();
    return text.length >= form.minLength
      ? undefined
      : {
          fieldIndex: 0,
          message: `Response needs at least ${String(form.minLength)} characters.`,
        };
  }
  if (form.kind === "single-select") {
    return typeof values["value"] === "string" && values["value"].length > 0
      ? undefined
      : {
          fieldIndex: 0,
          message: "Choose one option before submitting.",
        };
  }
  if (form.kind === "multi-select") {
    const selected = Array.isArray(values["value"]) ? values["value"] : [];
    return selected.length >= form.minSelections &&
      selected.length <= form.maxSelections
      ? undefined
      : {
          fieldIndex: 0,
          message: `Choose ${String(form.minSelections)}–${String(form.maxSelections)} options.`,
        };
  }
  for (const question of form.questions) {
    const fieldIndex = indexFor(question.questionId);
    if (question.kind === "free-text") {
      const text = String(values[question.questionId] ?? "").trim();
      if (text.length < question.minLength) {
        return {
          fieldIndex,
          message: `${question.prompt} still needs an answer.`,
        };
      }
      continue;
    }
    if (question.kind === "multi-select") {
      const raw = values[question.questionId];
      const selected = Array.isArray(raw) ? raw : [];
      if (
        selected.length < question.minSelections ||
        selected.length > question.maxSelections
      ) {
        return {
          fieldIndex,
          message: `${question.prompt} still needs an answer.`,
        };
      }
      continue;
    }
    const value = values[question.questionId];
    if (typeof value !== "string" || value.length === 0) {
      return {
        fieldIndex,
        message: `${question.prompt} still needs an answer.`,
      };
    }
  }
  return undefined;
}

export function buildResponse(
  item: WebAttentionItemV1,
  values: Record<string, string | string[]>,
):
  | { kind: "text"; text: string }
  | { kind: "option"; optionId: string }
  | { kind: "multi-select"; optionIds: string[] }
  | {
      kind: "question-set";
      answers: Array<
        | { questionId: string; kind: "multi-select"; optionIds: string[] }
        | { questionId: string; kind: "free-text"; text: string }
        | {
            questionId: string;
            kind: "confirm" | "single-select";
            optionId: string;
          }
      >;
    }
  | undefined {
  if (item.form?.kind === "text") {
    return { kind: "text", text: String(values["value"] ?? "") };
  }
  if (item.form?.kind === "single-select") {
    return { kind: "option", optionId: String(values["value"] ?? "") };
  }
  if (item.form?.kind === "multi-select") {
    const value = values["value"];
    return {
      kind: "multi-select",
      optionIds: Array.isArray(value) ? value.map(String) : [],
    };
  }
  if (item.form?.kind !== "question-set") {
    return undefined;
  }
  return {
    kind: "question-set",
    answers: item.form.questions.map((question) => {
      const value = values[question.questionId];
      if (question.kind === "multi-select") {
        return {
          questionId: question.questionId,
          kind: question.kind,
          optionIds: Array.isArray(value) ? value.map(String) : [],
        };
      }
      if (question.kind === "free-text") {
        return {
          questionId: question.questionId,
          kind: question.kind,
          text: String(value ?? ""),
        };
      }
      return {
        questionId: question.questionId,
        kind: question.kind,
        optionId: String(value ?? ""),
      };
    }),
  };
}

export function actionUnavailableReason(
  capability: SessionCapability | undefined,
): string {
  return capability === undefined
    ? "Controls load with the newest sessions; this session is outside that window."
    : "Not proven for this harness and retained event.";
}

export function isActionAvailable(
  capability: SessionCapability | undefined,
  action: WebSessionAction,
): boolean {
  return (
    capability !== undefined &&
    capability.latestEventId !== undefined &&
    capability.supportedActions.includes(action)
  );
}
