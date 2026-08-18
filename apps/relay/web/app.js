/* global Blob, CSS, FormData, HTMLElement, URL, URLSearchParams, clearTimeout, crypto, document, fetch, history, location, matchMedia, setInterval, setTimeout, window */

import {
  HISTORY_PAGE_SIZE,
  appendHistoryPage,
  attentionAnnouncement,
  buildAttention,
  buildCurrentGroups,
  buildRail,
  buildResponse,
  describeHoldReason,
  describeTerminalRequest,
  harnessLabel,
  historySummary,
  indexSnapshotSessions,
  relativeTime,
  renderAttentionHtml,
  renderCurrentGroupsHtml,
  renderEventDetailHtml,
  renderHistoryRowsHtml,
  renderNoticesHtml,
  renderRailHtml,
  renderTimelineHtml,
  sessionReference,
  sessionTitle,
  shouldHoldUpdates,
  stateLabel,
} from "./state.js";
import { WEB_API_VERSION, WEB_ASSET_VERSION } from "./version.js";

const POLL_INTERVAL_MS = 3_000;
const SNAPSHOT_MAX_AGE_MS = 60_000;
const STALE_CONTACT_MS = 30_000;
const MAX_NOTICES = 5;
const MAX_TERMINAL_LOOKUPS = 5;

const select = (selector) => document.querySelector(selector);
const elements = {
  connectPanel: select("[data-connect-panel]"),
  connectForm: select("[data-connect-form]"),
  connectError: select("[data-connect-error]"),
  dashboardCommand: select("[data-dashboard-command]"),
  console: select("[data-console]"),
  liveRegion: select("[data-live-region]"),
  connectionDot: select("[data-connection-dot]"),
  connectionLabel: select("[data-connection-label]"),
  syncTime: select("[data-sync-time]"),
  statusBanner: select("[data-status-banner]"),
  statusTitle: select("[data-status-title]"),
  statusCopy: select("[data-status-copy]"),
  layout: select("[data-dashboard-layout]"),
  rail: select("[data-project-rail]"),
  railList: select("[data-rail-list]"),
  railNote: select("[data-rail-note]"),
  railTotal: select("[data-rail-total]"),
  projectPane: select("#project-pane"),
  paneTitle: select("[data-pane-title]"),
  paneEyebrow: select("[data-pane-eyebrow]"),
  paneMeta: select("[data-pane-meta]"),
  paneError: select("[data-pane-error]"),
  paneLoading: select("[data-pane-loading]"),
  paneBody: select("[data-pane-body]"),
  actionStatus: select("[data-action-status]"),
  updatePill: select("[data-update-pill]"),
  updatePillCopy: select("[data-update-pill-copy]"),
  applyUpdates: select("[data-apply-updates]"),
  exportDiagnostics: select("[data-export-diagnostics]"),
  stateFilter: select("[data-state-filter]"),
  harnessFilter: select("[data-harness-filter]"),
  search: select("[data-search]"),
  searchNote: select("[data-search-note]"),
  attentionSection: select("#needs-attention"),
  noticeList: select("[data-notice-list]"),
  attentionList: select("[data-attention-list]"),
  attentionEmpty: select("[data-attention-empty]"),
  attentionCount: select("[data-attention-count]"),
  attentionScopeNote: select("[data-attention-scope-note]"),
  currentList: select("[data-current-list]"),
  currentEmpty: select("[data-current-empty]"),
  currentCount: select("[data-current-count]"),
  historyTable: select("[data-history-table]"),
  historyBody: select("[data-history-body]"),
  historyEmpty: select("[data-history-empty]"),
  historyCount: select("[data-recent-count]"),
  historySummary: select("[data-history-summary]"),
  historyStale: select("[data-history-stale]"),
  reloadHistory: select("[data-reload-history]"),
  loadMore: select("[data-load-more]"),
  drawerBackdrop: select("[data-drawer-backdrop]"),
  timelineTitle: select("[data-timeline-title]"),
  timelineSubtitle: select("[data-timeline-subtitle]"),
  timelineReference: select("[data-timeline-reference]"),
  timelineList: select("[data-timeline-list]"),
  timelineEmpty: select("[data-timeline-empty]"),
  closeTimeline: select("[data-close-timeline]"),
  eventDetailPanel: select("[data-event-detail-panel]"),
  eventDetail: select("[data-event-detail]"),
  closeDetail: select("[data-close-detail]"),
  revealEvent: select("[data-reveal-event]"),
  privateReveal: select("[data-private-reveal]"),
  privateRevealContent: select("[data-private-reveal-content]"),
  sessionControlStatus: select("[data-session-control-status]"),
};

const model = {
  authMode: "none",
  authGeneration: 0,
  token: "",
  csrfToken: "",
  snapshot: undefined,
  requests: [],
  capabilities: new Map(),
  history: [],
  historyCursor: undefined,
  historyPages: 0,
  historyCapped: false,
  historyStale: false,
  selectedProjectKey: "all",
  filters: { state: "all", harness: "all" },
  query: "",
  changeCursor: "",
  connection: "disconnected",
  lastSync: 0,
  lastContact: 0,
  rendered: false,
  pending: undefined,
  pendingCount: 0,
  pendingReason: "",
  pointerOnInteractive: false,
  drafts: new Map(),
  notices: [],
  trackedRequestIds: new Set(),
  announcedAttention: -1,
  openSessionKey: "",
  drawerReturnFocus: undefined,
  detailReturnFocus: undefined,
  pendingEndConfirmation: "",
  requestedAttentionId:
    new URL(location.href).searchParams.get("request") ?? "",
  requestedAttentionResolved: false,
  loading: false,
  polling: false,
  refreshQueued: false,
  queuedOptions: undefined,
  detailRequest: 0,
  pollTimer: undefined,
  clockTimer: undefined,
  releaseTimer: undefined,
  liveToggle: false,
};

function prefersReducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function announce(message) {
  if (message === undefined || message.length === 0) return;
  model.liveToggle = !model.liveToggle;
  elements.liveRegion.textContent = model.liveToggle ? message : `${message} `;
}

function setActionStatus(message) {
  elements.actionStatus.textContent = message;
  elements.actionStatus.hidden = message.length === 0;
}

function assertApiCompatibility(meta) {
  if (
    meta?.schema !== "agent-relay-web-meta.v1" ||
    meta.apiVersion !== WEB_API_VERSION ||
    meta.assetVersion !== WEB_ASSET_VERSION
  ) {
    const error = new Error("Local web companion version mismatch");
    error.status = 426;
    throw error;
  }
}

