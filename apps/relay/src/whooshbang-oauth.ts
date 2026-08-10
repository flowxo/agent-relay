import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  createMachineCredentialMaterial,
  normalizeWhooshBangBaseUrl,
  WHOOSHBANG_CONTRACT_VERSION,
  WHOOSHBANG_MACHINE_SCOPES,
  WhooshBangMachineInteractionSource,
} from "@agent-relay/whooshbang-transport";

import type { AddressInfo } from "node:net";
import type {
  MachineCredentialMaterial,
  WhooshBangConnectionConfiguration,
  WhooshBangConnectionCredential,
  WhooshBangFetch,
} from "@agent-relay/whooshbang-transport";

const OAUTH_SCOPES = ["projects:read", "machine-clients:write"] as const;
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_OAUTH_JSON_BYTES = 64 * 1024;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_PAGES = 20;

type BootstrapStage =
  | "configuration"
  | "discovery"
  | "registration"
  | "authorization"
  | "token"
  | "mcp"
  | "machine"
  | "verification";

export type WhooshBangOAuthConnectionConfiguration = Omit<
  WhooshBangConnectionConfiguration,
  "canaryDiagnosticId" | "canaryMessageId"
> & {
  /** The environment identifier resolved from OAuth-authorized MCP context. */
  environmentId: string;
};

export interface WhooshBangOAuthProof {
  authorization: "oauth-authorization-code-s256";
  grantedScopes: typeof OAUTH_SCOPES;
  mcpProtocolVersion: typeof MCP_PROTOCOL_VERSION;
  machineScopeCount: 4;
  narrowPollSchema: "whooshbang.machine-events.v1";
  projectResolvedBy: "id" | "only-active" | "slug";
}

export interface WhooshBangOAuthMachineResult {
  /**
   * One-shot compensation for a caller that cannot durably store the returned
   * credential. The OAuth token remains private inside this closure.
   */
  cleanupProvisioned: () => Promise<boolean>;
  configuration: WhooshBangOAuthConnectionConfiguration;
  credential: WhooshBangConnectionCredential;
  proof: WhooshBangOAuthProof;
}

export interface WhooshBangAuthorizationRequest {
  authorizationUrl: URL;
  signal: AbortSignal;
}

export interface AuthorizeWhooshBangMachineOptions {
  baseUrl: string | URL;
  /**
   * Project id or slug. When omitted, bootstrap proceeds only if exactly one
   * visible active project has the requested active environment.
   */
  projectSelector?: string;
  environment: "test" | "live";
  machineId: string;
  notifierId: string;
  subscriberId: string;
  displayName?: string;
  fetch?: WhooshBangFetch;
  openAuthorization?: (
    request: WhooshBangAuthorizationRequest,
  ) => Promise<void> | void;
  callbackTimeoutMs?: number;
  createCredentialMaterial?: (resolved: {
    environmentId: string;
    projectId: string;
  }) => Promise<MachineCredentialMaterial>;
  now?: () => Date;
}

export class WhooshBangOAuthBootstrapError extends Error {
  public override readonly name = "WhooshBangOAuthBootstrapError";

  public constructor(
    message: string,
    public readonly code:
      | "whooshbang-oauth-configuration-invalid"
      | "whooshbang-oauth-discovery-failed"
      | "whooshbang-oauth-registration-failed"
      | "whooshbang-oauth-authorization-failed"
      | "whooshbang-oauth-token-failed"
      | "whooshbang-mcp-failed"
      | "whooshbang-machine-registration-failed"
      | "whooshbang-machine-verification-failed",
    public readonly cleanupIncomplete = false,
  ) {
    super(message);
  }
}

interface OAuthMetadata {
  authorizationEndpoint: URL;
  registrationEndpoint: URL;
  tokenEndpoint: URL;
}

interface OAuthTokens {
  accessToken: string;
  scopes: typeof OAUTH_SCOPES;
}

interface CallbackListener {
  redirectUri: string;
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => Promise<void>;
}

interface McpProjectEnvironment {
  environment: "test" | "live";
  environmentId: string;
  status: string;
}

