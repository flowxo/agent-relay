import type {
  AgentAttentionEventV1,
  RelayDiagnosticV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
} from "@agent-relay/protocol";

import type {
  DiagnosticIngestResult,
  DrainResult,
  IngestResult,
  PendingRequestRecord,
  ReplyRouteResult,
  ResumeClaimResult,
  ResumeCommandRecord,
  ResolutionResult,
  SessionRecord,
  StoreStatus,
} from "@agent-relay/core";
import type { Harness } from "@agent-relay/protocol";

export class RelayClientError extends Error {
  public override readonly name = "RelayClientError";

  public constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface RelayClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  telegramWebhookSecret?: string;
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly telegramWebhookSecret: string | undefined;

  public constructor(options: RelayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4317").replace(
      /\/$/,
      "",
    );
    this.token = options.token;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.telegramWebhookSecret = options.telegramWebhookSecret;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(this.token === undefined
            ? {}
            : { authorization: `Bearer ${this.token}` }),
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      throw new RelayClientError(
        timedOut
          ? "relay daemon request timed out"
          : "relay daemon is unavailable",
        timedOut ? "daemon-timeout" : "daemon-unavailable",
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new RelayClientError(
        `relay daemon returned non-JSON status ${response.status}`,
        "daemon-malformed-response",
        response.status,
      );
    }
    if (!response.ok) {
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      throw new RelayClientError(
        typeof record["message"] === "string"
          ? record["message"]
          : `relay daemon returned status ${response.status}`,
        typeof record["code"] === "string"
          ? record["code"]
          : "daemon-request-failed",
        response.status,
      );
    }
    return body as T;
  }

  public async ingest(event: AgentAttentionEventV1): Promise<IngestResult> {
    return await this.request<IngestResult>("/v1/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  public async reportDiagnostic(
    diagnostic: RelayDiagnosticV1,
  ): Promise<DiagnosticIngestResult> {
    return await this.request<DiagnosticIngestResult>("/v1/diagnostics", {
      method: "POST",
      body: JSON.stringify(diagnostic),
    });
  }

  public async listDiagnostics(limit = 100): Promise<RelayDiagnosticV1[]> {
    const result = await this.request<{ diagnostics: RelayDiagnosticV1[] }>(
      `/v1/diagnostics?limit=${encodeURIComponent(String(limit))}`,
    );
    return result.diagnostics;
  }

  public async registerSession(session: SessionRegistrationV1): Promise<void> {
    await this.request<{ registered: true }>("/v1/sessions/register", {
      method: "POST",
      body: JSON.stringify(session),
    });
  }

  public async heartbeat(
    heartbeat: SessionHeartbeatV1,
  ): Promise<{ updated: boolean }> {
    return await this.request<{ updated: boolean }>("/v1/sessions/heartbeat", {
      method: "POST",
      body: JSON.stringify(heartbeat),
    });
  }

  public async listSessionsByBridge(input: {
    machineId: string;
    bridgeSessionId: string;
    harness: Harness;
  }): Promise<SessionRecord[]> {
    const result = await this.request<{ sessions: SessionRecord[] }>(
      "/v1/sessions/by-bridge",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return result.sessions;
  }

  public async drain(limit = 50): Promise<DrainResult> {
    return await this.request<DrainResult>("/v1/deliveries/drain", {
      method: "POST",
      body: JSON.stringify({ limit }),
    });
  }

  public async status(): Promise<
    StoreStatus & { transport: string; healthy: true }
  > {
    return await this.request<
      StoreStatus & { transport: string; healthy: true }
    >("/v1/status");
  }

  public async getRequest(
    correlationId: string,
  ): Promise<PendingRequestRecord | undefined> {
    const result = await this.request<{
      request?: PendingRequestRecord;
    }>(`/v1/requests/${encodeURIComponent(correlationId)}`);
    return result.request;
  }

  public async waitForAnswer(
    correlationId: string,
    timeoutMs: number,
    pollIntervalMs = 100,
  ): Promise<PendingRequestRecord | undefined> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const request = await this.getRequest(correlationId);
      if (request === undefined || request.state !== "open") {
        return request;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return request;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      });
    } while (Date.now() <= deadline);
    return await this.getRequest(correlationId);
  }

  public async resolveTerminal(input: {
    correlationId: string;
    answer: string;
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
    };
  }): Promise<ResolutionResult> {
    return await this.request<ResolutionResult>(
      `/v1/requests/${encodeURIComponent(input.correlationId)}/resolve-terminal`,
      {
        method: "POST",
        body: JSON.stringify({
          answer: input.answer,
          expected: input.expected,
        }),
      },
    );
  }

  public async handleTelegramUpdate(
    update: unknown,
  ): Promise<ReplyRouteResult> {
    return await this.request<ReplyRouteResult>("/v1/telegram/updates", {
      method: "POST",
      headers:
        this.telegramWebhookSecret === undefined
          ? {}
          : {
              "x-telegram-bot-api-secret-token": this.telegramWebhookSecret,
            },
      body: JSON.stringify(update),
    });
  }

  public async claimNextResume(input: {
    machineId: string;
    bridgeSessionId: string;
    harness: Harness;
    ownerId: string;
  }): Promise<ResumeClaimResult> {
    return await this.request<ResumeClaimResult>("/v1/resumes/claim", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  public async markResumeStarted(
    correlationId: string,
    ownerId: string,
  ): Promise<ResumeCommandRecord> {
    return await this.request<ResumeCommandRecord>(
      `/v1/resumes/${encodeURIComponent(correlationId)}/started`,
      {
        method: "POST",
        body: JSON.stringify({ ownerId }),
      },
    );
  }

  public async markResumeFinished(input: {
    correlationId: string;
    ownerId: string;
    succeeded: boolean;
    exitCode?: number;
    signal?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<ResumeCommandRecord> {
    const { correlationId, ...body } = input;
    return await this.request<ResumeCommandRecord>(
      `/v1/resumes/${encodeURIComponent(correlationId)}/finished`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }
}