async function api(path) {
  const response = await fetch(path, {
    headers:
      model.authMode === "manual"
        ? { authorization: `Bearer ${model.token}` }
        : {},
    cache: "no-store",
  });
  if (!response.ok) {
    const error = new Error(`Agent Relay returned ${String(response.status)}`);
    error.status = response.status;
    try {
      const body = await response.json();
      if (typeof body?.code === "string") error.code = body.code;
    } catch {
      error.code = undefined;
    }
    throw error;
  }
  return await response.json();
}

async function mutationApi(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(model.authMode === "manual"
        ? { authorization: `Bearer ${model.token}` }
        : {}),
      "content-type": "application/json",
      "x-agent-relay-csrf": model.csrfToken,
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    result = { code: "invalid-response" };
  }
  return { ok: response.ok, status: response.status, result };
}

function setConnection(connection, detail) {
  const previous = model.connection;
  model.connection = connection;
  elements.connectionDot.className = `connection-dot ${connection}`;
  const labels = {
    connected: "Live",
    degraded: "Reconnecting",
    stale: "Daemon stale",
    disconnected: "Disconnected",
  };
  elements.connectionLabel.textContent = labels[connection];
  const showBanner = connection === "degraded" || connection === "stale";
  elements.statusBanner.hidden = !showBanner;
  if (showBanner) {
    elements.statusTitle.textContent =
      connection === "stale"
        ? "Daemon appears stale"
        : "Connection interrupted";
    elements.statusCopy.textContent =
      detail ??
      (connection === "stale"
        ? "No successful update for 30 seconds. The sessions below are the last safe snapshot; controls still submit through the daemon and fail closed if it is gone."
        : "Showing the last safe snapshot while Agent Relay reconnects. Answers submitted now may fail until the daemon replies.");
  }
  if (previous !== connection && previous !== "disconnected") {
    announce(
      connection === "connected"
        ? "Reconnected to the local daemon."
        : connection === "degraded"
          ? "Connection interrupted. Showing the last safe snapshot."
          : connection === "stale"
            ? "The daemon has not answered for 30 seconds."
            : undefined,
    );
  }
}

function requireCredential(message) {
  stopPolling();
  closeTimeline();
  model.authMode = "none";
  model.authGeneration += 1;
  model.token = "";
  model.csrfToken = "";
  model.drafts.clear();
  model.snapshot = undefined;
  model.requests = [];
  model.history = [];
  model.historyPages = 0;
  model.rendered = false;
  model.pending = undefined;
  model.pendingCount = 0;
  model.connection = "disconnected";
  clearEvidencePanels();
  elements.attentionList.innerHTML = "";
  elements.currentList.innerHTML = "";
  elements.historyBody.innerHTML = "";
  elements.noticeList.innerHTML = "";
  elements.console.hidden = true;
  elements.connectPanel.hidden = false;
  elements.connectError.textContent = message;
  setConnection("disconnected");
  elements.dashboardCommand?.focus();
}

/* ------------------------------------------------------------------ *
 * Update policy: nothing moves under the pointer, keyboard focus, an  *
 * unsent answer, or an open evidence dialog.                          *
 * ------------------------------------------------------------------ */

function hasUnsentDraft() {
  for (const form of elements.attentionList.querySelectorAll(
    "[data-response-form]",
  )) {
    for (const control of form.elements) {
      if (control.type === "radio" || control.type === "checkbox") {
        if (control.checked) return true;
      } else if (
        typeof control.value === "string" &&
        control.value.trim().length > 0 &&
        control.type !== "submit" &&
        control.type !== "button"
      ) {
        return true;
      }
    }
  }
  return false;
}

function focusInLiveRegion() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) {
    return false;
  }
  return [...document.querySelectorAll("[data-live-section]")].some((section) =>
    section.contains(active),
  );
}

function holdContext() {
  return {
    focusInLiveRegion: focusInLiveRegion(),
    pointerOnInteractive: model.pointerOnInteractive,
    hasUnsentDraft: hasUnsentDraft(),
    drawerOpen: model.openSessionKey.length > 0,
  };
}

function renderUpdatePill() {
  const held = model.pending !== undefined;
  elements.updatePill.hidden = !held;
  if (!held) return;
  const count = model.pendingCount;
  elements.updatePillCopy.textContent = `${String(count)} update${
    count === 1 ? "" : "s"
  } waiting · ${model.pendingReason}`;
}

function applyPendingUpdate() {
  const next = model.pending;
  if (next === undefined) return;
  model.pending = undefined;
  model.pendingCount = 0;
  renderUpdatePill();
  commit(next);
  announce("Updated the project view.");
}

function maybeReleaseHold() {
  clearTimeout(model.releaseTimer);
  model.releaseTimer = setTimeout(() => {
    if (model.pending !== undefined && !shouldHoldUpdates(holdContext())) {
      applyPendingUpdate();
    }
  }, 200);
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */

function captureFocusDescriptor() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  if (active.dataset.projectKey !== undefined) {
    return `[data-project-key="${CSS.escape(active.dataset.projectKey)}"]`;
  }
  if (
    active.dataset.sessionAction !== undefined &&
    active.dataset.sessionKey !== undefined &&
    active.dataset.sessionScope !== undefined
  ) {
    return `[data-session-action="${CSS.escape(
      active.dataset.sessionAction,
    )}"][data-session-key="${CSS.escape(
      active.dataset.sessionKey,
    )}"][data-session-scope="${CSS.escape(active.dataset.sessionScope)}"]`;
  }
  return undefined;
}

function restoreFocusDescriptor(descriptor) {
  if (descriptor === undefined) return;
  const target = document.querySelector(descriptor);
  if (target instanceof HTMLElement) target.focus();
}

function findRequest(requestId, sessionKey) {
  return model.requests.find(
    (candidate) =>
      candidate.requestId === requestId && candidate.sessionKey === sessionKey,
  );
}

function captureDrafts() {
  for (const form of elements.attentionList.querySelectorAll(
    "[data-response-form]",
  )) {
    const item = findRequest(form.dataset.requestId, form.dataset.sessionKey);
    if (item !== undefined) {
      model.drafts.set(item.requestId, valuesFromForm(item, form));
    }
  }
}

function restoreDrafts() {
  for (const form of elements.attentionList.querySelectorAll(
    "[data-response-form]",
  )) {
    const item = findRequest(form.dataset.requestId, form.dataset.sessionKey);
    const values =
      item === undefined ? undefined : model.drafts.get(item.requestId);
    if (item === undefined || values === undefined) continue;
    const restore = (name, value) => {
      for (const control of form.querySelectorAll(
        `[name="${CSS.escape(name)}"]`,
      )) {
        if (control.type === "radio" || control.type === "checkbox") {
          control.checked = Array.isArray(value)
            ? value.includes(control.value)
            : control.value === value;
        } else {
          control.value = String(value ?? "");
        }
      }
    };
    if (item.form?.kind === "question-set") {
      for (const question of item.form.questions) {
        restore(`question:${question.questionId}`, values[question.questionId]);
      }
    } else {
      restore("response", values.value);
    }
  }
}

