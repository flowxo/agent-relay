import {
  NotificationsClient,
  NotificationsContractError,
  NotificationsProblemError,
  NotificationsProtocolError,
  NotificationsTransportError,
} from "@flowxo/notifications";
import {
  contractValidationErrors,
  contractVersion,
  createMachineCredentialMaterial,
  validateCreateMachineClientRequest,
  validateMachineClient,
  validateMachineCredential,
  validateMachineCredentialBearer,
  validateProblem,
  validateRegisterMachineCredentialRequest,
} from "@flowxo/notifications-contracts";

import type {
  MachineClient,
  MachineCredential,
  MachineCredentialMaterial,
  RegisterMachineCredentialRequest,
  SubscriptionLink,
  ContractValidator,
  CreateMachineClientRequest,
} from "@flowxo/notifications-contracts";
import type { NotificationsFetch } from "@flowxo/notifications";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROBLEM_BYTES = 64 * 1024;
const MACHINE_SCOPES = [
  "machine-messages:write",
  "machine-messages:read",
  "machine-events:read",
  "machine-events:ack",
] as const;

type SetupProblemCode =
  | "authentication-required"
  | "credential-invalid"
  | "scope-forbidden"
  | "environment-mismatch"
  | "idempotency-conflict"
  | "request-invalid"
  | "subscriber-unbound"
  | "resource-not-found"
  | "resource-expired"
  | "rate-limited"
  | "contract-invalid"
  | "protocol-invalid"
  | "transport-unavailable"
  | "setup-invalid"
  | "setup-failed";

export class NotificationsSetupError extends Error {
  public override readonly name = "NotificationsSetupError";
  public readonly cleanupIncomplete: boolean;
  public readonly diagnosticId?: string;
  public readonly status?: number;

