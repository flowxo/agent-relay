import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctor.js";
import {
  inspectVendorIntegrations,
  runVendorIntegrationLifecycle,
  vendorIntegrationPaths,
} from "./vendor-integration-lifecycle.js";

const now = () => new Date("2026-08-13T18:00:00.000Z");
const versions = {
  codex: "codex-cli 0.145.0",
  claude: "2.1.219 (Claude Code)",
  cursor: "2026.07.23-e383d2b",
};

async function setup(prefix = "agent-relay-integrations-") {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const entryPath = join(rootDir, "relay-entry.js");
  await writeFile(entryPath, "process.exitCode = 0;\n", { mode: 0o600 });
  return { rootDir, entryPath, paths: vendorIntegrationPaths(rootDir) };
}

async function missing(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => false,
    () => true,
  );
}

describe("vendor integration isolated-home lifecycle", () => {
  it("installs, repeats, detects and repairs drift, disables, enables, upgrades, rolls back, and uninstalls", async () => {
    const runtime = await setup();
    const options = {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now,
    };

    const installed = await runVendorIntegrationLifecycle("install", options);
    expect(installed.changed).toBe(true);
    expect(installed.harnesses.map((entry) => entry.state)).toEqual([
      "installed",
      "installed",
      "installed",
    ]);
    expect(
      installed.harnesses.map((entry) => entry.compatibility.classification),
    ).toEqual(["verified", "verified", "verified"]);
    expect((await stat(runtime.paths.launcherPath)).mode & 0o777).toBe(0o700);
    expect(
      (
        await stat(
          join(runtime.paths.targets.codex, "bin", "agent-relay-plugin"),
        )
      ).mode & 0o777,
    ).toBe(0o700);

    await expect(
      runVendorIntegrationLifecycle("install", options),
    ).resolves.toMatchObject({ changed: false });

    const driftPath = join(
      runtime.paths.targets.cursor,
      "commands",
      "agent-relay-doctor.md",
    );
    await writeFile(driftPath, "drift\n", "utf8");
    await expect(
      runVendorIntegrationLifecycle("status", options),
    ).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({ harness: "cursor", state: "drifted" }),
      ]),
    });
    await runVendorIntegrationLifecycle("repair", options);
    expect(await readFile(driftPath, "utf8")).not.toBe("drift\n");

    await runVendorIntegrationLifecycle("disable", options);
    expect(await missing(runtime.paths.targets.claude)).toBe(true);
    expect(await missing(runtime.paths.disabledTargets.claude)).toBe(false);
    expect(await missing(runtime.paths.codexMarketplacePath)).toBe(true);
    await expect(
      runVendorIntegrationLifecycle("disable", { ...options, dryRun: true }),
    ).resolves.toMatchObject({ changed: false, dryRun: true });
    await expect(
      runVendorIntegrationLifecycle("install", options),
    ).resolves.toMatchObject({
      changed: false,
      harnesses: expect.arrayContaining([
        expect.objectContaining({ harness: "codex", state: "disabled" }),
      ]),
    });

    const disabledDrift = join(
      runtime.paths.disabledTargets.cursor,
      "commands",
      "agent-relay-doctor.md",
    );
    await writeFile(disabledDrift, "disabled drift\n", "utf8");
    await expect(
      runVendorIntegrationLifecycle("status", options),
    ).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({ harness: "cursor", state: "drifted" }),
      ]),
    });
    await runVendorIntegrationLifecycle("repair", options);
    expect(await readFile(disabledDrift, "utf8")).not.toBe("disabled drift\n");
    await runVendorIntegrationLifecycle("enable", options);
    expect(await missing(runtime.paths.targets.claude)).toBe(false);

    const rollbackSentinel = join(
      runtime.paths.targets.codex,
      "ROLLBACK-EVIDENCE.txt",
    );
    await writeFile(rollbackSentinel, "owned prior version\n", "utf8");
    const rollbackMetadataPath = join(
      runtime.paths.targets.codex,
      "agent-relay.integration.json",
    );
    const rollbackMetadata = JSON.parse(
      await readFile(rollbackMetadataPath, "utf8"),
    ) as { compatibility: { skillContract: string } };
    rollbackMetadata.compatibility.skillContract = "0.9.0";
    await writeFile(
      rollbackMetadataPath,
      `${JSON.stringify(rollbackMetadata, null, 2)}\n`,
      "utf8",
    );
    await runVendorIntegrationLifecycle("upgrade", options);
    expect(await missing(rollbackSentinel)).toBe(true);
    await runVendorIntegrationLifecycle("rollback", options);
    expect(await readFile(rollbackSentinel, "utf8")).toBe(
      "owned prior version\n",
    );
    await expect(
      runVendorIntegrationLifecycle("status", options),
    ).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({ harness: "codex", state: "installed" }),
      ]),
    });
    await expect(
      inspectVendorIntegrations(runtime.rootDir),
    ).resolves.toMatchObject({
      healthy: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "integration-skill-contract-compatibility",
          level: "fail",
        }),
      ]),
    });
    await runVendorIntegrationLifecycle("repair", options);

    await writeFile(
      join(runtime.rootDir, "unrelated.txt"),
      "preserve\n",
      "utf8",
    );
    await runVendorIntegrationLifecycle("uninstall", options);
    expect(await missing(runtime.paths.targets.codex)).toBe(true);
    expect(await missing(runtime.paths.targets.claude)).toBe(true);
    expect(await missing(runtime.paths.targets.cursor)).toBe(true);
    expect(await missing(runtime.paths.manifestPath)).toBe(true);
    expect(await readFile(join(runtime.rootDir, "unrelated.txt"), "utf8")).toBe(
      "preserve\n",
    );
  });

  it("preserves unrelated vendor configuration byte-for-byte", async () => {
    const runtime = await setup();
    const claudeSettings = '{\n  "permissions": { "allow": ["Read"] }\n}\n';
    const cursorHooks =
      '{"version":1,"hooks":{"stop":[{"command":"user-hook"}]}}\n';
    const codexConfig =
      '[mcp_servers.unrelated]\ncommand = "safe-server"\n\n[plugins.agent-relay]\nenabled = true\n';
    const claudeConfig =
      '{"note":"agent-relay documentation only","mcpServers":{"unrelated":{"command":"safe-server"}}}\n';
    for (const [path, source] of [
      [join(runtime.rootDir, ".claude", "settings.json"), claudeSettings],
      [join(runtime.rootDir, ".claude.json"), claudeConfig],
      [join(runtime.rootDir, ".cursor", "hooks.json"), cursorHooks],
      [join(runtime.rootDir, ".codex", "config.toml"), codexConfig],
    ] as const) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source, "utf8");
    }
    const unrelatedPlugin = join(
      runtime.rootDir,
      ".claude",
      "plugins",
      "user-plugin",
      "plugin.json",
    );
    await mkdir(dirname(unrelatedPlugin), { recursive: true });
    await writeFile(unrelatedPlugin, '{"name":"user-plugin"}\n', "utf8");
    await runVendorIntegrationLifecycle("install", {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      now,
    });
    expect(
      await readFile(join(runtime.rootDir, ".claude", "settings.json"), "utf8"),
    ).toBe(claudeSettings);
    expect(
      await readFile(join(runtime.rootDir, ".cursor", "hooks.json"), "utf8"),
    ).toBe(cursorHooks);
    expect(
      await readFile(join(runtime.rootDir, ".codex", "config.toml"), "utf8"),
    ).toBe(codexConfig);
    expect(await readFile(join(runtime.rootDir, ".claude.json"), "utf8")).toBe(
      claudeConfig,
    );
    await runVendorIntegrationLifecycle("uninstall", {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      now,
    });
    expect(await readFile(unrelatedPlugin, "utf8")).toBe(
      '{"name":"user-plugin"}\n',
    );
  });

  it("fails before mutation for manual duplicates, unowned targets, and malformed configuration", async () => {
    for (const scenario of [
      "manual-mcp",
      "manual-plugin",
      "manual-marketplace",
      "unowned-target",
      "malformed",
    ] as const) {
      const runtime = await setup(`agent-relay-${scenario}-`);
      if (scenario === "manual-mcp") {
        const path = join(runtime.rootDir, ".cursor", "mcp.json");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{"mcpServers":{"agent-relay":{}}}\n', "utf8");
      } else if (scenario === "manual-plugin") {
        const path = join(
          runtime.rootDir,
          ".claude",
          "plugins",
          "installed_plugins.json",
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          '{"version":2,"plugins":{"agent-relay@manual":[]}}\n',
          "utf8",
        );
      } else if (scenario === "manual-marketplace") {
        await mkdir(dirname(runtime.paths.codexMarketplacePath), {
          recursive: true,
        });
        await writeFile(
          runtime.paths.codexMarketplacePath,
          '{"name":"user-marketplace","plugins":[]}\n',
          "utf8",
        );
      } else if (scenario === "unowned-target") {
        await mkdir(runtime.paths.targets.claude, { recursive: true });
        await writeFile(
          join(runtime.paths.targets.claude, "user.txt"),
          "mine\n",
          "utf8",
        );
      } else {
        const path = join(runtime.rootDir, ".claude", "settings.json");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "{ malformed", "utf8");
      }
      await expect(
        runVendorIntegrationLifecycle("install", {
          rootDir: runtime.rootDir,
          entryPath: runtime.entryPath,
          now,
        }),
      ).rejects.toThrow();
      expect(await missing(runtime.paths.manifestPath)).toBe(true);
      if (scenario === "manual-mcp") {
        expect(
          await readFile(join(runtime.rootDir, ".cursor", "mcp.json"), "utf8"),
        ).toBe('{"mcpServers":{"agent-relay":{}}}\n');
      }
    }
  });

  it("reports unselected harnesses as healthy and rejects ambiguous duplicate trees", async () => {
    const runtime = await setup();
    const options = {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnesses: ["codex"] as const,
      now,
    };
    await runVendorIntegrationLifecycle("install", options);
    const initial = await inspectVendorIntegrations(runtime.rootDir, {
      harnessVersions: { codex: versions.codex },
      hookTrust: { codex: "approved" },
    });
    expect(initial.healthy).toBe(true);
    expect(initial.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "integration-claude-artifacts",
          level: "pass",
        }),
      ]),
    );

    await cp(runtime.paths.targets.codex, runtime.paths.disabledTargets.codex, {
      recursive: true,
    });
    await expect(
      runVendorIntegrationLifecycle("status", options),
    ).resolves.toMatchObject({
      harnesses: [expect.objectContaining({ state: "drifted" })],
    });
    const duplicate = await inspectVendorIntegrations(runtime.rootDir);
    expect(duplicate.healthy).toBe(false);
    expect(duplicate.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "integration-conflicts",
          level: "fail",
        }),
      ]),
    );
    await expect(
      runVendorIntegrationLifecycle("repair", options),
    ).rejects.toThrow("both active and disabled");
  });

  it("requires installed lifecycle state before disable or enable", async () => {
    const runtime = await setup();
    for (const operation of ["disable", "enable"] as const) {
      await expect(
        runVendorIntegrationLifecycle(operation, {
          rootDir: runtime.rootDir,
          entryPath: runtime.entryPath,
          harnesses: ["cursor"],
          now,
        }),
      ).rejects.toThrow("no Agent Relay lifecycle state");
    }
  });

  it("refuses a symlinked isolated-home root before mutation", async () => {
    const realRoot = await mkdtemp(join(tmpdir(), "agent-relay-real-root-"));
    const parent = await mkdtemp(join(tmpdir(), "agent-relay-root-link-"));
    const linkedRoot = join(parent, "home");
    await symlink(realRoot, linkedRoot);
    const entryPath = join(realRoot, "relay-entry.js");
    await writeFile(entryPath, "process.exitCode = 0;\n", { mode: 0o600 });
    await expect(
      runVendorIntegrationLifecycle("install", {
        rootDir: linkedRoot,
        entryPath,
        now,
      }),
    ).rejects.toThrow("existing real directory");
    expect(await missing(join(realRoot, ".agent-relay"))).toBe(true);
  });

  it("reports an orphaned vendor bundle instead of falling through to legacy diagnosis", async () => {
    const runtime = await setup();
    await mkdir(runtime.paths.targets.claude, { recursive: true });
    await writeFile(
      join(runtime.paths.targets.claude, "orphaned.txt"),
      "synthetic orphan\n",
      "utf8",
    );
    await expect(
      inspectVendorIntegrations(runtime.rootDir),
    ).resolves.toMatchObject({
      installed: true,
      healthy: false,
      checks: [
        expect.objectContaining({
          name: "integration-lifecycle-manifest",
          level: "fail",
        }),
      ],
    });
    const doctor = await runDoctor({ rootDir: runtime.rootDir });
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "integration-lifecycle-manifest",
          level: "fail",
        }),
      ]),
    );
    expect(doctor.checks.map((check) => check.name)).not.toContain(
      "install-manifest",
    );
  }, 10_000);

  it("rolls an interrupted multi-harness update back to its exact prior trees", async () => {
    const runtime = await setup();
    const options = {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      now,
    };
    await runVendorIntegrationLifecycle("install", options);
    const before = await readFile(
      join(runtime.paths.targets.codex, "agent-relay.integration.json"),
      "utf8",
    );
    await expect(
      runVendorIntegrationLifecycle("reinstall", {
        ...options,
        failAfterWrites: 2,
      }),
    ).rejects.toThrow("rolled back");
    expect(
      await readFile(
        join(runtime.paths.targets.codex, "agent-relay.integration.json"),
        "utf8",
      ),
    ).toBe(before);
    await expect(
      runVendorIntegrationLifecycle("status", options),
    ).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({ harness: "codex", state: "installed" }),
      ]),
    });
  });

  it("reports compatibility, missing capability, disabled, denied-hook, drift, and repair without secret data", async () => {
    const runtime = await setup();
    const options = {
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      now,
    };
    await runVendorIntegrationLifecycle("install", options);
    await runVendorIntegrationLifecycle("disable", {
      ...options,
      harnesses: ["cursor"],
    });
    await writeFile(
      join(runtime.paths.targets.codex, "hooks", "hooks.json"),
      "drift\n",
      "utf8",
    );
    await writeFile(
      runtime.paths.codexMarketplacePath,
      '{"name":"drifted-marketplace","plugins":[]}\n',
      "utf8",
    );
    const lifecycle = JSON.parse(
      await readFile(runtime.paths.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    lifecycle["agentRelayVersion"] = "0.2.0";
    await writeFile(
      runtime.paths.manifestPath,
      `${JSON.stringify(lifecycle, null, 2)}\n`,
      "utf8",
    );
    const report = await inspectVendorIntegrations(runtime.rootDir, {
      harnessVersions: {
        codex: "codex-cli 0.146.0",
        claude: versions.claude,
        cursor: "2025.01.01-incompatible",
      },
      harnessClassifications: { cursor: "unsupported" },
      hookTrust: { codex: "denied", claude: "approved", cursor: "unknown" },
    });
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "integration-codex-artifacts",
          level: "fail",
        }),
        expect.objectContaining({
          name: "integration-codex-marketplace",
          level: "fail",
        }),
        expect.objectContaining({
          name: "integration-codex-compatibility",
          level: "warn",
        }),
        expect.objectContaining({
          name: "integration-codex-hook-trust",
          level: "warn",
        }),
        expect.objectContaining({
          name: "integration-cursor-disabled",
          level: "warn",
        }),
        expect.objectContaining({
          name: "integration-cursor-compatibility",
          level: "fail",
        }),
        expect.objectContaining({
          name: "integration-contract-compatibility",
          level: "fail",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(
      /\/Users\/|bearer|csrf|credential|mcpbind_|session_/i,
    );

    const manualMcp = join(runtime.rootDir, ".cursor", "mcp.json");
    await mkdir(dirname(manualMcp), { recursive: true });
    await writeFile(
      manualMcp,
      '{"mcpServers":{"agent-relay-manual":{}}}\n',
      "utf8",
    );
    await expect(
      inspectVendorIntegrations(runtime.rootDir),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "integration-conflicts",
          level: "fail",
        }),
      ]),
    });

    const doctor = await runDoctor({ rootDir: runtime.rootDir });
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "integration-codex-artifacts" }),
        expect.objectContaining({ name: "integration-contract-compatibility" }),
        expect.objectContaining({ name: "integration-conflicts" }),
      ]),
    );
    expect(doctor.checks.map((check) => check.name)).not.toContain(
      "installation-manifest",
    );
    expect(JSON.stringify(doctor)).not.toMatch(
      /\/Users\/|bearer|csrf|credential|mcpbind_|session_/i,
    );
  });
});