/**
 * Every session the page currently shows: the snapshot's complete sets plus
 * every history page already loaded.
 */
function sessionIndex() {
  const index =
    model.snapshot === undefined
      ? new Map()
      : indexSnapshotSessions(model.snapshot);
  for (const session of model.history) {
    if (!index.has(session.sessionKey)) index.set(session.sessionKey, session);
  }
  return index;
}

function findSession(sessionKey) {
  return sessionIndex().get(sessionKey);
}

/**
 * The attention count an incoming snapshot would show, computed exactly the way
 * the rendered section computes it so announcements and the heading agree.
 */
function incomingAttentionCount(next) {
  const index = indexSnapshotSessions(next.snapshot);
  for (const session of model.history) {
    if (!index.has(session.sessionKey)) index.set(session.sessionKey, session);
  }
  return buildAttention(next.snapshot, next.requests, index).items.length;
}

function renderRail() {
  const snapshot = model.snapshot;
  if (snapshot === undefined) return;
  const rail = buildRail(snapshot);
  const { scrollTop, scrollLeft } = elements.railList;
  elements.railList.innerHTML = renderRailHtml(rail);
  elements.railList.scrollTop = scrollTop;
  elements.railList.scrollLeft = scrollLeft;
  elements.railTotal.textContent =
    rail.totalCount === 1 ? "1 project" : `${String(rail.totalCount)} projects`;
  const notes = [];
  if (rail.truncated) {
    notes.push(
      `Showing ${String(rail.shownCount)} of ${String(
        rail.totalCount,
      )} projects. All projects counts stay exact.`,
    );
  }
  if (rail.selectedMissing) {
    notes.push("The selected project has no retained sessions right now.");
  }
  elements.railNote.hidden = notes.length === 0;
  elements.railNote.textContent = notes.join(" ");
}

function renderPaneHead() {
  const snapshot = model.snapshot;
  if (snapshot === undefined) return;
  const selected =
    snapshot.selectedProjectKey === "all"
      ? snapshot.projects.all
      : (snapshot.projects.items.find(
          (item) => item.projectKey === snapshot.selectedProjectKey,
        ) ?? snapshot.projects.all);
  elements.paneEyebrow.textContent =
    snapshot.selectedProjectKey === "all"
      ? "Every project on this machine"
      : "Selected project";
  elements.paneTitle.textContent = selected.label;
  const parts = [
    `${String(selected.needsAttentionCount)} needing attention`,
    `${String(selected.currentCount)} current`,
    `${String(selected.recentCount)} recent`,
  ];
  if (selected.lastActivityAt !== undefined) {
    parts.push(
      `last activity ${relativeTime(selected.lastActivityAt, Date.now())}`,
    );
  }
  elements.paneMeta.textContent = parts.join(" · ");
}

function renderAttention() {
  const snapshot = model.snapshot;
  if (snapshot === undefined) return 0;
  captureDrafts();
  const view = buildAttention(snapshot, model.requests, sessionIndex());
  elements.attentionCount.textContent = `${String(view.items.length)} open`;
  elements.attentionList.innerHTML = renderAttentionHtml(view, {
    now: Date.now(),
    capabilities: model.capabilities,
  });
  elements.attentionEmpty.hidden = view.items.length !== 0;
  elements.noticeList.innerHTML = renderNoticesHtml(model.notices);
  const strayCount = view.outOfScopeRequestCount;
  elements.attentionScopeNote.hidden = strayCount === 0;
  elements.attentionScopeNote.textContent =
    strayCount === 0 ? "" : describeOutOfScopeRequests(strayCount);
  restoreDrafts();
  return view.items.length;
}

/** Names the exact narrowing that is hiding an answerable question. */
function describeOutOfScopeRequests(count) {
  const plural = count === 1 ? "" : "s";
  const remedies = [];
  if (model.selectedProjectKey !== "all") remedies.push("choose All projects");
  if (model.filters.state !== "all") remedies.push("clear the state filter");
  if (model.filters.harness !== "all") {
    remedies.push("clear the harness filter");
  }
  const remedy =
    remedies.length === 0
      ? "They belong to sessions outside this view."
      : `To see ${count === 1 ? "it" : "them"}, ${remedies.join(" or ")}.`;
  return `${String(count)} open question${plural} ${
    count === 1 ? "is" : "are"
  } hidden by the current view. ${remedy}`;
}

function renderCurrent() {
  const snapshot = model.snapshot;
  if (snapshot === undefined) return;
  const groups = buildCurrentGroups(snapshot);
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  elements.currentCount.textContent = `${String(total)} current`;
  elements.currentList.innerHTML = renderCurrentGroupsHtml(groups, {
    now: Date.now(),
    capabilities: model.capabilities,
  });
  elements.currentEmpty.hidden = total !== 0;
}

function visibleHistory() {
  return model.history;
}

function renderHistory() {
  const visible = visibleHistory();
  elements.historyBody.innerHTML = renderHistoryRowsHtml(visible, {
    now: Date.now(),
    capabilities: model.capabilities,
  });
  renderHistoryFooter(visible.length);
}

function renderHistoryFooter(visibleCount) {
  elements.historyCount.textContent = `${String(model.history.length)} loaded`;
  const empty = model.history.length === 0;
  elements.historyTable.hidden = visibleCount === 0;
  if (!empty && visibleCount === 0) {
    elements.historyEmpty.hidden = false;
    elements.historyEmpty.textContent =
      "No retained history matches this search.";
  } else if (empty) {
    elements.historyEmpty.hidden = false;
    elements.historyEmpty.textContent =
      model.query.trim().length > 0
        ? "No retained history matches this search."
        : "No finished sessions have been retained for this project.";
  } else {
    elements.historyEmpty.hidden = true;
  }
  elements.loadMore.hidden =
    model.historyCursor === undefined || model.historyCapped;
  elements.historyStale.hidden = !model.historyStale;
  elements.historySummary.textContent = historySummary(
    model.history.length,
    model.historyCursor === undefined,
    model.historyCapped,
    visibleCount,
  );
}

function render() {
  model.pendingEndConfirmation = "";
  renderRail();
  renderPaneHead();
  const attentionCount = renderAttention();
  renderCurrent();
  renderHistory();
  elements.searchNote.hidden = model.query.trim().length === 0;
  elements.paneLoading.hidden = true;
  elements.paneBody.hidden = false;
  model.rendered = true;
  return attentionCount;
}

function renderSyncTime() {
  elements.syncTime.textContent =
    model.lastSync === 0
      ? "Not synced"
      : `Synced ${relativeTime(new Date(model.lastSync).toISOString(), Date.now())}`;
}

