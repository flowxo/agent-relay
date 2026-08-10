import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

import {
  eraseWhooshBangConnection,
  markWhooshBangDisconnected,
  whooshbangConnectionPaths,
  WhooshBangConnectionConfigurationSchema,
  WhooshBangMachineCredentialSchema,
  readWhooshBangConnection,
  safeWhooshBangConnectionSummary,
  writeWhooshBangConnection,
} from "./whooshbang-config.js";

import type {
  WhooshBangConnectionConfiguration,
  WhooshBangMachineCredential,
} from "./whooshbang-config.js";
import type { MachineCredentialMaterial } from "@agent-relay/whooshbang-transport";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-relay-whooshbang-config-"),
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

function configuration(
  material: MachineCredentialMaterial,
): WhooshBangConnectionConfiguration {
  return WhooshBangConnectionConfigurationSchema.parse({
    schema: "agent-relay-whooshbang-config.v1",
    status: "active",
    baseUrl: "https://whooshbang.example.test/",
    contractVersion: "1.0.0-rc.12",
    environment: "test",
    projectId: "project_synthetic_setup",
    machineClientId: "machine_client_synthetic_setup",
    subscriberId: "subscriber_synthetic_setup",
    notifierId: "notifier_synthetic_setup",
    bindingId: "binding_synthetic_setup",
    currentCredentialId: material.credentialId,
    scopeSummary: [...WHOOSHBANG_MACHINE_SCOPES],
    connectedAt: "2026-07-26T18:00:00.000Z",
    canaryMessageId: "message_synthetic_canary",
    canaryDiagnosticId: "diagnostic_synthetic_canary",
    pendingRevocations: [],
  });
}

function credential(
  material: MachineCredentialMaterial,
  generation = 1,
): WhooshBangMachineCredential {
  return WhooshBangMachineCredentialSchema.parse({
    schema: "agent-relay-whooshbang-credential.v1",
    credentialId: material.credentialId,
    bearerToken: material.bearerToken,
    createdAt: "2026-07-26T18:00:00.000Z",
    rotation: { generation },
  });
}