interface McpProject {
  environments: McpProjectEnvironment[];
  projectId: string;
  slug: string;
  status: string;
}

interface RegisteredMachine {
  bindingId: string;
  credentialCreatedAt: string;
  credentialId: string;
  environment: "test" | "live";
  environmentId: string;
  machineClientId: string;
  machineId: string;
  notifierId: string;
  projectId: string;
  scopes: typeof WHOOSHBANG_MACHINE_SCOPES;
  subscriberId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

function pathSegment(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    boundedString(value, 128) === undefined
  ) {
    throw new Error("path-segment");
  }
  return encodeURIComponent(value);
}

function visibleCredential(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    /^[\u0021-\u007e]+$/u.test(value)
    ? value
    : undefined;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item) => typeof item === "string") &&
    expected.every((item) => value.includes(item))
  );
}

function noRedirectFetch(
  fetchImplementation?: WhooshBangFetch,
): WhooshBangFetch {
  const runtimeFetch = fetchImplementation ?? globalThis.fetch;
  if (typeof runtimeFetch !== "function") {
    throw new WhooshBangOAuthBootstrapError(
      "A Fetch-compatible implementation is required.",
      "whooshbang-oauth-configuration-invalid",
    );
  }
  const bound = runtimeFetch.bind(globalThis);
  return async (input, init) =>
    await bound(input, { ...init, redirect: "manual" });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new Error("response-size");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("response-body");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      length += item.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response-size");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("response-json");
  }
}

function jsonMediaType(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

async function jsonRequest(
  fetchImplementation: WhooshBangFetch,
  url: URL,
  init: RequestInit,
  expectedStatus: number,
  maximumBytes = MAX_JSON_BYTES,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal =
    init.signal === undefined || init.signal === null
      ? timeout
      : AbortSignal.any([init.signal, timeout]);
  const response = await fetchImplementation(url, {
    ...init,
    redirect: "manual",
    signal,
  });
  if (
    response.status !== expectedStatus ||
    (response.status >= 300 && response.status < 400) ||
    !jsonMediaType(response)
  ) {
    throw new Error("response-status");
  }
  return await readBoundedJson(response, maximumBytes);
}

function sameOriginEndpoint(value: unknown, origin: string): URL | undefined {
  if (typeof value !== "string" || value.length > 2_048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.origin === origin &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

async function discoverOAuth(
  baseUrl: URL,
  fetchImplementation: WhooshBangFetch,
): Promise<OAuthMetadata> {
  const value = await jsonRequest(
    fetchImplementation,
    new URL("/.well-known/oauth-authorization-server", baseUrl),
    { headers: { accept: "application/json" }, method: "GET" },
    200,
    MAX_OAUTH_JSON_BYTES,
  );
  if (!isRecord(value)) {
    throw new Error("metadata-shape");
  }
  const authorizationEndpoint = sameOriginEndpoint(
    value["authorization_endpoint"],
    baseUrl.origin,
  );
  const registrationEndpoint = sameOriginEndpoint(
    value["registration_endpoint"],
    baseUrl.origin,
  );
  const tokenEndpoint = sameOriginEndpoint(
    value["token_endpoint"],
    baseUrl.origin,
  );
  if (
    authorizationEndpoint === undefined ||
    registrationEndpoint === undefined ||
    tokenEndpoint === undefined ||
    !Array.isArray(value["code_challenge_methods_supported"]) ||
    !value["code_challenge_methods_supported"].includes("S256")
  ) {
    throw new Error("metadata-shape");
  }
  return { authorizationEndpoint, registrationEndpoint, tokenEndpoint };
}

async function registerOAuthClient(
  metadata: OAuthMetadata,
  redirectUri: string,
  fetchImplementation: WhooshBangFetch,
): Promise<string> {
  const value = await jsonRequest(
    fetchImplementation,
    metadata.registrationEndpoint,
    {
      body: JSON.stringify({
        client_name: "Agent Relay",
        grant_types: ["authorization_code"],
        redirect_uris: [redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    },
    201,
    MAX_OAUTH_JSON_BYTES,
  );
  if (!isRecord(value) || value["client_secret"] !== undefined) {
    throw new Error("registration-shape");
  }
  const clientId = boundedString(value["client_id"], 512);
  if (
    clientId === undefined ||
    (value["token_endpoint_auth_method"] !== undefined &&
      value["token_endpoint_auth_method"] !== "none")
  ) {
    throw new Error("registration-shape");
  }
  return clientId;
}

async function defaultOpenAuthorization(
  request: WhooshBangAuthorizationRequest,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("browser-open-unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], {
      // Opening a browser needs no Agent Relay environment. In particular,
      // never copy unrelated process credentials into the helper.
      env: {},
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => reject(new Error("browser-open-failed")));
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("browser-open-failed"));
      }
    });
    const escaped = request.authorizationUrl
      .toString()
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    child.stdin.end(`open location "${escaped}"\n`);
    request.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true },
    );
  });
}

