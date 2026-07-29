import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMachineCredentialMaterial,
  WHOOSHBANG_MACHINE_SCOPES,
  WhooshBangSetupError,
} from "@agent-relay/whooshbang-transport";
import { createWhooshBangContractMock } from "@whooshbang/contract-mock";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveWhooshBangProjectCredential,
  runWhooshBangCommand,
} from "./whooshbang-command.js";
import {
  whooshbangConnectionPaths,
  WhooshBangConnectionConfigurationSchema,
  WhooshBangMachineCredentialSchema,
  readWhooshBangConnection,
  writeWhooshBangConnection,
} from "./whooshbang-config.js";

import type {
  MachineCredentialMaterial,
  WhooshBangFetch,
} from "@agent-relay/whooshbang-transport";
import type {
  ContractMockCredential,
  ContractMockIdGenerator,
  WhooshBangContractMock,
} from "@whooshbang/contract-mock";

const temporaryDirectories: string[] = [];
const projectCredential = "synthetic-project-command-token";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-whooshbang-command-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function mockCredentials(
  materials: readonly MachineCredentialMaterial[],
  sharedMachineClientId?: string,
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
      token: projectCredential,
    },
    ...materials.map((material, index): ContractMockCredential => ({
      accountId: "account_synthetic",
      bindingId: `binding_command_${String(index + 1).padStart(3, "0")}`,
      environment: "test",
      kind: "machine",
      machineClientId:
        sharedMachineClientId ??
        `machine_client_command_${String(index + 1).padStart(3, "0")}`,
      machineId: `machine_command_${String(index + 1).padStart(3, "0")}`,
      notifierId: "default",
      projectId: "project_synthetic",
      scopes: [
        "machine-messages:write",
        "machine-messages:read",
        "machine-events:read",
        "machine-events:ack",
      ],
      status: "active",
      subscriberId: "agent_relay_operator",
      token: material.bearerToken,
    })),
  ];
}