/* ------------------------------------------------------------------ *
 * Snapshot loading                                                    *
 * ------------------------------------------------------------------ */

function scopeKey() {
  return [
    model.selectedProjectKey,
    model.filters.harness,
    model.filters.state,
    model.query.trim(),
  ].join("|");
}

function requestToken() {
  return { generation: model.authGeneration, scope: scopeKey() };
}

function isCurrentToken(token) {
  return (
    token.generation === model.authGeneration && token.scope === scopeKey()
  );
}

function snapshotQuery(cursor) {
  const params = new URLSearchParams();
  params.set("project", model.selectedProjectKey);
  params.set("limit", String(HISTORY_PAGE_SIZE));
  if (model.filters.harness !== "all") {
    params.set("harness", model.filters.harness);
  }
  if (model.filters.state !== "all") params.set("state", model.filters.state);
  const search = model.query.trim();
  if (search.length > 0) params.set("q", search);
  if (cursor !== undefined) params.set("cursor", cursor);
  return params.toString();
}

function capabilityMap(sessions) {
  return new Map(
    sessions.map((session) => [
      session.sessionKey,
      {
        supportedActions: session.supportedActions,
        latestEventId: session.latestEventId,
      },
    ]),
  );
}

async function fetchDashboard(cursor) {
  const [meta, snapshot, sessionResult, attentionResult] = await Promise.all([
    api("/v1/web/meta"),
    api(`/v1/web/projects?${snapshotQuery(cursor)}`),
    api("/v1/web/sessions?limit=500"),
    api("/v1/web/attention?limit=500"),
  ]);
  assertApiCompatibility(meta);
  return {
    snapshot,
    requests: attentionResult.attention,
    capabilities: capabilityMap(sessionResult.sessions),
  };
}

function commit(next, options = {}) {
  const descriptor =
    options.resetScroll === true ? undefined : captureFocusDescriptor();
  const scrollY = window.scrollY;
  model.snapshot = next.snapshot;
  model.requests = next.requests;
  model.capabilities = next.capabilities;
  if (next.keepHistory !== true) {
    if (options.resetHistory === true || model.historyPages <= 1) {
      model.history = next.snapshot.recent.items;
      model.historyCursor = next.snapshot.recent.nextCursor;
      model.historyPages = 1;
      model.historyCapped = false;
      model.historyStale = false;
    } else {
      // Deeper history is already paged in. Replacing it would throw the
      // operator back to page one, so it is kept and explicitly marked stale.
      model.historyStale = true;
    }
  }
  model.selectedProjectKey = next.snapshot.selectedProjectKey;
  pruneDrafts();
  render();
  if (options.resetScroll === true) {
    elements.projectPane.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  } else {
    window.scrollTo({ top: scrollY, behavior: "auto" });
    restoreFocusDescriptor(descriptor);
  }
}

function pruneDrafts() {
  const open = new Set(model.requests.map(({ requestId }) => requestId));
  for (const requestId of [...model.drafts.keys()]) {
    if (!open.has(requestId)) model.drafts.delete(requestId);
  }
}

async function trackTerminalRequests(next) {
  const open = new Set(next.requests.map(({ requestId }) => requestId));
  const disappeared = [...model.trackedRequestIds].filter(
    (requestId) => !open.has(requestId),
  );
  model.trackedRequestIds = open;
  const previousByRequest = new Map(
    model.requests.map((item) => [item.requestId, item]),
  );
  const sessions = sessionIndex();
  for (const requestId of disappeared.slice(0, MAX_TERMINAL_LOOKUPS)) {
    const previous = previousByRequest.get(requestId);
    if (previous === undefined) continue;
    if (model.notices.some((notice) => notice.requestId === requestId)) {
      continue;
    }
    let state;
    try {
      const detail = await api(
        `/v1/web/events/${encodeURIComponent(previous.eventId)}`,
      );
      state = detail.event.request?.state;
    } catch {
      state = undefined;
    }
    if (state === "open") continue;
    pushNotice(
      requestId,
      describeTerminalRequest(
        sessions.get(previous.sessionKey),
        state ?? "unverified",
      ),
    );
  }
}

function pushNotice(requestId, label) {
  model.notices = [
    { requestId, label },
    ...model.notices.filter((notice) => notice.requestId !== requestId),
  ].slice(0, MAX_NOTICES);
}

function clearPaneError() {
  elements.paneError.hidden = true;
  elements.paneError.textContent = "";
}

function showPaneError(message) {
  elements.paneError.hidden = false;
  elements.paneError.textContent = message;
  elements.paneLoading.hidden = true;
}

/** Keeps the strongest intent when several refreshes coalesce into one. */
function mergeRefreshOptions(left = {}, right = {}) {
  return {
    ...(left.force === true || right.force === true ? { force: true } : {}),
    ...(left.resetHistory === true || right.resetHistory === true
      ? { resetHistory: true }
      : {}),
    ...(left.resetScroll === true || right.resetScroll === true
      ? { resetScroll: true }
      : {}),
  };
}

function runQueuedRefresh() {
  if (!model.refreshQueued) return;
  model.refreshQueued = false;
  const queued = model.queuedOptions;
  model.queuedOptions = undefined;
  setTimeout(() => void loadDashboard(queued ?? {}), 0);
}

async function loadDashboard(options = {}) {
  if (model.loading) {
    model.refreshQueued = true;
    model.queuedOptions = mergeRefreshOptions(model.queuedOptions, options);
    return;
  }
  model.loading = true;
  const token = requestToken();
  try {
    const next = await fetchDashboard();
    if (!isCurrentToken(token)) return;
    await trackTerminalRequests(next);
    if (!isCurrentToken(token)) return;
    model.changeCursor = next.snapshot.changeCursor;
    model.lastSync = Date.now();
    model.lastContact = model.lastSync;
    clearPaneError();
    setConnection("connected");
    renderSyncTime();
    const context = holdContext();
    const attentionCount = incomingAttentionCount(next);
    const message = attentionAnnouncement(
      model.announcedAttention,
      attentionCount,
    );
    model.announcedAttention = attentionCount;
    if (
      options.force !== true &&
      model.rendered &&
      shouldHoldUpdates(context)
    ) {
      model.pending = next;
      model.pendingCount += 1;
      model.pendingReason = describeHoldReason(context);
      renderUpdatePill();
      announce(
        message === undefined ? undefined : `${message} Updates are waiting.`,
      );
      return;
    }
    model.pending = undefined;
    model.pendingCount = 0;
    renderUpdatePill();
    commit(next, options);
    announce(message);
  } catch (error) {
    handleLoadError(error, options);
  } finally {
    model.loading = false;
    runQueuedRefresh();
  }
}

