import { describe, expect, it } from "vitest";

import {
  applyCursorPluginEnablement,
  cursorPluginEnablementHealthy,
  cursorUserMcpHasForeignAgentRelay,
} from "./cursor-user-mcp.js";

const launcherPath = "/tmp/isolated/.agent-relay/bin/agent-relay";
const unrelated = `{
  "mcpServers": {
    "linear": {
      "command": "safe-server"
    }
  }
}
`;

describe("Cursor user-MCP enablement merge", () => {
  it("adds only the Agent Relay server and can remove it again", () => {
    const enabled = applyCursorPluginEnablement(unrelated, launcherPath, "enable");
    expect(JSON.parse(enabled ?? "")).toEqual({
      mcpServers: {
        linear: { command: "safe-server" },
        "agent-relay": {
          type: "stdio",
          command: launcherPath,
          args: ["mcp"],
          env: {
            AGENT_RELAY_MCP_HARNESS: "cursor",
          },
        },
      },
    });
    expect(
      cursorPluginEnablementHealthy(enabled, launcherPath, "enabled"),
    ).toBe(true);
    expect(cursorUserMcpHasForeignAgentRelay(enabled, launcherPath)).toBe(false);

    const disabled = applyCursorPluginEnablement(
      enabled,
      launcherPath,
      "disable",
    );
    expect(JSON.parse(disabled ?? "")).toEqual({
      mcpServers: { linear: { command: "safe-server" } },
    });
    expect(
      cursorPluginEnablementHealthy(disabled, launcherPath, "disabled"),
    ).toBe(true);

    const removed = applyCursorPluginEnablement(
      disabled,
      launcherPath,
      "uninstall",
    );
    expect(JSON.parse(removed ?? "")).toEqual({
      mcpServers: { linear: { command: "safe-server" } },
    });
    expect(
      cursorPluginEnablementHealthy(removed, launcherPath, "absent"),
    ).toBe(true);
  });

  it("deletes a file that only contained Agent Relay", () => {
    const enabled = applyCursorPluginEnablement(undefined, launcherPath, "enable");
    expect(enabled).toContain('"agent-relay"');
    expect(
      applyCursorPluginEnablement(enabled, launcherPath, "uninstall"),
    ).toBeUndefined();
  });

  it("treats a prior owned Agent Relay declaration as upgradeable", () => {
    const prior = applyCursorPluginEnablement(undefined, launcherPath, "enable");
    const parsed = JSON.parse(prior ?? "") as {
      mcpServers: { "agent-relay": Record<string, unknown> };
    };
    delete parsed.mcpServers["agent-relay"]?.["type"];
    expect(
      cursorUserMcpHasForeignAgentRelay(
        `${JSON.stringify(parsed)}\n`,
        launcherPath,
      ),
    ).toBe(false);
  });

  it("treats a different Agent Relay declaration as foreign", () => {
    expect(
      cursorUserMcpHasForeignAgentRelay(
        '{"mcpServers":{"agent-relay":{}}}\n',
        launcherPath,
      ),
    ).toBe(true);
    expect(
      cursorUserMcpHasForeignAgentRelay(
        '{"mcpServers":{"agent-relay-manual":{}}}\n',
        launcherPath,
      ),
    ).toBe(true);
  });

  it("refuses malformed Cursor MCP configuration instead of rewriting it", () => {
    expect(() =>
      applyCursorPluginEnablement("{ malformed", launcherPath, "enable"),
    ).toThrow(/not valid JSON/u);
  });
});
