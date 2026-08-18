/**
 * Pure dashboard view-model and markup builders.
 *
 * Everything here is deterministic and free of DOM, network, and clock access
 * so it can be unit tested directly. Canonical session state always arrives
 * from the protected API; nothing in this module infers activity, decodes an
 * opaque identity, or reads a private field.
 */

export const HARNESS_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};

export const STATE_LABELS = {
  working: "Working",
  needs_input: "Needs input",
  background_work: "Background work",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
  ended: "Ended",
};

export const ATTENTION_STATES = ["needs_input", "failed", "unknown"];

export const HISTORY_PAGE_SIZE = 25;

/** Rendering bound for accumulated history pages. */
export const HISTORY_VIEW_MAX = 1_000;

const STATE_EXPLANATIONS = {
  working: "Work was recently observed or is known to remain in flight.",
  needs_input: "One unresolved operator question or permission is open.",
  background_work: "Foreground work stopped while durable async work remains.",
  idle: "The session is available but no work was observed recently.",
  done: "The latest turn appears complete.",
  failed: "Work explicitly failed.",
  unknown: "Evidence is stale, incomplete, or contradictory.",
  ended: "The durable relay lane was explicitly closed.",
};

/**
 * Neutral words used to render an opaque session key as a readable name. The
 * lists must stay identical to the shared core session-name module so the
 * browser matches Telegram and the TUI. Prefer `session.sessionName` from the
 * protected project-read payload when present.
 */
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
];

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
];

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function harnessLabel(harness) {
  return HARNESS_LABELS[harness] ?? harness;
}

export function stateLabel(session) {
  return session.activity.stateLabel ?? STATE_LABELS[session.activity.state];
}

export function stateExplanation(state) {
  return STATE_EXPLANATIONS[state] ?? STATE_EXPLANATIONS.unknown;
}

function keySlice(sessionKey, start, length) {
  const value = Number.parseInt(
    String(sessionKey).slice(start, start + length),
    16,
  );
  return Number.isFinite(value) ? value : 0;
}

/**
 * Safe, stable, readable session name. It is a fixed rendering of the already
 * opaque public session key, so it never contains a path, a harness session ID,
 * or any other private identifier, and it never changes for a given session.
 * Keep this algorithm identical to the shared core `sessionName` helper.
 */
