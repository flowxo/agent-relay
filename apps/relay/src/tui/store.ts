import type { ProjectKey, ProjectReadSessionV1 } from "@agent-relay/core";

import type { WebAttentionItemV1, WebSessionAction } from "../web-contract.js";

import { DashboardClientError } from "./client.js";
import type { DashboardClient, DashboardSnapshotBundle } from "./client.js";
import {
  appendHistoryPage,
  buildAttention,
  buildCurrentGroups,
  buildRail,
  buildResponse,
  describeHoldReason,
  describeTerminalRequest,
  formFields,
  incompleteFormStatus,
  historySummary,
  indexSnapshotSessions,
  isActionAvailable,
  shouldHoldUpdates,
  withFocusedChoice,
} from "./view-model.js";
import type { RailItem, SessionCapability } from "./view-model.js";

export const POLL_INTERVAL_MS = 3_000;
export const SNAPSHOT_MAX_AGE_MS = 60_000;
export const STALE_CONTACT_MS = 30_000;

export type ConnectionState =
  "online" | "reconnecting" | "stale" | "disconnected";

export type DashboardPane =
  "rail" | "list" | "detail" | "filter" | "help" | "form";

export type ListSection = "attention" | "current" | "recent";

export type FormDraft = {
  requestId: string;
  sessionKey: string;
  values: Record<string, string | string[]>;
  fieldIndex: number;
  submitting: boolean;
  status: string;
};

export type ListEntry = {
  section: ListSection;
  sessionKey: string;
  requestId?: string;
};

export interface DashboardViewState {
  connection: ConnectionState;
  renderer: "ink" | "node-host";
  selectedProjectKey: ProjectKey;
  filters: { harness: string; state: string };
  query: string;
  pane: DashboardPane;
  railIndex: number;
  listIndex: number;
  helpOpen: boolean;
  detailOpen: boolean;
  pendingEndSessionKey: string;
  status: string;
  notice: string;
  pendingUpdates: number;
  pendingReason: string;
  lastSync: number;
  lastContact: number;
  historyStale: boolean;
  historyCapped: boolean;
  historyCursor?: string | undefined;
  snapshot?: DashboardSnapshotBundle["snapshot"] | undefined;
  requests: WebAttentionItemV1[];
  capabilities: Map<string, SessionCapability>;
  history: ProjectReadSessionV1[];
  rail: RailItem[];
  list: ListEntry[];
  selectedSession?: ProjectReadSessionV1 | undefined;
  selectedRequest?: WebAttentionItemV1 | undefined;
  draft?: FormDraft | undefined;
}

export interface DashboardStoreOptions {
  client: DashboardClient;
  now?: () => number;
  pollIntervalMs?: number;
  renderer?: "ink" | "node-host";
}

export class DashboardStore {
  public readonly client: DashboardClient;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  private loading = false;
  private polling = false;
  private refreshQueued = false;
  private queuedRefresh: { force?: boolean; resetHistory?: boolean } = {};
  private generation = 0;
  private closed = false;
  private changeCursor = "";
  private pendingBundle: DashboardSnapshotBundle | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  public revision = 0;
  public state: DashboardViewState;

  public constructor(options: DashboardStoreOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.state = {
      connection: "disconnected",
      renderer: options.renderer ?? "ink",
      selectedProjectKey: "all",
      filters: { harness: "all", state: "all" },
      query: "",
      pane: "list",
      railIndex: 0,
      listIndex: 0,
      helpOpen: false,
      detailOpen: false,
      pendingEndSessionKey: "",
      status: "Connecting to the local daemon…",
      notice: "",
      pendingUpdates: 0,
      pendingReason: "",
      lastSync: 0,
      lastContact: 0,
      historyStale: false,
      historyCapped: false,
      requests: [],
      capabilities: new Map(),
      history: [],
      rail: [],
      list: [],
    };
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async start(): Promise<void> {
    await this.refresh({ force: true, resetHistory: true });
    this.startPolling();
    this.clockTimer = setInterval(() => {
      this.evaluateFreshness();
    }, 1_000);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.clockTimer !== undefined) clearInterval(this.clockTimer);
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.pollTimer = undefined;
    this.clockTimer = undefined;
    this.searchTimer = undefined;
  }

  public async refresh(
    options: { force?: boolean; resetHistory?: boolean } = {},
  ): Promise<void> {
    if (this.closed) return;
    if (options.force === true || options.resetHistory === true) {
      this.generation += 1;
    }
    if (this.loading) {
      this.refreshQueued = true;
      this.queuedRefresh = {
        force: this.queuedRefresh.force === true || options.force === true,
        resetHistory:
          this.queuedRefresh.resetHistory === true ||
          options.resetHistory === true,
      };
      return;
    }
    await this.runRefresh(options);
  }

