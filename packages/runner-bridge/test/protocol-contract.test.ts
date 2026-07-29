import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  decodeRunnerFrame,
  encodeRunnerFrame,
  runRunnerProtocolCodecConformance,
  runnerProtocolV1Manifest,
  type RunnerProtocolConformanceFixture,
} from "@session/protocol-runner";
import { describe, expect, test } from "vitest";

import { verifyRunnerProtocolArtifacts } from "../../../contracts/lib/runner-protocol-preflight.mjs";

describe("pinned runner protocol", () => {
  test("passes every immutable codec fixture", async () => {
    const { fixtures, lock } = await verifyRunnerProtocolArtifacts(
      resolve(import.meta.dirname, "../../.."),
    );
    const report = runRunnerProtocolCodecConformance(
      {
        name: "@agent-relay/runner-bridge",
        decode: decodeRunnerFrame,
        encode: encodeRunnerFrame,
      },
      fixtures.fixtures as readonly RunnerProtocolConformanceFixture[],
    );

    expect(report.total).toBe(33);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
    expect(lock.release_eligible).toBe(true);
    expect(lock.source_commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(runnerProtocolV1Manifest.compatibilityCommitment).toBe(
      "internal-until-gate-5",
    );
  });

  test("production bridge cannot import presentation or provider adapters", async () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const files = [
      "bridge.ts",
      "digests.ts",
      "ports.ts",
      "status.ts",
      "store.ts",
    ];
    for (const file of files) {
      const source = await readFile(resolve(sourceRoot, file), "utf8");
      expect(source).not.toMatch(
        /@agent-relay\/(?:core|whooshbang-transport)|telegram|apps\/relay/u,
      );
    }
  });
});
