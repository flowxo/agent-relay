import type {
  CapabilityDescriptor,
  IsoTimestamp,
  Sha256Digest,
} from "@session/contracts";
import type {
  RunnerCommandFrame,
  RunnerHelloProofInput,
  RunnerNormalizedActuatorAction,
} from "@session/protocol-runner";

export interface RunnerBridgeConnection {
  send(encodedFrame: string): Promise<void>;
  close(): Promise<void>;
}

export interface RunnerBridgeTransport {
  connect(handlers: {
    readonly onFrame: (encodedFrame: string) => Promise<void>;
    readonly onDisconnect: (safeCode: string) => void;
  }): Promise<RunnerBridgeConnection>;
}

export interface RunnerIdentityProof {
  readonly nonce: string;
  readonly proof: string;
}

export interface RunnerIdentityProofPort {
  createHelloProof(
    input: Omit<RunnerHelloProofInput, "nonce">,
  ): Promise<RunnerIdentityProof>;
}

export interface BridgeClock {
  now(): IsoTimestamp;
}

export interface StructuredHarnessCommandContext {
  readonly idempotencyKey: string;
  readonly effectFingerprint: Sha256Digest;
  readonly nativeSessionReference?: string;
  readonly nativeTurnReference?: string;
  readonly nativeApprovalReference?: string;
  readonly command: RunnerCommandFrame;
}

export type StructuredHarnessCommandResult =
  | {
      readonly status: "completed";
      readonly resultDigest: Sha256Digest;
      readonly nativeSessionReference?: string;
      readonly nativeTurnReference?: string;
    }
  | {
      readonly status: "outcome_unknown";
      readonly resultDigest: Sha256Digest;
      readonly safeCode: string;
    };

export type StructuredHarnessObservationKind =
  | "session.started"
  | "session.resumed"
  | "turn.started"
  | "turn.completed"
  | "item.started"
  | "item.completed"
  | "approval.requested"
  | "attention.required"
  | "native.error"
  | "process.exited";

export interface StructuredHarnessObservation {
  readonly kind: StructuredHarnessObservationKind;
  readonly observedAt: IsoTimestamp;
  readonly nativeSessionReference?: string;
  readonly nativeTurnReference?: string;
  readonly nativeItemReference?: string;
  readonly nativeApprovalReference?: string;
  readonly itemKind?: string;
  readonly approvalKind?: string;
  readonly action?: RunnerNormalizedActuatorAction;
  readonly actionDigest?: Sha256Digest;
  readonly status?: string;
  readonly safeCode?: string;
}

export type StructuredHarnessObserver = (
  observation: StructuredHarnessObservation,
) => void | Promise<void>;

export interface StandaloneSessionAdoptionClaim {
  readonly adoptionId: string;
  readonly requestFingerprint: Sha256Digest;
  readonly machineId: string;
  readonly harness: "codex";
  readonly surface: "cli";
  readonly nativeSessionReference: string;
  readonly bridgeSessionId: string;
  readonly expectedSequence: number;
  readonly projectAuthorityDigest: string;
  readonly standaloneCapabilityDigest: Sha256Digest;
  readonly harnessVersion: string;
  readonly productSessionId: string;
  readonly claimedAt: IsoTimestamp;
}

export interface StandaloneSessionAdoptionReceipt {
  readonly adoptionId: string;
  readonly requestFingerprint: Sha256Digest;
  readonly productSessionId: string;
  readonly nativeSessionReference: string;
  readonly claimedAt: IsoTimestamp;
}

export type StandaloneSessionAdoptionResult =
  | {
      readonly status: "claimed" | "duplicate";
      readonly receipt: StandaloneSessionAdoptionReceipt;
    }
  | {
      readonly status: "rejected";
      readonly safeCode: string;
    };

export interface StandaloneSessionAuthorityPort {
  claim(
    claim: StandaloneSessionAdoptionClaim,
  ): Promise<StandaloneSessionAdoptionResult>;
  inspect(
    adoptionId: string,
  ): Promise<StandaloneSessionAdoptionReceipt | undefined>;
}

export interface StructuredHarnessDriver {
  readonly profileId: string;
  readonly capabilities: readonly CapabilityDescriptor[];

  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(observer: StructuredHarnessObserver): () => void;

  resolveApproval(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  describeArtifact(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  grantArtifact(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  revokeArtifact(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  inspectProject(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  registerProject(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  revokeProject(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  diagnoseRunner(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  pauseSession(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  resumeSession(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  startSession(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  cancelTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  followUpTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  startTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
  steerTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult>;
}
