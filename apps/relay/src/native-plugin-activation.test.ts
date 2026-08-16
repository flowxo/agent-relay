import { describe, expect, it } from "vitest";

import {
  claudeActivationArgsForTest,
  claudeMarketplaceAddArgsForTest,
  claudeMarketplaceRemoveArgsForTest,
} from "./native-plugin-activation.js";

describe("native plugin activation argv", () => {
  it("registers the owned Claude marketplace before install on frozen 2.1.219", () => {
    expect(
      claudeMarketplaceAddArgsForTest(
        "/tmp/isolated/.agent-relay/vendor/claude-marketplace",
      ),
    ).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/tmp/isolated/.agent-relay/vendor/claude-marketplace",
      "--scope",
      "user",
    ]);
  });

  it("installs Claude without -y so frozen 2.1.219 stays compatible", () => {
    expect(claudeActivationArgsForTest("enable")).toEqual([
      "plugin",
      "install",
      "agent-relay@agent-relay-local",
      "-s",
      "user",
    ]);
  });

  it("can add -y for newer Claude non-TTY confirmation retries", () => {
    expect(claudeActivationArgsForTest("enable", { yes: true })).toEqual([
      "plugin",
      "install",
      "agent-relay@agent-relay-local",
      "-s",
      "user",
      "-y",
    ]);
  });

  it("uninstalls Claude without -y and removes the owned marketplace", () => {
    expect(claudeActivationArgsForTest("uninstall")).toEqual([
      "plugin",
      "uninstall",
      "agent-relay@agent-relay-local",
      "-s",
      "user",
    ]);
    expect(claudeMarketplaceRemoveArgsForTest()).toEqual([
      "plugin",
      "marketplace",
      "remove",
      "agent-relay-local",
    ]);
  });

  it("disables Claude without a yes flag", () => {
    expect(claudeActivationArgsForTest("disable")).toEqual([
      "plugin",
      "disable",
      "agent-relay@agent-relay-local",
      "-s",
      "user",
    ]);
  });
});
