import { readFile, readdir } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  CODEX_APP_SERVER_CAPABILITIES,
  CodexAppServerDriver,
} from "../src/index.js";

const sourceDirectory = new URL("../src/", import.meta.url);

describe("Codex app-server adapter boundary", () => {
  test("depends outward only on the bridge-owned port", async () => {
    const sourceFiles = (await readdir(sourceDirectory)).filter((name) =>
      name.endsWith(".ts"),
    );
    const source = (
      await Promise.all(
        sourceFiles.map(async (name) => {
          return await readFile(new URL(name, sourceDirectory), "utf8");
        }),
      )
    ).join("\n");
    expect(source).toContain('"@agent-relay/runner-bridge"');
    for (const forbidden of [
      "@agent-relay/core",
      "@agent-relay/whooshbang-transport",
      "telegram",
      "flowxo",
      "apps/relay",
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(source).not.toMatch(
      /(?:executeNative|nativeRpc|shellCommand|arbitraryCommand)/u,
    );
  });

  test("advertises only operations with typed native implementations", () => {
    expect(CODEX_APP_SERVER_CAPABILITIES.map(({ name }) => name)).toEqual([
      "session.lifecycle",
      "turn.start",
      "turn.follow_up",
      "turn.steer.active",
      "turn.cancel",
      "approval.resolve",
    ]);
    const methods = Object.getOwnPropertyNames(CodexAppServerDriver.prototype);
    expect(methods).toEqual(
      expect.arrayContaining([
        "startSession",
        "resumeSession",
        "startTurn",
        "followUpTurn",
        "steerTurn",
        "cancelTurn",
        "resolveApproval",
      ]),
    );
  });
});
