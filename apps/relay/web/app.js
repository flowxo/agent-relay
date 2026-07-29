/* global AbortController, Blob, CSS, FormData, Option, TextDecoder, URL, clearTimeout, crypto, document, fetch, location, setInterval, setTimeout */

import {
  buildResponse,
  escapeHtml,
  filterSessions,
  mergeCursor,
  parseSseBlock,
  reconcileSessions,
  sortAttention,
  summarizeSessions,
} from "./state.js";
import { WEB_API_VERSION, WEB_ASSET_VERSION } from "./version.js";

const select = (selector) => document.querySelector(selector);
const elements = {
  connectPanel: select("[data-connect-panel]"),
  connectForm: select("[data-connect-form]"),
  connectError: select("[data-connect-error]"),
  console: select("[data-console]"),
  connectionDot: select("[data-connection-dot]"),
  connectionLabel: select("[data-connection-label]"),
  syncTime: select("[data-sync-time]"),
  statusBanner: select("[data-status-banner]"),
  statusTitle: select("[data-status-title]"),
  statusCopy: select("[data-status-copy]"),
  overviewCopy: select("[data-overview-copy]"),
  metricAttention: select("[data-metric-attention]"),
  metricRunning: select("[data-metric-running]"),
  metricRisk: select("[data-metric-risk]"),
  search: select("[data-search]"),
  stateFilters: select("[data-state-filters]"),
  harnessFilter: select("[data-harness-filter]"),
  repositoryFilter: select("[data-repository-filter]"),
  sessionList: select("[data-session-list]"),
  sessionCount: select("[data-session-count]"),
  sessionEmpty: select("[data-session-empty]"),
  sessionEmptyCopy: select("[data-session-empty-copy]"),
  attentionList: select("[data-attention-list]"),
  attentionCount: select("[data-attention-count]"),
  attentionEmpty: select("[data-attention-empty]"),
  resolutionList: select("[data-resolution-list]"),
  exportDiagnostics: select("[data-export-diagnostics]"),
  drawerBackdrop: select("[data-drawer-backdrop]"),
  timelineTitle: select("[data-timeline-title]"),
  timelineSubtitle: select("[data-timeline-subtitle]"),
  timelineList: select("[data-timeline-list]"),
  timelineEmpty: select("[data-timeline-empty]"),
  closeTimeline: select("[data-close-timeline]"),
  eventDetailPanel: select("[data-event-detail-panel]"),
  eventDetail: select("[data-event-detail]"),
  closeDetail: select("[data-close-detail]"),
  revealEvent: select("[data-reveal-event]"),
  privateReveal: select("[data-private-reveal]"),
  privateRevealContent: select("[data-private-reveal-content]"),
  sessionControls: select("[data-session-controls]"),
  sessionControlStatus: select("[data-session-control-status]"),
};

const model = {
  token: "",
  csrfToken: "",
  sessions: [],
  attention: [],
  terminalRequests: [],
  responseDrafts: new Map(),
  cursor: 0,
  connection: "disconnected",
  lastSync: 0,
  lastContact: 0,
  highlightedSession: "",
  openSessionKey: "",
  requestedAttentionId:
    new URL(location.href).searchParams.get("request") ?? "",
  filters: {
    query: "",
    state: "all",
    harness: "all",
    repository: "all",
  },
  reconnectAttempt: 0,
  streamAbort: undefined,
  refreshTimer: undefined,
};

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

