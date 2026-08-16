import { createHash } from "node:crypto";

import {
  AGENT_RELAY_SKILL_CONTRACT_VERSION,
  AGENT_RELAY_SKILL_VERSION_RANGE,
  RELAY_MCP_PROTOCOL_VERSION,
  RELAY_MCP_SURFACE_VERSION,
} from "@agent-relay/protocol";
import type { Harness } from "@agent-relay/protocol";

import { officialAgentRelaySkillArtifacts } from "./agent-skills.js";
import { EXACT_SESSION_BINDING, pluginMcpEnvironment } from "./mcp-binding.js";

export const VENDOR_INTEGRATION_SCHEMA = "agent-relay-integration.v1" as const;
export const VENDOR_INTEGRATION_VERSION = "1.0.0" as const;
export const VENDOR_INTEGRATION_OWNER = "flowxo/agent-relay" as const;

export interface VendorPluginArtifact {
  relativePath: string;
  content: string;
  mode: 0o600 | 0o700;
  sha256: string;
}

export interface VendorPluginBundle {
  harness: Harness;
  displayName: string;
  nativeKind: string;
  verifiedVersion: string;
  updateChannel: string;
  disableBehavior: string;
  installLocation: string;
  artifacts: readonly VendorPluginArtifact[];
}

const verifiedVersions: Record<Harness, string> = {
  codex: "codex-cli 0.145.0",
  claude: "2.1.219 (Claude Code)",
  cursor: "2026.07.23-e383d2b",
};

