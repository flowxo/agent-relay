import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface WorkspacePackage {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function packageManifest(relativePath: string): WorkspacePackage {
  return JSON.parse(
    readFileSync(join(repositoryRoot, relativePath, "package.json"), "utf8"),
  ) as WorkspacePackage;
}

function productionTypeScript(relativePath: string): string[] {
  const absolutePath = join(repositoryRoot, relativePath);
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__snapshots__" ? [] : productionTypeScript(child);
    }
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
      ? [child]
      : [];
  });
}

describe("notification package boundaries", () => {
  it("keeps neutral contracts independent of core and providers", () => {
    const manifest = packageManifest("packages/notification-contracts");
    expect(manifest.dependencies).not.toHaveProperty("@agent-relay/core");
    expect(manifest.dependencies).not.toHaveProperty(
      "@agent-relay/telegram-transport",
    );
    expect(manifest.dependencies).not.toHaveProperty(
      "@agent-relay/whooshbang-transport",
    );

    for (const sourcePath of productionTypeScript(
      "packages/notification-contracts/src",
    )) {
      const source = readFileSync(join(repositoryRoot, sourcePath), "utf8");
      expect(source, sourcePath).not.toMatch(
        /@agent-relay\/(?:core|telegram-transport|whooshbang-transport)/u,
      );
    }
  });

  it("keeps core independent of concrete provider packages", () => {
    const manifest = packageManifest("packages/core");
    expect(manifest.dependencies).toHaveProperty(
      "@agent-relay/notification-contracts",
    );
    expect(manifest.dependencies).not.toHaveProperty(
      "@agent-relay/telegram-transport",
    );
    expect(manifest.dependencies).not.toHaveProperty(
      "@agent-relay/whooshbang-transport",
    );

    for (const sourcePath of productionTypeScript("packages/core/src")) {
      const source = readFileSync(join(repositoryRoot, sourcePath), "utf8");
      expect(source, sourcePath).not.toMatch(
        /@agent-relay\/(?:telegram-transport|whooshbang-transport)/u,
      );
    }

    for (const retiredPath of [
      "packages/core/src/transport.ts",
      "packages/core/src/telegram-transport.ts",
      "packages/core/src/reply-router.ts",
    ]) {
      expect(existsSync(join(repositoryRoot, retiredPath)), retiredPath).toBe(
        false,
      );
    }
  });

  it("composes concrete providers only at the relay application boundary", () => {
    const telegram = packageManifest("packages/telegram-transport");
    expect(telegram.dependencies).toHaveProperty(
      "@agent-relay/notification-contracts",
    );
    expect(telegram.dependencies).toHaveProperty("@agent-relay/core");

    const whooshbang = packageManifest("packages/whooshbang-transport");
    expect(whooshbang.dependencies).toHaveProperty(
      "@agent-relay/notification-contracts",
    );
    expect(whooshbang.dependencies).not.toHaveProperty("@agent-relay/core");
    expect(whooshbang.dependencies).not.toHaveProperty(
      "@agent-relay/telegram-transport",
    );

    const relay = packageManifest("apps/relay");
    expect(relay.dependencies).toHaveProperty("@agent-relay/core");
    expect(relay.dependencies).toHaveProperty(
      "@agent-relay/notification-contracts",
    );
    expect(relay.dependencies).toHaveProperty(
      "@agent-relay/telegram-transport",
    );
    expect(relay.dependencies).toHaveProperty(
      "@agent-relay/whooshbang-transport",
    );
  });
});