  public constructor(
    message: string,
    public readonly code: `notifications-${SetupProblemCode}`,
    public readonly retryable: boolean,
    options: {
      cleanupIncomplete?: boolean;
      diagnosticId?: string;
      status?: number;
    } = {},
  ) {
    super(message);
    this.cleanupIncomplete = options.cleanupIncomplete ?? false;
    if (options.diagnosticId !== undefined) {
      this.diagnosticId = options.diagnosticId;
    }
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

const SAFE_PROBLEM_MESSAGES = {
  authentication_required:
    "Notifications requires a valid project bootstrap credential.",
  cancellation_too_late:
    "The Notifications setup resource can no longer be cancelled.",
  credential_invalid:
    "The Notifications project bootstrap credential is invalid or revoked.",
  environment_mismatch:
    "The Notifications project credential targets another environment.",
  idempotency_conflict: "Notifications rejected a conflicting setup operation.",
  idempotency_key_required:
    "Notifications rejected the setup operation identity.",
  provider_outcome_unknown:
    "Notifications could not prove the setup canary outcome.",
  provider_retryable:
    "Notifications reported a temporary setup canary failure.",
  provider_terminal: "Notifications rejected the setup canary.",
  rate_limited: "Notifications rate limited setup.",
  request_invalid: "Notifications rejected the setup request contract.",
  resource_expired: "The Notifications setup resource has expired.",
  resource_not_found: "The Notifications setup resource was not found.",
  scope_forbidden:
    "The Notifications project credential lacks setup permission.",
  subscriber_unbound:
    "The Notifications subscriber is not authorized for this notifier.",
} as const;

function setupProblemCode(
  code: keyof typeof SAFE_PROBLEM_MESSAGES,
): SetupProblemCode {
  switch (code) {
    case "authentication_required":
      return "authentication-required";
    case "credential_invalid":
      return "credential-invalid";
    case "scope_forbidden":
      return "scope-forbidden";
    case "environment_mismatch":
      return "environment-mismatch";
    case "idempotency_conflict":
    case "idempotency_key_required":
      return "idempotency-conflict";
    case "request_invalid":
      return "request-invalid";
    case "subscriber_unbound":
      return "subscriber-unbound";
    case "resource_not_found":
      return "resource-not-found";
    case "resource_expired":
    case "cancellation_too_late":
      return "resource-expired";
    case "rate_limited":
    case "provider_retryable":
      return "rate-limited";
    case "provider_terminal":
    case "provider_outcome_unknown":
      return "setup-failed";
  }
}

export function asNotificationsSetupError(
  error: unknown,
  options: { cleanupIncomplete?: boolean } = {},
): NotificationsSetupError {
  if (error instanceof NotificationsSetupError) {
    if (options.cleanupIncomplete === true && !error.cleanupIncomplete) {
      return new NotificationsSetupError(
        error.message,
        error.code,
        error.retryable,
        {
          cleanupIncomplete: true,
          ...(error.diagnosticId === undefined
            ? {}
            : { diagnosticId: error.diagnosticId }),
          ...(error.status === undefined ? {} : { status: error.status }),
        },
      );
    }
    return error;
  }
  if (error instanceof NotificationsProblemError) {
    return new NotificationsSetupError(
      SAFE_PROBLEM_MESSAGES[error.problem.code],
      `notifications-${setupProblemCode(error.problem.code)}`,
      error.retryable,
      {
        ...(options.cleanupIncomplete === undefined
          ? {}
          : { cleanupIncomplete: options.cleanupIncomplete }),
        diagnosticId: error.diagnosticId,
        status: error.status,
      },
    );
  }
  if (error instanceof NotificationsContractError) {
    return new NotificationsSetupError(
      "Notifications returned data outside the pinned setup contract.",
      "notifications-contract-invalid",
      false,
      {
        ...(options.cleanupIncomplete === undefined
          ? {}
          : { cleanupIncomplete: options.cleanupIncomplete }),
      },
    );
  }
  if (error instanceof NotificationsProtocolError) {
    return new NotificationsSetupError(
      "Notifications returned an invalid setup protocol response.",
      "notifications-protocol-invalid",
      false,
      {
        ...(options.cleanupIncomplete === undefined
          ? {}
          : { cleanupIncomplete: options.cleanupIncomplete }),
        ...(error.status === undefined ? {} : { status: error.status }),
      },
    );
  }
  if (error instanceof NotificationsTransportError) {
    return new NotificationsSetupError(
      "The Notifications setup request could not be completed.",
      "notifications-transport-unavailable",
      true,
      {
        cleanupIncomplete: options.cleanupIncomplete ?? error.outcomeUnknown,
      },
    );
  }
  if (error instanceof TypeError) {
    return new NotificationsSetupError(
      "The Notifications setup configuration is invalid.",
      "notifications-setup-invalid",
      false,
      {
        ...(options.cleanupIncomplete === undefined
          ? {}
          : { cleanupIncomplete: options.cleanupIncomplete }),
      },
    );
  }
  return new NotificationsSetupError(
    "Notifications setup failed with an unclassified response.",
    "notifications-setup-failed",
    false,
    {
      ...(options.cleanupIncomplete === undefined
        ? {}
        : { cleanupIncomplete: options.cleanupIncomplete }),
    },
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function normalizeNotificationsBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("Notifications base URL must not contain credentials.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new TypeError(
      "Notifications base URL must use HTTPS except on explicit loopback.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError(
      "Notifications base URL must not contain a query or fragment.",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function noRedirectFetch(
  fetchImplementation: NotificationsFetch | undefined,
): NotificationsFetch {
  const runtimeFetch = fetchImplementation ?? globalThis.fetch;
  if (typeof runtimeFetch !== "function") {
    throw new TypeError("A Fetch-compatible implementation is required.");
  }
  const bound = runtimeFetch.bind(globalThis);
  return async (input, init) =>
    await bound(input, { ...init, redirect: "manual" });
}

function validateCredential(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    !/^[\u0021-\u007e]+$/u.test(value)
  ) {
    throw new TypeError(
      `${label} must be a bounded visible-ASCII bearer token.`,
    );
  }
}

function validateIdempotencyKey(value: string): void {
  if (
    value.length < 8 ||
    value.length > 255 ||
    !/^[\u0021-\u007e]+$/u.test(value)
  ) {
    throw new TypeError(
      "Notifications setup idempotency key must contain 8 to 255 visible ASCII characters.",
    );
  }
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function pathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    containsAsciiControl(value)
  ) {
    throw new TypeError(`${label} must be a bounded opaque identifier.`);
  }
  return encodeURIComponent(value);
}

function responseMediaType(response: Response): string {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

async function readBoundedJson(
  response: Response,
  operation: string,
  limit: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) > limit)
  ) {
    throw new NotificationsProtocolError(
      operation,
      "The Notifications setup response exceeded the client safety limit.",
      response.status,
    );
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    try {
      for (;;) {
        let result;
        try {
          result = await reader.read();
        } catch {
          throw new NotificationsProtocolError(
            operation,
            "The Notifications setup response body could not be read safely.",
            response.status,
          );
        }
        if (result.done) {
          break;
        }
        byteLength += result.value.byteLength;
        if (byteLength > limit) {
          try {
            await reader.cancel();
          } catch {
            // The bounded public error intentionally redacts reader failures.
          }
          throw new NotificationsProtocolError(
            operation,
            "The Notifications setup response exceeded the client safety limit.",
            response.status,
          );
        }
        chunks.push(result.value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A hostile reader cannot replace the bounded public protocol error.
      }
    }
  }

  const bytes = new Uint8Array(byteLength);
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
    throw new NotificationsProtocolError(
      operation,
      "The Notifications setup response was not valid UTF-8 JSON.",
      response.status,
    );
  }
}

interface AdministrationRequest<T> {
  body?: unknown;
  expectedStatuses: readonly number[];
  idempotencyKey?: string;
  method: "GET" | "POST";
  operation: string;
  path: string;
  signal?: AbortSignal;
  validator: ContractValidator<T>;
}

export interface NotificationsAdministrationClientOptions {
  baseUrl: string | URL;
  projectCredential: string;
  fetch?: NotificationsFetch;
}

export class NotificationsAdministrationClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: NotificationsFetch;
  private readonly projectCredential: string;

