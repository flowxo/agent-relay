import {
  createMachineCredentialMaterial,
  WHOOSHBANG_MACHINE_SCOPES,
} from "@agent-relay/whooshbang-transport";
import { describe, expect, it } from "vitest";

import {
  authorizeWhooshBangMachine,
  WhooshBangOAuthBootstrapError,
} from "./whooshbang-oauth.js";

import type {
  MachineCredentialMaterial,
  WhooshBangFetch,
} from "@agent-relay/whooshbang-transport";

const BASE_URL = "https://whooshbang.mock.test/";
const OAUTH_ACCESS_TOKEN = "oauth-access-private-synthetic";
const PRIVATE_REMOTE_DETAIL = "private-remote-detail-synthetic";
const MACHINE_CLIENT_ID = "machine_client_synthetic_001";
const MACHINE_ID = "machine_synthetic_a";
const NOTIFIER_ID = "default";
const SUBSCRIBER_ID = "agent_relay_operator";
const PROJECT_ID = "project_synthetic";

type ResponseMode = "malformed" | "ok" | "redirect";

interface FlowOptions {
  cleanup?: ResponseMode;
  contextScopes?: readonly string[];
  dcr?: ResponseMode;
  machineMutator?: (machine: Record<string, unknown>) => void;
  pollFails?: boolean;
  token?: ResponseMode;
  toolFails?: boolean;
  toolFailsOnce?: boolean;
}

interface ObservedRequest {
  authorization?: string;
  body?: string;
  idempotencyKey?: string;
  method: string;
  path: string;
  redirect: string;
}

function json(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redirect(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "https://private-redirect.invalid/secret" },
  });
}

function rpc(id: unknown, result: Record<string, unknown>): Response {
  return json({ id, jsonrpc: "2.0", result });
}

function machineClient(): Record<string, unknown> {
  return {
    binding_id: "binding_synthetic_relay",
    created_at: "2026-08-10T14:00:00.000Z",
    display_name: "Synthetic Agent Relay",
    environment: "test",
    id: MACHINE_CLIENT_ID,
    machine_id: MACHINE_ID,
    notifier_id: NOTIFIER_ID,
    project_id: PROJECT_ID,
    revoked_at: "2026-08-10T14:01:00.000Z",
    scope_summary: WHOOSHBANG_MACHINE_SCOPES,
    status: "revoked",
    subscriber_id: SUBSCRIBER_ID,
    updated_at: "2026-08-10T14:01:00.000Z",
  };
}

class SyntheticOAuthFlow {
  public readonly cleanupPaths: string[] = [];
  public readonly observed: ObservedRequest[] = [];
  public authorizationUrl?: URL;
  public createArguments?: Record<string, unknown>;
  public initializedProtocol?: unknown;
  public registration?: Record<string, unknown>;
  public tokenParameters?: URLSearchParams;
  public stateMismatch = false;
  public toolCalls = 0;

  public constructor(
    private readonly material: MachineCredentialMaterial,
    private readonly options: FlowOptions = {},
  ) {}

  public readonly openAuthorization = async (input: {
    authorizationUrl: URL;
  }): Promise<void> => {
    this.authorizationUrl = new URL(input.authorizationUrl);
    const redirectUri = this.authorizationUrl.searchParams.get("redirect_uri");
    const state = this.authorizationUrl.searchParams.get("state");
    if (redirectUri === null || state === null) {
      throw new Error("Synthetic authorization URL is incomplete.");
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "private-authorization-code");
    callback.searchParams.set(
      "state",
      this.stateMismatch ? "private-wrong-state" : state,
    );
    await fetch(callback);
  };

