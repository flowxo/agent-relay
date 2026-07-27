import type {
  CapabilityDescriptor,
  IsoTimestamp,
  Sha256Digest,
} from "@session/contracts";
import type {
  RunnerCommandFrame,
  RunnerHelloProofInput,
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
  readonly command: RunnerCommandFrame;
}

export type StructuredHarnessCommandResult =
  | {
      readonly status: "completed";
      readonly resultDigest: Sha256Digest;
    }
  | {
      readonly status: "outcome_unknown";
      readonly resultDigest: Sha256Digest;
      readonly safeCode: string;
    };

export interface StructuredHarnessDriver {
  readonly profileId: string;
  readonly capabilities: readonly CapabilityDescriptor[];

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
