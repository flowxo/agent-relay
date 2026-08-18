import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ProjectReadChangesV1Schema,
  ProjectReadSnapshotV1Schema,
} from "@agent-relay/core";
import type {
  ProjectKey,
  ProjectReadChangesV1,
  ProjectReadSnapshotV1,
} from "@agent-relay/core";

import { DashboardLaunchError } from "../dashboard.js";
import { assertLocalMcpDaemonUrl } from "../mcp-server.js";
import {
  WEB_API_VERSION,
  WEB_ASSET_VERSION,
  WebAttentionItemV1Schema,
  WebEventDetailV1Schema,
  WebMetaV1Schema,
  WebSessionSummaryV2Schema,
} from "../web-contract.js";
import type {
  WebAttentionItemV1,
  WebEventDetailV1,
  WebResolveRequestV1,
  WebSessionAction,
  WebSessionSummaryV2,
} from "../web-contract.js";
import { readWebCredential } from "../web-credential.js";
import type { WebCredential } from "../web-credential.js";

import { HISTORY_PAGE_SIZE } from "./view-model.js";
import type { SessionCapability } from "./view-model.js";

export class DashboardClientError extends Error {
  public override readonly name = "DashboardClientError";

  public constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface DashboardSnapshotBundle {
  snapshot: ProjectReadSnapshotV1;
  requests: WebAttentionItemV1[];
  capabilities: Map<string, SessionCapability>;
}

export interface ResolveOutcome {
  ok: boolean;
  status: number;
  outcome?: string;
  requestState?: string;
  resolvedBy?: string;
  replayed?: boolean;
}

export interface SessionActionOutcome {
  ok: boolean;
  status: number;
  outcome?: string;
}

export interface DashboardClient {
  origin: string;
  loadSnapshot(query: {
    projectKey: ProjectKey;
    harness?: string;
    state?: string;
    search?: string;
    historyCursor?: string;
  }): Promise<DashboardSnapshotBundle>;
  pollChanges(cursor: string): Promise<ProjectReadChangesV1>;
  loadEvent(eventId: string): Promise<WebEventDetailV1>;
  resolveRequest(
    requestId: string,
    sessionKey: string,
    response: WebResolveRequestV1["response"],
    operationId?: string,
  ): Promise<ResolveOutcome>;
  runSessionAction(
    sessionKey: string,
    eventId: string,
    action: Exclude<WebSessionAction, "details">,
    operationId?: string,
  ): Promise<SessionActionOutcome>;
}

function persistentHeaders(
  origin: string,
  credential: WebCredential,
  mutation: boolean,
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.token}`,
    origin,
    ...(mutation
      ? {
          "content-type": "application/json",
          "x-agent-relay-csrf": credential.csrfToken,
        }
      : {}),
  };
}

async function readJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new DashboardClientError(
      0,
      "dashboard-daemon-unavailable",
      "The local Agent Relay daemon is unavailable. Start it with agent-relay daemon, then retry.",
    );
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = undefined;
  }
  return { response, body };
}

function errorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = body.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function createDashboardClient(options: {
  daemonUrl: string;
  stateDirectory: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  webCredentialPath?: string;
}): Promise<DashboardClient> {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  let origin: string;
  try {
    origin = assertLocalMcpDaemonUrl(options.daemonUrl);
  } catch {
    throw new DashboardLaunchError(
      "dashboard-loopback-required",
      "The dashboard accepts only an exact loopback HTTP daemon URL. Public listeners and tunnels are unsupported.",
    );
  }

  let credential: WebCredential;
  try {
    credential = await readWebCredential(
      options.webCredentialPath ??
        join(options.stateDirectory, "web-credential.json"),
    );
  } catch {
    throw new DashboardLaunchError(
      "dashboard-credential-unavailable",
      "The private local web credential is unavailable or unsafe. Restart the daemon with the intended state directory, repair the mode-0600 credential file, then retry.",
    );
  }

  const meta = await readJson(
    fetchImplementation,
    `${origin}/v1/web/meta`,
    { headers: persistentHeaders(origin, credential, false) },
    timeoutMs,
  );
  if (!meta.response.ok || !WebMetaV1Schema.safeParse(meta.body).success) {
    throw new DashboardLaunchError(
      "dashboard-app-not-ready",
      meta.response.status === 401
        ? "The protected dashboard rejected the private local credential. Restart the daemon with the intended state directory, then retry."
        : "The protected dashboard assets and API are not compatible or ready. Restart or reinstall Agent Relay, then retry.",
    );
  }
  const parsedMeta = WebMetaV1Schema.parse(meta.body);
  if (
    parsedMeta.apiVersion !== WEB_API_VERSION ||
    parsedMeta.assetVersion !== WEB_ASSET_VERSION
  ) {
    throw new DashboardLaunchError(
      "dashboard-app-not-ready",
      "The packaged dashboard and daemon disagree on the API/asset version. Rebuild or reinstall Agent Relay and restart the daemon.",
    );
  }

  const request = async (
    path: string,
    init: RequestInit,
    mutation: boolean,
  ): Promise<{ response: Response; body: unknown }> => {
    return await readJson(
      fetchImplementation,
      `${origin}${path}`,
      {
        ...init,
        headers: {
          ...persistentHeaders(origin, credential, mutation),
          ...(init.headers ?? {}),
        },
      },
      timeoutMs,
    );
  };

  return {
    origin,
    async loadSnapshot(query) {
      const params = new URLSearchParams();
      params.set("project", query.projectKey);
      params.set("limit", String(HISTORY_PAGE_SIZE));
      if (query.harness !== undefined) params.set("harness", query.harness);
      if (query.state !== undefined) params.set("state", query.state);
      if (query.search !== undefined && query.search.trim().length > 0) {
        params.set("q", query.search.trim());
      }
      if (query.historyCursor !== undefined) {
        params.set("cursor", query.historyCursor);
      }
      const [projects, sessions, attention] = await Promise.all([
        request(`/v1/web/projects?${params.toString()}`, {}, false),
        request("/v1/web/sessions?limit=500", {}, false),
        request("/v1/web/attention?limit=500", {}, false),
      ]);
      if (!projects.response.ok) {
        throw new DashboardClientError(
          projects.response.status,
          errorCode(projects.body),
          "The project snapshot failed.",
        );
      }
      if (!sessions.response.ok || !attention.response.ok) {
        throw new DashboardClientError(
          sessions.response.ok
            ? attention.response.status
            : sessions.response.status,
          errorCode(sessions.response.ok ? attention.body : sessions.body),
          "The dashboard control set failed to load.",
        );
      }
      const snapshot = ProjectReadSnapshotV1Schema.parse(projects.body);
      const sessionRecord =
        typeof sessions.body === "object" &&
        sessions.body !== null &&
        "sessions" in sessions.body
          ? sessions.body.sessions
          : [];
      const attentionRecord =
        typeof attention.body === "object" &&
        attention.body !== null &&
        "attention" in attention.body
          ? attention.body.attention
          : [];
      const parsedSessions =
        WebSessionSummaryV2Schema.array().parse(sessionRecord);
      const requests = WebAttentionItemV1Schema.array().parse(attentionRecord);
      const capabilities = new Map<string, SessionCapability>(
        parsedSessions.map((session: WebSessionSummaryV2) => [
          session.sessionKey,
          {
            supportedActions: session.supportedActions,
            ...(session.latestEventId === undefined
              ? {}
              : { latestEventId: session.latestEventId }),
          },
        ]),
      );
      return { snapshot, requests, capabilities };
    },
    async pollChanges(cursor) {
      const result = await request(
        `/v1/web/project-changes?cursor=${encodeURIComponent(cursor)}`,
        {},
        false,
      );
      if (!result.response.ok) {
        throw new DashboardClientError(
          result.response.status,
          errorCode(result.body),
          "The project change cursor could not be read.",
        );
      }
      return ProjectReadChangesV1Schema.parse(result.body);
    },
    async loadEvent(eventId) {
      const result = await request(
        `/v1/web/events/${encodeURIComponent(eventId)}`,
        {},
        false,
      );
      if (!result.response.ok) {
        throw new DashboardClientError(
          result.response.status,
          errorCode(result.body),
          "The event detail could not be read.",
        );
      }
      return WebEventDetailV1Schema.parse(
        typeof result.body === "object" &&
          result.body !== null &&
          "event" in result.body
          ? result.body.event
          : result.body,
      );
    },
    async resolveRequest(requestId, sessionKey, response, operationId) {
      const result = await request(
        `/v1/web/requests/${encodeURIComponent(requestId)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            schema: "agent-relay-web-resolve.v1",
            operationId: operationId ?? `tui_response_${randomUUID()}`,
            sessionKey,
            response,
          }),
        },
        true,
      );
      const body =
        typeof result.body === "object" && result.body !== null
          ? (result.body as Record<string, unknown>)
          : {};
      return {
        ok: result.response.ok,
        status: result.response.status,
        ...(typeof body["outcome"] === "string"
          ? { outcome: body["outcome"] }
          : {}),
        ...(typeof body["requestState"] === "string"
          ? { requestState: body["requestState"] }
          : {}),
        ...(typeof body["resolvedBy"] === "string"
          ? { resolvedBy: body["resolvedBy"] }
          : {}),
        ...(typeof body["replayed"] === "boolean"
          ? { replayed: body["replayed"] }
          : {}),
      };
    },
    async runSessionAction(sessionKey, eventId, action, operationId) {
      const result = await request(
        `/v1/web/sessions/${encodeURIComponent(sessionKey)}/actions`,
        {
          method: "POST",
          body: JSON.stringify({
            schema: "agent-relay-web-session-action.v1",
            operationId: operationId ?? `tui_session_${randomUUID()}`,
            eventId,
            action,
          }),
        },
        true,
      );
      const body =
        typeof result.body === "object" && result.body !== null
          ? (result.body as Record<string, unknown>)
          : {};
      return {
        ok: result.response.ok,
        status: result.response.status,
        ...(typeof body["outcome"] === "string"
          ? { outcome: body["outcome"] }
          : {}),
      };
    },
  };
}