function handleLoadError(error, options = {}) {
  if (error.status === 401) {
    requireCredential(
      "This browser session ended. Run agent-relay dashboard --web to reconnect safely.",
    );
    return;
  }
  if (error.status === 426) {
    showPaneError(
      "The dashboard assets and daemon API are incompatible. Rebuild or reinstall Agent Relay and restart the daemon.",
    );
    return;
  }
  if (
    error.status === 404 &&
    error.code === "project_not_found" &&
    model.selectedProjectKey !== "all"
  ) {
    model.selectedProjectKey = "all";
    resetHistoryState();
    announce("That project has no retained sessions. Showing All projects.");
    setTimeout(
      () => void loadDashboard({ force: true, resetHistory: true }),
      0,
    );
    return;
  }
  if (error.status === 503 && error.code === "complete_set_capacity_exceeded") {
    showPaneError(
      "This machine has more concurrent sessions than the dashboard can show completely. Select one project, or filter by state or harness, to get an exact view.",
    );
    return;
  }
  if (!model.rendered) {
    showPaneError(
      error.status === undefined
        ? "The local daemon could not be reached. Confirm agent-relay daemon is running, then reload this page."
        : `The project snapshot failed (${String(error.status)}). Reload this page; if it continues, restart Agent Relay.`,
    );
    setConnection("degraded");
    return;
  }
  void options;
  setConnection("degraded");
}

function resetHistoryState() {
  model.history = [];
  model.historyCursor = undefined;
  model.historyPages = 0;
  model.historyCapped = false;
  model.historyStale = false;
}

async function loadMoreHistory() {
  const cursor = model.historyCursor;
  if (cursor === undefined || model.loading) return;
  elements.loadMore.disabled = true;
  const previousCount = model.history.length;
  const token = requestToken();
  model.loading = true;
  try {
    const next = await fetchDashboard(cursor);
    if (!isCurrentToken(token)) return;
    const merged = appendHistoryPage(model.history, next.snapshot.recent.items);
    model.history = merged.items;
    model.historyCapped = merged.capped;
    model.historyCursor = next.snapshot.recent.nextCursor;
    model.historyPages += 1;
    model.capabilities = next.capabilities;
    model.changeCursor = next.snapshot.changeCursor;
    const visible = visibleHistory();
    elements.historyBody.innerHTML = renderHistoryRowsHtml(visible, {
      now: Date.now(),
      capabilities: model.capabilities,
    });
    renderHistoryFooter(visible.length);
    model.lastContact = Date.now();
    setConnection("connected");
    announce(
      `Loaded ${String(model.history.length - previousCount)} more recent sessions.${
        model.historyCursor === undefined
          ? " That is the end of retained history."
          : ""
      }`,
    );
    stageOrHoldSideData(next);
  } catch (error) {
    if (
      (error.status === 409 || error.status === 400) &&
      isCurrentToken(token)
    ) {
      announce(
        "Recent history changed while paging. Reloading the newest page.",
      );
      model.loading = false;
      resetHistoryState();
      await loadDashboard({ force: true, resetHistory: true });
      return;
    }
    handleLoadError(error);
  } finally {
    model.loading = false;
    elements.loadMore.disabled = false;
    if (!elements.console.hidden) {
      if (elements.loadMore.hidden) {
        elements.historySummary.focus();
      } else {
        elements.loadMore.focus();
      }
    }
    runQueuedRefresh();
  }
}

/**
 * A history page also carries fresh rail/current/attention data. Applying it
 * would move content while the operator is paging, so it goes through the same
 * hold policy as any other update.
 */
function stageOrHoldSideData(next) {
  const context = holdContext();
  if (shouldHoldUpdates(context)) {
    model.pending = { ...next, keepHistory: true };
    model.pendingCount += 1;
    model.pendingReason = describeHoldReason(context);
    renderUpdatePill();
    return;
  }
  model.snapshot = next.snapshot;
  model.requests = next.requests;
  pruneDrafts();
  renderRail();
  renderPaneHead();
  renderAttention();
  renderCurrent();
}

/* ------------------------------------------------------------------ *
 * Change polling                                                      *
 * ------------------------------------------------------------------ */

function stopPolling() {
  clearTimeout(model.pollTimer);
  model.pollTimer = undefined;
}

