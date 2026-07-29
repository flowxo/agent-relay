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

import { afterEach, describe, expect, it } from "vitest";

import { runWebhookCommand } from "./webhook-command.js";
import {
  readWebhookConfiguration,
  resolveWebhookConfiguration,
  webhookConfigurationPath,
  writeWebhookConfiguration,
} from "./webhook-config.js";

const temporaryDirectories: string[] = [];
const secret = "synthetic-webhook-secret-material-0001";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-webhook-config-"),
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

describe("outbound webhook configuration", () => {
  it("writes and reads a strict mode-0600 credential file", async () => {
    const stateDirectory = await temporaryDirectory();
    const path = webhookConfigurationPath(stateDirectory);
    await writeWebhookConfiguration(
      path,
      {
        endpoint: "https://receiver.example.test/agent-relay?tenant=test",
        secret,
        timeoutMs: 7_500,
      },
      new Date("2026-07-28T14:00:00.000Z"),
    );

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(readWebhookConfiguration(path)).resolves.toEqual({
      schema: "agent-relay-webhook-config.v1",
      endpoint: "https://receiver.example.test/agent-relay?tenant=test",
      secret,
      timeoutMs: 7_500,
      configuredAt: "2026-07-28T14:00:00.000Z",
    });
    const resolved = await resolveWebhookConfiguration({
      stateDirectory,
      environment: {},
    });
    expect(resolved.readiness).toEqual({
      configured: true,
      endpointOrigin: "https://receiver.example.test",
      issueCodes: [],
      ready: true,
      secretPresent: true,
      source: "file",
      timeoutMs: 7_500,
    });
    expect(JSON.stringify(resolved.readiness)).not.toContain(secret);
    expect(JSON.stringify(resolved.readiness)).not.toContain("tenant=test");
  });

  it("reports partial and invalid environment overrides without falling through to a file", async () => {
    const stateDirectory = await temporaryDirectory();
    await writeWebhookConfiguration(webhookConfigurationPath(stateDirectory), {
      endpoint: "https://file.example.test/hook",
      secret,
    });

    await expect(
      resolveWebhookConfiguration({
        stateDirectory,
        environment: {
          AGENT_RELAY_WEBHOOK_URL: "https://environment.example.test/hook",
        },
      }),
    ).resolves.toEqual({
      readiness: {
        configured: true,
        issueCodes: ["webhook-secret-missing"],
        ready: false,
        secretPresent: false,
        source: "environment",
      },
    });

    await expect(
      resolveWebhookConfiguration({
        stateDirectory,
        environment: {
          AGENT_RELAY_WEBHOOK_URL: "http://remote.example.test/hook",
          AGENT_RELAY_WEBHOOK_SECRET: secret,
        },
      }),
    ).resolves.toEqual({
      readiness: {
        configured: true,
        issueCodes: ["webhook-configuration-invalid"],
        ready: false,
        secretPresent: true,
        source: "environment",
      },
    });
  });

  it("rejects permissive and symlinked credential files without touching referents", async () => {
    const stateDirectory = await temporaryDirectory();
    const path = webhookConfigurationPath(stateDirectory);
    await writeWebhookConfiguration(path, {
      endpoint: "https://receiver.example.test/hook",
      secret,
    });
    await chmod(path, 0o644);
    await expect(readWebhookConfiguration(path)).rejects.toThrow(
      "must not be accessible",
    );

    await rm(path);
    const target = join(stateDirectory, "outside.json");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await symlink(target, path);
    await expect(
      writeWebhookConfiguration(path, {
        endpoint: "https://receiver.example.test/hook",
        secret,
      }),
    ).rejects.toThrow("not a regular file");
    await expect(readFile(target, "utf8")).resolves.toBe("untouched\n");
  });

  it("configures from stdin, exposes only a safe status, and disconnects without changing selection", async () => {
    const stateDirectory = await temporaryDirectory();
    await expect(
      runWebhookCommand({
        args: [
          "configure",
          "--url",
          "http://127.0.0.1:4319/hook",
          "--secret-stdin",
          "--timeout-ms",
          "1250",
        ],
        environment: {},
        now: () => new Date("2026-07-28T14:00:00.000Z"),
        readStdin: async () => `${secret}\n`,
        stateDirectory,
      }),
    ).resolves.toEqual({
      configured: true,
      endpointOrigin: "http://127.0.0.1:4319",
      issueCodes: [],
      ready: true,
      secretPresent: true,
      source: "file",
      timeoutMs: 1_250,
      restartRequired: true,
      transportSelectionUnchanged: true,
    });

    const status = await runWebhookCommand({
      args: ["status"],
      environment: {},
      stateDirectory,
    });
    expect(status).toMatchObject({
      ready: true,
      endpointOrigin: "http://127.0.0.1:4319",
    });
    expect(JSON.stringify(status)).not.toContain(secret);

    await expect(
      runWebhookCommand({
        args: ["disconnect"],
        environment: {},
        stateDirectory,
      }),
    ).resolves.toEqual({
      disconnected: true,
      environmentActive: false,
      restartRequired: true,
      transportSelectionUnchanged: true,
    });
    await expect(
      readWebhookConfiguration(webhookConfigurationPath(stateDirectory)),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed command flags and never accepts a secret argument", async () => {
    const stateDirectory = await temporaryDirectory();
    await expect(
      runWebhookCommand({
        args: [
          "configure",
          "--url",
          "https://receiver.example.test/hook",
          "--secret",
          secret,
        ],
        readStdin: async () => "",
        stateDirectory,
      }),
    ).rejects.toThrow("unknown argument");
    await expect(
      runWebhookCommand({
        args: [
          "configure",
          "--url",
          "https://receiver.example.test/hook",
          "--secret-stdin",
          "--timeout-ms",
          "NaN",
        ],
        readStdin: async () => secret,
        stateDirectory,
      }),
    ).rejects.toThrow();
  });
});