  private async runRefresh(options: {
    force?: boolean;
    resetHistory?: boolean;
  }): Promise<void> {
    if (this.closed || this.loading) return;
    this.loading = true;
    const generation = this.generation;
    try {
      const bundle = await this.client.loadSnapshot({
        projectKey: this.state.selectedProjectKey,
        ...(this.state.filters.harness === "all"
          ? {}
          : { harness: this.state.filters.harness }),
        ...(this.state.filters.state === "all"
          ? {}
          : { state: this.state.filters.state }),
        ...(this.state.query.trim().length === 0
          ? {}
          : { search: this.state.query.trim() }),
      });
      if (generation !== this.generation) return;
      this.lastContact(this.now());
      if (
        options.force !== true &&
        shouldHoldUpdates(this.holdContext()) &&
        this.state.snapshot !== undefined
      ) {
        this.pendingBundle = bundle;
        this.state.pendingUpdates += 1;
        this.state.pendingReason = describeHoldReason(this.holdContext());
        this.emit();
        return;
      }
      this.commit(bundle, options);
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleLoadError(error);
    } finally {
      this.loading = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        const queued = this.queuedRefresh;
        this.queuedRefresh = {};
        void this.runRefresh(queued);
      }
    }
  }

  public applyPendingUpdates(): void {
    if (this.pendingBundle === undefined) return;
    this.commit(this.pendingBundle, {});
  }

  public selectProject(projectKey: ProjectKey): void {
    if (projectKey === this.state.selectedProjectKey) return;
    this.state.selectedProjectKey = projectKey;
    this.state.listIndex = 0;
    this.state.detailOpen = false;
    this.state.draft = undefined;
    void this.refresh({ force: true, resetHistory: true });
  }

  public setFilter(kind: "harness" | "state", value: string): void {
    this.state.filters[kind] = value;
    this.state.listIndex = 0;
    void this.refresh({ force: true, resetHistory: true });
  }

  public setQuery(query: string): void {
    this.state.query = query;
    this.emit();
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.state.listIndex = 0;
      void this.refresh({ force: true, resetHistory: true });
    }, 250);
  }

  public setPane(pane: DashboardPane): void {
    this.state.pane = pane;
    this.state.helpOpen = pane === "help";
    this.emit();
  }

  public moveRail(delta: number): void {
    const next = this.state.railIndex + delta;
    this.state.railIndex = Math.max(
      0,
      Math.min(this.state.rail.length - 1, next),
    );
    this.emit();
  }

  public moveList(delta: number): void {
    const next = this.state.listIndex + delta;
    this.state.listIndex = Math.max(
      0,
      Math.min(this.state.list.length - 1, next),
    );
    this.syncSelection();
    this.emit();
  }

  public moveFormField(delta: number): void {
    if (this.state.draft === undefined) {
      return;
    }
    const max = Math.max(
      0,
      formFields(this.state.selectedRequest?.form).length - 1,
    );
    this.state.draft = {
      ...this.state.draft,
      fieldIndex: Math.max(
        0,
        Math.min(max, this.state.draft.fieldIndex + delta),
      ),
    };
    this.emit();
  }

  public activateSelection(): void {
    if (this.state.pane === "rail") {
      const item = this.state.rail[this.state.railIndex];
      if (item !== undefined) this.selectProject(item.projectKey);
      return;
    }
    if (this.state.selectedRequest !== undefined) {
      this.openForm(this.state.selectedRequest);
      return;
    }
    this.state.detailOpen = true;
    this.emit();
  }

  public openForm(request: WebAttentionItemV1): void {
    if (
      this.state.draft !== undefined &&
      this.state.draft.requestId === request.requestId
    ) {
      this.state.pane = "form";
      this.emit();
      return;
    }
    this.state.draft = {
      requestId: request.requestId,
      sessionKey: request.sessionKey,
      values: {},
      fieldIndex: 0,
      submitting: false,
      status: "",
    };
    this.state.pane = "form";
    this.emit();
  }

  public updateDraft(values: Record<string, string | string[]>): void {
    if (this.state.draft === undefined || this.state.draft.submitting) return;
    this.state.draft = {
      ...this.state.draft,
      values: { ...this.state.draft.values, ...values },
    };
    this.emit();
  }

  public cancelForm(): void {
    this.state.draft = undefined;
    this.state.pane = "list";
    this.emit();
  }

  public async submitForm(): Promise<void> {
    const draft = this.state.draft;
    const request = this.state.requests.find(
      (item) =>
        item.requestId === draft?.requestId &&
        item.sessionKey === draft.sessionKey,
    );
    if (draft === undefined || request === undefined || draft.submitting) {
      if (draft !== undefined && request === undefined) {
        draft.status = "This question is stale or no longer open.";
        this.emit();
      }
      return;
    }
    const values = withFocusedChoice(
      request.form,
      draft.values,
      draft.fieldIndex,
    );
    const incomplete = incompleteFormStatus(request.form, values);
    if (incomplete !== undefined) {
      this.state.draft = {
        ...draft,
        values,
        fieldIndex: incomplete.fieldIndex,
        status: incomplete.message,
      };
      this.emit();
      return;
    }
    const response = buildResponse(request, values);
    if (response === undefined) {
      draft.status =
        "This request cannot be answered from the terminal dashboard.";
      this.emit();
      return;
    }
    draft.submitting = true;
    draft.status = "Submitting through the shared request authority…";
    this.emit();
    const outcome = await this.client.resolveRequest(
      request.requestId,
      request.sessionKey,
      response,
    );
    if (
      this.state.draft === undefined ||
      this.state.draft.requestId !== request.requestId
    ) {
      return;
    }
    if (outcome.requestState !== undefined && outcome.requestState !== "open") {
      this.state.notice = describeTerminalRequest(
        this.state.selectedSession,
        outcome.requestState,
        outcome.resolvedBy ?? "tui",
      );
      this.state.status =
        outcome.requestState === "answered" &&
        (outcome.resolvedBy === "web" || outcome.resolvedBy === "tui")
          ? "Answer committed."
          : "This question was already resolved on another surface.";
      this.state.draft = undefined;
      this.state.pane = "list";
      this.emit();
      await this.refresh({ force: true });
      return;
    }
    this.state.draft.submitting = false;
    this.state.draft.status =
      outcome.status === 422 || outcome.status === 400
        ? "Review the response bounds and complete every required answer."
        : outcome.status === 409
          ? "This form is stale or another surface already handled it."
          : outcome.status === 404
            ? "This question is no longer retained."
            : outcome.status === 0
              ? "Connection interrupted before the request authority replied."
              : "The response could not be committed.";
    this.emit();
  }

  public async runAction(action: WebSessionAction): Promise<void> {
    const session = this.state.selectedSession;
    const capability = session
      ? this.state.capabilities.get(session.sessionKey)
      : undefined;
    if (session === undefined) return;
    if (action === "details") {
      this.state.detailOpen = true;
      this.state.pane = "detail";
      this.emit();
      return;
    }
    if (!isActionAvailable(capability, action)) {
      this.state.status =
        capability === undefined
          ? "Controls load with the newest sessions; this session is outside that window."
          : "Not proven for this harness and retained event.";
      this.emit();
      return;
    }
    if (
      action === "end" &&
      this.state.pendingEndSessionKey !== session.sessionKey
    ) {
      this.state.pendingEndSessionKey = session.sessionKey;
      this.state.status =
        "Ending closes the relay lane for this session. Press e again to confirm.";
      this.emit();
      return;
    }
    this.state.pendingEndSessionKey = "";
    const eventId = capability?.latestEventId;
    if (eventId === undefined) return;
    const outcome = await this.client.runSessionAction(
      session.sessionKey,
      eventId,
      action,
    );
    this.state.status = outcome.ok
      ? action === "end"
        ? "Relay lane ended. The harness process was not terminated."
        : `${action} committed.`
      : outcome.outcome === "blocked"
        ? "Answer the pending question before ending this lane."
        : "This control became stale or is unavailable.";
    this.emit();
    await this.refresh({ force: true });
  }

  public async loadMoreHistory(): Promise<void> {
    const cursor = this.state.historyCursor;
    if (cursor === undefined || this.loading) return;
    this.loading = true;
    try {
      const next = await this.client.loadSnapshot({
        projectKey: this.state.selectedProjectKey,
        historyCursor: cursor,
        ...(this.state.filters.harness === "all"
          ? {}
          : { harness: this.state.filters.harness }),
        ...(this.state.filters.state === "all"
          ? {}
          : { state: this.state.filters.state }),
        ...(this.state.query.trim().length === 0
          ? {}
          : { search: this.state.query.trim() }),
      });
      const merged = appendHistoryPage(
        this.state.history,
        next.snapshot.recent.items,
      );
      this.state.history = merged.items;
      this.state.historyCapped = merged.capped;
      this.state.historyCursor = next.snapshot.recent.nextCursor;
      this.state.capabilities = next.capabilities;
      this.rebuildList();
      this.state.status = `Loaded ${String(merged.added)} more recent sessions.`;
      this.emit();
    } catch (error) {
      if (
        error instanceof DashboardClientError &&
        (error.status === 409 || error.status === 400)
      ) {
        this.state.status =
          "Recent history changed while paging. Reloading the newest page.";
        await this.refresh({ force: true, resetHistory: true });
        return;
      }
      this.handleLoadError(error);
    } finally {
      this.loading = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        const queued = this.queuedRefresh;
        this.queuedRefresh = {};
        void this.runRefresh(queued);
      }
    }
  }

  private commit(
    bundle: DashboardSnapshotBundle,
    options: { resetHistory?: boolean },
  ): void {
    this.pendingBundle = undefined;
    this.state.pendingUpdates = 0;
    this.state.pendingReason = "";
    this.state.snapshot = bundle.snapshot;
    this.state.requests = bundle.requests;
    this.state.capabilities = bundle.capabilities;
    this.state.selectedProjectKey = bundle.snapshot.selectedProjectKey;
    this.changeCursor = bundle.snapshot.changeCursor;
    if (options.resetHistory === true || this.state.history.length === 0) {
      this.state.history = bundle.snapshot.recent.items;
      this.state.historyCursor = bundle.snapshot.recent.nextCursor;
      this.state.historyCapped = false;
      this.state.historyStale = false;
    } else {
      this.state.historyStale = true;
    }
    this.state.connection = "online";
    this.state.lastSync = this.now();
    this.state.lastContact = this.now();
    if (this.state.status.startsWith("Connecting")) {
      this.state.status = "";
    }
    this.rebuildDerived();
    this.emit();
  }

  private rebuildDerived(): void {
    if (this.state.snapshot === undefined) {
      this.state.rail = [];
      this.state.list = [];
      return;
    }
    this.state.rail = buildRail(this.state.snapshot).items;
    const selectedIndex = this.state.rail.findIndex((item) => item.selected);
    if (selectedIndex >= 0) this.state.railIndex = selectedIndex;
    this.rebuildList();
  }

  private rebuildList(): void {
    if (this.state.snapshot === undefined) {
      this.state.list = [];
      return;
    }
    const known = new Map(indexSnapshotSessions(this.state.snapshot));
    for (const session of this.state.history) {
      if (!known.has(session.sessionKey))
        known.set(session.sessionKey, session);
    }
    const attention = buildAttention(
      this.state.snapshot,
      this.state.requests,
      known,
    );
    const current = buildCurrentGroups(this.state.snapshot);
    const recent = this.state.history;
    const list: ListEntry[] = [];
    for (const row of attention.items) {
      if (row.requests.length === 0) {
        list.push({ section: "attention", sessionKey: row.session.sessionKey });
        continue;
      }
      for (const request of row.requests) {
        list.push({
          section: "attention",
          sessionKey: row.session.sessionKey,
          requestId: request.requestId,
        });
      }
    }
    for (const group of current) {
      for (const item of group.sessions) {
        list.push({
          section: "current",
          sessionKey: item.session.sessionKey,
        });
      }
    }
    for (const session of recent) {
      list.push({ section: "recent", sessionKey: session.sessionKey });
    }
    this.state.list = list;
    if (this.state.listIndex >= list.length) {
      this.state.listIndex = Math.max(0, list.length - 1);
    }
    this.syncSelection();
  }

  private syncSelection(): void {
    const entry = this.state.list[this.state.listIndex];
    if (entry === undefined || this.state.snapshot === undefined) {
      this.state.selectedSession = undefined;
      this.state.selectedRequest = undefined;
      return;
    }
    const known = new Map(indexSnapshotSessions(this.state.snapshot));
    for (const session of this.state.history) {
      if (!known.has(session.sessionKey))
        known.set(session.sessionKey, session);
    }
    this.state.selectedSession = known.get(entry.sessionKey);
    this.state.selectedRequest =
      entry.requestId === undefined
        ? undefined
        : this.state.requests.find(
            (request) =>
              request.requestId === entry.requestId &&
              request.sessionKey === entry.sessionKey,
          );
  }

  private holdContext(): {
    hasUnsentDraft: boolean;
    drawerOpen: boolean;
    focusInLiveRegion: boolean;
  } {
    return {
      hasUnsentDraft:
        this.state.draft !== undefined &&
        (this.state.pane === "form" ||
          Object.keys(this.state.draft.values).length > 0),
      drawerOpen: this.state.detailOpen || this.state.helpOpen,
      focusInLiveRegion:
        this.state.pane === "list" || this.state.pane === "form",
    };
  }

  private startPolling(): void {
    const tick = async () => {
      if (this.closed) return;
      await this.pollChanges();
      if (!this.closed) {
        this.pollTimer = setTimeout(() => {
          void tick();
        }, this.pollIntervalMs);
      }
    };
    this.pollTimer = setTimeout(() => {
      void tick();
    }, this.pollIntervalMs);
  }

  private async pollChanges(): Promise<void> {
    if (
      this.polling ||
      this.loading ||
      this.closed ||
      this.changeCursor.length === 0
    ) {
      return;
    }
    this.polling = true;
    const generation = this.generation;
    try {
      const result = await this.client.pollChanges(this.changeCursor);
      if (generation !== this.generation) return;
      this.state.lastContact = this.now();
      this.changeCursor = result.cursor;
      if (
        this.state.connection === "reconnecting" ||
        this.state.connection === "stale"
      ) {
        this.state.connection = "online";
      }
      if (
        result.invalidations.length > 0 ||
        result.hasMore ||
        this.now() - this.state.lastSync >= SNAPSHOT_MAX_AGE_MS
      ) {
        await this.refresh();
      } else {
        this.evaluateFreshness();
        this.emit();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof DashboardClientError && error.status === 401) {
        this.handleLoadError(error);
        return;
      }
      if (
        error instanceof DashboardClientError &&
        (error.status === 409 || error.status === 400)
      ) {
        await this.refresh({ force: true, resetHistory: true });
        return;
      }
      this.state.connection =
        this.state.snapshot === undefined ? "disconnected" : "reconnecting";
      this.emit();
    } finally {
      this.polling = false;
    }
  }

  private evaluateFreshness(): void {
    if (this.state.connection !== "online") return;
    if (this.now() - this.state.lastContact >= STALE_CONTACT_MS) {
      this.state.connection = "stale";
      this.emit();
    }
  }

  private discardTrustedSnapshot(): void {
    this.generation += 1;
    this.changeCursor = "";
    this.pendingBundle = undefined;
    this.state.snapshot = undefined;
    this.state.requests = [];
    this.state.capabilities = new Map();
    this.state.history = [];
    this.state.historyCursor = undefined;
    this.state.historyStale = false;
    this.state.historyCapped = false;
    this.state.rail = [];
    this.state.list = [];
    this.state.selectedSession = undefined;
    this.state.selectedRequest = undefined;
    this.state.draft = undefined;
    this.state.connection = "disconnected";
  }

  private handleLoadError(error: unknown): void {
    if (error instanceof DashboardClientError && error.status === 401) {
      this.discardTrustedSnapshot();
      this.state.status =
        "The protected dashboard rejected the private local credential. Restart the daemon, then rerun agent-relay dashboard.";
      this.emit();
      return;
    }
    if (
      error instanceof DashboardClientError &&
      error.status === 404 &&
      error.code === "project_not_found" &&
      this.state.selectedProjectKey !== "all"
    ) {
      this.state.selectedProjectKey = "all";
      this.state.status =
        "That project has no retained sessions. Showing All projects.";
      void this.refresh({ force: true, resetHistory: true });
      return;
    }
    if (
      error instanceof DashboardClientError &&
      error.status === 503 &&
      error.code === "complete_set_capacity_exceeded"
    ) {
      this.state.status =
        "This machine has more concurrent sessions than the dashboard can show completely. Select one project, or filter by state or harness.";
      this.emit();
      return;
    }
    if (this.state.snapshot === undefined) {
      this.state.connection = "disconnected";
      this.state.status =
        "The local daemon could not be reached. Confirm agent-relay daemon is running, then retry.";
    } else {
      this.state.connection = "reconnecting";
    }
    this.emit();
  }

  private lastContact(value: number): void {
    this.state.lastContact = value;
  }

  private emit(): void {
    if (this.state.snapshot !== undefined) {
      this.state.status =
        this.state.status.length === 0
          ? historySummary(
              this.state.history.length,
              this.state.historyCursor === undefined,
              this.state.historyCapped,
              this.state.history.length,
            )
          : this.state.status;
    }
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