function startPolling() {
  stopPolling();
  const generation = model.authGeneration;
  const tick = async () => {
    if (generation !== model.authGeneration) return;
    await pollChanges(generation);
    if (
      generation === model.authGeneration &&
      model.connection !== "disconnected"
    ) {
      model.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  model.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function pollChanges(generation = model.authGeneration) {
  if (
    model.polling ||
    model.loading ||
    generation !== model.authGeneration ||
    model.connection === "disconnected" ||
    model.changeCursor.length === 0 ||
    document.hidden
  ) {
    return;
  }
  model.polling = true;
  try {
    const result = await api(
      `/v1/web/project-changes?cursor=${encodeURIComponent(model.changeCursor)}`,
    );
    if (generation !== model.authGeneration) return;
    model.lastContact = Date.now();
    if (model.connection !== "connected") setConnection("connected");
    model.changeCursor = result.cursor;
    if (
      result.invalidations.length > 0 ||
      result.hasMore ||
      Date.now() - model.lastSync >= SNAPSHOT_MAX_AGE_MS
    ) {
      await loadDashboard();
    }
  } catch (error) {
    if (generation !== model.authGeneration) return;
    if (error.status === 401) {
      requireCredential(
        "This browser session ended. Run agent-relay dashboard --web to reconnect safely.",
      );
    } else if (error.status === 409 || error.status === 400) {
      await loadDashboard();
    } else {
      setConnection("degraded");
    }
  } finally {
    model.polling = false;
  }
}

/* ------------------------------------------------------------------ *
 * Interactions                                                        *
 * ------------------------------------------------------------------ */

function valuesFromForm(item, form) {
  const data = new FormData(form);
  if (item.form?.kind === "question-set") {
    return Object.fromEntries(
      item.form.questions.map((question) => {
        const name = `question:${question.questionId}`;
        return [
          question.questionId,
          question.kind === "multi-select"
            ? data.getAll(name).map(String)
            : String(data.get(name) ?? ""),
        ];
      }),
    );
  }
  return {
    value:
      item.form?.kind === "multi-select"
        ? data.getAll("response").map(String)
        : String(data.get("response") ?? ""),
  };
}

async function submitResponse(form, quickContinue = false) {
  const item = findRequest(form.dataset.requestId, form.dataset.sessionKey);
  if (item === undefined) return;
  const status = form.querySelector("[data-response-status]");
  const buttons = [...form.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  status.textContent = "Submitting through the shared request authority…";
  const response = quickContinue
    ? { kind: "text", text: "Continue." }
    : buildResponse(item, valuesFromForm(item, form));
  if (response === undefined) {
    status.textContent = "This request does not expose a browser response.";
    for (const button of buttons) button.disabled = false;
    return;
  }
  let outcome;
  try {
    outcome = await mutationApi(
      `/v1/web/requests/${encodeURIComponent(item.requestId)}/resolve`,
      {
        schema: "agent-relay-web-resolve.v1",
        operationId: `web_response_${crypto.randomUUID()}`,
        sessionKey: item.sessionKey,
        response,
      },
    );
  } catch {
    status.textContent =
      "Connection interrupted before the request authority replied.";
    for (const button of buttons) button.disabled = false;
    return;
  }
  const requestState = outcome.result.requestState;
  if (requestState !== undefined && requestState !== "open") {
    const sessions = sessionIndex();
    model.requests = model.requests.filter(
      (candidate) => candidate.requestId !== item.requestId,
    );
    model.drafts.delete(item.requestId);
    model.trackedRequestIds.delete(item.requestId);
    pushNotice(
      item.requestId,
      describeTerminalRequest(
        sessions.get(item.sessionKey),
        requestState,
        outcome.result.resolvedBy,
      ),
    );
    renderAttention();
    elements.attentionSection.focus();
    const committed =
      requestState === "answered" && outcome.result.resolvedBy === "web";
    setActionStatus(
      committed
        ? "Answer committed."
        : "This question was already resolved on another surface.",
    );
    announce(
      committed
        ? "Answer committed."
        : "This question was already resolved on another surface.",
    );
    void loadDashboard({ force: true });
    return;
  }
  status.textContent =
    outcome.status === 422
      ? "Review the response bounds and complete every required answer."
      : outcome.status === 409
        ? "This form is stale or another surface already handled it."
        : outcome.status === 404
          ? "This question is no longer retained."
          : "The response could not be committed.";
  for (const button of buttons) button.disabled = false;
}

function resetEndConfirmation() {
  if (model.pendingEndConfirmation.length === 0) return;
  for (const button of document.querySelectorAll(
    '[data-session-action="end"]',
  )) {
    if (button.dataset.sessionKey === model.pendingEndConfirmation) {
      button.textContent = "End";
      button.classList.remove("is-confirming");
    }
  }
  model.pendingEndConfirmation = "";
}

async function runSessionAction(button) {
  const action = button.dataset.sessionAction;
  const sessionKey = button.dataset.sessionKey;
  const capability = model.capabilities.get(sessionKey);
  if (capability?.latestEventId === undefined) return;
  if (action === "details") {
    openTimeline(sessionKey, button);
    return;
  }
  if (action === "end" && model.pendingEndConfirmation !== sessionKey) {
    resetEndConfirmation();
    model.pendingEndConfirmation = sessionKey;
    button.textContent = "Confirm end";
    button.classList.add("is-confirming");
    setActionStatus(
      "Ending closes the relay lane for this session. Activate End again to confirm.",
    );
    announce(
      "Ending closes the relay lane for this session. Activate End again to confirm.",
    );
    return;
  }
  resetEndConfirmation();
  button.disabled = true;
  try {
    const outcome = await mutationApi(
      `/v1/web/sessions/${encodeURIComponent(sessionKey)}/actions`,
      {
        schema: "agent-relay-web-session-action.v1",
        operationId: `web_session_${crypto.randomUUID()}`,
        eventId: capability.latestEventId,
        action,
      },
    );
    const message = outcome.ok
      ? action === "end"
        ? "Relay lane ended. The harness process was not terminated."
        : `${action} committed.`
      : outcome.result.outcome === "blocked"
        ? "Answer the pending question before ending this lane."
        : "This control became stale or is unavailable.";
    setActionStatus(message);
    announce(message);
    if (model.openSessionKey === sessionKey) {
      elements.sessionControlStatus.textContent = message;
    }
    await loadDashboard({ force: true });
  } catch {
    setActionStatus(
      "Connection interrupted before the session authority replied.",
    );
    announce("Connection interrupted before the session authority replied.");
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Timeline drawer                                                     *
 * ------------------------------------------------------------------ */

function focusableDrawerElements() {
  return [
    ...elements.drawerBackdrop.querySelectorAll(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.offsetParent !== null);
}

function clearEvidencePanels() {
  model.detailRequest += 1;
  elements.eventDetailPanel.hidden = true;
  elements.eventDetail.textContent = "";
  elements.privateReveal.hidden = true;
  elements.privateRevealContent.textContent = "";
  delete elements.revealEvent.dataset.eventId;
  elements.revealEvent.hidden = true;
  elements.timelineList.innerHTML = "";
}

async function loadTimeline(key) {
  elements.timelineList.innerHTML = "";
  elements.timelineEmpty.hidden = false;
  elements.timelineEmpty.textContent = "Loading retained evidence…";
  try {
    const result = await api(
      `/v1/web/sessions/${encodeURIComponent(key)}/timeline?limit=200`,
    );
    if (model.openSessionKey !== key) return;
    elements.timelineList.innerHTML = renderTimelineHtml(result.timeline, {
      now: Date.now(),
    });
    elements.timelineEmpty.hidden = result.timeline.length !== 0;
    elements.timelineEmpty.textContent =
      "This session has no timeline rows inside the current retention window.";
  } catch (error) {
    if (model.openSessionKey !== key) return;
    elements.timelineEmpty.hidden = false;
    elements.timelineEmpty.textContent =
      error.status === 404
        ? "This session was pruned while the evidence view was open."
        : "Timeline evidence is temporarily unavailable.";
  }
}

function openTimeline(key, invoker) {
  const session = findSession(key);
  if (session === undefined) return;
  model.openSessionKey = key;
  model.drawerReturnFocus = invoker;
  clearEvidencePanels();
  elements.timelineTitle.textContent = sessionTitle(session);
  elements.timelineSubtitle.textContent = `${session.projectLabel} · ${harnessLabel(
    session.harness,
  )} · ${stateLabel(session)}`;
  elements.timelineReference.textContent = `Session key ${sessionReference(session)}`;
  elements.sessionControlStatus.textContent = "";
  elements.drawerBackdrop.hidden = false;
  document.body.classList.add("drawer-open");
  elements.closeTimeline.focus();
  void loadTimeline(key);
}

function closeTimeline() {
  if (model.openSessionKey.length === 0) return;
  model.openSessionKey = "";
  elements.drawerBackdrop.hidden = true;
  clearEvidencePanels();
  document.body.classList.remove("drawer-open");
  const invoker = model.drawerReturnFocus;
  model.drawerReturnFocus = undefined;
  if (invoker instanceof HTMLElement && invoker.isConnected) {
    invoker.focus();
  } else {
    elements.projectPane.focus();
  }
  maybeReleaseHold();
}

async function showEventDetail(eventId, invoker) {
  model.detailRequest += 1;
  const request = model.detailRequest;
  const openKey = model.openSessionKey;
  model.detailReturnFocus = invoker;
  elements.eventDetailPanel.hidden = false;
  elements.privateReveal.hidden = true;
  elements.privateRevealContent.textContent = "";
  elements.eventDetail.textContent = "Loading bounded event evidence…";
  elements.revealEvent.hidden = true;
  elements.eventDetailPanel.scrollIntoView({
    behavior: scrollBehavior(),
    block: "nearest",
  });
  elements.closeDetail.focus();
  try {
    const result = await api(`/v1/web/events/${encodeURIComponent(eventId)}`);
    if (model.openSessionKey !== openKey || model.detailRequest !== request) {
      return;
    }
    elements.eventDetail.innerHTML = renderEventDetailHtml(result.event);
    elements.revealEvent.dataset.eventId = eventId;
    elements.revealEvent.hidden = false;
  } catch {
    if (model.openSessionKey !== openKey || model.detailRequest !== request) {
      return;
    }
    elements.eventDetail.textContent =
      "This event is unavailable inside the current retention window.";
  }
}

async function revealEventDetail(eventId) {
  const request = model.detailRequest;
  const openKey = model.openSessionKey;
  elements.revealEvent.disabled = true;
  let text;
  try {
    const result = await api(
      `/v1/web/events/${encodeURIComponent(eventId)}/reveal`,
    );
    text = [result.event.summary, result.event.assistantExcerpt]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("\n\n");
  } catch {
    text =
      "Private content is unavailable inside the current retention window.";
  } finally {
    elements.revealEvent.disabled = false;
  }
  // The evidence view may have closed while the excerpt was in flight. Private
  // content must never be written back into a dismissed panel.
  if (model.openSessionKey !== openKey || model.detailRequest !== request) {
    return;
  }
  elements.privateRevealContent.textContent = text;
  elements.privateReveal.hidden = false;
  elements.revealEvent.focus();
}

/* ------------------------------------------------------------------ *
 * Event wiring                                                        *
 * ------------------------------------------------------------------ */

function selectProject(projectKey) {
  if (projectKey === model.selectedProjectKey) return;
  model.selectedProjectKey = projectKey;
  resetHistoryState();
  model.pending = undefined;
  model.pendingCount = 0;
  renderUpdatePill();
  elements.paneLoading.hidden = false;
  void loadDashboard({
    force: true,
    resetScroll: true,
    resetHistory: true,
  }).then(() => {
    const restored = document.querySelector(
      `[data-project-key="${CSS.escape(projectKey)}"]`,
    );
    if (restored instanceof HTMLElement) restored.focus();
  });
}

elements.railList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-key]");
  if (button === null) return;
  selectProject(button.dataset.projectKey);
});

for (const [element, key] of [
  [elements.stateFilter, "state"],
  [elements.harnessFilter, "harness"],
]) {
  element.addEventListener("change", () => {
    model.filters[key] = element.value;
    resetHistoryState();
    void loadDashboard({ force: true, resetHistory: true });
  });
}

let searchReloadTimer = 0;
elements.search.addEventListener("input", () => {
  model.query = elements.search.value;
  elements.searchNote.hidden = model.query.trim().length === 0;
  window.clearTimeout(searchReloadTimer);
  searchReloadTimer = window.setTimeout(() => {
    resetHistoryState();
    void loadDashboard({ force: true, resetHistory: true });
  }, 250);
});

elements.applyUpdates.addEventListener("click", () => {
  applyPendingUpdate();
  elements.projectPane.focus();
});

elements.loadMore.addEventListener("click", () => {
  void loadMoreHistory();
});

elements.reloadHistory.addEventListener("click", () => {
  resetHistoryState();
  void loadDashboard({ force: true, resetHistory: true });
});

for (const container of [elements.attentionList, elements.currentList]) {
  container.addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto-attention]");
    if (goto !== null) {
      focusAttentionCard(goto.dataset.gotoAttention);
      return;
    }
    const action = event.target.closest("[data-session-action]");
    if (action !== null && !action.disabled) {
      void runSessionAction(action);
      return;
    }
    const quick = event.target.closest("[data-quick-continue]");
    const form = quick?.closest("[data-response-form]");
    if (form !== undefined && form !== null) {
      void submitResponse(form, true);
    }
  });
}

elements.historyBody.addEventListener("click", (event) => {
  const action = event.target.closest("[data-session-action]");
  if (action !== null && !action.disabled) void runSessionAction(action);
});

elements.attentionList.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-response-form]");
  if (form === null) return;
  event.preventDefault();
  void submitResponse(form);
});

