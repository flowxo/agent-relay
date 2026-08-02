import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMachineCredentialMaterial,
  WHOOSHBANG_MACHINE_SCOPES,
} from "@agent-relay/whooshbang-transport";
import { afterEach, describe, expect, it } from "vitest";

import { runTransportCommand } from "./transport-command.js";
import {
  whooshbangConnectionPaths,
  WhooshBangConnectionConfigurationSchema,
  WhooshBangMachineCredentialSchema,
  writeWhooshBangConnection,
} from "./whooshbang-config.js";
import {
  readTransportSelection,
  resolveTransportSelection,
  transportSelectionPath,
  writeTransportSelection,
} from "./transport-config.js";
import {
  webhookConfigurationPath,
  writeWebhookConfiguration,
} from "./webhook-config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-transport-command-"),
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

async function configureWhooshBang(stateDirectory: string) {
  const material = await createMachineCredentialMaterial();
  await writeWhooshBangConnection(
    whooshbangConnectionPaths(stateDirectory),
    WhooshBangConnectionConfigurationSchema.parse({
      schema: "agent-relay-whooshbang-config.v1",
      status: "active",
      baseUrl: "https://whooshbang.example.test/",
      contractVersion: "1.0.0-rc.5",
      environment: "test",
      projectId: "project_private_full_identity",
      machineClientId: "machine_client_private_full_identity",
      subscriberId: "subscriber_private_full_identity",
      notifierId: "notifier_private_full_identity",
      bindingId: "binding_private_full_identity",
      currentCredentialId: material.credentialId,
      scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
      connectedAt: "2026-07-26T18:00:00.000Z",
      canaryMessageId: "message_private_full_identity",
      canaryDiagnosticId: "diagnostic_private_full_identity",
      pendingRevocations: [],
    }),
    WhooshBangMachineCredentialSchema.parse({
      schema: "agent-relay-whooshbang-credential.v1",
      credentialId: material.credentialId,
      bearerToken: material.bearerToken,
      createdAt: "2026-07-26T18:00:00.000Z",
      rotation: { generation: 1 },
    }),
  );
  return material;
}

describe("durable transport selection", () => {
  it("defaults to fake even when every transport credential set is present", async () => {
    const stateDirectory = await temporaryDirectory();
    const material = await configureWhooshBang(stateDirectory);

    const report = await runTransportCommand({
      args: ["status"],
      environment: {
        AGENT_RELAY_TELEGRAM_TOKEN: "123456:synthetic-token",
        AGENT_RELAY_TELEGRAM_CHAT_ID: "10001",
        AGENT_RELAY_TELEGRAM_OPERATOR_ID: "10002",
        AGENT_RELAY_WEBHOOK_URL:
          "https://receiver.example.test/private/path?tenant=private",
        AGENT_RELAY_WEBHOOK_SECRET: "synthetic-private-webhook-secret-material",
      },
      stateDirectory,
    });
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({
      selectedTransport: "fake",
      selection: {
        configured: false,
        selected: "fake",
        source: "default",
      },
      transports: {
        fake: { ready: true },
        telegram: {
          deliveryReady: true,
          replyReady: true,
          ready: true,
        },
        whooshbang: {
          configured: true,
          credentialPresent: true,
          ready: true,
        },
        webhook: {
          endpointOrigin: "https://receiver.example.test",
          ready: true,
          secretPresent: true,
          source: "environment",
        },
      },
    });
    expect(serialized).not.toContain(material.bearerToken);
    expect(serialized).not.toContain("project_private_full_identity");
    expect(serialized).not.toContain("subscriber_private_full_identity");
    expect(serialized).not.toContain("binding_private_full_identity");
    expect(serialized).not.toContain("synthetic-private-webhook");
    expect(serialized).not.toContain("tenant=private");
  });

  it("writes a strict mode-0600 selection and resolves override precedence", async () => {
    const stateDirectory = await temporaryDirectory();
    const path = transportSelectionPath(stateDirectory);
    await writeTransportSelection(
      path,
      "whooshbang",
      new Date("2026-07-26T19:00:00.000Z"),
    );

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(readTransportSelection(path)).resolves.toEqual({
      schema: "agent-relay-transport-selection.v1",
      selected: "whooshbang",
      updatedAt: "2026-07-26T19:00:00.000Z",
    });
    await expect(
      resolveTransportSelection({
        stateDirectory,
        environmentOverride: "telegram",
      }),
    ).resolves.toMatchObject({
      selected: "telegram",
      source: "environment",
    });
    await expect(
      resolveTransportSelection({
        stateDirectory,
        commandLineOverride: "fake",
        environmentOverride: "telegram",
      }),
    ).resolves.toMatchObject({
      selected: "fake",
      source: "command-line",
    });
    await expect(
      runTransportCommand({
        args: ["status"],
        environment: { AGENT_RELAY_TRANSPORT: "telegram" },
        stateDirectory,
      }),
    ).resolves.toMatchObject({
      selectedTransport: "telegram",
      selection: {
        selected: "telegram",
        source: "environment",
      },
    });
  });

  it("switches only future daemon selection and preserves unrelated state", async () => {
    const stateDirectory = await temporaryDirectory();
    const databasePath = join(stateDirectory, "relay.sqlite");
    const sentinel = "synthetic retained event/request/decision state\n";
    await writeFile(databasePath, sentinel, { mode: 0o600 });

    await expect(
      runTransportCommand({
        args: ["select", "telegram"],
        environment: {},
        now: () => new Date("2026-07-26T20:00:00.000Z"),
        stateDirectory,
      }),
    ).resolves.toMatchObject({
      restartRequired: true,
      retainedLocalState: true,
      durableSelection: "telegram",
      selectedTransport: "telegram",
      selection: { source: "durable" },
      transports: {
        telegram: {
          ready: false,
          issueCodes: ["telegram-not-configured"],
        },
      },
    });
    await expect(readFile(databasePath, "utf8")).resolves.toBe(sentinel);
  });

  it("selects a ready file-backed webhook without exposing its secret or URL path", async () => {
    const stateDirectory = await temporaryDirectory();
    const secret = "synthetic-file-webhook-secret-material-001";
    await writeWebhookConfiguration(webhookConfigurationPath(stateDirectory), {
      endpoint:
        "https://receiver.example.test/private/agent-relay?tenant=private",
      secret,
    });

    const result = await runTransportCommand({
      args: ["select", "webhook"],
      environment: {},
      stateDirectory,
    });
    expect(result).toMatchObject({
      durableSelection: "webhook",
      selectedTransport: "webhook",
      transports: {
        webhook: {
          endpointOrigin: "https://receiver.example.test",
          ready: true,
          source: "file",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("/private/agent-relay");
    expect(JSON.stringify(result)).not.toContain("tenant=private");
  });

  it("rejects permissive and symlinked selection files without touching referents", async () => {
    const stateDirectory = await temporaryDirectory();
    const path = transportSelectionPath(stateDirectory);
    await writeTransportSelection(path, "fake");
    await chmod(path, 0o644);
    await expect(readTransportSelection(path)).rejects.toThrow(
      "must not be accessible",
    );

    await rm(path);
    const target = join(stateDirectory, "outside.json");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await symlink(target, path);
    await expect(writeTransportSelection(path, "telegram")).rejects.toThrow(
      "not a regular file",
    );
    await expect(readFile(target, "utf8")).resolves.toBe("untouched\n");
  });
});
