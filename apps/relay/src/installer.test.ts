import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
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

import {
  AGENT_RELAY_SKILL_OWNER_MARKER,
  officialAgentRelaySkillArtifacts,
} from "./agent-skills.js";
import {
  inspectAgentRelayInstallation,
  installAgentRelay,
  installerPaths,
  uninstallAgentRelay,
} from "./installer.js";

const installedAt = new Date("2026-07-24T12:00:00.000Z");
const versions = {
  codex: "codex-cli 0.145.0",
  claude: "2.1.219 (Claude Code)",
  cursor: "2026.07.23-e383d2b",
};

async function setup(prefix = "agent-relay-install-") {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const entryPath = join(rootDir, "agent-relay-entry.js");
  await writeFile(entryPath, "process.exitCode = 0;\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return { rootDir, entryPath, paths: installerPaths(rootDir) };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function markerCount(value: unknown): number {
  return JSON.stringify(value).split("AGENT_RELAY_HOOK_OWNER").length - 1;
}

async function expectOfficialSkills(
  paths: ReturnType<typeof installerPaths>,
): Promise<void> {
  for (const artifact of officialAgentRelaySkillArtifacts()) {
    const path = paths.skills[artifact.harness];
    expect(await readFile(path, "utf8")).toBe(artifact.content);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
}

describe("agent relay harness installer", () => {
  it("minimally patches all harness configs and creates private backups", async () => {
    const runtime = await setup();
    await writeJson(runtime.paths.configs.codex, {
      description: "user-owned metadata",
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "user-stop-hook" }],
          },
        ],
      },
    });
    await writeJson(runtime.paths.configs.claude, {
      permissions: { allow: ["Read"] },
    });
    await writeJson(runtime.paths.configs.cursor, {
      version: 1,
      hooks: {
        stop: [{ command: "user-cursor-hook" }],
      },
    });

    const result = await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => installedAt,
    });

    expect(result.changed).toBe(true);
    expect(
      result.actions.filter((action) => action.backupPath !== undefined),
    ).toHaveLength(3);
    for (const action of result.actions) {
      if (action.backupPath !== undefined) {
        expect((await stat(action.backupPath)).mode & 0o777).toBe(0o600);
      }
    }
    const codex = await readJson(runtime.paths.configs.codex);
    const claude = await readJson(runtime.paths.configs.claude);
    const cursor = await readJson(runtime.paths.configs.cursor);
    expect(codex).toMatchObject({ description: "user-owned metadata" });
    expect(claude).toMatchObject({ permissions: { allow: ["Read"] } });
    expect(JSON.stringify(codex)).toContain("user-stop-hook");
    expect(JSON.stringify(cursor)).toContain("user-cursor-hook");
    expect(markerCount(codex)).toBe(4);
    expect(markerCount(claude)).toBe(5);
    expect(markerCount(cursor)).toBe(1);
    expect(JSON.stringify(codex)).toContain("startup|resume|clear");
    expect(JSON.stringify(claude)).toContain("startup|resume|clear|fork");
    expect((await stat(runtime.paths.launcherPath)).mode & 0o777).toBe(0o700);
    expect(await readJson(runtime.paths.manifestPath)).toMatchObject({
      packageVersion: "0.1.0-alpha.3",
      skills: expect.arrayContaining([
        expect.objectContaining({
          harness: "codex",
          contractVersion: "1.0.0",
          mcpSurfaceVersion: "agent-relay-mcp.v1",
          mcpProtocolVersion: "2025-11-25",
          agentRelayVersionRange: ">=0.1.0-alpha.2 <0.2.0-0",
        }),
      ]),
    });
    await expectOfficialSkills(runtime.paths);
    expect(await inspectAgentRelayInstallation(runtime.rootDir)).toMatchObject({
      healthy: true,
      installed: true,
    });
  });

  it("is unchanged on repeat install and replaces owned hooks on upgrade", async () => {
    const runtime = await setup();
    const first = await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => installedAt,
    });
    expect(first.changed).toBe(true);
    const second = await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => new Date("2026-07-24T13:00:00.000Z"),
    });
    expect(second.changed).toBe(false);
    expect(second.actions.every((action) => action.kind === "unchanged")).toBe(
      true,
    );

    const upgraded = await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: { ...versions, codex: "codex-cli 0.146.0" },
      now: () => new Date("2026-07-24T14:00:00.000Z"),
    });
    expect(upgraded.changed).toBe(true);
    expect(
      upgraded.actions.some((action) => action.backupPath !== undefined),
    ).toBe(true);
    const codex = await readJson(runtime.paths.configs.codex);
    expect(markerCount(codex)).toBe(4);
    expect(JSON.stringify(codex)).toContain("codex-cli 0.146.0");
    expect(JSON.stringify(codex)).not.toContain("codex-cli 0.145.0");
  });

  it("detects and repairs owned skill drift without reporting its contents", async () => {
    const runtime = await setup("agent-relay-install-skill-drift-");
    await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => installedAt,
    });
    const sensitiveDrift = (
      await readFile(runtime.paths.skills.codex, "utf8")
    ).replace(
      "# Agent Relay",
      "# Agent Relay\n\nprompt=do not print this private identifier FXO-PRIVATE-123",
    );
    await writeFile(runtime.paths.skills.codex, sensitiveDrift, {
      encoding: "utf8",
      mode: 0o600,
    });

    const report = await inspectAgentRelayInstallation(runtime.rootDir);
    expect(report.healthy).toBe(false);
    const drift = report.checks.find(
      (check) => check.name === "codex-skill-drift",
    );
    expect(drift).toMatchObject({ level: "fail" });
    expect(JSON.stringify(drift)).not.toContain("FXO-PRIVATE-123");
    expect(JSON.stringify(drift)).not.toContain("prompt=");

    const repaired = await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => new Date("2026-07-24T13:00:00.000Z"),
    });
    expect(
      repaired.actions.find(
        (action) => action.path === runtime.paths.skills.codex,
      ),
    ).toMatchObject({ kind: "update" });
    await expectOfficialSkills(runtime.paths);
    expect((await inspectAgentRelayInstallation(runtime.rootDir)).healthy).toBe(
      true,
    );
  });

  it("refuses a non-owned skill target before making partial changes", async () => {
    const runtime = await setup("agent-relay-install-skill-conflict-");
    await mkdir(dirname(runtime.paths.skills.claude), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      runtime.paths.skills.claude,
      `---\nname: agent-relay\n---\nUser-owned skill quoting ${AGENT_RELAY_SKILL_OWNER_MARKER}.\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(
      installAgentRelay({
        rootDir: runtime.rootDir,
        entryPath: runtime.entryPath,
        harnessVersions: versions,
      }),
    ).rejects.toThrow("contains non-Agent Relay material");
    expect(await readFile(runtime.paths.skills.claude, "utf8")).toContain(
      "User-owned skill",
    );
    await expect(access(runtime.paths.configs.codex)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(runtime.paths.launcherPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uninstalls only owned entries and preserves user configuration", async () => {
    const runtime = await setup();
    const unrelatedSkill = join(
      runtime.rootDir,
      ".agents",
      "skills",
      "user-owned",
      "SKILL.md",
    );
    const colocatedNote = join(
      dirname(runtime.paths.skills.codex),
      "user-notes.md",
    );
    await mkdir(dirname(unrelatedSkill), { recursive: true, mode: 0o700 });
    await writeFile(unrelatedSkill, "user skill\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeJson(runtime.paths.configs.codex, {
      userSetting: true,
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "user-stop-hook" },
              {
                type: "command",
                command:
                  "echo AGENT_RELAY_HOOK_OWNER=agent-relay-v1 is user text",
              },
            ],
          },
        ],
      },
    });
    await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => installedAt,
    });
    await writeFile(colocatedNote, "user note\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const userReplacement =
      "---\nname: agent-relay\n---\nUser replaced this artifact.\n";
    await writeFile(runtime.paths.skills.cursor, userReplacement, {
      encoding: "utf8",
      mode: 0o600,
    });

    const result = await uninstallAgentRelay({
      rootDir: runtime.rootDir,
      now: () => new Date("2026-07-24T13:00:00.000Z"),
    });
    expect(result.changed).toBe(true);
    const codex = await readJson(runtime.paths.configs.codex);
    expect(codex).toMatchObject({ userSetting: true });
    expect(JSON.stringify(codex)).toContain("user-stop-hook");
    expect(JSON.stringify(codex)).toContain(
      "echo AGENT_RELAY_HOOK_OWNER=agent-relay-v1 is user text",
    );
    expect(markerCount(codex)).toBe(1);
    await expect(access(runtime.paths.launcherPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(runtime.paths.manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const skillPath of [
      runtime.paths.skills.codex,
      runtime.paths.skills.claude,
    ]) {
      await expect(access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(runtime.paths.skills.cursor, "utf8")).toBe(
      userReplacement,
    );
    expect(await readFile(unrelatedSkill, "utf8")).toBe("user skill\n");
    expect(await readFile(colocatedNote, "utf8")).toBe("user note\n");
  });

  it("removes installer-created config scaffolds without deleting state", async () => {
    const runtime = await setup();
    await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
      now: () => installedAt,
    });
    await writeFile(join(runtime.paths.stateDir, "relay.sqlite"), "state", {
      encoding: "utf8",
      mode: 0o600,
    });

    await uninstallAgentRelay({ rootDir: runtime.rootDir });
    for (const configPath of Object.values(runtime.paths.configs)) {
      await expect(access(configPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const skillPath of Object.values(runtime.paths.skills)) {
      await expect(access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      access(join(runtime.paths.stateDir, "relay.sqlite"), constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("preflights malformed JSON without making partial changes", async () => {
    const runtime = await setup();
    await mkdir(dirname(runtime.paths.configs.claude), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(runtime.paths.configs.claude, "{invalid-json", "utf8");

    await expect(
      installAgentRelay({
        rootDir: runtime.rootDir,
        entryPath: runtime.entryPath,
        harnessVersions: versions,
      }),
    ).rejects.toThrow("settings.json is not valid JSON");
    await expect(access(runtime.paths.configs.codex)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(runtime.paths.launcherPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back earlier writes when a later config write fails", async () => {
    const runtime = await setup();
    const claudeDirectory = dirname(runtime.paths.configs.claude);
    await mkdir(claudeDirectory, { recursive: true, mode: 0o500 });
    await chmod(claudeDirectory, 0o500);
    try {
      await expect(
        installAgentRelay({
          rootDir: runtime.rootDir,
          entryPath: runtime.entryPath,
          harnessVersions: versions,
        }),
      ).rejects.toThrow("rolled back");
    } finally {
      await chmod(claudeDirectory, 0o700);
    }
    await expect(access(runtime.paths.configs.codex)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(runtime.paths.launcherPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports dry-run and safely quotes exact paths", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-relay-install-parent-"));
    const rootDir = join(parent, "root with ' quote");
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const entryPath = join(rootDir, "entry with ' quote.js");
    await writeFile(entryPath, "process.exitCode = 0;\n", "utf8");
    const paths = installerPaths(rootDir);

    const dryRun = await installAgentRelay({
      rootDir,
      entryPath,
      harnessVersions: versions,
      dryRun: true,
    });
    expect(dryRun.changed).toBe(true);
    await expect(access(paths.configs.codex)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await installAgentRelay({
      rootDir,
      entryPath,
      harnessVersions: versions,
    });
    const cursor = await readJson(paths.configs.cursor);
    const command = JSON.stringify(cursor);
    expect(command).toContain("'\\\"'\\\"'");
    expect(
      spawnSync("/bin/sh", ["-n", paths.launcherPath], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
  });

  it("refuses symlinked owned paths and hostile roots before mutation", async () => {
    expect(() => installerPaths("/")).toThrow(
      "installer root cannot be the filesystem root",
    );

    const runtime = await setup("agent-relay-install-symlink-");
    const external = await mkdtemp(join(tmpdir(), "agent-relay-external-"));
    await symlink(external, dirname(runtime.paths.configs.codex));

    await expect(
      installAgentRelay({
        rootDir: runtime.rootDir,
        entryPath: runtime.entryPath,
        harnessVersions: versions,
      }),
    ).rejects.toThrow("refuses symbolic links");
    await expect(access(join(external, "hooks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(runtime.paths.launcherPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("diagnoses package and launcher ownership mismatches", async () => {
    const runtime = await setup("agent-relay-install-mismatch-");
    await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
    });

    const packageMismatch = await inspectAgentRelayInstallation(
      runtime.rootDir,
      {
        packageVersion: "0.1.0-alpha.999",
      },
    );
    expect(packageMismatch.healthy).toBe(false);
    expect(packageMismatch.checks).toContainEqual(
      expect.objectContaining({
        name: "package-version",
        level: "fail",
      }),
    );

    const incompatibleSkillVersion = await inspectAgentRelayInstallation(
      runtime.rootDir,
      { packageVersion: "0.2.0-alpha.1" },
    );
    expect(incompatibleSkillVersion.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "codex-skill-version",
          level: "fail",
        }),
        expect.objectContaining({
          name: "claude-skill-version",
          level: "fail",
        }),
        expect.objectContaining({
          name: "cursor-skill-version",
          level: "fail",
        }),
      ]),
    );

    await writeFile(
      runtime.paths.launcherPath,
      "#!/bin/sh\n# Managed by agent-relay installer.\nexit 0\n",
      { encoding: "utf8", mode: 0o700 },
    );
    const launcherMismatch = await inspectAgentRelayInstallation(
      runtime.rootDir,
    );
    expect(launcherMismatch.healthy).toBe(false);
    expect(launcherMismatch.checks).toContainEqual(
      expect.objectContaining({
        name: "launcher-target",
        level: "fail",
      }),
    );
  });

  it("diagnoses an owned hook command that differs from its manifest", async () => {
    const runtime = await setup("agent-relay-install-hook-mismatch-");
    await installAgentRelay({
      rootDir: runtime.rootDir,
      entryPath: runtime.entryPath,
      harnessVersions: versions,
    });
    const codex = await readFile(runtime.paths.configs.codex, "utf8");
    await writeFile(
      runtime.paths.configs.codex,
      codex.replaceAll("codex-cli 0.145.0", "codex-cli 0.144.0"),
      { encoding: "utf8", mode: 0o600 },
    );

    const report = await inspectAgentRelayInstallation(runtime.rootDir);
    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "codex-hooks", level: "fail" }),
    );
  });
});
