import { describe, expect, it } from "vitest";

import {
  applyCodexPluginEnablement,
  codexPluginEnablementHealthy,
} from "./codex-user-config.js";

const marketplaceRoot = "/tmp/isolated/.agent-relay/vendor/codex-marketplace";
const unrelated = `[mcp_servers.unrelated]
command = "safe-server"

[plugins.agent-relay]
enabled = true
`;

describe("Codex user-config enablement merge", () => {
  it("adds only Agent Relay marketplace tables and can remove them again", () => {
    const enabled = applyCodexPluginEnablement(
      unrelated,
      marketplaceRoot,
      "enable",
    );
    expect(enabled).toContain("[mcp_servers.unrelated]");
    expect(enabled).toContain("[plugins.agent-relay]");
    expect(enabled).toContain("[marketplaces.agent-relay-local]");
    expect(enabled).toContain(
      `[plugins."agent-relay@agent-relay-local"]\nenabled = true`,
    );
    expect(enabled).toContain(`source = ${JSON.stringify(marketplaceRoot)}`);
    expect(
      codexPluginEnablementHealthy(enabled, marketplaceRoot, "enabled"),
    ).toBe(true);

    const disabled = applyCodexPluginEnablement(
      enabled,
      marketplaceRoot,
      "disable",
    );
    expect(disabled).toContain("[plugins.agent-relay]");
    expect(disabled).toContain(
      `[plugins."agent-relay@agent-relay-local"]\nenabled = false`,
    );
    expect(
      codexPluginEnablementHealthy(disabled, marketplaceRoot, "disabled"),
    ).toBe(true);

    const removed = applyCodexPluginEnablement(
      disabled,
      marketplaceRoot,
      "uninstall",
    );
    expect(removed).toBe(unrelated);
    expect(
      codexPluginEnablementHealthy(removed, marketplaceRoot, "absent"),
    ).toBe(true);
  });

  it("deletes a file that only contained Agent Relay tables", () => {
    const enabled = applyCodexPluginEnablement(
      undefined,
      marketplaceRoot,
      "enable",
    );
    expect(
      applyCodexPluginEnablement(enabled, marketplaceRoot, "uninstall"),
    ).toBeUndefined();
  });
});
