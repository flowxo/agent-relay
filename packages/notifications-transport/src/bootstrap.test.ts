import {
  NotificationsClient,
  NotificationsProblemError,
  NotificationsProtocolError,
} from "@flowxo/notifications";
import {
  createMachineCredentialMaterial,
  validateMachineCredentialBearer,
} from "@flowxo/notifications-contracts";
import { createNotificationsContractMock } from "@flowxo/notifications-contract-mock";
import { describe, expect, it, vi } from "vitest";

import {
  connectNotificationsMachine,
  disconnectNotificationsMachine,
  normalizeNotificationsBaseUrl,
  NotificationsAdministrationClient,
  NotificationsSetupError,
} from "./bootstrap.js";

import type { MachineCredentialMaterial } from "@flowxo/notifications-contracts";
import type {
  ContractMockCredential,
  ContractMockIdGenerator,
  NotificationsContractMock,
} from "@flowxo/notifications-contract-mock";
import type { NotificationsFetch } from "@flowxo/notifications";

const projectToken = "synthetic-project-bootstrap-token";
const machineClientId = "machine_client_setup_001";
const machineId = "machine_setup_fixture";
const subscriberId = "agent_relay_operator";
const notifierId = "default";

function idGenerator(): ContractMockIdGenerator {
  const counters = new Map<string, number>();
  return (kind) => {
    if (kind === "machine_client") {
      return machineClientId;
    }
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_setup_${String(next).padStart(3, "0")}`;
  };
}

function idempotencyKey(operation: string): string {
  return `setup-${operation}-12345678`;
}

function credentials(
  material: MachineCredentialMaterial,
): ContractMockCredential[] {
  return [
    {
      accountId: "account_synthetic",
      environment: "test",
      kind: "project",
      projectId: "project_synthetic",
      scopes: [
        "subscriptions:write",
        "subscriptions:read",
        "messages:write",
        "messages:read",
        "machine-clients:write",
        "machine-clients:read",
        "capabilities:read",
      ],
      token: projectToken,
    },
    {
      accountId: "account_synthetic",
      bindingId: "binding_setup_fixture",
      environment: "test",
      kind: "machine",
      machineClientId,
      machineId,
      notifierId,
      projectId: "project_synthetic",
      scopes: [
        "machine-messages:write",
        "machine-messages:read",
        "machine-events:read",
        "machine-events:ack",
      ],
      status: "active",
      subscriberId,
      token: material.bearerToken,
    },
    {
      accountId: "account_synthetic",
      bindingId: "binding_synthetic_relay",
      environment: "test",
      kind: "machine",
      machineClientId: "machine_client_synthetic_001",
      machineId: "machine_synthetic_a",
      notifierId,
      projectId: "project_synthetic",
      scopes: [
        "machine-messages:write",
        "machine-messages:read",
        "machine-events:read",
        "machine-events:ack",
      ],
      status: "active",
      subscriberId,
      token: "synthetic-foreign-machine-token",
    },
  ];
}

function fetchFor(mock: NotificationsContractMock): NotificationsFetch {
  return async (input, init) => mock.fetch(new Request(input, init));
}

interface ObservedRequest {
  authorization?: string;
  body?: string;
  path: string;
}

function observingFetch(
  mock: NotificationsContractMock,
  observed: ObservedRequest[],
): NotificationsFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.body === null ? undefined : await request.clone().text();
    const authorization = request.headers.get("authorization");
    observed.push({
      path: new URL(request.url).pathname,
      ...(authorization === null ? {} : { authorization }),
      ...(body === undefined ? {} : { body }),
    });
    return await mock.fetch(request);
  };
}

async function connectedFixture(
  options: {
    scenario?: "nominal" | "cross-machine-rejection";
  } = {},
) {
  const material = await createMachineCredentialMaterial();
  const mock = createNotificationsContractMock({
    credentials: credentials(material),
    idGenerator: idGenerator(),
    scenario: options.scenario ?? "nominal",
  });
  const observed: ObservedRequest[] = [];
  const authorizations: unknown[] = [];
  const result = await connectNotificationsMachine({
    baseUrl: "https://notifications.mock.test",
    createCredentialMaterial: async () => material,
    createIdempotencyKey: idempotencyKey,
    fetch: observingFetch(mock, observed),
    machineId,
    now: () => new Date("2026-07-26T18:00:00.000Z"),
    notifierId,
    onAuthorization: (authorization) => {
      authorizations.push(authorization);
    },
    projectCredential: projectToken,
    subscriberId,
  });
  if (result.status !== "connected") {
    throw new Error("Synthetic Notifications setup did not connect.");
  }
  return { authorizations, material, mock, observed, result };
}

describe("Notifications machine bootstrap", () => {
  it("provisions, smoke-tests, and canaries a locally generated narrow credential", async () => {
    const { authorizations, material, mock, observed, result } =
      await connectedFixture();

    expect(validateMachineCredentialBearer(material.bearerToken)).toBe(true);
    expect(result.credential).toEqual({
      bearerToken: material.bearerToken,
      createdAt: "2026-07-26T18:00:00.000Z",
      credentialId: material.credentialId,
    });
    expect(result.configuration).toMatchObject({
      baseUrl: "https://notifications.mock.test/",
      contractVersion: "1.0.0-rc.1",
      environment: "test",
      machineClientId,
      notifierId,
      subscriberId,
      scopeSummary: [
        "machine-messages:write",
        "machine-messages:read",
        "machine-events:read",
        "machine-events:ack",
      ],
    });
    expect(authorizations).toEqual([
      expect.objectContaining({
        status: "pending",
        url: expect.stringMatching(/^https:\/\//u),
      }),
    ]);

    const registration = observed.find((request) =>
      request.path.endsWith("/credentials"),
    );
    expect(JSON.parse(registration?.body ?? "{}")).toEqual(
      material.registration,
    );
    expect(registration?.body).not.toContain(material.bearerToken);
    expect(observed.every((request) => request.body !== projectToken)).toBe(
      true,
    );
    expect(
      observed
        .filter(
          (request) =>
            request.path === "/v1/machine-events" ||
            request.path === "/v1/messages",
        )
        .every(
          (request) =>
            request.authorization === `Bearer ${material.bearerToken}`,
        ),
    ).toBe(true);
    expect(
      observed
        .filter(
          (request) =>
            request.path.startsWith("/v1/subscription-links") ||
            request.path.startsWith("/v1/machine-clients"),
        )
        .every((request) => request.authorization === `Bearer ${projectToken}`),
    ).toBe(true);

    const snapshot = mock.inspect();
    expect(snapshot.machineClients).toContainEqual(
      expect.objectContaining({ id: machineClientId, status: "active" }),
    );
    expect(snapshot.machineCredentials).toContainEqual(
      expect.objectContaining({
        credential_id: material.credentialId,
        machine_client_id: machineClientId,
        status: "active",
      }),
    );
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        id: result.configuration.canaryMessageId,
        subscriber_id: subscriberId,
      }),
    );
  });

  it("does not create or persist credential material while authorization is pending", async () => {
    const material = await createMachineCredentialMaterial();
    const createCredential = vi.fn(async () => material);
    const mock = createNotificationsContractMock({
      credentials: credentials(material),
      idGenerator: idGenerator(),
      scenario: "cancellation-before-send",
    });

    const result = await connectNotificationsMachine({
      authorizationWaitMs: 0,
      baseUrl: "https://notifications.mock.test",
      createCredentialMaterial: createCredential,
      createIdempotencyKey: idempotencyKey,
      fetch: fetchFor(mock),
      machineId,
      notifierId,
      projectCredential: projectToken,
      subscriberId,
    });

    expect(result).toMatchObject({
      authorization: {
        status: "pending",
        url: expect.stringMatching(/^https:\/\//u),
      },
      contractVersion: "1.0.0-rc.1",
      status: "authorization_pending",
    });
    expect(createCredential).not.toHaveBeenCalled();
    expect(mock.inspect().machineClients).not.toContainEqual(
      expect.objectContaining({ id: machineClientId }),
    );
    expect(JSON.stringify(result)).not.toContain(projectToken);
    expect(JSON.stringify(result)).not.toContain(material.bearerToken);
  });

  it("proves cross-machine stream and message isolation", async () => {
    const { material, mock, result } = await connectedFixture({
      scenario: "cross-machine-rejection",
    });
    const generatedClient = new NotificationsClient({
      baseUrl: "https://notifications.mock.test",
      credential: material.bearerToken,
      fetch: fetchFor(mock),
    });
    const foreignClient = new NotificationsClient({
      baseUrl: "https://notifications.mock.test",
      credential: "synthetic-foreign-machine-token",
      fetch: fetchFor(mock),
    });

    await expect(
      generatedClient.pollMachineEvents({ wait: 0 }),
    ).resolves.toMatchObject({ events: [] });
    await expect(
      foreignClient.pollMachineEvents({ wait: 0 }),
    ).resolves.toMatchObject({ events: [expect.any(Object)] });
    await expect(
      foreignClient.getMessage(result.configuration.canaryMessageId),
    ).rejects.toMatchObject({ status: 404 });

    const narrowAsAdministrator = new NotificationsAdministrationClient({
      baseUrl: "https://notifications.mock.test",
      projectCredential: material.bearerToken,
      fetch: fetchFor(mock),
    });
    await expect(
      narrowAsAdministrator.createMachineClient(
        {
          machine_id: "machine_other_fixture",
          notifier_id: notifierId,
          subscriber_id: subscriberId,
        },
        { idempotencyKey: "narrow-admin-denied-12345678" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("revokes both credential and client idempotently", async () => {
    const { material, mock } = await connectedFixture();
    const options = {
      baseUrl: "https://notifications.mock.test",
      credentialId: material.credentialId,
      createIdempotencyKey: idempotencyKey,
      fetch: fetchFor(mock),
      machineClientId,
      projectCredential: projectToken,
    };

    await expect(
      disconnectNotificationsMachine(options),
    ).resolves.toMatchObject({
      client: { status: "revoked" },
      credential: { status: "revoked" },
    });
    await expect(
      disconnectNotificationsMachine(options),
    ).resolves.toMatchObject({
      client: { status: "revoked" },
      credential: { status: "revoked" },
    });
    const revokedClient = new NotificationsClient({
      baseUrl: "https://notifications.mock.test",
      credential: material.bearerToken,
      fetch: fetchFor(mock),
    });
    await expect(
      revokedClient.pollMachineEvents({ wait: 0 }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("revokes provisional remote state when the narrow smoke test fails", async () => {
    const material = await createMachineCredentialMaterial();
    const mock = createNotificationsContractMock({
      credentials: credentials(material),
      idGenerator: idGenerator(),
    });
    const fetchImplementation: NotificationsFetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        new URL(request.url).pathname === "/v1/machine-events" &&
        request.headers.get("authorization") ===
          `Bearer ${material.bearerToken}`
      ) {
        throw new Error("synthetic private network detail");
      }
      return await mock.fetch(request);
    };

    await expect(
      connectNotificationsMachine({
        baseUrl: "https://notifications.mock.test",
        createCredentialMaterial: async () => material,
        createIdempotencyKey: idempotencyKey,
        fetch: fetchImplementation,
        machineId,
        notifierId,
        projectCredential: projectToken,
        subscriberId,
      }),
    ).rejects.toMatchObject({
      cleanupIncomplete: false,
      code: "notifications-transport-unavailable",
    });
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({ id: machineClientId, status: "revoked" }),
    );
    expect(mock.inspect().machineCredentials).toContainEqual(
      expect.objectContaining({
        credential_id: material.credentialId,
        status: "revoked",
      }),
    );
  });

  it("reports incomplete cleanup when provisional revocation cannot be proven", async () => {
    const material = await createMachineCredentialMaterial();
    const mock = createNotificationsContractMock({
      credentials: credentials(material),
      idGenerator: idGenerator(),
    });
    let cleanupAttempts = 0;
    const fetchImplementation: NotificationsFetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (
        path === "/v1/machine-events" &&
        request.headers.get("authorization") ===
          `Bearer ${material.bearerToken}`
      ) {
        throw new Error("synthetic narrow transport failure");
      }
      if (path.endsWith("/revoke")) {
        cleanupAttempts += 1;
        throw new Error("synthetic cleanup transport failure");
      }
      return await mock.fetch(request);
    };

    await expect(
      connectNotificationsMachine({
        baseUrl: "https://notifications.mock.test",
        createCredentialMaterial: async () => material,
        createIdempotencyKey: idempotencyKey,
        fetch: fetchImplementation,
        machineId,
        notifierId,
        projectCredential: projectToken,
        subscriberId,
      }),
    ).rejects.toMatchObject({
      cleanupIncomplete: true,
      code: "notifications-transport-unavailable",
    });
    expect(cleanupAttempts).toBe(2);
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({ id: machineClientId, status: "active" }),
    );
  });

  it("redacts untrusted problem details from setup errors", async () => {
    const fetchImplementation: NotificationsFetch = async () =>
      new Response(
        JSON.stringify({
          type: "https://flowxo.com/notifications/problems/credential_invalid",
          title: "Credential invalid",
          status: 401,
          detail: "broad-token-value at /private/machine/path",
          code: "credential_invalid",
          diagnostic_id: "diagnostic_setup_12345678",
          retryable: false,
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 401,
        },
      );

    const failure = await connectNotificationsMachine({
      baseUrl: "https://notifications.mock.test",
      createIdempotencyKey: idempotencyKey,
      fetch: fetchImplementation,
      machineId,
      notifierId,
      projectCredential: projectToken,
      subscriberId,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotificationsSetupError);
    expect(failure).toMatchObject({
      code: "notifications-credential-invalid",
      diagnosticId: "diagnostic_setup_12345678",
      retryable: false,
    });
    expect((failure as Error).message).not.toContain("broad-token-value");
    expect((failure as Error).message).not.toContain("/private/machine/path");
  });
});

describe("Notifications setup HTTP safety", () => {
  it("requires HTTPS outside exact loopback origins", () => {
    expect(
      normalizeNotificationsBaseUrl("https://notifications.example.test/api"),
    ).toEqual(new URL("https://notifications.example.test/api/"));
    expect(normalizeNotificationsBaseUrl("http://127.0.0.1:4319")).toEqual(
      new URL("http://127.0.0.1:4319/"),
    );
    expect(normalizeNotificationsBaseUrl("http://[::1]:4319")).toEqual(
      new URL("http://[::1]:4319/"),
    );
    expect(() =>
      normalizeNotificationsBaseUrl("http://notifications.example.test"),
    ).toThrow("HTTPS");
    expect(() =>
      normalizeNotificationsBaseUrl(
        "https://user:secret@notifications.example.test",
      ),
    ).toThrow("must not contain credentials");
    expect(() =>
      normalizeNotificationsBaseUrl(
        "https://notifications.example.test?credential=value",
      ),
    ).toThrow("query or fragment");
  });

  it("never follows redirects carrying a project credential", async () => {
    const fetchImplementation = vi.fn<NotificationsFetch>(
      async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          headers: {
            location: "https://untrusted.example.test/capture",
          },
          status: 307,
        });
      },
    );
    const client = new NotificationsAdministrationClient({
      baseUrl: "https://notifications.example.test",
      projectCredential: projectToken,
      fetch: fetchImplementation,
    });

    await expect(
      client.getMachineClient(machineClientId),
    ).rejects.toBeInstanceOf(NotificationsProtocolError);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("never follows a subscription redirect carrying a project credential", async () => {
    const fetchImplementation = vi.fn<NotificationsFetch>(
      async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          headers: {
            location: "https://untrusted.example.test/capture",
          },
          status: 307,
        });
      },
    );

    await expect(
      connectNotificationsMachine({
        baseUrl: "https://notifications.example.test",
        createIdempotencyKey: idempotencyKey,
        fetch: fetchImplementation,
        machineId,
        notifierId,
        projectCredential: projectToken,
        subscriberId,
      }),
    ).rejects.toMatchObject({
      cleanupIncomplete: false,
      code: "notifications-protocol-invalid",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and malformed admin responses before contract use", async () => {
    const oversized = new NotificationsAdministrationClient({
      baseUrl: "https://notifications.example.test",
      projectCredential: projectToken,
      fetch: async () =>
        new Response("{}", {
          headers: {
            "content-length": String(1024 * 1024 + 1),
            "content-type": "application/json",
          },
          status: 200,
        }),
    });
    await expect(
      oversized.getMachineClient(machineClientId),
    ).rejects.toBeInstanceOf(NotificationsProtocolError);

    const malformed = new NotificationsAdministrationClient({
      baseUrl: "https://notifications.example.test",
      projectCredential: projectToken,
      fetch: async () =>
        new Response("{", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });
    await expect(
      malformed.getMachineClient(machineClientId),
    ).rejects.toBeInstanceOf(NotificationsProtocolError);
  });

  it("keeps the typed upstream problem available for bounded callers", async () => {
    const client = new NotificationsAdministrationClient({
      baseUrl: "https://notifications.example.test",
      projectCredential: projectToken,
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "https://flowxo.com/notifications/problems/scope_forbidden",
            title: "Scope forbidden",
            status: 403,
            detail: "Synthetic protected detail.",
            code: "scope_forbidden",
            diagnostic_id: "diagnostic_setup_12345678",
            retryable: false,
          }),
          {
            headers: { "content-type": "application/problem+json" },
            status: 403,
          },
        ),
    });
    await expect(
      client.getMachineClient(machineClientId),
    ).rejects.toBeInstanceOf(NotificationsProblemError);
  });
});
