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
  NOTIFICATIONS_MACHINE_SCOPES,
} from "@agent-relay/notifications-transport";
import { afterEach, describe, expect, it } from "vitest";

import { runTransportCommand } from "./transport-command.js";
import {
  notificationsConnectionPaths,
  NotificationsConnectionConfigurationSchema,
  NotificationsMachineCredentialSchema,
  writeNotificationsConnection,
} from "./notifications-config.js";
import {
  readTransportSelection,
  resolveTransportSelection,
  transportSelectionPath,
  writeTransportSelection,
} from "./transport-config.js";

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

async function configureNotifications(stateDirectory: string) {
  const material = await createMachineCredentialMaterial();
  await writeNotificationsConnection(
    notificationsConnectionPaths(stateDirectory),
    NotificationsConnectionConfigurationSchema.parse({
      schema: "agent-relay-notifications-config.v1",
      status: "active",
      baseUrl: "https://notifications.example.test/",
      contractVersion: "1.0.0-rc.1",
      environment: "test",
      projectId: "project_private_full_identity",
      machineClientId: "machine_client_private_full_identity",
      subscriberId: "subscriber_private_full_identity",
      notifierId: "notifier_private_full_identity",
      bindingId: "binding_private_full_identity",
      currentCredentialId: material.credentialId,
      scopeSummary: [...NOTIFICATIONS_MACHINE_SCOPES],
      connectedAt: "2026-07-26T18:00:00.000Z",
      canaryMessageId: "message_private_full_identity",
      canaryDiagnosticId: "diagnostic_private_full_identity",
      pendingRevocations: [],
    }),
    NotificationsMachineCredentialSchema.parse({
      schema: "agent-relay-notifications-credential.v1",
      credentialId: material.credentialId,
      bearerToken: material.bearerToken,
      createdAt: "2026-07-26T18:00:00.000Z",
      rotation: { generation: 1 },
    }),
  );
  return material;
}

describe("durable transport selection", () => {
  it("defaults to fake even when both transport credential sets are present", async () => {
    const stateDirectory = await temporaryDirectory();
    const material = await configureNotifications(stateDirectory);

    const report = await runTransportCommand({
      args: ["status"],
      environment: {
        AGENT_RELAY_TELEGRAM_TOKEN: "123456:synthetic-token",
        AGENT_RELAY_TELEGRAM_CHAT_ID: "10001",
        AGENT_RELAY_TELEGRAM_OPERATOR_ID: "10002",
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
        notifications: {
          configured: true,
          credentialPresent: true,
          ready: true,
        },
      },
    });
    expect(serialized).not.toContain(material.bearerToken);
    expect(serialized).not.toContain("project_private_full_identity");
    expect(serialized).not.toContain("subscriber_private_full_identity");
    expect(serialized).not.toContain("binding_private_full_identity");
  });

  it("writes a strict mode-0600 selection and resolves override precedence", async () => {
    const stateDirectory = await temporaryDirectory();
    const path = transportSelectionPath(stateDirectory);
    await writeTransportSelection(
      path,
      "notifications",
      new Date("2026-07-26T19:00:00.000Z"),
    );

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(readTransportSelection(path)).resolves.toEqual({
      schema: "agent-relay-transport-selection.v1",
      selected: "notifications",
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