const officialSources: Record<Harness, readonly string[]> = {
  codex: [
    "https://developers.openai.com/codex/plugins",
    "https://developers.openai.com/codex/mcp",
    "https://developers.openai.com/codex/hooks",
  ],
  claude: [
    "https://code.claude.com/docs/en/plugins-reference",
    "https://code.claude.com/docs/en/mcp",
    "https://code.claude.com/docs/en/hooks",
  ],
  cursor: [
    "https://cursor.com/docs/plugins",
    "https://cursor.com/docs/reference/plugins",
  ],
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  relativePath: string,
  content: string,
  mode: 0o600 | 0o700 = 0o600,
): VendorPluginArtifact {
  return {
    relativePath,
    content,
    mode,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function wrapper(): string {
  return `#!/bin/sh
set -eu

relay_bin="\${AGENT_RELAY_BIN:-\${HOME}/.agent-relay/bin/agent-relay}"
if [ ! -x "$relay_bin" ]; then
  printf '%s\\n' 'Agent Relay core is unavailable; run agent-relay integrations repair.' >&2
  exit 69
fi

case "\${1:-}" in
  mcp)
    shift
    exec "$relay_bin" mcp "$@"
    ;;
  hook)
    harness="\${2:-}"
    if [ -z "$harness" ]; then
      printf '%s\\n' 'Agent Relay hook wrapper requires a harness.' >&2
      exit 64
    fi
    version="\${AGENT_RELAY_HARNESS_VERSION:-unknown}"
    exec "$relay_bin" hook "$harness" --harness-version "$version"
    ;;
  connect)
    shift
    exec "$relay_bin" whooshbang connect "$@"
    ;;
  doctor)
    shift
    exec "$relay_bin" doctor "$@"
    ;;
  dashboard)
    shift
    exec "$relay_bin" dashboard "$@"
    ;;
  *)
    printf '%s\\n' 'Usage: agent-relay-plugin {mcp|hook HARNESS|connect|doctor|dashboard}' >&2
    exit 64
    ;;
esac
`;
}

function command(title: string, invocation: string, purpose: string): string {
  return `---
description: ${purpose}
---

# ${title}

Run \`${invocation}\`. Keep authentication, trust, permission, and approval prompts on the harness's native path. Report the bounded result without exposing configuration contents, credentials, identifiers, private paths, or session data.
`;
}

function auxiliarySkill(
  name: string,
  description: string,
  invocation: string,
): string {
  return `---
name: ${name}
description: ${description}
---

<!-- agent-relay-integration-owner: ${VENDOR_INTEGRATION_SCHEMA} -->

# ${name}

Run \`${invocation}\`. Preserve every native permission, approval, authentication, and trust prompt. Never include secrets, private identifiers, or session data in the response.
`;
}

function metadata(harness: Harness, nativeKind: string): string {
  return json({
    schema: VENDOR_INTEGRATION_SCHEMA,
    version: VENDOR_INTEGRATION_VERSION,
    owner: VENDOR_INTEGRATION_OWNER,
    harness,
    nativeKind,
    compatibility: {
      agentRelay: AGENT_RELAY_SKILL_VERSION_RANGE,
      mcpSurface: RELAY_MCP_SURFACE_VERSION,
      mcpProtocol: RELAY_MCP_PROTOCOL_VERSION,
      skillContract: AGENT_RELAY_SKILL_CONTRACT_VERSION,
      verifiedHarnessVersion: verifiedVersions[harness],
      otherHarnessVersions: "compatible-unverified",
    },
    security: {
      networking: "loopback-only",
      authorization: "native-harness-only",
      exactSessionBinding: EXACT_SESSION_BINDING,
      embeddedCredentials: false,
    },
    officialSources: officialSources[harness],
  });
}

function codexArtifacts(): VendorPluginArtifact[] {
  const skill = officialAgentRelaySkillArtifacts().find(
    (entry) => entry.harness === "codex",
  );
  if (skill === undefined) throw new Error("missing canonical Codex skill");
  return [
    artifact(
      ".codex-plugin/plugin.json",
      json({
        name: "agent-relay",
        version: VENDOR_INTEGRATION_VERSION,
        description:
          "Local-first operator interaction and activity integration for Agent Relay.",
        author: {
          name: "Flow XO",
          url: "https://github.com/flowxo/agent-relay",
        },
        homepage: "https://github.com/flowxo/agent-relay",
        repository: "https://github.com/flowxo/agent-relay",
        license: "MIT",
        keywords: ["agent-relay", "operator", "local-first"],
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: {
          displayName: "Agent Relay",
          shortDescription: "Local operator interaction for concurrent agents",
          longDescription:
            "Uses Agent Relay's canonical local MCP, activity hooks, and skill contract without replacing Codex permissions or approvals.",
          developerName: "Flow XO",
          category: "Productivity",
          capabilities: ["MCP", "Hooks", "Skills"],
          websiteURL: "https://github.com/flowxo/agent-relay",
          defaultPrompt: ["Check Agent Relay health"],
        },
      }),
    ),
    artifact(
      ".mcp.json",
      json({
        mcpServers: {
          "agent-relay": {
            command: "./bin/agent-relay-plugin",
            args: ["mcp"],
            cwd: ".",
            env: pluginMcpEnvironment("codex"),
          },
        },
      }),
    ),
    artifact(
      "hooks/hooks.json",
      json({
        hooks: Object.fromEntries(
          ["SessionStart", "UserPromptSubmit", "Stop"].map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      '"${PLUGIN_ROOT}/bin/agent-relay-plugin" hook codex',
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    ),
    artifact("skills/agent-relay/SKILL.md", skill.content),
    artifact(
      "skills/agent-relay-connect/SKILL.md",
      auxiliarySkill(
        "agent-relay-connect",
        "Connect Agent Relay using its canonical hosted transport entry point and native authentication flow.",
        '"$HOME/.agent-relay/bin/agent-relay" whooshbang connect',
      ),
    ),
    artifact(
      "skills/agent-relay-doctor/SKILL.md",
      auxiliarySkill(
        "agent-relay-doctor",
        "Run the secret-free Agent Relay integration health report.",
        '"$HOME/.agent-relay/bin/agent-relay" doctor',
      ),
    ),
    artifact(
      "skills/agent-relay-dashboard/SKILL.md",
      auxiliarySkill(
        "agent-relay-dashboard",
        "Open the authenticated canonical Agent Relay loopback dashboard.",
        '"$HOME/.agent-relay/bin/agent-relay" dashboard --web',
      ),
    ),
    artifact("bin/agent-relay-plugin", wrapper(), 0o700),
    artifact("agent-relay.integration.json", metadata("codex", "Codex plugin")),
  ];
}

function claudeArtifacts(): VendorPluginArtifact[] {
  const skill = officialAgentRelaySkillArtifacts().find(
    (entry) => entry.harness === "claude",
  );
  if (skill === undefined) throw new Error("missing canonical Claude skill");
  const commandRoot = "${CLAUDE_PLUGIN_ROOT}/bin/agent-relay-plugin";
  const coreCommand = '"$HOME/.agent-relay/bin/agent-relay"';
  return [
    artifact(
      ".claude-plugin/plugin.json",
      json({
        name: "agent-relay",
        version: VENDOR_INTEGRATION_VERSION,
        description:
          "Local-first operator interaction and activity integration for Agent Relay.",
        author: { name: "Flow XO" },
        homepage: "https://github.com/flowxo/agent-relay",
        repository: "https://github.com/flowxo/agent-relay",
        license: "MIT",
        keywords: ["agent-relay", "operator", "local-first"],
      }),
    ),
    artifact(
      ".mcp.json",
      json({
        mcpServers: {
          "agent-relay": {
            command: `${commandRoot}`,
            args: ["mcp"],
            env: pluginMcpEnvironment("claude"),
          },
        },
      }),
    ),
    artifact(
      "hooks/hooks.json",
      json({
        hooks: Object.fromEntries(
          ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"].map(
            (event) => [
              event,
              [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `"${commandRoot}" hook claude`,
                    },
                  ],
                },
              ],
            ],
          ),
        ),
      }),
    ),
    artifact("skills/agent-relay/SKILL.md", skill.content),
    artifact(
      "commands/agent-relay-connect.md",
      command(
        "Agent Relay Connect",
        `${coreCommand} whooshbang connect`,
        "Connect Agent Relay through the canonical native authentication path.",
      ),
    ),
    artifact(
      "commands/agent-relay-doctor.md",
      command(
        "Agent Relay Doctor",
        `${coreCommand} doctor`,
        "Inspect secret-free Agent Relay integration health.",
      ),
    ),
    artifact(
      "commands/agent-relay-dashboard.md",
      command(
        "Agent Relay Dashboard",
        `${coreCommand} dashboard --web`,
        "Open the authenticated canonical Agent Relay loopback dashboard.",
      ),
    ),
    artifact("bin/agent-relay-plugin", wrapper(), 0o700),
    artifact(
      "agent-relay.integration.json",
      metadata("claude", "Claude Code plugin"),
    ),
  ];
}

function cursorArtifacts(): VendorPluginArtifact[] {
  const skill = officialAgentRelaySkillArtifacts().find(
    (entry) => entry.harness === "cursor",
  );
  if (skill === undefined) throw new Error("missing canonical Cursor skill");
  const commandRoot = "${PLUGIN_ROOT}/bin/agent-relay-plugin";
  const coreCommand = '"$HOME/.agent-relay/bin/agent-relay"';
  return [
    artifact(
      ".cursor-plugin/plugin.json",
      json({
        name: "agent-relay",
        version: VENDOR_INTEGRATION_VERSION,
        description:
          "Local-first operator interaction and activity integration for Agent Relay.",
        author: { name: "Flow XO" },
        homepage: "https://github.com/flowxo/agent-relay",
        repository: "https://github.com/flowxo/agent-relay",
        license: "MIT",
        keywords: ["agent-relay", "operator", "local-first"],
      }),
    ),
    artifact("mcp.json", json({ mcpServers: {} })),
    artifact(
      "hooks/hooks.json",
      json({
        version: 1,
        hooks: {
          sessionStart: [{ command: `"${commandRoot}" hook cursor` }],
          stop: [{ command: `"${commandRoot}" hook cursor` }],
        },
      }),
    ),
    artifact("skills/agent-relay/SKILL.md", skill.content),
    artifact(
      "commands/agent-relay-connect.md",
      command(
        "Agent Relay Connect",
        `${coreCommand} whooshbang connect`,
        "Connect Agent Relay through the canonical native authentication path.",
      ),
    ),
    artifact(
      "commands/agent-relay-doctor.md",
      command(
        "Agent Relay Doctor",
        `${coreCommand} doctor`,
        "Inspect secret-free Agent Relay integration health.",
      ),
    ),
    artifact(
      "commands/agent-relay-dashboard.md",
      command(
        "Agent Relay Dashboard",
        `${coreCommand} dashboard --web`,
        "Open the authenticated canonical Agent Relay loopback dashboard.",
      ),
    ),
    artifact("bin/agent-relay-plugin", wrapper(), 0o700),
    artifact(
      "agent-relay.integration.json",
      metadata("cursor", "Cursor local plugin"),
    ),
  ];
}

export function vendorPluginBundles(): readonly VendorPluginBundle[] {
  return [
    {
      harness: "codex",
      displayName: "Codex",
      nativeKind: "Codex plugin in an Agent Relay-owned local marketplace",
      verifiedVersion: verifiedVersions.codex,
      updateChannel:
        "agent-relay integrations upgrade; native marketplace refresh after review",
      disableBehavior:
        "codex plugin remove agent-relay or Agent Relay lifecycle disable",
      installLocation:
        ".agent-relay/vendor/codex-marketplace/plugins/agent-relay",
      artifacts: codexArtifacts(),
    },
    {
      harness: "claude",
      displayName: "Claude Code",
      nativeKind:
        "Claude Code plugin in an Agent Relay-owned local marketplace",
      verifiedVersion: verifiedVersions.claude,
      updateChannel:
        "agent-relay integrations upgrade; native marketplace refresh after review",
      disableBehavior:
        "claude plugin uninstall or Agent Relay lifecycle disable",
      installLocation:
        ".agent-relay/vendor/claude-marketplace/plugins/agent-relay",
      artifacts: claudeArtifacts(),
    },
    {
      harness: "cursor",
      displayName: "Cursor",
      nativeKind: "Cursor local development plugin",
      verifiedVersion: verifiedVersions.cursor,
      updateChannel: "agent-relay integrations upgrade",
      disableBehavior:
        "Agent Relay lifecycle disable; Cursor loads the local plugin from plugins/local",
      installLocation: ".cursor/plugins/local/agent-relay",
      artifacts: cursorArtifacts(),
    },
  ];
}

export function vendorPluginBundle(harness: Harness): VendorPluginBundle {
  const bundle = vendorPluginBundles().find(
    (entry) => entry.harness === harness,
  );
  if (bundle === undefined)
    throw new Error(`missing ${harness} integration bundle`);
  return bundle;
}

export function codexMarketplaceJson(): string {
  return json({
    name: "agent-relay-local",
    interface: { displayName: "Agent Relay Local" },
    plugins: [
      {
        name: "agent-relay",
        source: { source: "local", path: "./plugins/agent-relay" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  });
}

export function claudeMarketplaceJson(): string {
  return json({
    name: "agent-relay-local",
    owner: { name: "Flow XO" },
    plugins: [
      {
        name: "agent-relay",
        source: "./plugins/agent-relay",
        description:
          "Local-first operator interaction and activity integration for Agent Relay.",
      },
    ],
  });
}