  public readonly fetch: WhooshBangFetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.body === null ? undefined : await request.clone().text();
    const authorization = request.headers.get("authorization");
    const idempotencyKey = request.headers.get("idempotency-key");
    this.observed.push({
      ...(authorization === null ? {} : { authorization }),
      ...(body === undefined ? {} : { body }),
      ...(idempotencyKey === null ? {} : { idempotencyKey }),
      method: request.method,
      path: url.pathname,
      redirect: request.redirect,
    });

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: `${BASE_URL}oauth/authorize`,
        code_challenge_methods_supported: ["S256"],
        registration_endpoint: `${BASE_URL}oauth/register`,
        token_endpoint: `${BASE_URL}oauth/token`,
      });
    }
    if (url.pathname === "/oauth/register") {
      this.registration = JSON.parse(body ?? "null") as Record<string, unknown>;
      if (this.options.dcr === "redirect") {
        return redirect();
      }
      if (this.options.dcr === "malformed") {
        return json(
          {
            client_id: PRIVATE_REMOTE_DETAIL,
            client_secret: "private-client-secret",
          },
          201,
        );
      }
      return json(
        { client_id: "client_synthetic", token_endpoint_auth_method: "none" },
        201,
      );
    }
    if (url.pathname === "/oauth/token") {
      this.tokenParameters = new URLSearchParams(body);
      if (this.options.token === "redirect") {
        return redirect();
      }
      if (this.options.token === "malformed") {
        return json({
          access_token: OAUTH_ACCESS_TOKEN,
          detail: PRIVATE_REMOTE_DETAIL,
          scope: "projects:read",
          token_type: "Bearer",
        });
      }
      return json({
        access_token: OAUTH_ACCESS_TOKEN,
        scope: "projects:read machine-clients:write",
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/mcp") {
      const message = JSON.parse(body ?? "null") as Record<string, unknown>;
      if (message["method"] === "initialize") {
        this.initializedProtocol = (
          message["params"] as Record<string, unknown>
        )["protocolVersion"];
        return rpc(message["id"], {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "whooshbang", version: "synthetic" },
        });
      }
      const parameters = message["params"] as Record<string, unknown>;
      if (parameters["name"] === "whooshbang_list_context") {
        return rpc(message["id"], {
          structuredContent: {
            granted_scopes: this.options.contextScopes ?? [
              "projects:read",
              "machine-clients:write",
            ],
            projects: [
              {
                environments: [
                  {
                    environment: "test",
                    environment_id: "environment_synthetic_test",
                    status: "active",
                  },
                ],
                project_id: PROJECT_ID,
                slug: "synthetic-project",
                status: "active",
              },
            ],
          },
        });
      }
      if (parameters["name"] === "whooshbang_create_machine_client") {
        this.toolCalls += 1;
        this.createArguments = parameters["arguments"] as Record<
          string,
          unknown
        >;
        if (
          this.options.toolFails === true ||
          (this.options.toolFailsOnce === true && this.toolCalls === 1)
        ) {
          return rpc(message["id"], {
            isError: true,
            structuredContent: {
              error: { code: "transient", retryable: true },
              detail: PRIVATE_REMOTE_DETAIL,
            },
          });
        }
        const machine: Record<string, unknown> = {
          binding_id: "binding_synthetic_relay",
          credential: {
            created_at: "2026-08-10T14:00:00.000Z",
            credential_id: this.material.credentialId,
            registered_by: "machine",
            scope_summary: WHOOSHBANG_MACHINE_SCOPES,
            status: "active",
          },
          environment: "test",
          environment_id: "environment_synthetic_test",
          machine_client_id: MACHINE_CLIENT_ID,
          machine_id: MACHINE_ID,
          notifier_id: NOTIFIER_ID,
          project_id: PROJECT_ID,
          scope_summary: WHOOSHBANG_MACHINE_SCOPES,
          status: "active",
          subscriber_id: SUBSCRIBER_ID,
        };
        this.options.machineMutator?.(machine);
        return rpc(message["id"], { structuredContent: machine });
      }
      return json({ detail: PRIVATE_REMOTE_DETAIL }, 500);
    }
    if (url.pathname === "/v1/machine-events") {
      if (this.options.pollFails === true) {
        return json({ detail: PRIVATE_REMOTE_DETAIL });
      }
      return json({
        committed_cursor: null,
        events: [],
        schema: "whooshbang.machine-events.v1",
        server_time: "2026-08-10T14:00:01.000Z",
      });
    }
    if (
      url.pathname ===
      `/v1/projects/${PROJECT_ID}/environments/environment_synthetic_test/machine-clients/${MACHINE_CLIENT_ID}/revoke`
    ) {
      this.cleanupPaths.push(url.pathname);
      if (this.options.cleanup === "redirect") {
        return redirect();
      }
      if (this.options.cleanup === "malformed") {
        return json({ id: "private-other-client", status: "active" });
      }
      return json(machineClient());
    }
    return json({ detail: PRIVATE_REMOTE_DETAIL }, 404);
  };
}