  public constructor(options: NotificationsAdministrationClientOptions) {
    this.baseUrl = normalizeNotificationsBaseUrl(options.baseUrl);
    validateCredential(options.projectCredential, "projectCredential");
    this.projectCredential = options.projectCredential;
    this.fetchImplementation = noRedirectFetch(options.fetch);
  }

  public async createMachineClient(
    request: CreateMachineClientRequest,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<MachineClient> {
    if (!validateCreateMachineClientRequest(request)) {
      throw new NotificationsContractError(
        "createMachineClient",
        contractValidationErrors(validateCreateMachineClientRequest),
        "The machine-client request does not match the pinned contract.",
      );
    }
    return await this.request({
      body: request,
      expectedStatuses: [201],
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      operation: "createMachineClient",
      path: "v1/machine-clients",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validator: validateMachineClient,
    });
  }

  public async getMachineClient(
    machineClientId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MachineClient> {
    return await this.request({
      expectedStatuses: [200],
      method: "GET",
      operation: "getMachineClient",
      path: `v1/machine-clients/${pathSegment(
        machineClientId,
        "machineClientId",
      )}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validator: validateMachineClient,
    });
  }

  public async registerMachineCredential(
    machineClientId: string,
    request: RegisterMachineCredentialRequest,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<MachineCredential> {
    if (!validateRegisterMachineCredentialRequest(request)) {
      throw new NotificationsContractError(
        "registerMachineCredential",
        contractValidationErrors(validateRegisterMachineCredentialRequest),
        "The machine-credential registration does not match the pinned contract.",
      );
    }
    return await this.request({
      body: request,
      expectedStatuses: [200, 201],
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      operation: "registerMachineCredential",
      path: `v1/machine-clients/${pathSegment(
        machineClientId,
        "machineClientId",
      )}/credentials`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validator: validateMachineCredential,
    });
  }

  public async revokeMachineCredential(
    machineClientId: string,
    credentialId: string,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<MachineCredential> {
    return await this.request({
      expectedStatuses: [200],
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      operation: "revokeMachineCredential",
      path: `v1/machine-clients/${pathSegment(
        machineClientId,
        "machineClientId",
      )}/credentials/${pathSegment(credentialId, "credentialId")}/revoke`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validator: validateMachineCredential,
    });
  }

  public async revokeMachineClient(
    machineClientId: string,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<MachineClient> {
    return await this.request({
      expectedStatuses: [200],
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      operation: "revokeMachineClient",
      path: `v1/machine-clients/${pathSegment(
        machineClientId,
        "machineClientId",
      )}/revoke`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validator: validateMachineClient,
    });
  }

  private async request<T>(descriptor: AdministrationRequest<T>): Promise<T> {
    const headers = new Headers({
      accept: "application/json, application/problem+json",
      authorization: `Bearer ${this.projectCredential}`,
    });
    if (descriptor.idempotencyKey !== undefined) {
      validateIdempotencyKey(descriptor.idempotencyKey);
      headers.set("idempotency-key", descriptor.idempotencyKey);
    }
    let body: string | undefined;
    if (descriptor.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(descriptor.body);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        new URL(descriptor.path, this.baseUrl),
        {
          ...(body === undefined ? {} : { body }),
          headers,
          method: descriptor.method,
          redirect: "manual",
          ...(descriptor.signal === undefined
            ? {}
            : { signal: descriptor.signal }),
        },
      );
    } catch {
      throw new NotificationsTransportError(
        descriptor.operation,
        descriptor.method !== "GET",
      );
    }

    const mediaType = responseMediaType(response);
    if (!response.ok) {
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location")
      ) {
        throw new NotificationsProtocolError(
          descriptor.operation,
          "Notifications setup redirects are not permitted.",
          response.status,
        );
      }
      if (mediaType !== "application/problem+json") {
        throw new NotificationsProtocolError(
          descriptor.operation,
          "The Notifications setup error response had an unexpected media type.",
          response.status,
        );
      }
      const value = await readBoundedJson(
        response,
        descriptor.operation,
        MAX_PROBLEM_BYTES,
      );
      if (!validateProblem(value) || value.status !== response.status) {
        throw new NotificationsProtocolError(
          descriptor.operation,
          "The Notifications setup error response did not match Problem Details.",
          response.status,
        );
      }
      throw new NotificationsProblemError(value);
    }
    if (!descriptor.expectedStatuses.includes(response.status)) {
      throw new NotificationsProtocolError(
        descriptor.operation,
        "The Notifications setup response used an unexpected success status.",
        response.status,
      );
    }
    if (mediaType !== "application/json") {
      throw new NotificationsProtocolError(
        descriptor.operation,
        "The Notifications setup success response had an unexpected media type.",
        response.status,
      );
    }
    const value = await readBoundedJson(
      response,
      descriptor.operation,
      MAX_RESPONSE_BYTES,
    );
    if (!descriptor.validator(value)) {
      throw new NotificationsContractError(
        descriptor.operation,
        contractValidationErrors(descriptor.validator),
        "The Notifications setup response did not match the pinned contract.",
      );
    }
    return value;
  }
}

export interface NotificationsAuthorizationMetadata {
  diagnosticId: string;
  expiresAt: string;
  id: string;
  status:
    "pending" | "activated" | "expired" | "cancelled" | "failed" | "revoked";
  url?: string;
}

export interface NotificationsConnectionConfiguration {
  baseUrl: string;
  bindingId: string;
  canaryDiagnosticId: string;
  canaryMessageId: string;
  connectedAt: string;
  contractVersion: typeof contractVersion;
  environment: "test" | "live";
  machineClientId: string;
  notifierId: string;
  projectId: string;
  scopeSummary: typeof MACHINE_SCOPES;
  subscriberId: string;
}

export interface NotificationsConnectionCredential {
  bearerToken: string;
  createdAt: string;
  credentialId: string;
}

export type NotificationsConnectResult =
  | {
      authorization: NotificationsAuthorizationMetadata;
      contractVersion: typeof contractVersion;
      status: "authorization_pending" | "authorization_incomplete";
    }
  | {
      authorization: NotificationsAuthorizationMetadata;
      configuration: NotificationsConnectionConfiguration;
      credential: NotificationsConnectionCredential;
      status: "connected";
    };

export interface ConnectNotificationsMachineOptions {
  authorizationPollIntervalMs?: number;
  authorizationWaitMs?: number;
  baseUrl: string | URL;
  createCredentialMaterial?: () => Promise<MachineCredentialMaterial>;
  createIdempotencyKey?: (operation: string) => string;
  displayName?: string;
  fetch?: NotificationsFetch;
  machineId: string;
  notifierId?: string;
  now?: () => Date;
  onAuthorization?: (
    metadata: NotificationsAuthorizationMetadata,
  ) => Promise<void> | void;
  projectCredential: string;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  subscriberId: string;
}

function authorizationMetadata(
  link: SubscriptionLink,
): NotificationsAuthorizationMetadata {
  return {
    diagnosticId: link.diagnostic_id,
    expiresAt: link.expires_at,
    id: link.id,
    status: link.status,
    ...(link.authorization_url === undefined
      ? {}
      : { url: link.authorization_url }),
  };
}

function defaultIdempotencyKey(operation: string): string {
  const runtimeCrypto = globalThis.crypto;
  if (runtimeCrypto === undefined) {
    throw new TypeError("Web Crypto is required for Notifications setup.");
  }
  return `agent-relay-${operation}-${runtimeCrypto.randomUUID()}`;
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertBinding(
  link: SubscriptionLink,
  client: MachineClient,
  expected: { notifierId: string; subscriberId: string; machineId: string },
): void {
  const binding = link.binding;
  if (
    link.status !== "activated" ||
    binding === undefined ||
    binding.status !== "active" ||
    link.subscriber_id !== expected.subscriberId ||
    link.notifier_id !== expected.notifierId ||
    binding.subscriber_id !== expected.subscriberId ||
    binding.notifier_id !== expected.notifierId ||
    client.subscriber_id !== expected.subscriberId ||
    client.notifier_id !== expected.notifierId ||
    client.machine_id !== expected.machineId ||
    client.binding_id !== binding.id ||
    client.project_id !== link.project_id ||
    client.environment !== link.environment
  ) {
    throw new NotificationsSetupError(
      "Notifications did not prove the expected subscriber binding.",
      "notifications-setup-invalid",
      false,
    );
  }
}

function isAcceptedCanaryState(
  state:
    | "accepted"
    | "dispatch_pending"
    | "queued"
    | "sending"
    | "provider_accepted"
    | "retry_wait"
    | "terminal_failed"
    | "outcome_unknown"
    | "cancelled"
    | "expired",
): boolean {
  return (
    state === "accepted" ||
    state === "dispatch_pending" ||
    state === "queued" ||
    state === "sending" ||
    state === "provider_accepted" ||
    state === "retry_wait"
  );
}

async function waitForAuthorization(
  client: NotificationsClient,
  initial: SubscriptionLink,
  options: ConnectNotificationsMachineOptions,
): Promise<SubscriptionLink> {
  const waitMs = options.authorizationWaitMs ?? 0;
  const pollMs = options.authorizationPollIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 10 ||
    pollMs > 30_000
  ) {
    throw new TypeError("Authorization wait configuration is invalid.");
  }
  let current = await client.getSubscriptionLink(initial.id, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const deadline = Date.now() + waitMs;
  const sleep = options.sleep ?? defaultSleep;
  while (current.status === "pending" && Date.now() < deadline) {
    await sleep(
      Math.min(pollMs, Math.max(0, deadline - Date.now())),
      options.signal,
    );
    current = await client.getSubscriptionLink(initial.id, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  return current;
}

async function revokeProvisionedClient(
  administration: NotificationsAdministrationClient,
  machineClientId: string,
  credentialId: string,
  idempotencyKey: (operation: string) => string,
  signal?: AbortSignal,
): Promise<boolean> {
  let complete = true;
  try {
    await administration.revokeMachineCredential(
      machineClientId,
      credentialId,
      {
        idempotencyKey: idempotencyKey("cleanup-credential"),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch {
    complete = false;
  }
  try {
    await administration.revokeMachineClient(machineClientId, {
      idempotencyKey: idempotencyKey("cleanup-client"),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    complete = false;
  }
  return complete;
}

export async function connectNotificationsMachine(
  options: ConnectNotificationsMachineOptions,
): Promise<NotificationsConnectResult> {
  let provisioned:
    | {
        administration: NotificationsAdministrationClient;
        credentialId: string;
        machineClientId: string;
      }
    | undefined;
  const idempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
  try {
    const baseUrl = normalizeNotificationsBaseUrl(options.baseUrl);
    const notifierId = options.notifierId ?? "default";
    const fetchImplementation = noRedirectFetch(options.fetch);
    const projectClient = new NotificationsClient({
      baseUrl,
      credential: options.projectCredential,
      fetch: fetchImplementation,
    });
    const administration = new NotificationsAdministrationClient({
      baseUrl,
      projectCredential: options.projectCredential,
      fetch: fetchImplementation,
    });

    const initialLink = await projectClient.createSubscriptionLink(
      {
        subscriber_id: options.subscriberId,
        notifier_id: notifierId,
        channels: ["telegram"],
      },
      {
        idempotencyKey: idempotencyKey("subscription-link"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const initialAuthorization = authorizationMetadata(initialLink);
    await options.onAuthorization?.(initialAuthorization);
    const link = await waitForAuthorization(
      projectClient,
      initialLink,
      options,
    );
    const authorization = authorizationMetadata(link);
    if (link.status !== "activated") {
      return {
        authorization,
        contractVersion,
        status:
          link.status === "pending"
            ? "authorization_pending"
            : "authorization_incomplete",
      };
    }

    const machineClient = await administration.createMachineClient(
      {
        machine_id: options.machineId,
        notifier_id: notifierId,
        subscriber_id: options.subscriberId,
        ...(options.displayName === undefined
          ? {}
          : { display_name: options.displayName }),
      },
      {
        idempotencyKey: idempotencyKey("machine-client"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    assertBinding(link, machineClient, {
      machineId: options.machineId,
      notifierId,
      subscriberId: options.subscriberId,
    });

    const material = await (
      options.createCredentialMaterial ?? createMachineCredentialMaterial
    )();
    provisioned = {
      administration,
      credentialId: material.credentialId,
      machineClientId: machineClient.id,
    };
    const registered = await administration.registerMachineCredential(
      machineClient.id,
      material.registration,
      {
        idempotencyKey: idempotencyKey("machine-credential"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (
      registered.credential_id !== material.credentialId ||
      registered.machine_client_id !== machineClient.id ||
      registered.status !== "active" ||
      !MACHINE_SCOPES.every((scope) => registered.scope_summary.includes(scope))
    ) {
      throw new NotificationsSetupError(
        "Notifications did not return the required narrow machine scope.",
        "notifications-setup-invalid",
        false,
      );
    }

    const narrowClient = new NotificationsClient({
      baseUrl,
      credential: material.bearerToken,
      fetch: fetchImplementation,
    });
    const poll = await narrowClient.pollMachineEvents({
      wait: 0,
      limit: 1,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (poll.schema !== "notifications.machine-events.v1") {
      throw new NotificationsSetupError(
        "Notifications returned another machine-event contract.",
        "notifications-contract-invalid",
        false,
      );
    }
    const canary = await narrowClient.createMessage(
      {
        to: { subscriber_id: options.subscriberId },
        notifier_id: notifierId,
        content: {
          type: "text",
          text: "Agent Relay Notifications connection canary.",
        },
      },
      {
        idempotencyKey: idempotencyKey("canary-message"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (
      canary.subscriber_id !== options.subscriberId ||
      canary.notifier_id !== notifierId ||
      canary.binding.id !== machineClient.binding_id ||
      !isAcceptedCanaryState(canary.state)
    ) {
      throw new NotificationsSetupError(
        "Notifications did not prove the configured canary destination.",
        "notifications-setup-invalid",
        false,
      );
    }
    const activeClient = await administration.getMachineClient(
      machineClient.id,
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    assertBinding(link, activeClient, {
      machineId: options.machineId,
      notifierId,
      subscriberId: options.subscriberId,
    });
    if (activeClient.status !== "active") {
      throw new NotificationsSetupError(
        "Notifications did not activate the narrow machine client.",
        "notifications-setup-invalid",
        false,
      );
    }

    const connectedAt = (options.now?.() ?? new Date()).toISOString();
    provisioned = undefined;
    return {
      authorization,
      configuration: {
        baseUrl: baseUrl.toString(),
        bindingId: activeClient.binding_id,
        canaryDiagnosticId: canary.diagnostic_id,
        canaryMessageId: canary.id,
        connectedAt,
        contractVersion,
        environment: activeClient.environment,
        machineClientId: activeClient.id,
        notifierId: activeClient.notifier_id,
        projectId: activeClient.project_id,
        scopeSummary: MACHINE_SCOPES,
        subscriberId: activeClient.subscriber_id,
      },
      credential: {
        bearerToken: material.bearerToken,
        createdAt: connectedAt,
        credentialId: material.credentialId,
      },
      status: "connected",
    };
  } catch (error) {
    if (provisioned === undefined) {
      throw asNotificationsSetupError(error);
    }
    const cleanupComplete = await revokeProvisionedClient(
      provisioned.administration,
      provisioned.machineClientId,
      provisioned.credentialId,
      idempotencyKey,
      AbortSignal.timeout(10_000),
    );
    throw asNotificationsSetupError(error, {
      cleanupIncomplete: !cleanupComplete,
    });
  }
}

export interface DisconnectNotificationsMachineOptions {
  baseUrl: string | URL;
  credentialId: string;
  createIdempotencyKey?: (operation: string) => string;
  fetch?: NotificationsFetch;
  machineClientId: string;
  projectCredential: string;
  signal?: AbortSignal;
}

export async function disconnectNotificationsMachine(
  options: DisconnectNotificationsMachineOptions,
): Promise<{ client: MachineClient; credential: MachineCredential }> {
  try {
    const idempotencyKey =
      options.createIdempotencyKey ?? defaultIdempotencyKey;
    const administration = new NotificationsAdministrationClient(options);
    const credential = await administration.revokeMachineCredential(
      options.machineClientId,
      options.credentialId,
      {
        idempotencyKey: idempotencyKey("revoke-credential"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const client = await administration.revokeMachineClient(
      options.machineClientId,
      {
        idempotencyKey: idempotencyKey("revoke-client"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (credential.status !== "revoked" || client.status !== "revoked") {
      throw new NotificationsSetupError(
        "Notifications did not prove machine-client revocation.",
        "notifications-setup-invalid",
        false,
      );
    }
    return { client, credential };
  } catch (error) {
    throw asNotificationsSetupError(error);
  }
}

export const NOTIFICATIONS_MACHINE_SCOPES = MACHINE_SCOPES;
export const NOTIFICATIONS_CONTRACT_VERSION = contractVersion;
export { createMachineCredentialMaterial };
export type { MachineCredentialMaterial, NotificationsFetch };

export function isNotificationsMachineCredential(value: unknown): boolean {
  return validateMachineCredentialBearer(value);
}
