import { describe, expect, it } from "vitest";

import type { IsoTimestamp } from "@session/contracts";

import {
  ObservationOnlyStructuredHarnessDriver,
  reducedFidelityCapabilities,
  type ReducedFidelityAttentionFact,
  type ReducedFidelityAttentionSource,
} from "../src/index.js";

class Source implements ReducedFidelityAttentionSource {
  observer:
    ((fact: ReducedFidelityAttentionFact) => void | Promise<void>) | undefined;
  starts = 0;
  stops = 0;

  subscribe(
    observer: (fact: ReducedFidelityAttentionFact) => void | Promise<void>,
  ): () => void {
    this.observer = observer;
    return () => {
      this.observer = undefined;
    };
  }

  start(): Promise<void> {
    this.starts += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
}

const evidence = {
  profileId: "hpf_cursor_ide_observation_only",
  harness: "cursor",
  surface: "ide",
  evidenceId: "cursor-ide-compatible-unverified",
  deterministicStop: false,
  inlineContinue: false,
  permissionDecision: false,
  lateResume: false,
  activeSteer: false,
  processExitObservation: false,
} as const;

describe("observation-only structured harness profile", () => {
  it("advertises only observation capabilities with explicit fidelity limits", () => {
    const capabilities = reducedFidelityCapabilities(evidence);
    expect(capabilities.map(({ name }) => name)).toEqual([
      "session.observe",
      "turn.observe",
      "attention.observe",
    ]);
    expect(JSON.stringify(capabilities)).not.toMatch(
      /session\.lifecycle|turn\.steer|turn\.cancel|approval\.resolve/u,
    );
    expect(capabilities[0]?.limits).toMatchObject({
      actuator: "none",
      permissionDecision: false,
      lateResume: false,
      activeSteer: false,
      processExitObservation: false,
    });
  });

  it("forwards bounded facts and rejects every actuator method", async () => {
    const source = new Source();
    const driver = new ObservationOnlyStructuredHarnessDriver({
      evidence,
      source,
    });
    const observations: unknown[] = [];
    driver.subscribe((observation) => {
      observations.push(observation);
    });
    await driver.start();
    await source.observer?.({
      kind: "attention.required",
      observedAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
      nativeSessionReference: "native_reduced_fixture",
    });
    expect(observations).toEqual([
      expect.objectContaining({
        kind: "attention.required",
        nativeSessionReference: "native_reduced_fixture",
      }),
    ]);
    await expect(
      driver.cancelTurn({} as Parameters<typeof driver.cancelTurn>[0]),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      safeCode: "unsupported_native_operation",
    });
    await driver.stop();
    expect(source).toMatchObject({ starts: 1, stops: 1, observer: undefined });
  });
});