async function callbackListener(
  expectedState: string,
  timeoutMs: number,
): Promise<CallbackListener> {
  let settle:
    | { resolve: (code: string) => void; reject: (error: Error) => void }
    | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The callback can arrive while the browser opener is still resolving. Mark
  // the promise observed immediately; waitForCode still receives its outcome.
  void code.catch(() => undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    const state = url.searchParams.get("state");
    const readableCode = boundedString(url.searchParams.get("code"), 4_096);
    if (
      state !== expectedState ||
      readableCode === undefined ||
      url.searchParams.has("error")
    ) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "Authorization could not be verified. Return to Agent Relay.",
      );
      settle?.reject(new Error("authorization-callback-invalid"));
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("WhooshBang authorized. You can close this window.");
    settle?.resolve(readableCode);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const timer = setTimeout(() => {
    settle?.reject(new Error("authorization-callback-timeout"));
  }, timeoutMs);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${String(address.port)}/oauth/callback`,
    waitForCode: async (signal) => {
      if (signal.aborted) {
        throw new Error("authorization-aborted");
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("authorization-aborted")),
          { once: true },
        );
      });
      return await Promise.race([code, aborted]);
    },
    close: async () => {
      clearTimeout(timer);
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };
}

async function exchangeAuthorizationCode(
  metadata: OAuthMetadata,
  input: {
    clientId: string;
    code: string;
    redirectUri: string;
    verifier: string;
  },
  fetchImplementation: WhooshBangFetch,
): Promise<OAuthTokens> {
  const value = await jsonRequest(
    fetchImplementation,
    metadata.tokenEndpoint,
    {
      body: new URLSearchParams({
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.verifier,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
    200,
    MAX_OAUTH_JSON_BYTES,
  );
  if (!isRecord(value)) {
    throw new Error("token-shape");
  }
  const accessToken = visibleCredential(value["access_token"]);
  const scopes =
    typeof value["scope"] === "string"
      ? value["scope"].split(/\s+/u).filter((item) => item.length > 0)
      : undefined;
  if (
    accessToken === undefined ||
    (value["token_type"] !== undefined &&
      String(value["token_type"]).toLowerCase() !== "bearer") ||
    !exactStringSet(scopes, OAUTH_SCOPES)
  ) {
    throw new Error("token-shape");
  }
  return { accessToken, scopes: OAUTH_SCOPES };
}

async function mcpCall(
  fetchImplementation: WhooshBangFetch,
  endpoint: URL,
  accessToken: string,
  id: number,
  method: string,
  parameters?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await jsonRequest(
    fetchImplementation,
    endpoint,
    {
      body: JSON.stringify({
        id,
        jsonrpc: "2.0",
        method,
        ...(parameters === undefined ? {} : { params: parameters }),
      }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
    200,
  );
  if (
    !isRecord(value) ||
    value["jsonrpc"] !== "2.0" ||
    value["id"] !== id ||
    value["error"] !== undefined ||
    !isRecord(value["result"])
  ) {
    throw new Error("mcp-response");
  }
  return value["result"];
}

function toolStructuredContent(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result["isError"] === true || !isRecord(result["structuredContent"])) {
    throw new Error("mcp-tool-result");
  }
  return result["structuredContent"];
}

function contextProjects(value: Record<string, unknown>): McpProject[] {
  if (
    !exactStringSet(value["granted_scopes"], OAUTH_SCOPES) ||
    !Array.isArray(value["projects"])
  ) {
    throw new Error("mcp-context");
  }
  return value["projects"].map((item) => {
    if (!isRecord(item) || !Array.isArray(item["environments"])) {
      throw new Error("mcp-context");
    }
    const projectId = boundedString(item["project_id"], 128);
    const slug = boundedString(item["slug"], 63);
    const status = boundedString(item["status"], 32);
    if (projectId === undefined || slug === undefined || status === undefined) {
      throw new Error("mcp-context");
    }
    const environments = item["environments"].map((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error("mcp-context");
      }
      const environment = candidate["environment"];
      const environmentId = boundedString(candidate["environment_id"], 128);
      const environmentStatus = boundedString(candidate["status"], 32);
      if (
        (environment !== "test" && environment !== "live") ||
        environmentId === undefined ||
        environmentStatus === undefined
      ) {
        throw new Error("mcp-context");
      }
      return {
        environment: environment as "test" | "live",
        environmentId,
        status: environmentStatus,
      };
    });
    return { environments, projectId, slug, status };
  });
}

async function listMcpProjects(
  fetchImplementation: WhooshBangFetch,
  endpoint: URL,
  accessToken: string,
): Promise<McpProject[]> {
  const projects: McpProject[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_CONTEXT_PAGES; page += 1) {
    const result = await mcpCall(
      fetchImplementation,
      endpoint,
      accessToken,
      2 + page,
      "tools/call",
      {
        name: "whooshbang_list_context",
        arguments: after === undefined ? {} : { after },
      },
    );
    const content = toolStructuredContent(result);
    projects.push(...contextProjects(content));
    const next = content["next_cursor"];
    if (next === undefined) {
      return projects;
    }
    const cursor = boundedString(next, 256);
    if (cursor === undefined || cursors.has(cursor)) {
      throw new Error("mcp-context");
    }
    cursors.add(cursor);
    after = cursor;
  }
  throw new Error("mcp-context");
}

function resolveProject(
  projects: readonly McpProject[],
  selector: string | undefined,
  environment: "test" | "live",
): {
  environmentId: string;
  projectId: string;
  resolvedBy: "id" | "only-active" | "slug";
} {
  const matches = projects
    .filter(
      (project) =>
        project.status === "active" &&
        (selector === undefined ||
          project.projectId === selector ||
          project.slug === selector),
    )
    .map((project) => ({
      environments: project.environments.filter(
        (candidate) =>
          candidate.environment === environment &&
          candidate.status === "active",
      ),
      project,
    }))
    .filter((candidate) => candidate.environments.length === 1);
  if (matches.length !== 1) {
    throw new Error("project-selection");
  }
  const { environments, project } = matches[0]!;
  return {
    environmentId: environments[0]!.environmentId,
    projectId: project.projectId,
    resolvedBy:
      selector === undefined
        ? "only-active"
        : project.projectId === selector
          ? "id"
          : "slug",
  };
}

function registeredMachine(
  value: Record<string, unknown>,
  material: MachineCredentialMaterial,
  expected: {
    environment: "test" | "live";
    environmentId: string;
    machineId: string;
    notifierId: string;
    projectId: string;
    subscriberId: string;
  },
): RegisteredMachine {
  const credential = value["credential"];
  const bindingId = boundedString(value["binding_id"], 128);
  const machineClientId = boundedString(value["machine_client_id"], 128);
  if (
    !isRecord(credential) ||
    bindingId === undefined ||
    machineClientId === undefined ||
    value["status"] !== "active" ||
    value["project_id"] !== expected.projectId ||
    value["environment"] !== expected.environment ||
    value["environment_id"] !== expected.environmentId ||
    value["machine_id"] !== expected.machineId ||
    value["notifier_id"] !== expected.notifierId ||
    value["subscriber_id"] !== expected.subscriberId ||
    credential["credential_id"] !== material.credentialId ||
    credential["registered_by"] !== "machine" ||
    credential["status"] !== "active" ||
    !exactStringSet(value["scope_summary"], WHOOSHBANG_MACHINE_SCOPES) ||
    !exactStringSet(credential["scope_summary"], WHOOSHBANG_MACHINE_SCOPES)
  ) {
    throw new Error("machine-result");
  }
  const createdAt = boundedString(credential["created_at"], 64);
  if (createdAt === undefined || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("machine-result");
  }
  const serialized = JSON.stringify(value);
  if (
    serialized.includes(material.bearerToken) ||
    serialized.includes(material.registration.secret_sha256)
  ) {
    throw new Error("machine-secret-reflected");
  }
  return {
    bindingId,
    credentialCreatedAt: new Date(Date.parse(createdAt)).toISOString(),
    credentialId: material.credentialId,
    environment: expected.environment,
    environmentId: expected.environmentId,
    machineClientId,
    machineId: expected.machineId,
    notifierId: expected.notifierId,
    projectId: expected.projectId,
    scopes: WHOOSHBANG_MACHINE_SCOPES,
    subscriberId: expected.subscriberId,
  };
}

async function revokeProvisionedMachine(
  baseUrl: URL,
  accessToken: string,
  projectId: string,
  environmentId: string,
  machineClientId: string,
  fetchImplementation: WhooshBangFetch,
): Promise<boolean> {
  const digest = createHash("sha256")
    .update(`${projectId}\0${environmentId}\0${machineClientId}`)
    .digest("hex");
  try {
    const value = await jsonRequest(
      fetchImplementation,
      new URL(
        `/v1/projects/${pathSegment(projectId)}/environments/${pathSegment(environmentId)}/machine-clients/${pathSegment(machineClientId)}/revoke`,
        baseUrl,
      ),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "idempotency-key": `agent-relay-oauth-cleanup-client-${digest}`,
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
      200,
    );
    return (
      isRecord(value) &&
      value["id"] === machineClientId &&
      value["status"] === "revoked"
    );
  } catch {
    return false;
  }
}

function provisionedCleanup(input: {
  accessToken: string;
  baseUrl: URL;
  environmentId: string;
  fetchImplementation: WhooshBangFetch;
  machineClientId: string;
  projectId: string;
}): () => Promise<boolean> {
  let retained:
    | {
        accessToken: string;
        environmentId: string;
        machineClientId: string;
        projectId: string;
      }
    | undefined = {
    accessToken: input.accessToken,
    environmentId: input.environmentId,
    machineClientId: input.machineClientId,
    projectId: input.projectId,
  };
  let result: Promise<boolean> | undefined;
  return () => {
    if (result !== undefined) {
      return result;
    }
    const current = retained;
    retained = undefined;
    if (current === undefined) {
      return Promise.resolve(true);
    }
    result = revokeProvisionedMachine(
      input.baseUrl,
      current.accessToken,
      current.projectId,
      current.environmentId,
      current.machineClientId,
      input.fetchImplementation,
    );
    return result;
  };
}

function safeFailure(
  stage: BootstrapStage,
  cleanupIncomplete: boolean,
): WhooshBangOAuthBootstrapError {
  switch (stage) {
    case "configuration":
      return new WhooshBangOAuthBootstrapError(
        "The WhooshBang OAuth bootstrap configuration is invalid.",
        "whooshbang-oauth-configuration-invalid",
        cleanupIncomplete,
      );
    case "discovery":
      return new WhooshBangOAuthBootstrapError(
        "WhooshBang OAuth discovery could not be verified.",
        "whooshbang-oauth-discovery-failed",
        cleanupIncomplete,
      );
    case "registration":
      return new WhooshBangOAuthBootstrapError(
        "WhooshBang public client registration could not be verified.",
        "whooshbang-oauth-registration-failed",
        cleanupIncomplete,
      );
    case "authorization":
      return new WhooshBangOAuthBootstrapError(
        "WhooshBang authorization did not complete safely.",
        "whooshbang-oauth-authorization-failed",
        cleanupIncomplete,
      );
    case "token":
      return new WhooshBangOAuthBootstrapError(
        "WhooshBang token exchange could not be verified.",
        "whooshbang-oauth-token-failed",
        cleanupIncomplete,
      );
    case "mcp":
      return new WhooshBangOAuthBootstrapError(
        "The WhooshBang MCP session could not be verified.",
        "whooshbang-mcp-failed",
        cleanupIncomplete,
      );
    case "machine":
      return new WhooshBangOAuthBootstrapError(
        "WhooshBang machine registration could not be verified.",
        "whooshbang-machine-registration-failed",
        cleanupIncomplete,
      );
    case "verification":
      return new WhooshBangOAuthBootstrapError(
        "The narrow WhooshBang machine connection could not be verified.",
        "whooshbang-machine-verification-failed",
        cleanupIncomplete,
      );
  }
}

function validateOptions(options: AuthorizeWhooshBangMachineOptions): void {
  const bounded = [
    [options.machineId, 128],
    [options.notifierId, 128],
    [options.subscriberId, 128],
  ] as const;
  if (
    bounded.some(
      ([value, maximum]) => boundedString(value, maximum) === undefined,
    ) ||
    (options.projectSelector !== undefined &&
      boundedString(options.projectSelector, 128) === undefined) ||
    (options.displayName !== undefined &&
      boundedString(options.displayName, 120) === undefined)
  ) {
    throw new Error("configuration");
  }
}

/**
 * Authorize this Agent Relay process and bootstrap one digest-only machine
 * identity through WhooshBang's remote MCP tool. OAuth state and token material
 * never leave memory; only the returned narrow bearer is intended for private
 * mode-0600 storage by the caller.
 */
export async function authorizeWhooshBangMachine(
  options: AuthorizeWhooshBangMachineOptions,
): Promise<WhooshBangOAuthMachineResult> {
  let stage: BootstrapStage = "configuration";
  let listener: CallbackListener | undefined;
  let accessToken: string | undefined;
  let material: MachineCredentialMaterial | undefined;
  let provisionedMachineClientId: string | undefined;
  let resolvedEnvironmentId: string | undefined;
  let resolvedProjectId: string | undefined;
  let machineProvisioningUncertain = false;
  let cleanupIncomplete: boolean;
  let baseUrl: URL | undefined;
  let abort: AbortController | undefined;
  try {
    validateOptions(options);
    const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 10 * 60_000
    ) {
      throw new Error("configuration");
    }
    baseUrl = normalizeWhooshBangBaseUrl(options.baseUrl);
    const fetchImplementation = noRedirectFetch(options.fetch);
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    abort = new AbortController();

    // The loopback receiver is listening before any public client exists, so a
    // fast authorization redirect cannot race local readiness.
    listener = await callbackListener(state, timeoutMs);

    stage = "discovery";
    const metadata = await discoverOAuth(baseUrl, fetchImplementation);
    stage = "registration";
    const clientId = await registerOAuthClient(
      metadata,
      listener.redirectUri,
      fetchImplementation,
    );

    stage = "authorization";
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: listener.redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.join(" "),
      state,
    }).toString();
    const code = listener.waitForCode(abort.signal);
    const opened = Promise.resolve(
      (options.openAuthorization ?? defaultOpenAuthorization)({
        authorizationUrl,
        signal: abort.signal,
      }),
    );
    const authorizationCode = await Promise.race([
      code,
      opened.then(async () => await code),
    ]);

    stage = "token";
    const tokens = await exchangeAuthorizationCode(
      metadata,
      {
        clientId,
        code: authorizationCode,
        redirectUri: listener.redirectUri,
        verifier,
      },
      fetchImplementation,
    );
    accessToken = tokens.accessToken;

    stage = "mcp";
    const mcpEndpoint = new URL("mcp", baseUrl);
    const initialized = await mcpCall(
      fetchImplementation,
      mcpEndpoint,
      accessToken,
      1,
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "agent-relay", version: "0.1.0" },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    );
    if (initialized["protocolVersion"] !== MCP_PROTOCOL_VERSION) {
      throw new Error("mcp-version");
    }
    const projects = await listMcpProjects(
      fetchImplementation,
      mcpEndpoint,
      accessToken,
    );
    const project = resolveProject(
      projects,
      options.projectSelector,
      options.environment,
    );
    resolvedEnvironmentId = project.environmentId;
    resolvedProjectId = project.projectId;

    stage = "machine";
    material =
      options.createCredentialMaterial === undefined
        ? await createMachineCredentialMaterial()
        : await options.createCredentialMaterial({
            environmentId: project.environmentId,
            projectId: project.projectId,
          });
    machineProvisioningUncertain = true;
    const createParameters = {
      name: "whooshbang_create_machine_client",
      arguments: {
        project_id: project.projectId,
        environment: options.environment,
        machine_id: options.machineId,
        notifier_id: options.notifierId,
        subscriber_id: options.subscriberId,
        credential_id: material.registration.credential_id,
        secret_sha256: material.registration.secret_sha256,
        ...(options.displayName === undefined
          ? {}
          : { display_name: options.displayName }),
      },
    };
    let toolResult: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        toolResult = await mcpCall(
          fetchImplementation,
          mcpEndpoint,
          accessToken,
          1_002 + projects.length + attempt,
          "tools/call",
          createParameters,
        );
        if (toolResult["isError"] !== true) {
          break;
        }
      } catch {
        if (attempt === 1) {
          throw new Error("mcp-machine-create");
        }
      }
    }
    if (toolResult === undefined || toolResult["isError"] === true) {
      throw new Error("mcp-machine-create");
    }
    const toolContent = toolStructuredContent(toolResult);
    provisionedMachineClientId = boundedString(
      toolContent["machine_client_id"],
      128,
    );
    const machine = registeredMachine(toolContent, material, {
      environment: options.environment,
      environmentId: project.environmentId,
      machineId: options.machineId,
      notifierId: options.notifierId,
      projectId: project.projectId,
      subscriberId: options.subscriberId,
    });
    machineProvisioningUncertain = false;

    stage = "verification";
    const source = new WhooshBangMachineInteractionSource({
      baseUrl,
      credential: material.bearerToken,
      fetch: fetchImplementation,
    });
    const poll = await source.poll({
      limit: 1,
      waitSeconds: 0,
      signal: AbortSignal.timeout(30_000),
    });
    if (poll.schema !== "whooshbang.machine-events.v1") {
      throw new Error("poll-contract");
    }

    const connectedAt = (options.now?.() ?? new Date()).toISOString();
    return {
      cleanupProvisioned: provisionedCleanup({
        accessToken,
        baseUrl,
        environmentId: machine.environmentId,
        fetchImplementation,
        machineClientId: machine.machineClientId,
        projectId: machine.projectId,
      }),
      configuration: {
        baseUrl: baseUrl.toString(),
        bindingId: machine.bindingId,
        connectedAt,
        contractVersion: WHOOSHBANG_CONTRACT_VERSION,
        environment: machine.environment,
        environmentId: machine.environmentId,
        machineClientId: machine.machineClientId,
        notifierId: machine.notifierId,
        projectId: machine.projectId,
        scopeSummary: machine.scopes,
        subscriberId: machine.subscriberId,
      },
      credential: {
        bearerToken: material.bearerToken,
        createdAt: machine.credentialCreatedAt,
        credentialId: machine.credentialId,
      },
      proof: {
        authorization: "oauth-authorization-code-s256",
        grantedScopes: OAUTH_SCOPES,
        mcpProtocolVersion: MCP_PROTOCOL_VERSION,
        machineScopeCount: 4,
        narrowPollSchema: "whooshbang.machine-events.v1",
        projectResolvedBy: project.resolvedBy,
      },
    };
  } catch {
    cleanupIncomplete = machineProvisioningUncertain;
    if (
      baseUrl !== undefined &&
      accessToken !== undefined &&
      resolvedEnvironmentId !== undefined &&
      resolvedProjectId !== undefined &&
      provisionedMachineClientId !== undefined
    ) {
      cleanupIncomplete = !(await revokeProvisionedMachine(
        baseUrl,
        accessToken,
        resolvedProjectId,
        resolvedEnvironmentId,
        provisionedMachineClientId,
        noRedirectFetch(options.fetch),
      ));
    }
    throw safeFailure(stage, cleanupIncomplete);
  } finally {
    abort?.abort();
    await listener?.close().catch(() => undefined);
  }
}
