import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

export const WEB_BOOTSTRAP_TTL_MS = 60_000;
export const WEB_SESSION_IDLE_TTL_MS = 30 * 60_000;
export const WEB_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;

const DEFAULT_MAX_ACTIVE_GRANTS = 64;
const DEFAULT_MAX_ACTIVE_SESSIONS = 128;
const TOMBSTONE_TTL_MS = 2 * WEB_BOOTSTRAP_TTL_MS;

export const WebBootstrapGrantSchema = z
  .string()
  .regex(/^webboot_[A-Za-z0-9_-]{43}$/u);

export const WebSessionTokenSchema = z
  .string()
  .regex(/^websession_[A-Za-z0-9_-]{43}$/u);

export const WebBootstrapCreateSchema = z
  .object({
    schema: z.literal("agent-relay-web-bootstrap-create.v1"),
  })
  .strict();

export const WebBootstrapExchangeSchema = z
  .object({
    schema: z.literal("agent-relay-web-bootstrap-exchange.v1"),
    grant: WebBootstrapGrantSchema,
  })
  .strict();

export const WebBootstrapRevokeSchema = z
  .object({
    schema: z.literal("agent-relay-web-bootstrap-revoke.v1"),
    grant: WebBootstrapGrantSchema,
  })
  .strict();