function sequentialIdGenerator(): ContractMockIdGenerator {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_command_${String(next).padStart(3, "0")}`;
  };
}

function sharedMachineClientIdGenerator(
  machineClientId: string,
): ContractMockIdGenerator {
  const next = sequentialIdGenerator();
  return (kind) => (kind === "machine_client" ? machineClientId : next(kind));
}

function fetchFor(mock: WhooshBangContractMock): WhooshBangFetch {
  return async (input, init) => mock.fetch(new Request(input, init));
}

describe("WhooshBang project credential input", () => {
  it("prefers environment injection without reading or prompting", async () => {
    const readStdin = vi.fn(async () => "stdin-value");
    const prompt = vi.fn(async () => "prompt-value");
    await expect(
      resolveWhooshBangProjectCredential({
        environmentValue: "environment-value",
        prompt,
        readStdin,
        useStdin: true,
      }),
    ).resolves.toBe("environment-value");
    expect(readStdin).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("supports bounded stdin or a hidden-prompt provider", async () => {
    await expect(
      resolveWhooshBangProjectCredential({
        readStdin: async () => "  stdin-value\n",
        useStdin: true,
      }),
    ).resolves.toBe("stdin-value");
    await expect(
      resolveWhooshBangProjectCredential({
        prompt: async () => "prompt-value",
        readStdin: async () => {
          throw new Error("must not read stdin");
        },
        useStdin: false,
      }),
    ).resolves.toBe("prompt-value");
  });
});

describe("WhooshBang CLI lifecycle", () => {
  it("connects, reports safe status, rotates, revokes, and erases explicitly", async () => {
    const stateDirectory = join(await temporaryDirectory(), "state");
    const materials = [
      await createMachineCredentialMaterial(),
      await createMachineCredentialMaterial(),
    ];
    const remainingMaterials = [...materials];
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials(materials),
      idGenerator: sequentialIdGenerator(),
    });
    const diagnostics: unknown[] = [];
    let idempotencySequence = 0;
    const shared = {
      createCredentialMaterial: async () => {
        const material = remainingMaterials.shift();
        if (material === undefined) {
          throw new Error("Synthetic material exhausted.");
        }
        return material;
      },
      createIdempotencyKey: (operation: string) => {
        idempotencySequence += 1;
        return `command-${operation}-${String(idempotencySequence).padStart(
          8,
          "0",
        )}`;
      },
      environment: {
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
      },
      fetch: fetchFor(mock),
      stateDirectory,
      stdinIsTTY: true,
      writeDiagnostic: (value: unknown) => {
        diagnostics.push(value);
      },
    } as const;

    const first = await runWhooshBangCommand({
      ...shared,
      args: [
        "connect",
        "--base-url",
        "https://whooshbang.mock.test",
        "--subscriber-id",
        "agent_relay_operator",
        "--wait-seconds",
        "0",
      ],
      now: () => new Date("2026-07-26T18:00:00.000Z"),
    });
    const serializedFirst = JSON.stringify(first);
    expect(first).toMatchObject({
      status: "connected",
      configured: true,
      credentialPresent: true,
      canary: "accepted",
      pendingRevocations: 0,
    });
    expect(serializedFirst).not.toContain(projectCredential);
    expect(serializedFirst).not.toContain(materials[0]?.bearerToken);
    expect(serializedFirst).not.toContain("agent_relay_operator");
    expect(serializedFirst).not.toContain("machine_client_command_001");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "whooshbang.authorization-required",
        authorizationUrl: expect.stringMatching(/^https:\/\//u),
      }),
    );

    const paths = whooshbangConnectionPaths(stateDirectory);
    const credentialFile = await readFile(paths.credentialPath, "utf8");
    const configurationFile = await readFile(paths.configurationPath, "utf8");
    expect(credentialFile).toContain(materials[0]?.bearerToken);
    expect(credentialFile).not.toContain(projectCredential);
    expect(configurationFile).not.toContain(materials[0]?.bearerToken);

    await expect(
      runWhooshBangCommand({
        ...shared,
        args: ["status"],
      }),
    ).resolves.toMatchObject({
      configured: true,
      credentialPresent: true,
      status: "active",
    });

    const crossOriginFetch = vi.fn<WhooshBangFetch>(fetchFor(mock));
    await expect(
      runWhooshBangCommand({
        ...shared,
        args: [
          "connect",
          "--base-url",
          "https://other-whooshbang.mock.test",
          "--subscriber-id",
          "agent_relay_operator",
          "--wait-seconds",
          "0",
        ],
        fetch: crossOriginFetch,
      }),
    ).rejects.toMatchObject({
      cleanupIncomplete: false,
      code: "whooshbang-setup-invalid",
    });
    expect(crossOriginFetch).not.toHaveBeenCalled();

    await expect(
      runWhooshBangCommand({
        ...shared,
        args: ["disconnect"],
        now: () => new Date("2026-07-26T18:30:00.000Z"),
      }),
    ).resolves.toMatchObject({
      remoteRevocationProven: false,
      status: "disconnected",
    });

    const rotated = await runWhooshBangCommand({
      ...shared,
      args: [
        "connect",
        "--base-url",
        "https://whooshbang.mock.test",
        "--subscriber-id",
        "agent_relay_operator",
        "--wait-seconds",
        "0",
      ],
      now: () => new Date("2026-07-26T19:00:00.000Z"),
    });
    expect(rotated).toMatchObject({
      status: "connected",
      pendingRevocations: 0,
    });
    const rotatedStored = await readWhooshBangConnection(paths);
    expect(rotatedStored?.credential).toMatchObject({
      credentialId: materials[1]?.credentialId,
      rotation: {
        generation: 2,
        replacesCredentialId: materials[0]?.credentialId,
      },
    });
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({
        id: "machine_client_command_001",
        status: "revoked",
      }),
    );
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({
        id: "machine_client_command_002",
        status: "active",
      }),
    );

    await expect(
      runWhooshBangCommand({
        ...shared,
        args: [
          "disconnect",
          "--revoke",
          "--erase-credential",
          "--erase-configuration",
        ],
        now: () => new Date("2026-07-26T20:00:00.000Z"),
      }),
    ).resolves.toEqual({
      configured: false,
      localConfigurationErased: true,
      localCredentialErased: true,
      remoteRevocationProven: true,
      status: "revoked",
    });
    await expect(
      runWhooshBangCommand({
        ...shared,
        args: ["status"],
      }),
    ).resolves.toEqual({
      configured: false,
      status: "not_configured",
    });
  }, 15_000);

  it("rejects positional credentials without reflecting their value", async () => {
    const failure = await runWhooshBangCommand({
      args: ["connect", "private-positional-value"],
      environment: {},
      stateDirectory: await temporaryDirectory(),
      stdinIsTTY: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "credentials must never be positional",
    );
    expect((failure as Error).message).not.toContain(
      "private-positional-value",
    );
  });

  it("rotates a credential without revoking a reused live machine client", async () => {
    const stateDirectory = join(await temporaryDirectory(), "same-client");
    const machineClientId = "machine_client_command_shared";
    const materials = [
      await createMachineCredentialMaterial(),
      await createMachineCredentialMaterial(),
    ];
    const remainingMaterials = [...materials];
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials(materials, machineClientId),
      idGenerator: sharedMachineClientIdGenerator(machineClientId),
    });
    let idempotencySequence = 0;
    const shared = {
      createCredentialMaterial: async () => {
        const material = remainingMaterials.shift();
        if (material === undefined) {
          throw new Error("Synthetic material exhausted.");
        }
        return material;
      },
      createIdempotencyKey: (operation: string) => {
        idempotencySequence += 1;
        return `same-client-${operation}-${String(idempotencySequence).padStart(
          8,
          "0",
        )}`;
      },
      environment: {
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
      },
      fetch: fetchFor(mock),
      stateDirectory,
      stdinIsTTY: true,
    } as const;
    const connectArgs = [
      "connect",
      "--base-url",
      "https://whooshbang.mock.test",
      "--subscriber-id",
      "agent_relay_operator",
      "--wait-seconds",
      "0",
    ];

    await runWhooshBangCommand({
      ...shared,
      args: connectArgs,
      now: () => new Date("2026-07-26T18:00:00.000Z"),
    });
    await expect(
      runWhooshBangCommand({
        ...shared,
        args: connectArgs,
        now: () => new Date("2026-07-26T19:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      pendingRevocations: 0,
      status: "connected",
    });

    const snapshot = mock.inspect();
    expect(snapshot.machineClients).toContainEqual(
      expect.objectContaining({
        id: machineClientId,
        status: "active",
      }),
    );
    expect(snapshot.machineCredentials).toContainEqual(
      expect.objectContaining({
        credential_id: materials[0]?.credentialId,
        status: "revoked",
      }),
    );
    expect(snapshot.machineCredentials).toContainEqual(
      expect.objectContaining({
        credential_id: materials[1]?.credentialId,
        status: "active",
      }),
    );
  });

  it("revokes remote setup when private local storage cannot commit", async () => {
    const stateDirectory = join(await temporaryDirectory(), "storage-failure");
    const material = await createMachineCredentialMaterial();
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials([material]),
      idGenerator: sequentialIdGenerator(),
    });
    const paths = whooshbangConnectionPaths(stateDirectory);
    let blockedStorage = false;
    const fetchImplementation: WhooshBangFetch = async (input, init) => {
      const request = new Request(input, init);
      if (!blockedStorage && new URL(request.url).pathname === "/v1/messages") {
        await mkdir(paths.credentialPath);
        blockedStorage = true;
      }
      return await mock.fetch(request);
    };

    const failure = await runWhooshBangCommand({
      args: [
        "connect",
        "--base-url",
        "https://whooshbang.mock.test",
        "--subscriber-id",
        "agent_relay_operator",
        "--wait-seconds",
        "0",
      ],
      createCredentialMaterial: async () => material,
      createIdempotencyKey: (operation) =>
        `storage-failure-${operation}-12345678`,
      environment: {
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
      },
      fetch: fetchImplementation,
      stateDirectory,
      stdinIsTTY: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WhooshBangSetupError);
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      code: "whooshbang-setup-failed",
    });
    expect((failure as Error).message).not.toContain(projectCredential);
    expect((failure as Error).message).not.toContain(material.bearerToken);
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({
        id: "machine_client_command_001",
        status: "revoked",
      }),
    );
    expect(mock.inspect().machineCredentials).toContainEqual(
      expect.objectContaining({
        credential_id: material.credentialId,
        status: "revoked",
      }),
    );
  });

  it("revokes a new client when retained cleanup state exceeds its safe bound", async () => {
    const stateDirectory = join(await temporaryDirectory(), "cleanup-bound");
    const paths = whooshbangConnectionPaths(stateDirectory);
    const currentMaterial = await createMachineCredentialMaterial();
    const replacementMaterial = await createMachineCredentialMaterial();
    const pendingMaterials = await Promise.all(
      Array.from(
        { length: 20 },
        async () => await createMachineCredentialMaterial(),
      ),
    );
    await writeWhooshBangConnection(
      paths,
      WhooshBangConnectionConfigurationSchema.parse({
        schema: "agent-relay-whooshbang-config.v1",
        status: "active",
        baseUrl: "https://whooshbang.mock.test/",
        contractVersion: "1.0.0-rc.4",
        environment: "test",
        projectId: "project_synthetic",
        machineClientId: "machine_client_retained_current",
        subscriberId: "agent_relay_operator",
        notifierId: "default",
        bindingId: "binding_synthetic_relay",
        currentCredentialId: currentMaterial.credentialId,
        scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
        connectedAt: "2026-07-26T17:00:00.000Z",
        canaryMessageId: "message_retained_canary",
        canaryDiagnosticId: "diagnostic_retained_canary",
        pendingRevocations: pendingMaterials.map((material, index) => ({
          machineClientId: `machine_client_pending_${String(index).padStart(
            3,
            "0",
          )}`,
          credentialId: material.credentialId,
          recordedAt: "2026-07-26T16:00:00.000Z",
        })),
      }),
      WhooshBangMachineCredentialSchema.parse({
        schema: "agent-relay-whooshbang-credential.v1",
        credentialId: currentMaterial.credentialId,
        bearerToken: currentMaterial.bearerToken,
        createdAt: "2026-07-26T17:00:00.000Z",
        rotation: { generation: 1 },
      }),
    );
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials([replacementMaterial]),
      idGenerator: sequentialIdGenerator(),
    });

    await expect(
      runWhooshBangCommand({
        args: [
          "connect",
          "--base-url",
          "https://whooshbang.mock.test",
          "--subscriber-id",
          "agent_relay_operator",
          "--wait-seconds",
          "0",
        ],
        createCredentialMaterial: async () => replacementMaterial,
        createIdempotencyKey: (operation) =>
          `cleanup-bound-${operation}-12345678`,
        environment: {
          AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
        },
        fetch: fetchFor(mock),
        stateDirectory,
        stdinIsTTY: true,
      }),
    ).rejects.toMatchObject({
      cleanupIncomplete: false,
      code: "whooshbang-setup-failed",
    });
    expect(mock.inspect().machineClients).toContainEqual(
      expect.objectContaining({
        id: "machine_client_command_001",
        status: "revoked",
      }),
    );
    await expect(readWhooshBangConnection(paths)).resolves.toMatchObject({
      configuration: {
        currentCredentialId: currentMaterial.credentialId,
        pendingRevocations: expect.arrayContaining([
          expect.objectContaining({
            credentialId: pendingMaterials[0]?.credentialId,
          }),
        ]),
      },
      credential: {
        credentialId: currentMaterial.credentialId,
      },
    });
  });

  it("does not claim success or write files when authorization remains pending", async () => {
    const stateDirectory = join(await temporaryDirectory(), "pending");
    const material = await createMachineCredentialMaterial();
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials([material]),
      idGenerator: sequentialIdGenerator(),
      scenario: "cancellation-before-send",
    });

    const result = await runWhooshBangCommand({
      args: [
        "connect",
        "--base-url",
        "https://whooshbang.mock.test",
        "--subscriber-id",
        "agent_relay_operator",
        "--wait-seconds",
        "0",
      ],
      createCredentialMaterial: async () => material,
      createIdempotencyKey: (operation) => `pending-${operation}-12345678`,
      environment: {
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
      },
      fetch: fetchFor(mock),
      stateDirectory,
      stdinIsTTY: true,
    });

    expect(result).toMatchObject({
      status: "authorization_pending",
      credentialStored: false,
    });
    await expect(
      readWhooshBangConnection(whooshbangConnectionPaths(stateDirectory)),
    ).resolves.toBeUndefined();
  });
});