elements.layout.addEventListener("pointerover", (event) => {
  const inLive = event.target.closest("[data-live-section]") !== null;
  model.pointerOnInteractive =
    inLive &&
    event.target.closest(
      "button, a, input, textarea, select, label, .attention-card, .session-card, tr[data-history-session]",
    ) !== null;
  if (!model.pointerOnInteractive) maybeReleaseHold();
});

elements.layout.addEventListener("pointerleave", () => {
  model.pointerOnInteractive = false;
  maybeReleaseHold();
});

elements.layout.addEventListener("focusout", () => {
  maybeReleaseHold();
});

elements.layout.addEventListener("focusin", (event) => {
  if (event.target.closest('[data-session-action="end"]') === null) {
    resetEndConfirmation();
  }
});

function focusAttentionCard(sessionKey) {
  const card = elements.attentionList.querySelector(
    `[data-attention-session="${CSS.escape(sessionKey)}"]`,
  );
  if (!(card instanceof HTMLElement)) return;
  card.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  const control = card.querySelector("input, textarea, select, button");
  if (control instanceof HTMLElement) control.focus();
  else card.focus();
}

elements.closeTimeline.addEventListener("click", closeTimeline);
elements.drawerBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.drawerBackdrop) closeTimeline();
});
elements.closeDetail.addEventListener("click", () => {
  model.detailRequest += 1;
  elements.eventDetailPanel.hidden = true;
  elements.eventDetail.textContent = "";
  elements.privateReveal.hidden = true;
  elements.privateRevealContent.textContent = "";
  const invoker = model.detailReturnFocus;
  model.detailReturnFocus = undefined;
  if (invoker instanceof HTMLElement && invoker.isConnected) {
    invoker.focus();
  } else {
    elements.closeTimeline.focus();
  }
});
elements.revealEvent.addEventListener("click", () => {
  const eventId = elements.revealEvent.dataset.eventId;
  if (eventId !== undefined) void revealEventDetail(eventId);
});
elements.timelineList.addEventListener("click", (event) => {
  const entry = event.target.closest("[data-timeline-event]");
  if (entry !== null) void showEventDetail(entry.dataset.timelineEvent, entry);
});

