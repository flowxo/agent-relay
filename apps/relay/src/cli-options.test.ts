import { describe, expect, it } from "vitest";

import {
  isInertCanaryHelpRequest,
  resolveHookHarnessVersion,
  resolveSupervisorExecutable,
  resolveWebEnabled,
} from "./cli-options.js";

describe("canary help isolation", () => {
  it("recognizes both inert help flags for every canary command", () => {
    for (const command of [
      "canary",
      "telegram-canary",
      "whooshbang-canary",
      "webhook-canary",
    ]) {
      expect(isInertCanaryHelpRequest(command, ["--help"])).toBe(true);
      expect(isInertCanaryHelpRequest(command, ["-h"])).toBe(true);
      expect(
        isInertCanaryHelpRequest(command, ["--wait-ms", "100", "--help"]),
      ).toBe(true);
    }
  });

  it("does not intercept execution or unrelated commands", () => {
    expect(isInertCanaryHelpRequest("telegram-canary", [])).toBe(false);
    expect(
      isInertCanaryHelpRequest("telegram-canary", ["--wait-ms", "100"]),
    ).toBe(false);
    expect(isInertCanaryHelpRequest("status", ["--help"])).toBe(false);
    expect(isInertCanaryHelpRequest(undefined, ["--help"])).toBe(false);
  });
});

describe("hook harness version resolution", () => {
  it("prefers the live supervisor version over install-time hook metadata", () => {
    expect(
      resolveHookHarnessVersion({
        flagVersion: "installed-old",
        environmentVersion: "supervised-current",
        supervised: true,
      }),
    ).toBe("supervised-current");
  });

  it("retains explicit hook precedence outside supervision", () => {
    expect(
      resolveHookHarnessVersion({
        flagVersion: "configured",
        environmentVersion: "ambient",
        supervised: false,
      }),
    ).toBe("configured");
  });

  it("falls back through the available version and then unknown", () => {
    expect(
      resolveHookHarnessVersion({
        flagVersion: "installed",
        environmentVersion: undefined,
        supervised: true,
      }),
    ).toBe("installed");
    expect(
      resolveHookHarnessVersion({
        flagVersion: undefined,
        environmentVersion: "ambient",
        supervised: false,
      }),
    ).toBe("ambient");
    expect(
      resolveHookHarnessVersion({
        flagVersion: undefined,
        environmentVersion: undefined,
        supervised: false,
      }),
    ).toBe("unknown");
  });
});

describe("local web companion enablement", () => {
  it("defaults to enabled and accepts explicit environment values", () => {
    expect(
      resolveWebEnabled({
        environmentValue: undefined,
        disabledByFlag: false,
      }),
    ).toBe(true);
    for (const value of ["1", "true", "YES", "on"]) {
      expect(
        resolveWebEnabled({ environmentValue: value, disabledByFlag: false }),
      ).toBe(true);
    }
    for (const value of ["0", "false", "NO", "off"]) {
      expect(
        resolveWebEnabled({ environmentValue: value, disabledByFlag: false }),
      ).toBe(false);
    }
  });

  it("gives the local no-web flag precedence and diagnoses invalid values", () => {
    expect(
      resolveWebEnabled({
        environmentValue: "true",
        disabledByFlag: true,
      }),
    ).toBe(false);
    expect(() =>
      resolveWebEnabled({
        environmentValue: "sometimes",
        disabledByFlag: false,
      }),
    ).toThrow("AGENT_RELAY_WEB_ENABLED");
  });
});

describe("supervisor executable resolution", () => {
  it("uses the explicit executable or the harness fallback", () => {
    expect(resolveSupervisorExecutable([], "cursor-agent")).toBe(
      "cursor-agent",
    );
    expect(
      resolveSupervisorExecutable(
        ["--executable", "/approved/cursor-agent"],
        "cursor-agent",
      ),
    ).toBe("/approved/cursor-agent");
  });

  it("fails closed on missing, flag-shaped, empty, or duplicate values", () => {
    for (const args of [
      ["--executable"],
      ["--executable", ""],
      ["--executable", "--max-resumes", "1"],
    ]) {
      expect(() => resolveSupervisorExecutable(args, "cursor-agent")).toThrow(
        "--executable requires a value",
      );
    }
    expect(() =>
      resolveSupervisorExecutable(
        ["--executable", "/first", "--executable", "/second"],
        "cursor-agent",
      ),
    ).toThrow("--executable may be provided only once");
  });
});