function relativeTime(timestamp) {
  const difference = Date.now() - Date.parse(timestamp);
  const seconds = Math.max(0, Math.floor(difference / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function expiresIn(timestamp) {
  const seconds = Math.floor((Date.parse(timestamp) - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h left`;
}

function setConnection(connection, detail) {
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
        ? "No successful update for 30 seconds. The last safe snapshot remains visible."
        : "Showing the last safe snapshot while Agent Relay reconnects.");
  }
}

function requireCredential(message) {
  model.streamAbort?.abort();
  model.token = "";
  model.csrfToken = "";
  model.responseDrafts.clear();
  model.connection = "disconnected";
  elements.console.hidden = true;
  elements.connectPanel.hidden = false;
  elements.connectError.textContent = message;
  setConnection("disconnected");
  select("#credential")?.focus();
}

function updateOptions(selectElement, values, label) {
  const selected = selectElement.value;
  selectElement.replaceChildren(
    new Option(`All ${label}`, "all"),
    ...values.map((value) => new Option(value, value)),
  );
  selectElement.value = values.includes(selected) ? selected : "all";
}

function renderFilters() {
  updateOptions(
    elements.harnessFilter,
    [...new Set(model.sessions.map(({ harness }) => harness))].sort(),
    "harnesses",
  );
  updateOptions(
    elements.repositoryFilter,
    [...new Set(model.sessions.map(({ repository }) => repository))].sort(),
    "repositories",
  );
  model.filters.harness = elements.harnessFilter.value;
  model.filters.repository = elements.repositoryFilter.value;
}

function renderSessions() {
  const filtered = filterSessions(model.sessions, model.filters);
  elements.sessionCount.textContent = `${filtered.length} ${
    filtered.length === 1 ? "session" : "sessions"
  }`;
  elements.sessionEmpty.hidden = filtered.length !== 0;
  elements.sessionList.hidden = filtered.length === 0;
  if (filtered.length === 0) {
    elements.sessionEmptyCopy.textContent =
      model.sessions.length === 0
        ? "Start a supervised agent session and it will appear here."
        : "Clear a filter to bring hidden sessions back into view.";
  }
  elements.sessionList.innerHTML = filtered
    .map(
      (session) => `
        <button type="button" class="session-card ${
          model.highlightedSession === session.sessionKey
            ? "is-highlighted"
            : ""
        }" data-session-key="${escapeHtml(session.sessionKey)}" data-open-session>
          <span class="lane-indicator ${escapeHtml(session.state)}" aria-hidden="true"></span>
          <div class="session-identity">
            <strong>${escapeHtml(session.displayId)}</strong>
            <small>${escapeHtml(session.surface)} · ${escapeHtml(session.lastEventType ?? "registered")}</small>
          </div>
          <div class="session-project">
            <strong>${escapeHtml(session.repository)}</strong>
            <small>${escapeHtml(session.branch ?? "default branch")}</small>
          </div>
          <div class="session-harness">
            <span class="harness-badge">${escapeHtml(session.harness)}</span>
            <span class="lane-badge ${escapeHtml(session.state)}">${escapeHtml(session.state)}</span>
          </div>
          <div class="session-activity">
            <strong>${escapeHtml(relativeTime(session.lastSeenAt))}</strong>
            <small>last activity</small>
          </div>
          <span class="attention-badge ${
            session.attentionCount === 0 ? "is-clear" : ""
          }" aria-label="${session.attentionCount} open attention items">
            ${session.attentionCount}
          </span>
        </button>`,
    )
    .join("");
}

function optionFields(options, type, name) {
  return options
    .map(
      (option) => `
        <label class="response-option">
          <input
            type="${type}"
            name="${escapeHtml(name)}"
            value="${escapeHtml(option.optionId)}"
            ${type === "radio" ? "required" : ""}
          />
          <span>${escapeHtml(option.label)}</span>
        </label>`,
    )
    .join("");
}

function questionOptions(question) {
  if (question.kind === "confirm") {
    return [question.confirm, question.decline];
  }
  return question.options ?? [];
}

function renderQuestion(question) {
  const name = `question:${question.questionId}`;
  if (question.kind === "free-text") {
    return `
      <fieldset data-question="${escapeHtml(question.questionId)}">
        <legend>${escapeHtml(question.prompt)}</legend>
        <textarea
          name="${escapeHtml(name)}"
          minlength="${question.minLength}"
          maxlength="${question.maxLength}"
          ${question.multiline ? "" : 'rows="2"'}
          required
        ></textarea>
      </fieldset>`;
  }
  const type = question.kind === "multi-select" ? "checkbox" : "radio";
  const bounds =
    question.kind === "multi-select"
      ? ` · choose ${question.minSelections}–${question.maxSelections}`
      : "";
  return `
    <fieldset data-question="${escapeHtml(question.questionId)}">
      <legend>${escapeHtml(question.prompt)}${escapeHtml(bounds)}</legend>
      ${optionFields(questionOptions(question), type, name)}
    </fieldset>`;
}

function renderResponseForm(item) {
  const form = item.form;
  if (form === undefined) {
    return `
      <div class="unsupported-response">
        This harness/request combination is visible but cannot be answered from
        the local companion.
      </div>`;
  }
  let fields;
  if (form.kind === "text") {
    fields = `
      <textarea
        name="response"
        minlength="${form.minLength}"
        maxlength="${form.maxLength}"
        required
      ></textarea>`;
  } else if (form.kind === "single-select") {
    fields = `<fieldset>${optionFields(form.options, "radio", "response")}</fieldset>`;
  } else if (form.kind === "multi-select") {
    fields = `
      <fieldset>
        <legend>Choose ${form.minSelections}–${form.maxSelections}</legend>
        ${optionFields(form.options, "checkbox", "response")}
      </fieldset>`;
  } else {
    fields = `
      <strong>${escapeHtml(form.title)}</strong>
      ${form.questions.map(renderQuestion).join("")}`;
  }
  const quickContinue = item.supportedActions.includes("continue")
    ? '<button type="button" data-quick-continue>Continue</button>'
    : "";
  return `
    <form
      class="response-form"
      data-response-form
      data-request-id="${escapeHtml(item.requestId)}"
      data-session-key="${escapeHtml(item.sessionKey)}"
    >
      ${fields}
      <div class="response-actions">
        <button type="submit">Submit response</button>
        ${quickContinue}
      </div>
      <span class="response-status" data-response-status role="status"></span>
    </form>`;
}

function captureResponseDrafts() {
  for (const form of elements.attentionList.querySelectorAll(
    "[data-response-form]",
  )) {
    const item = model.attention.find(
      ({ requestId, sessionKey }) =>
        requestId === form.dataset.requestId &&
        sessionKey === form.dataset.sessionKey,
    );
    if (item !== undefined) {
      model.responseDrafts.set(item.requestId, valuesFromForm(item, form));
    }
  }
}

function restoreResponseDrafts() {
  for (const form of elements.attentionList.querySelectorAll(
    "[data-response-form]",
  )) {
    const item = model.attention.find(
      ({ requestId, sessionKey }) =>
        requestId === form.dataset.requestId &&
        sessionKey === form.dataset.sessionKey,
    );
    const values =
      item === undefined ? undefined : model.responseDrafts.get(item.requestId);
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

function renderAttention() {
  captureResponseDrafts();
  elements.attentionCount.textContent = `${model.attention.length} open`;
  elements.attentionEmpty.hidden =
    model.attention.length !== 0 || model.terminalRequests.length !== 0;
  elements.attentionList.hidden = model.attention.length === 0;
  elements.resolutionList.innerHTML = model.terminalRequests
    .map(
      (notice) => `
        <div class="resolution-notice">
          ${escapeHtml(notice.label)}
        </div>`,
    )
    .join("");
  elements.attentionList.innerHTML = model.attention
    .map((item) => {
      const session = model.sessions.find(
        ({ sessionKey }) => sessionKey === item.sessionKey,
      );
      const repository = session?.repository ?? "Unknown repository";
      const branch = session?.branch ?? "default branch";
      const displayId = session?.displayId ?? item.sessionKey.slice(-10);
      return `
        <article
          class="attention-item ${
            model.requestedAttentionId === item.requestId
              ? "is-deep-linked"
              : ""
          }"
          tabindex="0"
          data-attention-session="${escapeHtml(item.sessionKey)}"
          data-attention-request="${escapeHtml(item.requestId)}"
          aria-label="${escapeHtml(item.requestKind)} request for session ${escapeHtml(item.sessionKey.slice(-10))}"
        >
          <div class="attention-item-head">
            <strong>${escapeHtml(repository)} · ${escapeHtml(displayId)}</strong>
            <span class="attention-kind">${escapeHtml(item.requestKind)}</span>
          </div>
          <p>${escapeHtml(item.promptPreview)}</p>
          <div class="attention-item-meta">
            <span>${escapeHtml(item.harness)} · ${escapeHtml(branch)}</span>
            <span>${escapeHtml(expiresIn(item.expiresAt))}</span>
          </div>
          ${renderResponseForm(item)}
        </article>`;
    })
    .join("");
  restoreResponseDrafts();
}

function render() {
  const summary = summarizeSessions(model.sessions, model.attention);
  elements.metricAttention.textContent = String(summary.attention);
  elements.metricRunning.textContent = String(summary.running);
  elements.metricRisk.textContent = String(summary.risk);
  elements.overviewCopy.textContent =
    model.sessions.length === 0
      ? "Connected. No agent sessions have reported yet."
      : `${model.sessions.length} lanes across ${
          new Set(model.sessions.map(({ repository }) => repository)).size
        } repositories, ordered by operational urgency.`;
  elements.syncTime.textContent =
    model.lastSync === 0
      ? "Not synced"
      : `Synced ${relativeTime(new Date(model.lastSync).toISOString())}`;
  renderFilters();
  renderSessions();
  renderAttention();
}

function focusRequestedAttention() {
  if (model.requestedAttentionId.length === 0) return;
  const item = document.querySelector(
    `[data-attention-request="${CSS.escape(model.requestedAttentionId)}"]`,
  );
  if (item === null) return;
  model.highlightedSession = item.dataset.attentionSession;
  item.scrollIntoView({ behavior: "smooth", block: "center" });
  item.querySelector("input, textarea, select, button")?.focus();
}

function renderTimeline(timeline) {
  elements.timelineEmpty.hidden = timeline.length !== 0;
  elements.timelineList.hidden = timeline.length === 0;
  elements.timelineList.innerHTML = timeline
    .map(
      (entry) => `
        <button
          class="timeline-entry"
          type="button"
          ${
            entry.eventId === undefined
              ? "disabled"
              : `data-timeline-event="${escapeHtml(entry.eventId)}"`
          }
        >
          <span class="timeline-marker ${escapeHtml(entry.kind)}" aria-hidden="true"></span>
          <span>
            <span class="timeline-entry-head">
              <strong>${escapeHtml(entry.kind)} · ${escapeHtml(entry.label)}</strong>
              <time datetime="${escapeHtml(entry.at)}">${escapeHtml(relativeTime(entry.at))}</time>
            </span>
            <span class="timeline-entry-meta">
              <span class="timeline-correlation" title="${escapeHtml(entry.correlationId ?? entry.eventId ?? entry.id)}">
                ${escapeHtml(entry.correlationId ?? entry.eventId ?? entry.id)}
              </span>
              <span class="timeline-status">${escapeHtml(entry.status)}</span>
            </span>
          </span>
        </button>`,
    )
    .join("");
}

function renderSessionControls(session) {
  const supported = new Set(session.supportedActions);
  for (const button of elements.sessionControls.querySelectorAll(
    "[data-session-action]",
  )) {
    const available =
      supported.has(button.dataset.sessionAction) &&
      session.latestEventId !== undefined;
    button.disabled = !available;
    button.title = available
      ? ""
      : "Unavailable for the retained event and harness state";
  }
}

async function loadTimeline(key) {
  elements.timelineList.innerHTML =
    '<div class="empty-state compact"><span>↻</span><h3>Loading evidence</h3></div>';
  elements.timelineList.hidden = false;
  elements.timelineEmpty.hidden = true;
  try {
    const result = await api(
      `/v1/web/sessions/${encodeURIComponent(key)}/timeline?limit=200`,
    );
    if (model.openSessionKey === key) {
      renderTimeline(result.timeline);
    }
  } catch (error) {
    if (model.openSessionKey !== key) return;
    elements.timelineList.textContent =
      error.status === 404
        ? "This session was pruned while the timeline was open."
        : "Timeline evidence is temporarily unavailable.";
  }
}

function openTimeline(key) {
  const session = model.sessions.find(({ sessionKey }) => sessionKey === key);
  if (session === undefined) return;
  model.openSessionKey = key;
  elements.timelineTitle.textContent = `${session.repository} · ${session.displayId}`;
  elements.timelineSubtitle.textContent = `${session.harness} · ${
    session.branch ?? "default branch"
  } · ${session.state}`;
  elements.sessionControlStatus.textContent = "";
  renderSessionControls(session);
  elements.eventDetailPanel.hidden = true;
  elements.privateReveal.hidden = true;
  elements.drawerBackdrop.hidden = false;
  document.body.classList.add("drawer-open");
  elements.closeTimeline.focus();
  void loadTimeline(key);
}

function recordTerminalRequest(item, state, resolvedBy) {
  const winner =
    resolvedBy === undefined
      ? ""
      : ` · resolved in ${resolvedBy === "web" ? "this browser" : resolvedBy}`;
  const repository =
    model.sessions.find(({ sessionKey }) => sessionKey === item.sessionKey)
      ?.repository ?? item.sessionKey.slice(-10);
  model.terminalRequests = [
    {
      requestId: item.requestId,
      label: `${repository}: ${state}${winner}`,
    },
    ...model.terminalRequests.filter(
      ({ requestId }) => requestId !== item.requestId,
    ),
  ].slice(0, 5);
}

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

async function mutationApi(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${model.token}`,
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

async function submitResponse(form, quickContinue = false) {
  const requestId = form.dataset.requestId;
  const sessionKey = form.dataset.sessionKey;
  const item = model.attention.find(
    (candidate) =>
      candidate.requestId === requestId && candidate.sessionKey === sessionKey,
  );
  if (item === undefined) {
    return;
  }
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
  const operationId = `web_response_${crypto.randomUUID()}`;
  let outcome;
  try {
    outcome = await mutationApi(
      `/v1/web/requests/${encodeURIComponent(item.requestId)}/resolve`,
      {
        schema: "agent-relay-web-resolve.v1",
        operationId,
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
  if (
    outcome.result.requestState !== undefined &&
    outcome.result.requestState !== "open"
  ) {
    model.attention = model.attention.filter(
      (candidate) => candidate.requestId !== item.requestId,
    );
    model.responseDrafts.delete(item.requestId);
    recordTerminalRequest(
      item,
      outcome.result.requestState,
      outcome.result.resolvedBy,
    );
    renderAttention();
    scheduleRefresh();
    return;
  }
  status.textContent =
    outcome.status === 422
      ? "Review the response bounds and complete every required answer."
      : outcome.status === 409
        ? "This form is stale or another surface already handled it."
        : "The response could not be committed.";
  for (const button of buttons) button.disabled = false;
}

function closeTimeline() {
  const key = model.openSessionKey;
  model.openSessionKey = "";
  elements.drawerBackdrop.hidden = true;
  elements.eventDetailPanel.hidden = true;
  document.body.classList.remove("drawer-open");
  document.querySelector(`[data-session-key="${CSS.escape(key)}"]`)?.focus();
}

async function showEventDetail(eventId) {
  elements.eventDetailPanel.hidden = false;
  elements.privateReveal.hidden = true;
  elements.eventDetail.textContent = "Loading bounded event detail…";
  elements.revealEvent.hidden = true;
  try {
    const result = await api(`/v1/web/events/${encodeURIComponent(eventId)}`);
    elements.eventDetail.textContent = JSON.stringify(result.event, null, 2);
    elements.revealEvent.dataset.eventId = eventId;
    elements.revealEvent.hidden = false;
  } catch {
    elements.eventDetail.textContent =
      "This event is unavailable inside the current retention window.";
  }
}

async function revealEventDetail(eventId) {
  elements.revealEvent.disabled = true;
  try {
    const result = await api(
      `/v1/web/events/${encodeURIComponent(eventId)}/reveal`,
    );
    elements.privateRevealContent.textContent = JSON.stringify(
      result.event,
      null,
      2,
    );
    elements.privateReveal.hidden = false;
  } catch {
    elements.privateRevealContent.textContent =
      "Private content is unavailable inside the current retention window.";
    elements.privateReveal.hidden = false;
  } finally {
    elements.revealEvent.disabled = false;
  }
}

async function api(path) {
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${model.token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const error = new Error(`Agent Relay returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

async function refresh() {
  const [meta, sessionResult, attentionResult] = await Promise.all([
    api("/v1/web/meta"),
    api("/v1/web/sessions?limit=500"),
    api("/v1/web/attention?limit=500"),
  ]);
  assertApiCompatibility(meta);
  model.sessions = reconcileSessions(sessionResult.sessions);
  model.attention = sortAttention(attentionResult.attention);
  const openRequestIds = new Set(
    model.attention.map(({ requestId }) => requestId),
  );
  for (const requestId of model.responseDrafts.keys()) {
    if (!openRequestIds.has(requestId)) {
      model.responseDrafts.delete(requestId);
    }
  }
  model.lastSync = Date.now();
  model.lastContact = model.lastSync;
  model.reconnectAttempt = 0;
  setConnection("connected");
  render();
  if (model.openSessionKey.length > 0) {
    const openSession = model.sessions.find(
      ({ sessionKey }) => sessionKey === model.openSessionKey,
    );
    if (openSession === undefined) {
      closeTimeline();
    } else {
      elements.timelineSubtitle.textContent = `${openSession.harness} · ${
        openSession.branch ?? "default branch"
      } · ${openSession.state}`;
      renderSessionControls(openSession);
      void loadTimeline(model.openSessionKey);
    }
  }
}

function scheduleRefresh() {
  clearTimeout(model.refreshTimer);
  model.refreshTimer = setTimeout(() => {
    refresh().catch((error) => {
      if (error.status === 401) {
        requireCredential(
          "The local credential changed. Paste the current token to reconnect.",
        );
      } else {
        setConnection("degraded");
      }
    });
  }, 80);
}

function consumeSseBlock(block) {
  const parsed = parseSseBlock(block);
  if (parsed.id !== undefined) {
    model.cursor = mergeCursor(model.cursor, parsed.id);
  }
  if (parsed.event === "change" || parsed.event === "reset") {
    if (parsed.event === "change" && parsed.data.length > 0) {
      try {
        const change = JSON.parse(parsed.data);
        if (
          change.kind === "request" &&
          change.action === "update" &&
          change.payload?.state !== undefined &&
          change.payload.state !== "open"
        ) {
          const item = model.attention.find(
            ({ requestId }) => requestId === change.entityId,
          );
          if (item !== undefined) {
            recordTerminalRequest(
              item,
              change.payload.state,
              change.payload.resolvedBy,
            );
            model.attention = model.attention.filter(
              ({ requestId }) => requestId !== change.entityId,
            );
            model.responseDrafts.delete(change.entityId);
            renderAttention();
          }
        }
      } catch {
        setConnection(
          "degraded",
          "A malformed live update was rejected; refreshing authoritative state.",
        );
      }
    }
    if (parsed.event === "reset" && parsed.data.length > 0) {
      try {
        const bounds = JSON.parse(parsed.data);
        model.cursor = bounds.lastCursor ?? 0;
      } catch {
        model.cursor = 0;
      }
    }
    scheduleRefresh();
  }
}

async function openStream() {
  model.streamAbort?.abort();
  model.streamAbort = new AbortController();
  const response = await fetch(`/v1/web/stream?after=${model.cursor}`, {
    headers: { authorization: `Bearer ${model.token}` },
    cache: "no-store",
    signal: model.streamAbort.signal,
  });
  if (!response.ok || response.body === null) {
    const error = new Error(`Stream returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    model.lastContact = Date.now();
    if (model.connection === "degraded" || model.connection === "stale") {
      setConnection("connected");
    }
    buffer += decoder
      .decode(chunk.value, { stream: true })
      .replaceAll("\r", "");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  throw new Error("Stream closed");
}

function reconnectStream() {
  openStream().catch((error) => {
    if (error.name === "AbortError" || model.connection === "disconnected") {
      return;
    }
    if (error.status === 401) {
      requireCredential(
        "The local credential changed. Paste the current token to reconnect.",
      );
      return;
    }
    setConnection("degraded");
    model.reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * 2 ** model.reconnectAttempt);
    setTimeout(reconnectStream, delay);
  });
}

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.connectForm);
  model.token = String(form.get("credential") ?? "").trim();
  model.csrfToken = String(form.get("csrfCredential") ?? "").trim();
  elements.connectError.textContent = "";
  try {
    await refresh();
    elements.connectForm.reset();
    elements.connectPanel.hidden = true;
    elements.console.hidden = false;
    setTimeout(focusRequestedAttention, 0);
    reconnectStream();
  } catch (error) {
    model.token = "";
    model.csrfToken = "";
    elements.connectError.textContent =
      error.status === 401
        ? "Credential rejected. Copy the token field from the current local credential."
        : error.status === 426
          ? "The console assets and daemon API are incompatible. Rebuild or reinstall Agent Relay."
          : "The local daemon could not be reached.";
  }
});

elements.search.addEventListener("input", () => {
  model.filters.query = elements.search.value;
  renderSessions();
});

elements.stateFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-state]");
  if (button === null) return;
  model.filters.state = button.dataset.state;
  for (const item of elements.stateFilters.querySelectorAll("[data-state]")) {
    item.classList.toggle("is-active", item === button);
  }
  renderSessions();
});

elements.harnessFilter.addEventListener("change", () => {
  model.filters.harness = elements.harnessFilter.value;
  renderSessions();
});

elements.repositoryFilter.addEventListener("change", () => {
  model.filters.repository = elements.repositoryFilter.value;
  renderSessions();
});

elements.sessionList.addEventListener("click", (event) => {
  const session = event.target.closest("[data-open-session]");
  if (session !== null) {
    openTimeline(session.dataset.sessionKey);
  }
});

elements.timelineList.addEventListener("click", (event) => {
  const entry = event.target.closest("[data-timeline-event]");
  if (entry !== null) {
    void showEventDetail(entry.dataset.timelineEvent);
  }
});

elements.sessionControls.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-session-action]");
  if (button === null || button.disabled) return;
  const session = model.sessions.find(
    ({ sessionKey }) => sessionKey === model.openSessionKey,
  );
  if (session?.latestEventId === undefined) return;
  const action = button.dataset.sessionAction;
  if (action === "details") {
    await showEventDetail(session.latestEventId);
    return;
  }
  button.disabled = true;
  elements.sessionControlStatus.textContent =
    "Committing the exact session action…";
  try {
    const outcome = await mutationApi(
      `/v1/web/sessions/${encodeURIComponent(session.sessionKey)}/actions`,
      {
        schema: "agent-relay-web-session-action.v1",
        operationId: `web_session_${crypto.randomUUID()}`,
        eventId: session.latestEventId,
        action,
      },
    );
    elements.sessionControlStatus.textContent = outcome.ok
      ? action === "end"
        ? "Relay lane ended. The harness process was not terminated."
        : `${action} committed.`
      : outcome.result.outcome === "blocked"
        ? "Answer the pending request before ending this lane."
        : "This control became stale or is unavailable.";
    await refresh();
  } catch {
    elements.sessionControlStatus.textContent =
      "Connection interrupted before the session authority replied.";
    button.disabled = false;
  }
});

