import { describe, expect, it } from "vitest";

import { resolveHookHarnessVersion } from "./cli-options.js";

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
