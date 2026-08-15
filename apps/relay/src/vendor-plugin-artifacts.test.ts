import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { officialAgentRelaySkillArtifacts } from "./agent-skills.js";
import {
  VENDOR_INTEGRATION_OWNER,
  VENDOR_INTEGRATION_SCHEMA,
  VENDOR_INTEGRATION_VERSION,
  codexMarketplaceJson,
  vendorPluginBundles,
} from "./vendor-plugin-artifacts.js";

describe("vendor-native Agent Relay plugin artifacts", () => {
  it("matches the reviewed native inventory snapshot", () => {
    expect(
      vendorPluginBundles().map((bundle) => ({
        harness: bundle.harness,
        nativeKind: bundle.nativeKind,
        verifiedVersion: bundle.verifiedVersion,
        installLocation: bundle.installLocation,
        artifacts: bundle.artifacts.map((artifact) => ({
          path: artifact.relativePath,
          mode: artifact.mode.toString(8),
          sha256: artifact.sha256,
        })),
      })),
    ).toMatchSnapshot();
  });

  it("embeds the canonical skill byte-for-byte and delegates every entry point to Relay core", () => {
    const official = officialAgentRelaySkillArtifacts();
    for (const bundle of vendorPluginBundles()) {
      const skill = bundle.artifacts.find(
        (artifact) => artifact.relativePath === "skills/agent-relay/SKILL.md",
      );
      expect(skill?.content).toBe(
        official.find((artifact) => artifact.harness === bundle.harness)
          ?.content,
      );
      const wrapper = bundle.artifacts.find(
        (artifact) => artifact.relativePath === "bin/agent-relay-plugin",
      );
      expect(wrapper?.mode).toBe(0o700);
      expect(wrapper?.content).toContain('exec "$relay_bin" mcp');
      expect(wrapper?.content).toContain('exec "$relay_bin" hook');
      expect(wrapper?.content).toContain(
        'exec "$relay_bin" whooshbang connect',
      );
      expect(wrapper?.content).toContain('exec "$relay_bin" doctor');
      expect(wrapper?.content).toContain('exec "$relay_bin" dashboard');
      const dashboardEntry = bundle.artifacts.find((artifact) =>
        artifact.relativePath.includes("agent-relay-dashboard"),
      );
      expect(dashboardEntry?.content).toContain("dashboard --web");
      expect(dashboardEntry?.content).not.toMatch(/bearer|csrf|webboot_/iu);
      expect(wrapper?.content).not.toMatch(
        /bearer|csrf|oauth_url|session.?correlat|127\.0\.0\.1:\d+/i,
      );
    }
  });

  it("uses frozen activity events, handshake-only Cursor sessionStart, and exact MCP metadata", () => {
    const expectedEvents = {
      codex: ["SessionStart", "Stop", "UserPromptSubmit"],
      claude: ["SessionStart", "Stop", "StopFailure", "UserPromptSubmit"],
      cursor: ["sessionStart", "stop"],
    } as const;
    for (const bundle of vendorPluginBundles()) {
      const hook = bundle.artifacts.find(
        (artifact) => artifact.relativePath === "hooks/hooks.json",
      );
      const hookJson = JSON.parse(hook?.content ?? "") as {
        hooks: Record<string, unknown>;
      };
      expect(Object.keys(hookJson.hooks).sort()).toEqual(
        [...expectedEvents[bundle.harness]].sort(),
      );
      const metadataArtifact = bundle.artifacts.find(
        (artifact) => artifact.relativePath === "agent-relay.integration.json",
      );
      const metadata = JSON.parse(metadataArtifact?.content ?? "") as Record<
        string,
        unknown
      >;
      expect(metadata).toMatchObject({
        schema: VENDOR_INTEGRATION_SCHEMA,
        version: VENDOR_INTEGRATION_VERSION,
        owner: VENDOR_INTEGRATION_OWNER,
        compatibility: {
          mcpSurface: "agent-relay-mcp.v1",
          mcpProtocol: "2025-11-25",
          skillContract: "1.0.0",
        },
        security: {
          networking: "loopback-only",
          authorization: "native-harness-only",
          embeddedCredentials: false,
        },
      });
    }
    const mcpConfigs = Object.fromEntries(
      vendorPluginBundles().map((bundle) => {
        const path = bundle.harness === "cursor" ? "mcp.json" : ".mcp.json";
        const config = bundle.artifacts.find(
          (artifact) => artifact.relativePath === path,
        );
        return [bundle.harness, JSON.parse(config?.content ?? "")];
      }),
    ) as Record<
      string,
      {
        mcpServers: {
          "agent-relay": {
            command: string;
            cwd?: string;
            env?: Record<string, string>;
          };
        };
      }
    >;
    const supervisedEnv = {
      AGENT_RELAY_MCP_HARNESS: "${AGENT_RELAY_MCP_HARNESS}",
      AGENT_RELAY_MCP_BINDING: "${AGENT_RELAY_MCP_BINDING}",
      AGENT_RELAY_MACHINE_ID: "${AGENT_RELAY_MACHINE_ID}",
      AGENT_RELAY_BRIDGE_SESSION_ID: "${AGENT_RELAY_BRIDGE_SESSION_ID}",
      AGENT_RELAY_DAEMON_URL: "${AGENT_RELAY_DAEMON_URL}",
    };
    expect(mcpConfigs["codex"]?.mcpServers["agent-relay"]).toMatchObject({
      command: "./bin/agent-relay-plugin",
      cwd: "${PLUGIN_ROOT}",
      env: supervisedEnv,
    });
    expect(mcpConfigs["claude"]?.mcpServers["agent-relay"]).toMatchObject({
      command: "${CLAUDE_PLUGIN_ROOT}/bin/agent-relay-plugin",
      env: supervisedEnv,
    });
    expect(mcpConfigs["cursor"]?.mcpServers["agent-relay"]).toMatchObject({
      command: "${PLUGIN_ROOT}/bin/agent-relay-plugin",
      cwd: "${PLUGIN_ROOT}",
      env: supervisedEnv,
    });
    expect(JSON.stringify(mcpConfigs)).not.toMatch(
      /mcpbind_|bearer|csrf|oauth|session.?correlat/i,
    );
  });

  it("renders locally installable regular files with executable wrappers", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-vendor-artifacts-"));
    for (const bundle of vendorPluginBundles()) {
      for (const artifact of bundle.artifacts) {
        const path = join(root, bundle.harness, artifact.relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, artifact.content, { mode: artifact.mode });
        expect(await readFile(path, "utf8")).toBe(artifact.content);
        expect((await stat(path)).mode & 0o777).toBe(artifact.mode);
      }
    }
    expect(JSON.parse(codexMarketplaceJson())).toMatchObject({
      plugins: [
        {
          name: "agent-relay",
          source: { source: "local", path: "./plugins/agent-relay" },
        },
      ],
    });
  });

  it("matches the frozen capability and compatibility fixtures", async () => {
    const fixtureRoot = resolve(
      import.meta.dirname,
      "../../..",
      "integrations/agent-relay/fixtures",
    );
    const compatibility = JSON.parse(
      await readFile(join(fixtureRoot, "compatibility.v1.json"), "utf8"),
    ) as {
      integrationVersion: string;
      agentRelayRange: string;
      mcpSurface: string;
      mcpProtocol: string;
      skillContract: string;
      harnesses: Array<{ harness: string; verifiedVersion: string }>;
    };
    const capabilities = JSON.parse(
      await readFile(join(fixtureRoot, "capabilities.v1.json"), "utf8"),
    ) as {
      harnesses: Array<{
        harness: string;
        manifest: string;
        mcpDeclaration: string;
        hooks: string;
        skillsOrInstructions: string;
      }>;
    };
    expect(compatibility).toMatchObject({
      integrationVersion: VENDOR_INTEGRATION_VERSION,
      agentRelayRange: ">=0.1.0-alpha.2 <0.2.0-0",
      mcpSurface: "agent-relay-mcp.v1",
      mcpProtocol: "2025-11-25",
      skillContract: "agent-relay-skill-contract.v1@1.0.0",
    });
    for (const bundle of vendorPluginBundles()) {
      expect(
        compatibility.harnesses.find(
          (entry) => entry.harness === bundle.harness,
        ),
      ).toMatchObject({ verifiedVersion: bundle.verifiedVersion });
      const capability = capabilities.harnesses.find(
        (entry) => entry.harness === bundle.harness,
      );
      expect(bundle.artifacts.map((entry) => entry.relativePath)).toEqual(
        expect.arrayContaining([
          capability?.manifest,
          capability?.mcpDeclaration,
          capability?.hooks,
          "skills/agent-relay/SKILL.md",
        ]),
      );
      expect(capability?.skillsOrInstructions).toBe("skills/*/SKILL.md");
    }
  });
});