describe("WhooshBang private configuration", () => {
  it("atomically stores only the narrow credential at mode 0600", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(join(directory, "state"));
    const material = await createMachineCredentialMaterial();
    const broadCredential = "synthetic-broad-bootstrap-value";
    const expectedConfiguration = configuration(material);
    const expectedCredential = credential(material);

    await writeWhooshBangConnection(
      paths,
      expectedConfiguration,
      expectedCredential,
    );
    const stored = await readWhooshBangConnection(paths);
    const rawCredential = await readFile(paths.credentialPath, "utf8");
    const rawConfiguration = await readFile(paths.configurationPath, "utf8");

    expect(stored).toEqual({
      configuration: expectedConfiguration,
      credential: expectedCredential,
    });
    expect((await lstat(paths.credentialPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.configurationPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(rawCredential)).toEqual(expectedCredential);
    expect(rawCredential).not.toContain(broadCredential);
    expect(rawCredential).not.toContain(expectedConfiguration.machineClientId);
    expect(rawCredential).not.toContain(expectedConfiguration.subscriberId);
    expect(rawConfiguration).not.toContain(material.bearerToken);
    expect(
      (await readdir(join(directory, "state"))).some((name) =>
        name.includes(".tmp-"),
      ),
    ).toBe(false);
  });

  it("rejects mismatched, malformed, and permissive credentials", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(directory);
    const material = await createMachineCredentialMaterial();
    const otherMaterial = await createMachineCredentialMaterial();

    await expect(
      writeWhooshBangConnection(
        paths,
        configuration(material),
        credential(otherMaterial),
      ),
    ).rejects.toThrow("do not match");

    await writeWhooshBangConnection(
      paths,
      configuration(material),
      credential(material),
    );
    await chmod(paths.credentialPath, 0o644);
    await expect(readWhooshBangConnection(paths)).rejects.toThrow(
      "must not be readable or writable by group or others",
    );
  });

  it("rejects symlink targets without modifying their referents", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(directory);
    const target = join(directory, "outside.json");
    const material = await createMachineCredentialMaterial();
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await symlink(target, paths.credentialPath);

    await expect(
      writeWhooshBangConnection(
        paths,
        configuration(material),
        credential(material),
      ),
    ).rejects.toThrow("not a regular file");
    await expect(readFile(target, "utf8")).resolves.toBe("untouched\n");
  });

  it("preserves the current credential when configuration preflight fails", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(directory);
    const currentMaterial = await createMachineCredentialMaterial();
    const replacementMaterial = await createMachineCredentialMaterial();
    await writeWhooshBangConnection(
      paths,
      configuration(currentMaterial),
      credential(currentMaterial),
    );
    const currentCredential = await readFile(paths.credentialPath, "utf8");
    const target = join(directory, "outside-configuration.json");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await rm(paths.configurationPath);
    await symlink(target, paths.configurationPath);

    await expect(
      writeWhooshBangConnection(
        paths,
        configuration(replacementMaterial),
        credential(replacementMaterial, 2),
      ),
    ).rejects.toThrow("not a regular file");
    await expect(readFile(paths.credentialPath, "utf8")).resolves.toBe(
      currentCredential,
    );
    await expect(readFile(target, "utf8")).resolves.toBe("untouched\n");
  });

  it("rejects a symlink or exposed parent directory", async () => {
    const directory = await temporaryDirectory();
    const actual = join(directory, "actual");
    const linked = join(directory, "linked");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    const material = await createMachineCredentialMaterial();

    await expect(
      writeWhooshBangConnection(
        whooshbangConnectionPaths(linked),
        configuration(material),
        credential(material),
      ),
    ).rejects.toThrow();

    const exposed = join(directory, "exposed");
    const exposedPaths = whooshbangConnectionPaths(exposed);
    await mkdir(exposed, { mode: 0o755 });
    await expect(
      writeWhooshBangConnection(
        exposedPaths,
        configuration(material),
        credential(material),
      ),
    ).rejects.toThrow("must not be accessible");
  });

  it("disconnects locally, optionally erases the secret, and preserves diagnosis", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(directory);
    const material = await createMachineCredentialMaterial();
    await writeWhooshBangConnection(
      paths,
      configuration(material),
      credential(material),
    );

    const disconnected = await markWhooshBangDisconnected(paths, {
      at: new Date("2026-07-26T19:00:00.000Z"),
      revoked: false,
      eraseCredential: true,
    });
    expect(disconnected).toEqual({
      configuration: expect.objectContaining({
        status: "disconnected",
        disconnectedAt: "2026-07-26T19:00:00.000Z",
      }),
    });
    await expect(lstat(paths.credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readWhooshBangConnection(paths)).resolves.toEqual(
      disconnected,
    );
    expect(safeWhooshBangConnectionSummary(disconnected)).toMatchObject({
      configured: true,
      credentialPresent: false,
      status: "disconnected",
    });
  });

  it("keeps full provider identities out of safe status output", async () => {
    const material = await createMachineCredentialMaterial();
    const stored = {
      configuration: configuration(material),
      credential: credential(material),
    };
    const summary = safeWhooshBangConnectionSummary(stored);
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      apiOrigin: "https://whooshbang.example.test",
      canaryRef: expect.stringMatching(/^[a-f0-9]{12}$/u),
      configured: true,
      contractVersion: "1.0.0-rc.12",
      credentialPresent: true,
      environment: "test",
      machineClientRef: expect.stringMatching(/^[a-f0-9]{12}$/u),
      pendingRevocations: 0,
      status: "active",
    });
    expect(serialized).not.toContain(stored.configuration.machineClientId);
    expect(serialized).not.toContain(stored.configuration.subscriberId);
    expect(serialized).not.toContain(stored.configuration.notifierId);
    expect(serialized).not.toContain(material.bearerToken);
  });

  it("erases only explicitly selected retained files", async () => {
    const directory = await temporaryDirectory();
    const paths = whooshbangConnectionPaths(directory);
    const material = await createMachineCredentialMaterial();
    await writeWhooshBangConnection(
      paths,
      configuration(material),
      credential(material),
    );

    await expect(
      eraseWhooshBangConnection(paths, {
        configuration: false,
        credential: true,
      }),
    ).resolves.toEqual({
      configurationErased: false,
      credentialErased: true,
    });
    await expect(lstat(paths.configurationPath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    await expect(lstat(paths.credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      eraseWhooshBangConnection(paths, {
        configuration: true,
        credential: false,
      }),
    ).resolves.toEqual({
      configurationErased: true,
      credentialErased: false,
    });
  });
});
