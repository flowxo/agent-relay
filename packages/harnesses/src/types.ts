import type {
  AgentAttentionEventV1,
  CapabilitySet,
  Harness,
  Surface,
} from "@agent-relay/protocol";

export interface AdapterContext {
  machineId: string;
  bridgeSessionId: string;
  harnessVersion: string;
  surface: Surface;
  sequence: number;
  occurredAt: string;
  sourceFingerprint?: string;
}

export type AdapterEvent = Omit<
  AgentAttentionEventV1,
  | "schema"
  | "eventId"
  | "occurredAt"
  | "sequence"
  | "machineId"
  | "bridgeSessionId"
  | "harness"
  | "harnessVersion"
  | "surface"
  | "project"
  | "capabilities"
> & {
  cwd: string;
  stopHookActive?: boolean;
};

export interface ParseDiagnostic {
  code:
    | "invalid-json"
    | "malformed-payload"
    | "unsupported-event"
    | "unsupported-surface";
  harness: Harness;
  message: string;
  issues?: Array<{ path: string; message: string }>;
  safeBehavior: "no-op" | "native-prompt";
}

export type HarnessParseResult =
  | { ok: true; event: AgentAttentionEventV1; stopHookActive: boolean }
  | { ok: false; diagnostic: ParseDiagnostic };

export interface HarnessCapability {
  harness: Harness;
  surface: Surface;
  classification: CompatibilityClassification;
  verifiedVersion?: string;
  evidenceId: string;
  capabilityClassifications: CapabilityClassifications;
  deterministicStop: boolean;
  inlineContinue: boolean;
  permissionDecision: boolean;
  lateResume: boolean;
  activeSteer: boolean;
  stopFailureSignal: boolean;
  processExitObservation: boolean;
  evidence: "official-docs+local-help" | "official-docs";
  note: string;
}

export type CompatibilityClassification =
  "verified" | "compatible-unverified" | "unsupported" | "disabled";

export interface CapabilityClassifications {
  deterministicStop: CompatibilityClassification;
  inlineContinue: CompatibilityClassification;
  permissionDecision: CompatibilityClassification;
  lateResume: CompatibilityClassification;
  activeSteer: CompatibilityClassification;
  stopFailureSignal: CompatibilityClassification;
  processExitObservation: CompatibilityClassification;
}

export interface HarnessContinuation {
  stdout: Record<string, unknown>;
}

export interface ResumeInvocation {
  executable: string;
  args: string[];
}

export interface CapabilityLookup {
  protocol: CapabilitySet;
  detail: HarnessCapability;
}
