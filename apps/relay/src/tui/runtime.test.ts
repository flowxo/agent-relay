import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INK_RUNTIME_REQUIREMENTS } from "./runtime.js";
import { mapInkKey } from "./keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const relayManifest = JSON.parse(
  readFileSync(join(here, "../../package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const rootManifest = JSON.parse(
  readFileSync(join(here, "../../../../package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const release = JSON.parse(
  readFileSync(join(here, "../../../../packaging/release.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("Ink runtime inventory", () => {
  it("pins Ink on the product Node.js 22 floor with no FFI", () => {
    expect(INK_RUNTIME_REQUIREMENTS.framework).toBe("ink");
    expect(INK_RUNTIME_REQUIREMENTS.frameworkVersion).toBe("7.1.1");
    expect(INK_RUNTIME_REQUIREMENTS.reactVersion).toBe("19.2.8");
    expect(INK_RUNTIME_REQUIREMENTS.supportedProductRuntime).toBe("node>=22");
    expect(INK_RUNTIME_REQUIREMENTS.nativePackage).toBe("none");
    expect(INK_RUNTIME_REQUIREMENTS.liveNativeFlags).toEqual([]);
    expect(INK_RUNTIME_REQUIREMENTS.screenReader).toBe(
      "unsupported-documented-limitation",
    );
    expect(relayManifest.dependencies["ink"]).toBe(
      INK_RUNTIME_REQUIREMENTS.frameworkVersion,
    );
    expect(relayManifest.dependencies["react"]).toBe(
      INK_RUNTIME_REQUIREMENTS.reactVersion,
    );
    expect(rootManifest.dependencies["ink"]).toBe(
      INK_RUNTIME_REQUIREMENTS.frameworkVersion,
    );
    expect(rootManifest.dependencies["react"]).toBe(
      INK_RUNTIME_REQUIREMENTS.reactVersion,
    );
    expect(release.dependencies["ink"]).toBe(
      INK_RUNTIME_REQUIREMENTS.frameworkVersion,
    );
    expect(release.dependencies["react"]).toBe(
      INK_RUNTIME_REQUIREMENTS.reactVersion,
    );
  });

  it("maps Ink keys to the shared dashboard key vocabulary", () => {
    expect(mapInkKey("q", {})).toEqual({ name: "char", value: "q" });
    expect(mapInkKey("c", { ctrl: true })).toEqual({ name: "quit" });
    expect(mapInkKey("", { return: true })).toEqual({ name: "enter" });
    expect(mapInkKey("", { upArrow: true })).toEqual({ name: "up" });
    expect(mapInkKey("j", { eventType: "release" })).toBeUndefined();
    expect(mapInkKey("j", { eventType: "repeat" })).toEqual({
      name: "char",
      value: "j",
    });
  });
});
