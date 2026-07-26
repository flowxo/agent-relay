/* global AbortController, CSS, FormData, Option, TextDecoder, clearTimeout, document, fetch, setInterval, setTimeout */

import {
  filterSessions,
  mergeCursor,
  parseSseBlock,
  reconcileSessions,
  sortAttention,
  summarizeSessions,
} from "./state.js";

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
};

const model = {
  token: "",
  sessions: [],
  attention: [],
  cursor: 0,
  connection: "disconnected",
  lastSync: 0,
  lastContact: 0,
  highlightedSession: "",
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
        <article class="session-card ${
          model.highlightedSession === session.sessionKey
            ? "is-highlighted"
            : ""
        }" data-session-key="${escapeHtml(session.sessionKey)}">
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
        </article>`,
    )
    .join("");
}

function renderAttention() {
  elements.attentionCount.textContent = `${model.attention.length} open`;
  elements.attentionEmpty.hidden = model.attention.length !== 0;
  elements.attentionList.hidden = model.attention.length === 0;
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
          class="attention-item"
          tabindex="0"
          data-attention-session="${escapeHtml(item.sessionKey)}"
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
        </article>`;
    })
    .join("");
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
  const [sessionResult, attentionResult] = await Promise.all([
    api("/v1/web/sessions?limit=500"),
    api("/v1/web/attention?limit=500"),
  ]);
  model.sessions = reconcileSessions(sessionResult.sessions);
  model.attention = sortAttention(attentionResult.attention);
  model.lastSync = Date.now();
  model.lastContact = model.lastSync;
  model.reconnectAttempt = 0;
  setConnection("connected");
  render();
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
  elements.connectError.textContent = "";
  try {
    await refresh();
    elements.connectForm.reset();
    elements.connectPanel.hidden = true;
    elements.console.hidden = false;
    reconnectStream();
  } catch (error) {
    model.token = "";
    elements.connectError.textContent =
      error.status === 401
        ? "Credential rejected. Copy the token field from the current local credential."
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

function highlightAttention(event) {
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
elements.attentionList.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    highlightAttention(event);
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