document.addEventListener("keydown", (event) => {
  if (model.openSessionKey.length === 0) {
    if (event.key === "Escape") resetEndConfirmation();
    return;
  }
  if (event.key === "Escape") {
    closeTimeline();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableDrawerElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  if (!elements.drawerBackdrop.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
});

elements.exportDiagnostics.addEventListener("click", async () => {
  elements.exportDiagnostics.disabled = true;
  try {
    const response = await fetch("/v1/web/diagnostics/export?limit=500", {
      headers:
        model.authMode === "manual"
          ? { authorization: `Bearer ${model.token}` }
          : {},
      cache: "no-store",
    });
    if (response.status === 401) {
      requireCredential(
        "This browser session ended. Run agent-relay dashboard --web to reconnect safely.",
      );
      return;
    }
    if (!response.ok) throw new Error("diagnostic export failed");
    const blob = new Blob([await response.text()], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "agent-relay-diagnostics.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setActionStatus("Sanitized diagnostic export downloaded.");
  } catch {
    setActionStatus("The sanitized diagnostic export could not be created.");
    announce("The sanitized diagnostic export could not be created.");
  } finally {
    elements.exportDiagnostics.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && model.connection !== "disconnected") {
    void pollChanges();
  }
});

/* ------------------------------------------------------------------ *
 * Authentication bootstrap                                            *
 * ------------------------------------------------------------------ */

function focusRequestedAttention() {
  if (
    model.requestedAttentionId.length === 0 ||
    model.requestedAttentionResolved
  ) {
    return;
  }
  const request = elements.attentionList.querySelector(
    `[data-request="${CSS.escape(model.requestedAttentionId)}"]`,
  );
  model.requestedAttentionResolved = true;
  if (!(request instanceof HTMLElement)) {
    announce(
      "The linked question is not in this view. It may belong to another project or may already be resolved.",
    );
    setActionStatus(
      "The linked question is not in this view. It may belong to another project or may already be resolved.",
    );
    return;
  }
  request.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  const control = request.querySelector("input, textarea, select, button");
  if (control instanceof HTMLElement) control.focus();
}

async function showAuthenticatedDashboard() {
  elements.connectPanel.hidden = true;
  elements.console.hidden = false;
  await loadDashboard({ force: true });
  if (model.snapshot === undefined) {
    const error = new Error("dashboard data did not load");
    error.status = 500;
    throw error;
  }
  elements.connectForm.reset();
  setTimeout(focusRequestedAttention, 0);
  startPolling();
}

function removeBootstrapGrantFromHistory() {
  const clean = new URL(location.href);
  clean.searchParams.delete("grant");
  history.replaceState(
    null,
    "",
    `${clean.pathname}${clean.search}${clean.hash}`,
  );
}

async function exchangeBootstrapGrant(grant) {
  const responsePromise = fetch("/v1/web/bootstrap/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      schema: "agent-relay-web-bootstrap-exchange.v1",
      grant,
    }),
  });
  removeBootstrapGrantFromHistory();
  const response = await responsePromise;
  let session;
  try {
    session = await response.json();
  } catch {
    session = undefined;
  }
  if (
    !response.ok ||
    session?.schema !== "agent-relay-web-browser-session.v1" ||
    typeof session.csrfToken !== "string"
  ) {
    const error = new Error("Dashboard bootstrap failed");
    error.status = response.status;
    error.code = session?.code;
    throw error;
  }
  model.authMode = "session";
  model.authGeneration += 1;
  model.token = "";
  model.csrfToken = session.csrfToken;
}

async function restoreBrowserSession() {
  const response = await fetch("/v1/web/session", { cache: "no-store" });
  let session;
  try {
    session = await response.json();
  } catch {
    session = undefined;
  }
  if (
    !response.ok ||
    session?.schema !== "agent-relay-web-browser-session.v1" ||
    typeof session.csrfToken !== "string"
  ) {
    const error = new Error("Browser session unavailable");
    error.status = response.status;
    throw error;
  }
  model.authMode = "session";
  model.authGeneration += 1;
  model.token = "";
  model.csrfToken = session.csrfToken;
}

async function initializeAuthentication() {
  const grant = new URL(location.href).searchParams.get("grant");
  try {
    if (grant === null) {
      await restoreBrowserSession();
    } else {
      await exchangeBootstrapGrant(grant);
    }
  } catch (error) {
    if (grant !== null) removeBootstrapGrantFromHistory();
    requireCredential(
      grant === null
        ? "No active browser session was found. Run agent-relay dashboard --web to open one."
        : error.code === "web-bootstrap-expired" || error.status === 410
          ? "This launch link expired. Run agent-relay dashboard --web again."
          : "This launch link is stale or already used. Run agent-relay dashboard --web again.",
    );
    return;
  }
  try {
    await showAuthenticatedDashboard();
  } catch (error) {
    requireCredential(
      error.status === 401
        ? "This browser session ended. Run agent-relay dashboard --web to reconnect safely."
        : "This browser session is authenticated, but dashboard data could not load. Refresh the page; if the problem continues, restart Agent Relay and run agent-relay dashboard --web again.",
    );
  }
}

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.connectForm);
  model.token = String(form.get("credential") ?? "").trim();
  model.csrfToken = String(form.get("csrfCredential") ?? "").trim();
  model.authMode = "manual";
  model.authGeneration += 1;
  elements.connectError.textContent = "";
  try {
    await showAuthenticatedDashboard();
  } catch (error) {
    model.authMode = "none";
    model.token = "";
    model.csrfToken = "";
    elements.console.hidden = true;
    elements.connectPanel.hidden = false;
    elements.connectError.textContent =
      error.status === 401
        ? "Manual credentials were rejected. Confirm both current fields, or run agent-relay dashboard --web."
        : error.status === 426
          ? "The dashboard assets and daemon API are incompatible. Rebuild or reinstall Agent Relay."
          : "The local daemon could not be reached.";
  }
});

model.clockTimer = setInterval(() => {
  if (model.connection === "disconnected") return;
  renderSyncTime();
  if (
    model.lastContact > 0 &&
    Date.now() - model.lastContact > STALE_CONTACT_MS &&
    model.connection === "connected"
  ) {
    setConnection("stale");
  }
}, 5_000);

if (location.port === "4318" && elements.dashboardCommand) {
  const command = elements.dashboardCommand.querySelector("code");
  const launch = "agent-relay dashboard --web --demo";
  if (command) command.textContent = launch;
  else elements.dashboardCommand.textContent = launch;
}

void initializeAuthentication();
