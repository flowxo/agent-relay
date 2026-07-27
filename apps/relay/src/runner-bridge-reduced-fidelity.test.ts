import { describe, expect, it } from "vitest";

import { reducedFidelityEvidenceFor } from "./runner-bridge-reduced-fidelity.js";

describe("reduced fidelity composition", () => {
  it("derives exact Codex, Claude, and Cursor limits from the registry", () => {
    const codex = reducedFidelityEvidenceFor("codex", "cli");
    const claude = reducedFidelityEvidenceFor("claude", "cli");
    const cursorCli = reducedFidelityEvidenceFor("cursor", "cli");
    const cursorIde = reducedFidelityEvidenceFor("cursor", "ide");

    expect([codex, claude, cursorCli]).toEqual(
      expect.arrayContaining([expect.objectContaining({ activeSteer: false })]),
    );
    expect(
      [codex, claude, cursorCli].every(({ activeSteer }) => !activeSteer),
    ).toBe(true);
    expect(cursorCli.permissionDecision).toBe(false);
    expect(cursorIde).toMatchObject({
      permissionDecision: false,
      lateResume: false,
      processExitObservation: false,
    });
    expect(
      [codex, claude, cursorCli, cursorIde].every(
        ({ processExitObservation }) => !processExitObservation,
      ),
    ).toBe(true);
  });
});