async function fixture(options: FlowOptions = {}) {
  const material = await createMachineCredentialMaterial();
  const flow = new SyntheticOAuthFlow(material, options);
  const execute = async () =>
    await authorizeWhooshBangMachine({
      baseUrl: BASE_URL,
      callbackTimeoutMs: 2_000,
      createCredentialMaterial: async () => material,
      displayName: "Synthetic Agent Relay",
      environment: "test",
      fetch: flow.fetch,
      machineId: MACHINE_ID,
      notifierId: NOTIFIER_ID,
      now: () => new Date("2026-08-10T14:00:02.000Z"),
      openAuthorization: flow.openAuthorization,
      projectSelector: "synthetic-project",
      subscriberId: SUBSCRIBER_ID,
    });
  return { execute, flow, material };
}

async function safeError(execute: () => Promise<unknown>) {
  try {
    await execute();
  } catch (error) {
    expect(error).toBeInstanceOf(WhooshBangOAuthBootstrapError);
    return error as WhooshBangOAuthBootstrapError;
  }
  throw new Error("Expected OAuth bootstrap to fail.");
}

function expectNoPrivateError(
  error: WhooshBangOAuthBootstrapError,
  material: MachineCredentialMaterial,
): void {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const secret of [
    material.bearerToken,
    material.registration.secret_sha256,
    OAUTH_ACCESS_TOKEN,
    PRIVATE_REMOTE_DETAIL,
    "private-authorization-code",
    "private-wrong-state",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("WhooshBang OAuth machine bootstrap", () => {
  it("binds loopback first, uses exact OAuth scopes and S256, creates digest-only, and proves the narrow credential", async () => {
    const { execute, flow, material } = await fixture();

    const result = await execute();

    expect(result).toMatchObject({
      configuration: {
        baseUrl: BASE_URL,
        bindingId: "binding_synthetic_relay",
        connectedAt: "2026-08-10T14:00:02.000Z",
        contractVersion: "1.0.0-rc.12",
        environment: "test",
        environmentId: "environment_synthetic_test",
        machineClientId: MACHINE_CLIENT_ID,
        notifierId: NOTIFIER_ID,
        projectId: PROJECT_ID,
        scopeSummary: WHOOSHBANG_MACHINE_SCOPES,
        subscriberId: SUBSCRIBER_ID,
      },
      credential: {
        bearerToken: material.bearerToken,
        createdAt: "2026-08-10T14:00:00.000Z",
        credentialId: material.credentialId,
      },
      proof: {
        authorization: "oauth-authorization-code-s256",
        grantedScopes: ["projects:read", "machine-clients:write"],
        machineScopeCount: 4,
        mcpProtocolVersion: "2025-11-25",
        narrowPollSchema: "whooshbang.machine-events.v1",
        projectResolvedBy: "slug",
      },
    });
    expect(flow.registration).toEqual({
      client_name: "Agent Relay",
      grant_types: ["authorization_code"],
      redirect_uris: [
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u),
      ],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(flow.authorizationUrl?.searchParams.get("scope")).toBe(
      "projects:read machine-clients:write",
    );
    expect(
      flow.authorizationUrl?.searchParams.get("code_challenge_method"),
    ).toBe("S256");
    expect(flow.authorizationUrl?.searchParams.has("code_verifier")).toBe(
      false,
    );
    expect(flow.initializedProtocol).toBe("2025-11-25");
    expect(flow.tokenParameters?.get("code_verifier")).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect(flow.createArguments).toEqual({
      credential_id: material.registration.credential_id,
      display_name: "Synthetic Agent Relay",
      environment: "test",
      machine_id: MACHINE_ID,
      notifier_id: NOTIFIER_ID,
      project_id: PROJECT_ID,
      secret_sha256: material.registration.secret_sha256,
      subscriber_id: SUBSCRIBER_ID,
    });
    expect(
      flow.observed.every((request) => request.redirect === "manual"),
    ).toBe(true);
    expect(flow.cleanupPaths).toEqual([]);

    const safeResult = JSON.stringify({
      configuration: result.configuration,
      proof: result.proof,
    });
    expect(safeResult).not.toContain(material.bearerToken);
    expect(safeResult).not.toContain(material.registration.secret_sha256);
    expect(safeResult).not.toContain(OAUTH_ACCESS_TOKEN);
  });

  it("offers one idempotent opaque cleanup after successful provisioning", async () => {
    const { execute, flow, material } = await fixture();
    const result = await execute();

    const first = result.cleanupProvisioned();
    const second = result.cleanupProvisioned();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(flow.cleanupPaths).toEqual([
      `/v1/projects/${PROJECT_ID}/environments/environment_synthetic_test/machine-clients/${MACHINE_CLIENT_ID}/revoke`,
    ]);
    const cleanup = flow.observed.find(
      (request) => request.path === flow.cleanupPaths[0],
    );
    expect(cleanup).toMatchObject({
      authorization: `Bearer ${OAUTH_ACCESS_TOKEN}`,
      idempotencyKey: expect.stringMatching(
        /^agent-relay-oauth-cleanup-client-[a-f0-9]{64}$/u,
      ),
      method: "POST",
      redirect: "manual",
    });
    expect(
      flow.observed.some((request) => request.path.includes("/credentials/")),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(OAUTH_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(
      material.registration.secret_sha256,
    );
  });

  it("reports an environment-scoped cleanup response that cannot be verified", async () => {
    const { execute, flow } = await fixture({ cleanup: "malformed" });
    const result = await execute();

    const first = result.cleanupProvisioned();
    const second = result.cleanupProvisioned();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(false);
    expect(flow.cleanupPaths).toHaveLength(1);
    expect(
      flow.observed.some((request) => request.path.includes("/credentials/")),
    ).toBe(false);
  });

  it("selects the only active project when no private selector is supplied", async () => {
    const material = await createMachineCredentialMaterial();
    const flow = new SyntheticOAuthFlow(material);

    const result = await authorizeWhooshBangMachine({
      baseUrl: BASE_URL,
      callbackTimeoutMs: 2_000,
      createCredentialMaterial: async () => material,
      environment: "test",
      fetch: flow.fetch,
      machineId: MACHINE_ID,
      notifierId: NOTIFIER_ID,
      openAuthorization: flow.openAuthorization,
      subscriberId: SUBSCRIBER_ID,
    });

    expect(result.proof.projectResolvedBy).toBe("only-active");
    expect(flow.createArguments?.["project_id"]).toBe(PROJECT_ID);
  });

  it.each([
    {
      label: "returned scope",
      mutate: (machine: Record<string, unknown>) => {
        machine["scope_summary"] = WHOOSHBANG_MACHINE_SCOPES.slice(0, 3);
      },
    },
    {
      label: "returned identity",
      privateValue: "private-cross-machine-identity",
      mutate: (machine: Record<string, unknown>) => {
        machine["machine_id"] = "private-cross-machine-identity";
      },
    },
    {
      label: "returned project",
      privateValue: "private-cross-project-identity",
      mutate: (machine: Record<string, unknown>) => {
        machine["project_id"] = "private-cross-project-identity";
      },
    },
    {
      label: "returned environment",
      privateValue: "private-cross-environment-identity",
      mutate: (machine: Record<string, unknown>) => {
        machine["environment_id"] = "private-cross-environment-identity";
      },
    },
    {
      label: "returned subscriber",
      privateValue: "private-cross-subscriber-identity",
      mutate: (machine: Record<string, unknown>) => {
        machine["subscriber_id"] = "private-cross-subscriber-identity";
      },
    },
  ])(
    "rejects a mismatched $label and revokes the environment-scoped client",
    async ({ mutate, privateValue }) => {
      const { execute, flow, material } = await fixture({
        machineMutator: mutate,
      });

      const error = await safeError(execute);

      expect(error).toMatchObject({
        cleanupIncomplete: false,
        code: "whooshbang-machine-registration-failed",
      });
      expect(flow.cleanupPaths).toHaveLength(1);
      expectNoPrivateError(error, material);
      if (privateValue !== undefined) {
        expect(
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
        ).not.toContain(privateValue);
      }
    },
  );

  it("rejects a mismatched callback state before token exchange", async () => {
    const { execute, flow, material } = await fixture();
    flow.stateMismatch = true;

    const error = await safeError(execute);

    expect(error.code).toBe("whooshbang-oauth-authorization-failed");
    expect(flow.tokenParameters).toBeUndefined();
    expect(flow.cleanupPaths).toEqual([]);
    expectNoPrivateError(error, material);
  });

  it("replays one idempotent machine create after a tool failure", async () => {
    const { execute, flow } = await fixture({ toolFailsOnce: true });

    await expect(execute()).resolves.toMatchObject({
      configuration: { machineClientId: MACHINE_CLIENT_ID },
    });
    expect(flow.toolCalls).toBe(2);
  });

  it("reports cleanup uncertainty when both idempotent create attempts fail", async () => {
    const { execute, flow, material } = await fixture({ toolFails: true });

    const error = await safeError(execute);

    expect(error).toMatchObject({
      cleanupIncomplete: true,
      code: "whooshbang-machine-registration-failed",
    });
    expect(flow.toolCalls).toBe(2);
    expect(flow.cleanupPaths).toEqual([]);
    expectNoPrivateError(error, material);
  });

  it("revokes the environment-scoped client when narrow polling fails", async () => {
    const { execute, flow, material } = await fixture({ pollFails: true });

    const error = await safeError(execute);

    expect(error).toMatchObject({
      cleanupIncomplete: false,
      code: "whooshbang-machine-verification-failed",
    });
    expect(flow.cleanupPaths).toHaveLength(1);
    expectNoPrivateError(error, material);
  });

  it("marks automatic compensation incomplete when client revoke fails", async () => {
    const { execute, flow, material } = await fixture({
      cleanup: "redirect",
      pollFails: true,
    });

    const error = await safeError(execute);

    expect(error).toMatchObject({
      cleanupIncomplete: true,
      code: "whooshbang-machine-verification-failed",
    });
    expect(flow.cleanupPaths).toHaveLength(1);
    expectNoPrivateError(error, material);
  });

  it.each(["malformed", "redirect"] as const)(
    "rejects a %s DCR response without following it",
    async (dcr) => {
      const { execute, flow, material } = await fixture({ dcr });

      const error = await safeError(execute);

      expect(error.code).toBe("whooshbang-oauth-registration-failed");
      expect(flow.tokenParameters).toBeUndefined();
      expectNoPrivateError(error, material);
    },
  );

  it.each(["malformed", "redirect"] as const)(
    "rejects a %s token response without following it",
    async (token) => {
      const { execute, flow, material } = await fixture({ token });

      const error = await safeError(execute);

      expect(error.code).toBe("whooshbang-oauth-token-failed");
      expect(flow.cleanupPaths).toEqual([]);
      expectNoPrivateError(error, material);
    },
  );

  it("fails closed when MCP context omits an exact authorization scope", async () => {
    const { execute, flow, material } = await fixture({
      contextScopes: ["projects:read"],
    });

    const error = await safeError(execute);

    expect(error.code).toBe("whooshbang-mcp-failed");
    expect(flow.createArguments).toBeUndefined();
    expectNoPrivateError(error, material);
  });
});
