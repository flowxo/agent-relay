import type { CapabilityDescriptor, IsoTimestamp } from "@session/contracts";

import { sha256 } from "./digests.js";
import type {
  StructuredHarnessCommandContext,
  StructuredHarnessCommandResult,
  StructuredHarnessDriver,
  StructuredHarnessObservation,
  StructuredHarnessObserver,
} from "./ports.js";

export interface ReducedFidelityProfileEvidence {
  readonly profileId: string;
  readonly harness: "codex" | "claude" | "cursor";
  readonly surface: "cli" | "ide";
  readonly evidenceId: string;
  readonly deterministicStop: boolean;
  readonly inlineContinue: boolean;
  readonly permissionDecision: boolean;
  readonly lateResume: boolean;
  readonly activeSteer: boolean;
  readonly processExitObservation: boolean;
}

export interface ReducedFidelityAttentionFact {
  readonly kind:
    | "session.started"
    | "turn.started"
    | "turn.completed"
    | "attention.required"
    | "native.error";
  readonly observedAt: IsoTimestamp;
  readonly nativeSessionReference: string;
  readonly nativeTurnReference?: string;
  readonly status?: string;
  readonly safeCode?: string;
}

export interface ReducedFidelityAttentionSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(
    observer: (fact: ReducedFidelityAttentionFact) => void | Promise<void>,
  ): () => void;
}

export function reducedFidelityCapabilities(
  evidence: ReducedFidelityProfileEvidence,
): readonly CapabilityDescriptor[] {
  const limits = {
    actuator: "none",
    deterministicStop: evidence.deterministicStop,
    inlineContinue: evidence.inlineContinue,
    permissionDecision: evidence.permissionDecision,
    lateResume: evidence.lateResume,
    activeSteer: evidence.activeSteer,
    processExitObservation: evidence.processExitObservation,
  };
  return Object.freeze([
    {
      name: "session.observe",
      version: 1,
      support: "emulated-with-declared-semantics",
      limits,
      evidence: { profile: evidence.profileId, record: evidence.evidenceId },
    },
    {
      name: "turn.observe",
      version: 1,
      support: "emulated-with-declared-semantics",
      limits,
      evidence: { profile: evidence.profileId, record: evidence.evidenceId },
    },
    {
      name: "attention.observe",
      version: 1,
      support: "emulated-with-declared-semantics",
      limits,
      evidence: { profile: evidence.profileId, record: evidence.evidenceId },
    },
  ] as const);
}

function unsupported(label: string): StructuredHarnessCommandResult {
  return {
    status: "outcome_unknown",
    resultDigest: sha256(`reduced-fidelity:${label}`),
    safeCode: "unsupported_native_operation",
  };
}

export class ObservationOnlyStructuredHarnessDriver implements StructuredHarnessDriver {
  readonly profileId: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly #source: ReducedFidelityAttentionSource;
  readonly #observers = new Set<StructuredHarnessObserver>();
  #unsubscribe: (() => void) | undefined;

  constructor(input: {
    readonly evidence: ReducedFidelityProfileEvidence;
    readonly source: ReducedFidelityAttentionSource;
  }) {
    this.profileId = input.evidence.profileId;
    this.capabilities = reducedFidelityCapabilities(input.evidence);
    this.#source = input.source;
  }

  subscribe(observer: StructuredHarnessObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  async start(): Promise<void> {
    if (!this.#unsubscribe) {
      this.#unsubscribe = this.#source.subscribe(async (fact) => {
        const observation: StructuredHarnessObservation = {
          kind: fact.kind,
          observedAt: fact.observedAt,
          nativeSessionReference: fact.nativeSessionReference,
          ...(fact.nativeTurnReference === undefined
            ? {}
            : { nativeTurnReference: fact.nativeTurnReference }),
          ...(fact.status === undefined ? {} : { status: fact.status }),
          ...(fact.safeCode === undefined ? {} : { safeCode: fact.safeCode }),
        };
        await Promise.all(
          [...this.#observers].map(async (observer) => {
            await observer(observation);
          }),
        );
      });
    }
    try {
      await this.#source.start();
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#source.stop();
    } finally {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
    }
  }

  resolveApproval(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("approval.resolve"));
  }

  describeArtifact(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("artifact.describe"));
  }

  grantArtifact(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("artifact.grant"));
  }

  revokeArtifact(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("artifact.revoke"));
  }

  inspectProject(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("project.inspect"));
  }

  registerProject(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("project.register"));
  }

  revokeProject(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("project.revoke"));
  }

  diagnoseRunner(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("runner.diagnose"));
  }

  pauseSession(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("session.pause"));
  }

  resumeSession(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("session.resume"));
  }

  startSession(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("session.start"));
  }

  cancelTurn(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("turn.cancel"));
  }

  followUpTurn(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("turn.follow_up"));
  }

  startTurn(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("turn.start"));
  }

  steerTurn(
    _context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unsupported("turn.steer"));
  }
}
