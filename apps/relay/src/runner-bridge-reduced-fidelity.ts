import { capabilityFor } from "@agent-relay/harnesses";
import type { Harness } from "@agent-relay/protocol";
import type { ReducedFidelityProfileEvidence } from "@agent-relay/runner-bridge";

export function reducedFidelityEvidenceFor(
  harness: Harness,
  surface: "cli" | "ide",
): ReducedFidelityProfileEvidence {
  const capability = capabilityFor(harness, surface);
  if (!capability) {
    throw new Error("Reduced-fidelity harness surface is not registered.");
  }
  const detail = capability.detail;
  return {
    profileId: `hpf_${harness}_${surface}_observation_only`,
    harness,
    surface,
    evidenceId: detail.evidenceId,
    deterministicStop: detail.deterministicStop,
    inlineContinue: detail.inlineContinue,
    permissionDecision: detail.permissionDecision,
    lateResume: detail.lateResume,
    activeSteer: detail.activeSteer,
    processExitObservation: detail.processExitObservation,
  };
}