elements.closeTimeline.addEventListener("click", closeTimeline);
elements.drawerBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.drawerBackdrop) {
    closeTimeline();
  }
});
elements.closeDetail.addEventListener("click", () => {
  elements.eventDetailPanel.hidden = true;
  elements.privateReveal.hidden = true;
});
elements.revealEvent.addEventListener("click", () => {
  const eventId = elements.revealEvent.dataset.eventId;
  if (eventId !== undefined) {
    void revealEventDetail(eventId);
  }
});

elements.exportDiagnostics.addEventListener("click", async () => {
  elements.exportDiagnostics.disabled = true;
  try {
    const response = await fetch("/v1/web/diagnostics/export?limit=500", {
      headers: { authorization: `Bearer ${model.token}` },
      cache: "no-store",
    });
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
  } catch {
    setConnection(
      "degraded",
      "The sanitized diagnostic export could not be created.",
    );
  } finally {
    elements.exportDiagnostics.disabled = false;
  }
});

function highlightAttention(event) {
  if (
    event.target.closest(
      "form, button, input, textarea, select, label, fieldset",
    ) !== null
  ) {
    return;
  }
  const item = event.target.closest("[data-attention-session]");
  if (item === null) return;
  model.highlightedSession = item.dataset.attentionSession;
  model.filters.state = "all";
  model.filters.harness = "all";
  model.filters.repository = "all";
  model.filters.query = "";
  elements.search.value = "";
  elements.harnessFilter.value = "all";
  elements.repositoryFilter.value = "all";
  for (const filter of elements.stateFilters.querySelectorAll("[data-state]")) {
    filter.classList.toggle("is-active", filter.dataset.state === "all");
  }
  render();
  document
    .querySelector(
      `[data-session-key="${CSS.escape(model.highlightedSession)}"]`,
    )
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

elements.attentionList.addEventListener("click", highlightAttention);
elements.attentionList.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-response-form]");
  if (form === null) return;
  event.preventDefault();
  void submitResponse(form);
});
elements.attentionList.addEventListener("click", (event) => {
  const quick = event.target.closest("[data-quick-continue]");
  const form = quick?.closest("[data-response-form]");
  if (form !== undefined && form !== null) {
    void submitResponse(form, true);
  }
});
elements.attentionList.addEventListener("keydown", (event) => {
  if (
    event.target.closest(
      "form, button, input, textarea, select, label, fieldset",
    ) !== null
  ) {
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    highlightAttention(event);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && model.openSessionKey.length > 0) {
    closeTimeline();
  }
});

setInterval(() => {
  if (
    model.connection !== "disconnected" &&
    model.lastContact > 0 &&
    Date.now() - model.lastContact > 30_000
  ) {
    setConnection("stale");
  }
  if (model.connection !== "disconnected") {
    render();
  }
}, 5_000);
