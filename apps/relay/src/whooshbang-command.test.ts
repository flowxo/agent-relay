import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  markWhooshBangDisconnected,
  readWhooshBangOAuthProvisioningJournal,
  WhooshBangConnectionConfigurationSchema,
  WhooshBangMachineCredentialSchema,
  readWhooshBangConnection,
  writeWhooshBangOAuthProvisioningJournal,
  writeWhooshBangConnection,
} from "./whooshbang-config.js";

import type {
  MachineCredentialMaterial,
  WhooshBangFetch,
} from "@agent-relay/whooshbang-transport";
import type {
  AuthorizeWhooshBangMachineOptions,
  WhooshBangOAuthMachineResult,
} from "./whooshbang-oauth.js";
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

function oauthResult(
  material: MachineCredentialMaterial,
  suffix: string,
): WhooshBangOAuthMachineResult {
  return {
    cleanupProvisioned: vi.fn(async () => true),
    configuration: {
      baseUrl: "https://whooshbang.mock.test/",
      bindingId: `binding_${suffix}`,
      connectedAt: "2026-08-10T18:00:00.000Z",
      contractVersion: "1.0.0-rc.12",
      environment: "test",
      environmentId: `environment_${suffix}`,
      machineClientId: `machine_client_${suffix}`,
      notifierId: "default",
      projectId: `project_${suffix}`,
      scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
      subscriberId: `subscriber_${suffix}`,
    },
    credential: {
      bearerToken: material.bearerToken,
      createdAt: "2026-08-10T18:00:00.000Z",
      credentialId: material.credentialId,
    },
    proof: {
      authorization: "oauth-authorization-code-s256",
      grantedScopes: ["projects:read", "machine-clients:write"],
      machineScopeCount: 4,
      mcpProtocolVersion: "2025-11-25",
      narrowPollSchema: "whooshbang.machine-events.v1",
      projectResolvedBy: "only-active",
    },
  };
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
  it("uses OAuth/MCP by default and stores only the narrow machine credential", async () => {
    const stateDirectory = join(await temporaryDirectory(), "oauth");
    const material = await createMachineCredentialMaterial();
    const cleanupProvisioned = vi.fn(async () => true);
    const result: WhooshBangOAuthMachineResult = {
      cleanupProvisioned,
      configuration: {
        baseUrl: "https://whooshbang.mock.test/",
        bindingId: "binding_oauth_synthetic",
        connectedAt: "2026-08-10T18:00:00.000Z",
        contractVersion: "1.0.0-rc.12",
        environment: "test",
        environmentId: "environment_oauth_synthetic",
        machineClientId: "machine_client_oauth_synthetic",
        notifierId: "default",
        projectId: "project_oauth_synthetic",
        scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
        subscriberId: "subscriber_oauth_synthetic",
      },
      credential: {
        bearerToken: material.bearerToken,
        createdAt: "2026-08-10T18:00:00.000Z",
        credentialId: material.credentialId,
      },
      proof: {
        authorization: "oauth-authorization-code-s256",
        grantedScopes: ["projects:read", "machine-clients:write"],
        machineScopeCount: 4,
        mcpProtocolVersion: "2025-11-25",
        narrowPollSchema: "whooshbang.machine-events.v1",
        projectResolvedBy: "only-active",
      },
    };
    const authorizeMachine = vi.fn(
      async (_options: AuthorizeWhooshBangMachineOptions) => result,
    );

    const connected = await runWhooshBangCommand({
      args: ["connect", "--oauth"],
      authorizeMachine,
      environment: {
        AGENT_RELAY_WHOOSHBANG_BASE_URL: "https://whooshbang.mock.test",
        AGENT_RELAY_WHOOSHBANG_ENVIRONMENT: "test",
        AGENT_RELAY_WHOOSHBANG_NOTIFIER_ID: "default",
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL:
          "stale-broad-credential-must-be-ignored",
        AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID: "subscriber_oauth_synthetic",
      },
      stateDirectory,
    });

    expect(connected).toMatchObject({
      authorization: "oauth-authorization-code-s256",
      canary: "pending",
      canaryRef: null,
      credentialPresent: true,
      machineScopeCount: 4,
      mcpProtocolVersion: "2025-11-25",
      oauthScopeCount: 2,
      projectResolvedBy: "only-active",
      status: "connected",
    });
    expect(JSON.stringify(connected)).not.toContain(material.bearerToken);
    expect(JSON.stringify(connected)).not.toContain(
      "stale-broad-credential-must-be-ignored",
    );
    expect(authorizeMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://whooshbang.mock.test/",
        environment: "test",
        notifierId: "default",
        subscriberId: "subscriber_oauth_synthetic",
      }),
    );
    expect(authorizeMachine.mock.calls[0]?.[0]).not.toHaveProperty(
      "projectSelector",
    );
    expect(cleanupProvisioned).not.toHaveBeenCalled();
    await expect(
      readWhooshBangConnection(whooshbangConnectionPaths(stateDirectory)),
    ).resolves.toMatchObject({
      configuration: {
        currentCredentialId: material.credentialId,
      },
      credential: {
        bearerToken: material.bearerToken,
        credentialId: material.credentialId,
      },
    });
    const stored = await readWhooshBangConnection(
      whooshbangConnectionPaths(stateDirectory),
    );
    expect(stored?.configuration).not.toHaveProperty("canaryMessageId");
    expect(stored?.configuration).not.toHaveProperty("canaryDiagnosticId");
  });

  it("uses the in-memory OAuth cleanup when private persistence fails", async () => {
    const stateDirectory = join(await temporaryDirectory(), "oauth-failure");
    const paths = whooshbangConnectionPaths(stateDirectory);
    const material = await createMachineCredentialMaterial();
    const cleanupProvisioned = vi.fn(async () => true);
    const authorizeMachine = vi.fn(
      async (
        _options: AuthorizeWhooshBangMachineOptions,
      ): Promise<WhooshBangOAuthMachineResult> => {
        await mkdir(paths.credentialPath, { recursive: true, mode: 0o700 });
        return {
          cleanupProvisioned,
          configuration: {
            baseUrl: "https://whooshbang.mock.test/",
            bindingId: "binding_oauth_failure",
            connectedAt: "2026-08-10T18:00:00.000Z",
            contractVersion: "1.0.0-rc.12",
            environment: "test",
            environmentId: "environment_oauth_failure",
            machineClientId: "machine_client_oauth_failure",
            notifierId: "default",
            projectId: "project_oauth_failure",
            scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
            subscriberId: "subscriber_oauth_failure",
          },
          credential: {
            bearerToken: material.bearerToken,
            createdAt: "2026-08-10T18:00:00.000Z",
            credentialId: material.credentialId,
          },
          proof: {
            authorization: "oauth-authorization-code-s256",
            grantedScopes: ["projects:read", "machine-clients:write"],
            machineScopeCount: 4,
            mcpProtocolVersion: "2025-11-25",
            narrowPollSchema: "whooshbang.machine-events.v1",
            projectResolvedBy: "only-active",
          },
        };
      },
    );

    const failure = await runWhooshBangCommand({
      args: ["connect"],
      authorizeMachine,
      environment: {
        AGENT_RELAY_WHOOSHBANG_BASE_URL: "https://whooshbang.mock.test",
        AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID: "subscriber_oauth_failure",
      },
      stateDirectory,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      code: "whooshbang-setup-failed",
    });
    expect((failure as Error).message).not.toContain(material.bearerToken);
    expect(cleanupProvisioned).toHaveBeenCalledTimes(1);
  });

  it("replays one journaled bearer after an accepted response is lost", async () => {
    const stateDirectory = join(await temporaryDirectory(), "oauth-recovery");
    const paths = whooshbangConnectionPaths(stateDirectory);
    const generated = await createMachineCredentialMaterial();
    const createCredentialMaterial = vi.fn(async () => generated);
    let first = true;
    const observed: MachineCredentialMaterial[] = [];
    const authorizeMachine = vi.fn(
      async (
        options: AuthorizeWhooshBangMachineOptions,
      ): Promise<WhooshBangOAuthMachineResult> => {
        const material = await options.createCredentialMaterial!({
          environmentId: "environment_recovery",
          projectId: "project_recovery",
        });
        observed.push(material);
        if (first) {
          first = false;
          throw Object.assign(new Error("synthetic lost response"), {
            cleanupIncomplete: true,
          });
        }
        return oauthResult(material, "recovery");
      },
    );
    const runtime = {
      args: ["connect"],
      authorizeMachine,
      createCredentialMaterial,
      environment: {
        AGENT_RELAY_WHOOSHBANG_BASE_URL: "https://whooshbang.mock.test",
        AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID: "subscriber_recovery",
      },
      stateDirectory,
    };

    await expect(runWhooshBangCommand(runtime)).rejects.toThrow(
      "synthetic lost response",
    );
    const pending = await readWhooshBangOAuthProvisioningJournal(paths);
    expect(pending?.material.credentialId).toBe(generated.credentialId);
    expect((await stat(paths.oauthProvisioningPath)).mode & 0o077).toBe(0);
    const pendingStatus = await runWhooshBangCommand({
      args: ["status"],
      stateDirectory,
    });
    expect(pendingStatus).toEqual({
      configured: false,
      status: "oauth_recovery_pending",
    });
    expect(JSON.stringify(pendingStatus)).not.toContain(generated.bearerToken);
    await expect(
      runWhooshBangCommand({ args: ["disconnect"], stateDirectory }),
    ).resolves.toEqual({
      configured: false,
      status: "oauth_recovery_pending",
    });
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toMatchObject({
      credentialGeneration: 1,
      material: { credentialId: generated.credentialId },
    });
    const legacyFetch = vi.fn<WhooshBangFetch>(async () => {
      throw new Error("legacy recovery bypass must not reach WhooshBang");
    });
    const legacyMaterial = vi.fn(createMachineCredentialMaterial);
    await expect(
      runWhooshBangCommand({
        args: [
          "connect",
          "--legacy-project-credential",
          "--base-url",
          "https://whooshbang.mock.test",
          "--subscriber-id",
          "agent_relay_operator",
          "--wait-seconds",
          "0",
        ],
        createCredentialMaterial: legacyMaterial,
        environment: {
          AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
        },
        fetch: legacyFetch,
        stateDirectory,
      }),
    ).rejects.toThrow("pending WhooshBang OAuth recovery");
    expect(legacyFetch).not.toHaveBeenCalled();
    expect(legacyMaterial).not.toHaveBeenCalled();
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toMatchObject({
      material: { credentialId: generated.credentialId },
    });

    await expect(runWhooshBangCommand(runtime)).resolves.toMatchObject({
      status: "connected",
      canary: "pending",
    });
    expect(createCredentialMaterial).toHaveBeenCalledTimes(1);
    expect(observed.map((material) => material.credentialId)).toEqual([
      generated.credentialId,
      generated.credentialId,
    ]);
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();
  });

  it("reconciles a duplicate journal after persisted connection promotion and on disconnect", async () => {
    const stateDirectory = join(await temporaryDirectory(), "oauth-promoted");
    const paths = whooshbangConnectionPaths(stateDirectory);
    const material = await createMachineCredentialMaterial();
    const result = oauthResult(material, "promoted");
    const configuration = WhooshBangConnectionConfigurationSchema.parse({
      schema: "agent-relay-whooshbang-config.v1",
      status: "active",
      baseUrl: result.configuration.baseUrl,
      bindingId: result.configuration.bindingId,
      connectedAt: result.configuration.connectedAt,
      contractVersion: result.configuration.contractVersion,
      currentCredentialId: material.credentialId,
      environment: result.configuration.environment,
      machineClientId: result.configuration.machineClientId,
      notifierId: result.configuration.notifierId,
      pendingRevocations: [],
      projectId: result.configuration.projectId,
      scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
      subscriberId: result.configuration.subscriberId,
    });
    const credential = WhooshBangMachineCredentialSchema.parse({
      schema: "agent-relay-whooshbang-credential.v1",
      bearerToken: material.bearerToken,
      createdAt: result.credential.createdAt,
      credentialId: material.credentialId,
      rotation: { generation: 1 },
    });
    const writeDuplicateJournal = async () =>
      await writeWhooshBangOAuthProvisioningJournal(paths, {
        schema: "agent-relay-whooshbang-oauth-provisioning.v1",
        credentialGeneration: 1,
        material,
        recordedAt: "2026-08-10T18:00:00.000Z",
        target: {
          baseUrl: result.configuration.baseUrl,
          environment: result.configuration.environment,
          environmentId: result.configuration.environmentId,
          machineId: "machine_promoted_synthetic",
          notifierId: result.configuration.notifierId,
          projectId: result.configuration.projectId,
          subscriberId: result.configuration.subscriberId,
        },
      });
    await writeWhooshBangConnection(paths, configuration, credential);
    await writeFile(
      `${stateDirectory}/machine-id`,
      "machine_promoted_synthetic\n",
      { mode: 0o600 },
    );
    await writeDuplicateJournal();
    const authorizeMachine = vi.fn(
      async (_options: AuthorizeWhooshBangMachineOptions) => result,
    );

    const remoteFetch = vi.fn<WhooshBangFetch>();
    const alreadyConnected = await runWhooshBangCommand({
      args: ["connect"],
      authorizeMachine,
      environment: {
        AGENT_RELAY_WHOOSHBANG_BASE_URL: result.configuration.baseUrl,
        AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID: result.configuration.subscriberId,
      },
      fetch: remoteFetch,
      stateDirectory,
    });
    expect(alreadyConnected).toMatchObject({
      authorization: "oauth-authorization-code-s256",
      canary: "pending",
      configured: true,
      status: "already_connected",
    });
    expect(JSON.stringify(alreadyConnected)).not.toContain(
      material.bearerToken,
    );
    expect(JSON.stringify(alreadyConnected)).not.toContain(
      result.configuration.projectId,
    );
    expect(JSON.stringify(alreadyConnected)).not.toContain(
      result.configuration.subscriberId,
    );
    expect(authorizeMachine).not.toHaveBeenCalled();
    expect(remoteFetch).not.toHaveBeenCalled();
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();

    await writeDuplicateJournal();
    await expect(
      runWhooshBangCommand({
        args: ["connect", "--notifier-id", "different-notifier"],
        authorizeMachine,
        environment: {
          AGENT_RELAY_WHOOSHBANG_BASE_URL: result.configuration.baseUrl,
          AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID:
            result.configuration.subscriberId,
        },
        fetch: remoteFetch,
        stateDirectory,
      }),
    ).rejects.toThrow("Revoke the retained WhooshBang connection");
    expect(authorizeMachine).not.toHaveBeenCalled();
    expect(remoteFetch).not.toHaveBeenCalled();
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();

    await writeDuplicateJournal();
    await expect(
      runWhooshBangCommand({ args: ["status"], stateDirectory }),
    ).resolves.not.toHaveProperty("oauthRecoveryPending");
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();

    await writeDuplicateJournal();
    await expect(
      runWhooshBangCommand({ args: ["disconnect"], stateDirectory }),
    ).resolves.toMatchObject({ status: "disconnected" });
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();
  });

  it("recovers an exact journaled credential committed before its configuration marker", async () => {
    const stateDirectory = join(
      await temporaryDirectory(),
      "oauth-credential-only",
    );
    const paths = whooshbangConnectionPaths(stateDirectory);
    const material = await createMachineCredentialMaterial();
    const result = oauthResult(material, "credential_only");
    const machineId = "machine_credential_only_synthetic";
    await writeWhooshBangOAuthProvisioningJournal(paths, {
      schema: "agent-relay-whooshbang-oauth-provisioning.v1",
      credentialGeneration: 1,
      material,
      recordedAt: "2026-08-10T18:00:00.000Z",
      target: {
        baseUrl: result.configuration.baseUrl,
        environment: result.configuration.environment,
        environmentId: result.configuration.environmentId,
        machineId,
        notifierId: result.configuration.notifierId,
        projectId: result.configuration.projectId,
        subscriberId: result.configuration.subscriberId,
      },
    });
    await writeFile(`${stateDirectory}/machine-id`, `${machineId}\n`, {
      mode: 0o600,
    });
    await writeFile(
      paths.credentialPath,
      `${JSON.stringify(
        WhooshBangMachineCredentialSchema.parse({
          schema: "agent-relay-whooshbang-credential.v1",
          bearerToken: material.bearerToken,
          createdAt: result.credential.createdAt,
          credentialId: material.credentialId,
          rotation: { generation: 1 },
        }),
      )}\n`,
      { mode: 0o600 },
    );

    await expect(
      runWhooshBangCommand({ args: ["status"], stateDirectory }),
    ).resolves.toEqual({
      configured: false,
      status: "oauth_recovery_pending",
    });
    await expect(stat(paths.credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const authorizeMachine = vi.fn(
      async (options: AuthorizeWhooshBangMachineOptions) => {
        const replayed = await options.createCredentialMaterial!({
          environmentId: result.configuration.environmentId,
          projectId: result.configuration.projectId,
        });
        expect(replayed.credentialId).toBe(material.credentialId);
        return result;
      },
    );

    await expect(
      runWhooshBangCommand({
        args: ["connect"],
        authorizeMachine,
        environment: {
          AGENT_RELAY_WHOOSHBANG_BASE_URL: result.configuration.baseUrl,
          AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID:
            result.configuration.subscriberId,
        },
        stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "connected" });
    expect(authorizeMachine).toHaveBeenCalledTimes(1);
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toBeUndefined();
  });

  it("fails closed for a credential-only file that differs from the OAuth journal", async () => {
    const stateDirectory = join(
      await temporaryDirectory(),
      "oauth-credential-orphan",
    );
    const paths = whooshbangConnectionPaths(stateDirectory);
    const journaled = await createMachineCredentialMaterial();
    const orphaned = await createMachineCredentialMaterial();
    await writeWhooshBangOAuthProvisioningJournal(paths, {
      schema: "agent-relay-whooshbang-oauth-provisioning.v1",
      credentialGeneration: 1,
      material: journaled,
      recordedAt: "2026-08-10T18:00:00.000Z",
      target: {
        baseUrl: "https://whooshbang.mock.test/",
        environment: "test",
        environmentId: "environment_orphaned",
        machineId: "machine_orphaned_synthetic",
        notifierId: "default",
        projectId: "project_orphaned",
        subscriberId: "subscriber_orphaned",
      },
    });
    await writeFile(
      paths.credentialPath,
      `${JSON.stringify(
        WhooshBangMachineCredentialSchema.parse({
          schema: "agent-relay-whooshbang-credential.v1",
          bearerToken: orphaned.bearerToken,
          createdAt: "2026-08-10T18:00:00.000Z",
          credentialId: orphaned.credentialId,
          rotation: { generation: 1 },
        }),
      )}\n`,
      { mode: 0o600 },
    );

    await expect(
      runWhooshBangCommand({ args: ["status"], stateDirectory }),
    ).rejects.toThrow("does not match its OAuth recovery journal");
    await expect(stat(paths.credentialPath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toMatchObject({
      material: { credentialId: journaled.credentialId },
    });
  });

  it("replays journal generation two after its candidate replaced a retained revoked credential", async () => {
    const stateDirectory = join(
      await temporaryDirectory(),
      "oauth-revoked-generation",
    );
    const paths = whooshbangConnectionPaths(stateDirectory);
    const previousMaterial = await createMachineCredentialMaterial();
    const candidate = await createMachineCredentialMaterial();
    const previousResult = oauthResult(previousMaterial, "previous_revoked");
    await writeWhooshBangConnection(
      paths,
      WhooshBangConnectionConfigurationSchema.parse({
        schema: "agent-relay-whooshbang-config.v1",
        status: "active",
        baseUrl: previousResult.configuration.baseUrl,
        bindingId: previousResult.configuration.bindingId,
        connectedAt: previousResult.configuration.connectedAt,
        contractVersion: previousResult.configuration.contractVersion,
        currentCredentialId: previousMaterial.credentialId,
        environment: previousResult.configuration.environment,
        machineClientId: previousResult.configuration.machineClientId,
        notifierId: previousResult.configuration.notifierId,
        pendingRevocations: [],
        projectId: previousResult.configuration.projectId,
        scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
        subscriberId: previousResult.configuration.subscriberId,
      }),
      WhooshBangMachineCredentialSchema.parse({
        schema: "agent-relay-whooshbang-credential.v1",
        bearerToken: previousMaterial.bearerToken,
        createdAt: previousResult.credential.createdAt,
        credentialId: previousMaterial.credentialId,
        rotation: { generation: 1 },
      }),
    );
    await markWhooshBangDisconnected(paths, {
      at: new Date("2026-08-10T18:05:00.000Z"),
      revoked: true,
    });
    const result = oauthResult(candidate, "generation_two");
    const machineId = "machine_generation_two_synthetic";
    await writeWhooshBangOAuthProvisioningJournal(paths, {
      schema: "agent-relay-whooshbang-oauth-provisioning.v1",
      credentialGeneration: 2,
      material: candidate,
      recordedAt: "2026-08-10T18:10:00.000Z",
      target: {
        baseUrl: result.configuration.baseUrl,
        environment: result.configuration.environment,
        environmentId: result.configuration.environmentId,
        machineId,
        notifierId: result.configuration.notifierId,
        projectId: result.configuration.projectId,
        subscriberId: result.configuration.subscriberId,
      },
    });
    await writeFile(`${stateDirectory}/machine-id`, `${machineId}\n`, {
      mode: 0o600,
    });
    await writeFile(
      paths.credentialPath,
      `${JSON.stringify(
        WhooshBangMachineCredentialSchema.parse({
          schema: "agent-relay-whooshbang-credential.v1",
          bearerToken: candidate.bearerToken,
          createdAt: result.credential.createdAt,
          credentialId: candidate.credentialId,
          rotation: {
            generation: 2,
            replacesCredentialId: previousMaterial.credentialId,
          },
        }),
      )}\n`,
      { mode: 0o600 },
    );

    await expect(
      runWhooshBangCommand({ args: ["status"], stateDirectory }),
    ).resolves.toMatchObject({
      credentialPresent: false,
      oauthRecoveryPending: true,
      status: "revoked",
    });
    await expect(
      runWhooshBangCommand({
        args: ["disconnect", "--erase-credential", "--erase-configuration"],
        stateDirectory,
      }),
    ).resolves.toMatchObject({
      configured: false,
      oauthRecoveryPending: true,
      status: "revoked",
    });
    await expect(
      readWhooshBangOAuthProvisioningJournal(paths),
    ).resolves.toMatchObject({
      credentialGeneration: 2,
      material: { credentialId: candidate.credentialId },
    });
    const authorizeMachine = vi.fn(
      async (options: AuthorizeWhooshBangMachineOptions) => {
        const replayed = await options.createCredentialMaterial!({
          environmentId: result.configuration.environmentId,
          projectId: result.configuration.projectId,
        });
        expect(replayed.credentialId).toBe(candidate.credentialId);
        return result;
      },
    );
    await expect(
      runWhooshBangCommand({
        args: ["connect"],
        authorizeMachine,
        environment: {
          AGENT_RELAY_WHOOSHBANG_BASE_URL: result.configuration.baseUrl,
          AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID:
            result.configuration.subscriberId,
        },
        stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "connected" });
    await expect(readWhooshBangConnection(paths)).resolves.toMatchObject({
      configuration: { status: "active" },
      credential: {
        credentialId: candidate.credentialId,
        rotation: { generation: 2 },
      },
    });
  });

  it("serializes OAuth, legacy, and disconnect before another lifecycle can begin", async () => {
    const stateDirectory = join(await temporaryDirectory(), "oauth-lock");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authorizeMachine = vi.fn(
      async (
        _options: AuthorizeWhooshBangMachineOptions,
      ): Promise<WhooshBangOAuthMachineResult> => {
        entered();
        await held;
        return oauthResult(await createMachineCredentialMaterial(), "locked");
      },
    );
    const runtime = {
      args: ["connect"],
      authorizeMachine,
      environment: {
        AGENT_RELAY_WHOOSHBANG_BASE_URL: "https://whooshbang.mock.test",
        AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID: "subscriber_locked",
      },
      stateDirectory,
    };

    const firstConnect = runWhooshBangCommand(runtime);
    await started;
    await expect(runWhooshBangCommand(runtime)).rejects.toThrow(
      "already in progress",
    );
    const createLegacyMaterial = vi.fn(createMachineCredentialMaterial);
    const legacyFetch = vi.fn<WhooshBangFetch>(async () => {
      throw new Error("legacy provisioning must not start");
    });
    await expect(
      runWhooshBangCommand({
        args: [
          "connect",
          "--legacy-project-credential",
          "--base-url",
          "https://whooshbang.mock.test",
          "--subscriber-id",
          "agent_relay_operator",
          "--wait-seconds",
          "0",
        ],
        createCredentialMaterial: createLegacyMaterial,
        environment: {
          AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
        },
        fetch: legacyFetch,
        stateDirectory,
      }),
    ).rejects.toThrow("lifecycle operation is already in progress");
    await expect(
      runWhooshBangCommand({ args: ["disconnect"], stateDirectory }),
    ).rejects.toThrow("lifecycle operation is already in progress");
    expect(createLegacyMaterial).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
    release();
    await expect(firstConnect).resolves.toMatchObject({ status: "connected" });
    expect(authorizeMachine).toHaveBeenCalledTimes(1);
  });

  it("does not let a disconnect interleave with a legacy rotation snapshot", async () => {
    const stateDirectory = join(await temporaryDirectory(), "legacy-lock");
    const materials = [
      await createMachineCredentialMaterial(),
      await createMachineCredentialMaterial(),
    ];
    const mock = createWhooshBangContractMock({
      credentials: mockCredentials(materials),
      idGenerator: sequentialIdGenerator(),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let generation = 0;
    const createCredentialMaterial = async () => {
      const material = materials[generation];
      generation += 1;
      if (generation === 2) {
        entered();
        await held;
      }
      if (material === undefined) {
        throw new Error("Synthetic credential generation exhausted.");
      }
      return material;
    };
    const args = [
      "connect",
      "--legacy-project-credential",
      "--base-url",
      "https://whooshbang.mock.test",
      "--subscriber-id",
      "agent_relay_operator",
      "--wait-seconds",
      "0",
    ];
    const shared = {
      args,
      createCredentialMaterial,
      environment: {
        AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: projectCredential,
      },
      fetch: fetchFor(mock),
      stateDirectory,
    };

    await expect(runWhooshBangCommand(shared)).resolves.toMatchObject({
      status: "connected",
    });
    const rotation = runWhooshBangCommand(shared);
    await started;
    await expect(
      runWhooshBangCommand({ args: ["disconnect"], stateDirectory }),
    ).rejects.toThrow("lifecycle operation is already in progress");
    release();
    await expect(rotation).resolves.toMatchObject({ status: "connected" });
    await expect(
      readWhooshBangConnection(whooshbangConnectionPaths(stateDirectory)),
    ).resolves.toMatchObject({
      configuration: { status: "active" },
      credential: { rotation: { generation: 2 } },
    });
  }, 15_000);

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
        "--legacy-project-credential",
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
          "--legacy-project-credential",
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
        "--legacy-project-credential",
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
      "--legacy-project-credential",
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
        "--legacy-project-credential",
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
        contractVersion: "1.0.0-rc.12",
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
          "--legacy-project-credential",
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
        "--legacy-project-credential",
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
