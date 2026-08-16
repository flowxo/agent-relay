import { describe, expect, it } from "vitest";

import {
  applyClaudePluginEnablement,
  claudePluginEnablementHealthy,
} from "./claude-user-settings.js";

const marketplaceRoot = "/tmp/isolated/.agent-relay/vendor/claude-marketplace";

describe("Claude user-settings enablement merge", () => {
  it("adds only Agent Relay marketplace keys and can remove them again", () => {
    const enabled = applyClaudePluginEnablement(
      '{\n  "permissions": { "allow": ["Read"] }\n}\n',
      marketplaceRoot,
      "enable",
    );
    expect(JSON.parse(enabled ?? "")).toMatchObject({
      permissions: { allow: ["Read"] },
      enabledPlugins: { "agent-relay@agent-relay-local": true },
      extraKnownMarketplaces: {
        "agent-relay-local": {
          source: { source: "directory", path: marketplaceRoot },
        },
      },
    });
    expect(
      claudePluginEnablementHealthy(enabled, marketplaceRoot, "enabled"),
    ).toBe(true);

    const disabled = applyClaudePluginEnablement(
      enabled,
      marketplaceRoot,
      "disable",
    );
    expect(JSON.parse(disabled ?? "").enabledPlugins).toEqual({
      "agent-relay@agent-relay-local": false,
    });
    expect(
      claudePluginEnablementHealthy(disabled, marketplaceRoot, "disabled"),
    ).toBe(true);

    const removed = applyClaudePluginEnablement(
      disabled,
      marketplaceRoot,
      "uninstall",
    );
    expect(JSON.parse(removed ?? "")).toEqual({
      permissions: { allow: ["Read"] },
    });
    expect(
      claudePluginEnablementHealthy(removed, marketplaceRoot, "absent"),
    ).toBe(true);
  });

  it("refuses malformed Claude settings instead of rewriting them", () => {
    expect(() =>
      applyClaudePluginEnablement("{ malformed", marketplaceRoot, "enable"),
    ).toThrow(/not valid JSON/u);
  });
});