export function sessionName(sessionKey) {
  const adjective =
    NAME_ADJECTIVES[keySlice(sessionKey, 0, 4) % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[keySlice(sessionKey, 4, 4) % NAME_NOUNS.length];
  const number = String(keySlice(sessionKey, 8, 4) % 100).padStart(2, "0");
  return `${adjective}-${noun}-${number}`;
}

export function sessionTitle(session) {
  return session.sessionName ?? sessionName(session.sessionKey);
}

/** The exact opaque key, shown where precise correlation matters. */
export function sessionReference(session) {
  return String(session.sessionKey);
}

export function relativeTime(timestamp, now) {
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

/**
 * Display-only expiry hint. The daemon remains authoritative for expiry, so a
 * skewed browser clock never disables or hides a control.
 */
export function expiryHint(timestamp, now) {
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

/** Every session carried by one snapshot, keyed by its opaque session key. */
export function indexSnapshotSessions(snapshot) {
  const index = new Map();
  const add = (session) => {
    if (!index.has(session.sessionKey)) index.set(session.sessionKey, session);
  };
  for (const session of snapshot.needsAttention) add(session);
  for (const group of snapshot.currentByHarness) {
    for (const session of group.sessions) add(session);
  }
  for (const session of snapshot.recent.items) add(session);
  return index;
}

export function buildRail(snapshot) {
  const selected = snapshot.selectedProjectKey;
  const toItem = (summary) => ({
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

/**
 * Needs-attention view. Canonical attention sessions come from the protected
 * read model; open requests are correlated by exact opaque session key only.
 * `knownSessions` is every session the page can currently name, including
 * history pages beyond the snapshot's own page.
 */
export function buildAttention(snapshot, requests, knownSessions) {
  const known = knownSessions ?? indexSnapshotSessions(snapshot);
  const scoped = requests.filter((request) => known.has(request.sessionKey));
  const bySession = new Map();
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
  const seen = new Set();
  const items = snapshot.needsAttention.map((session) => {
    seen.add(session.sessionKey);
    return {
      session,
      requests: bySession.get(session.sessionKey) ?? [],
    };
  });
  const strays = [...bySession.entries()]
    .filter(([sessionKey]) => !seen.has(sessionKey))
    .map(([sessionKey, list]) => ({
      session: known.get(sessionKey),
      requests: list,
    }))
    .sort(
      (left, right) =>
        Date.parse(left.requests[0].expiresAt) -
          Date.parse(right.requests[0].expiresAt) ||
        left.session.sessionKey.localeCompare(right.session.sessionKey),
    );
  return {
    items: [...items, ...strays],
    outOfScopeRequestCount: requests.length - scoped.length,
  };
}

/**
 * Current sessions grouped by harness in server order. Attention sessions stay
 * in the complete current set but never render a second answer form.
 */
export function buildCurrentGroups(snapshot) {
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

/** Append one history page without duplicating or reordering earlier rows. */
export function appendHistoryPage(existing, incoming) {
  const seen = new Set(existing.map((session) => session.sessionKey));
  const added = [];
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

/**
 * Local narrowing helper retained for unit tests of safe-field matching.
 * Live dashboards send `q` to the protected project read instead.
 */
export function filterLoadedSessions(sessions, query) {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const haystack = [
      sessionTitle(session),
      session.projectLabel,
      harnessLabel(session.harness),
      stateLabel(session),
      session.sessionKey,
    ]
      .map((value) => String(value).toLocaleLowerCase())
      .join(" ");
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Update policy: nothing moves under the pointer, keyboard focus, an unsent
 * answer, or an open evidence dialog. Held data waits behind an explicit
 * control instead.
 */
export function shouldHoldUpdates(context) {
  return (
    context.focusInLiveRegion === true ||
    context.pointerOnInteractive === true ||
    context.hasUnsentDraft === true ||
    context.drawerOpen === true
  );
}

export function describeHoldReason(context) {
  if (context.hasUnsentDraft === true) {
    return "Updates are waiting so your unsent answer is not cleared.";
  }
  if (context.drawerOpen === true) {
    return "Updates are waiting while the evidence view is open.";
  }
  if (context.focusInLiveRegion === true) {
    return "Updates are waiting so nothing moves under your keyboard focus.";
  }
  return "Updates are waiting so nothing moves under your pointer.";
}

export function attentionAnnouncement(previous, next) {
  if (previous === next) return undefined;
  if (next === 0) return "Nothing needs attention.";
  const noun = next === 1 ? "session needs" : "sessions need";
  return `${String(next)} ${noun} attention.`;
}

export function buildResponse(item, values) {
  if (item.form?.kind === "text") {
    return { kind: "text", text: String(values.value ?? "") };
  }
  if (item.form?.kind === "single-select") {
    return { kind: "option", optionId: String(values.value ?? "") };
  }
  if (item.form?.kind === "multi-select") {
    return {
      kind: "multi-select",
      optionIds: Array.isArray(values.value) ? values.value.map(String) : [],
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

function countsSummary(item) {
  return [
    `${String(item.attentionCount)} needing attention`,
    `${String(item.currentCount)} current`,
    `${String(item.recentCount)} recent`,
  ].join(", ");
}

export function renderRailHtml(rail) {
  return rail.items
    .map(
      (item) => `
        <li>
          <button
            type="button"
            class="rail-button${item.selected ? " is-selected" : ""}"
            data-project-key="${escapeHtml(item.projectKey)}"
            ${item.selected ? 'aria-current="true"' : ""}
          >
            <span class="rail-label">${escapeHtml(item.label)}</span>
            <span class="rail-counts" aria-hidden="true">
              ${
                item.attentionCount > 0
                  ? `<span class="rail-badge is-attention">${escapeHtml(item.attentionCount)}</span>`
                  : ""
              }
              <span class="rail-badge">${escapeHtml(item.currentCount)}</span>
            </span>
            <span class="sr-only">${escapeHtml(countsSummary(item))}</span>
          </button>
        </li>`,
    )
    .join("");
}

function chip(text, className) {
  return `<span class="chip ${escapeHtml(className)}">${escapeHtml(text)}</span>`;
}

function sessionChips(session) {
  return [
    chip(stateLabel(session), `state-${session.activity.state}`),
    chip(harnessLabel(session.harness), "harness"),
    session.deliveryHealth.muted ? chip("Muted delivery", "muted") : "",
  ].join("");
}

function whyDisclosure(session, idPrefix) {
  const confidence =
    session.activity.confidence === "confirmed" ? "Confirmed" : "Inferred";
  return `
    <details class="why" data-why="${escapeHtml(session.sessionKey)}">
      <summary id="${idPrefix}-why">Why this state</summary>
      <p>
        ${escapeHtml(stateExplanation(session.activity.state))}
        ${escapeHtml(confidence)} from ${escapeHtml(session.activity.source)}:
        ${escapeHtml(session.activity.reasonText)}.
      </p>
    </details>`;
}

function sessionFacts(session, now) {
  const facts = [
    ["Last activity", relativeTime(session.activity.lastObservedAt, now)],
    ["Project", session.projectLabel],
  ];
  if (session.knownInFlightWork.count > 0) {
    facts.push([
      "In-flight work",
      `${String(session.knownInFlightWork.count)} item${session.knownInFlightWork.count === 1 ? "" : "s"}`,
    ]);
  }
  if (session.pendingInteraction.state === "waiting") {
    facts.push([
      "Pending interaction",
      `${String(session.pendingInteraction.count)} waiting`,
    ]);
  }
  return `
    <dl class="facts">
      ${facts
        .map(
          ([term, value]) =>
            `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join("")}
    </dl>`;
}

const SESSION_ACTION_LABELS = {
  details: "Details",
  continue: "Continue",
  mute: "Mute",
  end: "End",
};

/**
 * Session controls are advertised by the protected API. Unsupported controls
 * stay visible but disabled, and their reason is exposed to assistive
 * technology instead of living only in a hover tooltip.
 */
export function renderSessionActionsHtml(session, capability, options = {}) {
  const scope = options.scope ?? "current";
  const supported = new Set(capability?.supportedActions ?? []);
  const hasEvent = capability?.latestEventId !== undefined;
  const reasonId = `reason-${scope}-${session.sessionKey}`;
  const reason =
    capability === undefined
      ? "Controls load with the newest sessions; this session is outside that window."
      : "Not proven for this harness and retained event.";
  const anyDisabled = ["details", "continue", "mute", "end"].some(
    (action) => !(supported.has(action) && hasEvent),
  );
  return `
    <div class="session-actions" role="group" aria-label="${escapeHtml(
      `Controls for ${sessionTitle(session)}`,
    )}">
      ${["details", "continue", "mute", "end"]
        .map((action) => {
          const available = supported.has(action) && hasEvent;
          return `<button
              type="button"
              class="session-action${action === "end" ? " is-destructive" : ""}"
              data-session-action="${escapeHtml(action)}"
              data-session-key="${escapeHtml(session.sessionKey)}"
              data-session-scope="${escapeHtml(scope)}"
              ${
                available
                  ? ""
                  : `disabled title="${escapeHtml(reason)}" aria-describedby="${escapeHtml(reasonId)}"`
              }
            >${escapeHtml(SESSION_ACTION_LABELS[action])}</button>`;
        })
        .join("")}
      ${
        anyDisabled
          ? `<span class="sr-only" id="${escapeHtml(reasonId)}">${escapeHtml(reason)}</span>`
          : ""
      }
    </div>`;
}

function optionFields(options, type, name) {
  return options
    .map(
      (option) => `
        <label class="response-option">
          <input
            type="${escapeHtml(type)}"
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

function renderQuestion(question, requestId) {
  const name = `question:${question.questionId}`;
  const controlId = `q-${requestId}-${question.questionId}`;
  if (question.kind === "free-text") {
    return `
      <fieldset data-question="${escapeHtml(question.questionId)}">
        <legend><label for="${escapeHtml(controlId)}">${escapeHtml(question.prompt)}</label></legend>
        <textarea
          id="${escapeHtml(controlId)}"
          name="${escapeHtml(name)}"
          minlength="${escapeHtml(question.minLength)}"
          maxlength="${escapeHtml(question.maxLength)}"
          ${question.multiline ? "" : 'rows="2"'}
          required
        ></textarea>
      </fieldset>`;
  }
  const type = question.kind === "multi-select" ? "checkbox" : "radio";
  const bounds =
    question.kind === "multi-select"
      ? ` · choose ${String(question.minSelections)}–${String(question.maxSelections)}`
      : "";
  return `
    <fieldset data-question="${escapeHtml(question.questionId)}">
      <legend>${escapeHtml(question.prompt)}${escapeHtml(bounds)}</legend>
      ${optionFields(questionOptions(question), type, name)}
    </fieldset>`;
}

export function renderRequestHtml(item, now) {
  const expiry = expiryHint(item.expiresAt, now);
  const head = `
    <div class="request-head">
      <span class="chip request-kind">${escapeHtml(item.requestKind)}</span>
      <span class="request-expiry${expiry.elapsed ? " is-elapsed" : ""}">
        ${escapeHtml(expiry.text)}
      </span>
    </div>
    <p class="request-prompt">${escapeHtml(item.promptPreview)}</p>
    ${
      expiry.elapsed
        ? `<p class="request-note">This question is past its expiry on this
             browser's clock. The daemon decides whether it is still open.</p>`
        : ""
    }`;
  const form = item.form;
  if (form === undefined) {
    return `
      <div class="request" data-request="${escapeHtml(item.requestId)}">
        ${head}
        <p class="unsupported-response">
          This request is visible but cannot be answered from the local
          dashboard.
        </p>
      </div>`;
  }
  let fields;
  if (form.kind === "text") {
    fields = `
      <label class="sr-only" for="response-${escapeHtml(item.requestId)}">
        Response
      </label>
      <textarea
        id="response-${escapeHtml(item.requestId)}"
        name="response"
        minlength="${escapeHtml(form.minLength)}"
        maxlength="${escapeHtml(form.maxLength)}"
        required
      ></textarea>`;
  } else if (form.kind === "single-select") {
    fields = `<fieldset><legend class="sr-only">Choose one</legend>${optionFields(
      form.options,
      "radio",
      "response",
    )}</fieldset>`;
  } else if (form.kind === "multi-select") {
    fields = `
      <fieldset>
        <legend>Choose ${escapeHtml(form.minSelections)}–${escapeHtml(form.maxSelections)}</legend>
        ${optionFields(form.options, "checkbox", "response")}
      </fieldset>`;
  } else {
    fields = `
      <p class="question-set-title">${escapeHtml(form.title)}</p>
      ${form.questions
        .map((question) => renderQuestion(question, item.requestId))
        .join("")}`;
  }
  const quickContinue = item.supportedActions.includes("continue")
    ? '<button type="button" data-quick-continue>Continue</button>'
    : "";
  return `
    <div class="request" data-request="${escapeHtml(item.requestId)}">
      ${head}
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
      </form>
    </div>`;
}

export function renderAttentionHtml(view, options) {
  const now = options.now;
  return view.items
    .map(({ session, requests }) => {
      const titleId = `attention-${session.sessionKey}`;
      const capability = options.capabilities.get(session.sessionKey);
      return `
        <article
          class="attention-card"
          data-attention-session="${escapeHtml(session.sessionKey)}"
          aria-labelledby="${escapeHtml(titleId)}"
          tabindex="-1"
        >
          <header class="card-head">
            <h3 id="${escapeHtml(titleId)}">${escapeHtml(sessionTitle(session))}</h3>
            <span class="chips">${sessionChips(session)}</span>
          </header>
          ${sessionFacts(session, now)}
          ${whyDisclosure(session, escapeHtml(titleId))}
          ${
            requests.length === 0
              ? `<p class="attention-reason">${escapeHtml(
                  session.activity.state === "needs_input"
                    ? "A question is open for this session. Its controls load with the request list."
                    : `This session needs a look: ${stateLabel(session)}.`,
                )}</p>`
              : requests.map((item) => renderRequestHtml(item, now)).join("")
          }
          ${renderSessionActionsHtml(session, capability, { scope: "attention" })}
        </article>`;
    })
    .join("");
}

export function renderCurrentGroupsHtml(groups, options) {
  const now = options.now;
  return groups
    .map((group) => {
      const groupId = `harness-${group.harness}`;
      return `
        <section class="harness-group" aria-labelledby="${escapeHtml(groupId)}">
          <h3 class="harness-heading" id="${escapeHtml(groupId)}">
            ${escapeHtml(harnessLabel(group.harness))}
            <span class="harness-count">
              ${escapeHtml(group.sessions.length)}
              ${escapeHtml(group.sessions.length === 1 ? "session" : "sessions")}
            </span>
          </h3>
          <div class="session-grid">
            ${group.sessions
              .map(({ session, needsAttention }) => {
                const titleId = `current-${session.sessionKey}`;
                const capability = options.capabilities.get(session.sessionKey);
                return `
                  <article
                    class="session-card${needsAttention ? " is-attention" : ""}"
                    data-session-card="${escapeHtml(session.sessionKey)}"
                    aria-labelledby="${escapeHtml(titleId)}"
                  >
                    <header class="card-head">
                      <h4 id="${escapeHtml(titleId)}">${escapeHtml(sessionTitle(session))}</h4>
                      <span class="chips">${sessionChips(session)}</span>
                    </header>
                    ${sessionFacts(session, now)}
                    ${whyDisclosure(session, escapeHtml(titleId))}
                    ${
                      needsAttention
                        ? `<p class="attention-pointer">
                             <button type="button" data-goto-attention="${escapeHtml(
                               session.sessionKey,
                             )}">Answer in Needs attention</button>
                           </p>`
                        : ""
                    }
                    ${renderSessionActionsHtml(session, capability, { scope: "current" })}
                  </article>`;
              })
              .join("")}
          </div>
        </section>`;
    })
    .join("");
}

export function renderHistoryRowsHtml(sessions, options) {
  const now = options.now;
  return sessions
    .map((session) => {
      const capability = options.capabilities.get(session.sessionKey);
      const reasonId = `reason-history-${session.sessionKey}`;
      const unavailable = capability?.latestEventId === undefined;
      return `
        <tr role="row" data-history-session="${escapeHtml(session.sessionKey)}">
          <th role="rowheader" scope="row">${escapeHtml(sessionTitle(session))}</th>
          <td role="cell" data-label="Project">${escapeHtml(session.projectLabel)}</td>
          <td role="cell" data-label="Harness">${escapeHtml(harnessLabel(session.harness))}</td>
          <td role="cell" data-label="State">
            <span class="chip state-${escapeHtml(session.activity.state)}">
              ${escapeHtml(stateLabel(session))}
            </span>
          </td>
          <td role="cell" data-label="Last activity">
            <time datetime="${escapeHtml(session.activity.lastObservedAt)}">
              ${escapeHtml(relativeTime(session.activity.lastObservedAt, now))}
            </time>
          </td>
          <td role="cell" data-label="Controls">
            <button
              type="button"
              class="session-action"
              data-session-action="details"
              data-session-key="${escapeHtml(session.sessionKey)}"
              data-session-scope="history"
              ${
                unavailable
                  ? `disabled title="Retained evidence for this session is outside the loaded window." aria-describedby="${escapeHtml(reasonId)}"`
                  : ""
              }
            >Details</button>
            ${
              unavailable
                ? `<span class="sr-only" id="${escapeHtml(reasonId)}">Retained evidence for this session is outside the loaded window.</span>`
                : ""
            }
          </td>
        </tr>`;
    })
    .join("");
}

/** Bounded, safe projection of one event detail. Paths and branches never render. */
export function renderEventDetailHtml(event) {
  const rows = [
    ["Event", event.eventId],
    ["Type", event.type],
    ["Harness", `${harnessLabel(event.harness)} · ${event.surface}`],
    ["Harness version", event.harnessVersion],
    ["Occurred", event.occurredAt],
    ["Delivery", event.deliveryStatus],
  ];
  if (event.summary !== undefined) rows.push(["Summary", event.summary]);
  if (event.failure !== undefined) {
    rows.push(["Failure", `${event.failure.code}: ${event.failure.message}`]);
  }
  if (event.request !== undefined) {
    rows.push(["Request", `${event.request.kind} · ${event.request.state}`]);
  }
  return `
    <dl class="detail-list">
      ${rows
        .map(
          ([term, value]) =>
            `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join("")}
    </dl>`;
}

export function renderTimelineHtml(timeline, options) {
  const now = options.now;
  return timeline
    .map(
      (entry) => `
        <li>
          <button
            class="timeline-entry"
            type="button"
            ${
              entry.eventId === undefined
                ? 'disabled title="This row has no retained event to open."'
                : `data-timeline-event="${escapeHtml(entry.eventId)}"`
            }
          >
            <span class="timeline-marker ${escapeHtml(entry.kind)}" aria-hidden="true"></span>
            <span class="timeline-body">
              <span class="timeline-entry-head">
                <strong>${escapeHtml(entry.kind)} · ${escapeHtml(entry.label)}</strong>
                <time datetime="${escapeHtml(entry.at)}">${escapeHtml(
                  relativeTime(entry.at, now),
                )}</time>
              </span>
              <span class="timeline-status">${escapeHtml(entry.status)}</span>
              ${
                entry.eventId === undefined
                  ? '<span class="sr-only">No retained event to open.</span>'
                  : ""
              }
            </span>
          </button>
        </li>`,
    )
    .join("");
}

export function renderNoticesHtml(notices) {
  return notices
    .map(
      (notice) =>
        `<li class="resolution-notice">${escapeHtml(notice.label)}</li>`,
    )
    .join("");
}

/**
 * Describes a request that left the open set. `state` must be a terminal state
 * the server reported; an unverified disappearance is reported as exactly that
 * rather than claimed as an answer.
 */
export function describeTerminalRequest(session, state, resolvedBy) {
  const where =
    resolvedBy === undefined
      ? ""
      : ` in ${resolvedBy === "web" ? "this browser" : resolvedBy}`;
  const title = session === undefined ? "A session" : sessionTitle(session);
  const outcome = {
    answered: `was answered${where}`,
    expired: "expired before it was answered",
    cancelled: "was cancelled by the agent",
    failed: "could not be completed",
    unverified: "is no longer open; the daemon did not report how it ended",
  };
  return `${title}: the open question ${outcome[state] ?? `is now ${state}`}.`;
}

export function historySummary(loaded, exhausted, capped, filtered) {
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