export const WebBootstrapGrantResponseSchema = z
  .object({
    schema: z.literal("agent-relay-web-bootstrap-grant.v1"),
    grant: WebBootstrapGrantSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const WebBrowserSessionResponseSchema = z
  .object({
    schema: z.literal("agent-relay-web-browser-session.v1"),
    csrfToken: z.string().min(32).max(128),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface WebBrowserScope {
  origin: string;
  host: string;
}

interface GrantRecord extends WebBrowserScope {
  expiresAt: number;
}

interface GrantTombstone {
  reason: "expired" | "replayed" | "revoked" | "scope";
  expiresAt: number;
}

interface SessionRecord {
  host: string;
  csrfToken: string;
  createdAt: number;
  idleExpiresAt: number;
}

export class WebSessionAuthorityError extends Error {
  public override readonly name = "WebSessionAuthorityError";

  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WebSessionAuthorityOptions {
  now?: () => Date;
  bootstrapTtlMs?: number;
  sessionIdleTtlMs?: number;
  sessionAbsoluteTtlMs?: number;
  maxActiveGrants?: number;
  maxActiveSessions?: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export class WebSessionAuthority {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly grantTombstones = new Map<string, GrantTombstone>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => Date;
  private readonly bootstrapTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private readonly maxActiveGrants: number;
  private readonly maxActiveSessions: number;

  public constructor(options: WebSessionAuthorityOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.bootstrapTtlMs = positiveInteger(
      options.bootstrapTtlMs ?? WEB_BOOTSTRAP_TTL_MS,
      "web bootstrap TTL",
    );
    this.sessionIdleTtlMs = positiveInteger(
      options.sessionIdleTtlMs ?? WEB_SESSION_IDLE_TTL_MS,
      "web session idle TTL",
    );
    this.sessionAbsoluteTtlMs = positiveInteger(
      options.sessionAbsoluteTtlMs ?? WEB_SESSION_ABSOLUTE_TTL_MS,
      "web session absolute TTL",
    );
    this.maxActiveGrants = positiveInteger(
      options.maxActiveGrants ?? DEFAULT_MAX_ACTIVE_GRANTS,
      "maximum active web grants",
    );
    this.maxActiveSessions = positiveInteger(
      options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS,
      "maximum active web sessions",
    );
  }

  private timestamp(): number {
    return this.now().getTime();
  }

  private prune(now: number): void {
    for (const [key, record] of this.grants) {
      if (record.expiresAt <= now) {
        this.grants.delete(key);
        this.grantTombstones.set(key, {
          reason: "expired",
          expiresAt: now + TOMBSTONE_TTL_MS,
        });
      }
    }
    for (const [key, record] of this.grantTombstones) {
      if (record.expiresAt <= now) this.grantTombstones.delete(key);
    }
    for (const [key, record] of this.sessions) {
      const absoluteExpiresAt = record.createdAt + this.sessionAbsoluteTtlMs;
      if (record.idleExpiresAt <= now || absoluteExpiresAt <= now) {
        this.sessions.delete(key);
      }
    }
  }

  public issueGrant(
    scope: WebBrowserScope,
  ): z.infer<typeof WebBootstrapGrantResponseSchema> {
    const now = this.timestamp();
    this.prune(now);
    if (this.grants.size >= this.maxActiveGrants) {
      throw new WebSessionAuthorityError(
        429,
        "web-bootstrap-capacity",
        "too many local dashboard launches are pending; wait for an earlier launch to expire",
      );
    }
    const grant = secret("webboot_");
    const expiresAt = now + this.bootstrapTtlMs;
    this.grants.set(digest(grant), { ...scope, expiresAt });
    return WebBootstrapGrantResponseSchema.parse({
      schema: "agent-relay-web-bootstrap-grant.v1",
      grant,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  public exchangeGrant(
    rawGrant: string,
    scope: WebBrowserScope,
  ): {
    sessionToken: string;
    session: z.infer<typeof WebBrowserSessionResponseSchema>;
  } {
    const parsed = WebBootstrapGrantSchema.safeParse(rawGrant);
    if (!parsed.success) {
      throw new WebSessionAuthorityError(
        400,
        "web-bootstrap-malformed",
        "the local dashboard bootstrap grant is malformed",
      );
    }
    const now = this.timestamp();
    const key = digest(parsed.data);
    const record = this.grants.get(key);
    if (record === undefined) {
      const tombstone = this.grantTombstones.get(key);
      if (tombstone?.reason === "expired") {
        throw new WebSessionAuthorityError(
          410,
          "web-bootstrap-expired",
          "the local dashboard bootstrap grant expired; run agent-relay dashboard --web again",
        );
      }
      if (tombstone !== undefined) {
        throw new WebSessionAuthorityError(
          409,
          "web-bootstrap-replayed",
          "the local dashboard bootstrap grant was already consumed; run agent-relay dashboard --web again",
        );
      }
      throw new WebSessionAuthorityError(
        401,
        "web-bootstrap-invalid",
        "the local dashboard bootstrap grant is stale or invalid; run agent-relay dashboard --web again",
      );
    }

    this.grants.delete(key);
    this.grantTombstones.set(key, {
      reason: "replayed",
      expiresAt: now + TOMBSTONE_TTL_MS,
    });
    if (record.expiresAt <= now) {
      this.grantTombstones.set(key, {
        reason: "expired",
        expiresAt: now + TOMBSTONE_TTL_MS,
      });
      throw new WebSessionAuthorityError(
        410,
        "web-bootstrap-expired",
        "the local dashboard bootstrap grant expired; run agent-relay dashboard --web again",
      );
    }
    if (record.host !== scope.host) {
      this.grantTombstones.set(key, {
        reason: "scope",
        expiresAt: now + TOMBSTONE_TTL_MS,
      });
      throw new WebSessionAuthorityError(
        403,
        "web-bootstrap-host-rejected",
        "the local dashboard bootstrap host does not match its launch scope",
      );
    }
    if (record.origin !== scope.origin) {
      this.grantTombstones.set(key, {
        reason: "scope",
        expiresAt: now + TOMBSTONE_TTL_MS,
      });
      throw new WebSessionAuthorityError(
        403,
        "web-bootstrap-origin-rejected",
        "the local dashboard bootstrap origin does not match its launch scope",
      );
    }

    this.prune(now);
    if (this.sessions.size >= this.maxActiveSessions) {
      throw new WebSessionAuthorityError(
        429,
        "web-session-capacity",
        "too many local browser sessions are active; wait for idle expiry or restart the daemon, then retry",
      );
    }
    const sessionToken = secret("websession_");
    const csrfToken = randomBytes(32).toString("base64url");
    const absoluteExpiresAt = now + this.sessionAbsoluteTtlMs;
    const expiresAt = Math.min(now + this.sessionIdleTtlMs, absoluteExpiresAt);
    this.sessions.set(digest(sessionToken), {
      host: scope.host,
      csrfToken,
      createdAt: now,
      idleExpiresAt: expiresAt,
    });
    return {
      sessionToken,
      session: WebBrowserSessionResponseSchema.parse({
        schema: "agent-relay-web-browser-session.v1",
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
      }),
    };
  }

  public revokeGrant(rawGrant: string): void {
    const parsed = WebBootstrapGrantSchema.safeParse(rawGrant);
    if (!parsed.success) return;
    const now = this.timestamp();
    const key = digest(parsed.data);
    this.grants.delete(key);
    this.grantTombstones.set(key, {
      reason: "revoked",
      expiresAt: now + TOMBSTONE_TTL_MS,
    });
  }

  public authorizeSession(
    rawToken: string | undefined,
    host: string,
  ): z.infer<typeof WebBrowserSessionResponseSchema> {
    const parsed = WebSessionTokenSchema.safeParse(rawToken);
    if (!parsed.success) {
      throw new WebSessionAuthorityError(
        401,
        "web-session-missing",
        "the local browser session is missing; run agent-relay dashboard --web",
      );
    }
    const now = this.timestamp();
    const key = digest(parsed.data);
    const record = this.sessions.get(key);
    if (record === undefined) {
      throw new WebSessionAuthorityError(
        401,
        "web-session-expired",
        "the local browser session expired or the daemon restarted; run agent-relay dashboard --web",
      );
    }
    const absoluteExpiresAt = record.createdAt + this.sessionAbsoluteTtlMs;
    if (record.idleExpiresAt <= now || absoluteExpiresAt <= now) {
      this.sessions.delete(key);
      throw new WebSessionAuthorityError(
        401,
        "web-session-expired",
        "the local browser session expired or the daemon restarted; run agent-relay dashboard --web",
      );
    }
    if (record.host !== host) {
      throw new WebSessionAuthorityError(
        403,
        "web-session-host-rejected",
        "the local browser session does not match this loopback host",
      );
    }
    record.idleExpiresAt = Math.min(
      now + this.sessionIdleTtlMs,
      absoluteExpiresAt,
    );
    return WebBrowserSessionResponseSchema.parse({
      schema: "agent-relay-web-browser-session.v1",
      csrfToken: record.csrfToken,
      expiresAt: new Date(record.idleExpiresAt).toISOString(),
    });
  }
}
