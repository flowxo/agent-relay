import type {
  CapabilityDescriptor,
  IsoTimestamp,
  Sha256Digest,
} from "@session/contracts";
import type { RunnerCommandName } from "@session/protocol-runner";

import { sha256 } from "./digests.js";
import type {
  BridgeClock,
  RunnerBridgeConnection,
  RunnerBridgeTransport,
  RunnerIdentityProof,
  RunnerIdentityProofPort,
  StructuredHarnessCommandContext,
  StructuredHarnessCommandResult,
  StructuredHarnessDriver,
} from "./ports.js";

export class FixedBridgeClock implements BridgeClock {
  #value: IsoTimestamp;

  constructor(value: IsoTimestamp) {
    this.#value = value;
  }

  now(): IsoTimestamp {
    return this.#value;
  }

  set(value: IsoTimestamp): void {
    this.#value = value;
  }
}

export class FakeRunnerIdentityProof implements RunnerIdentityProofPort {
  readonly #proof: RunnerIdentityProof;
  calls = 0;

  constructor(
    proof: RunnerIdentityProof = {
      nonce: "nonce_runner_bridge_fixture",
      proof: "proof_runner_bridge_fixture",
    },
  ) {
    this.#proof = proof;
  }

  createHelloProof(): Promise<RunnerIdentityProof> {
    this.calls += 1;
    return Promise.resolve(this.#proof);
  }
}

export class InMemoryRunnerBridgeTransport implements RunnerBridgeTransport {
  readonly sent: string[] = [];
  #handlers:
    | {
        readonly onFrame: (encodedFrame: string) => Promise<void>;
        readonly onDisconnect: (safeCode: string) => void;
      }
    | undefined;
  connected = false;
  failNextSend = false;

  connect(handlers: {
    readonly onFrame: (encodedFrame: string) => Promise<void>;
    readonly onDisconnect: (safeCode: string) => void;
  }): Promise<RunnerBridgeConnection> {
    this.#handlers = handlers;
    this.connected = true;
    return Promise.resolve({
      send: async (encodedFrame) => {
        if (this.failNextSend) {
          this.failNextSend = false;
          throw new Error("fake send failure");
        }
        this.sent.push(encodedFrame);
      },
      close: () => {
        this.connected = false;
        return Promise.resolve();
      },
    });
  }

  async deliver(encodedFrame: string): Promise<void> {
    if (!this.#handlers || !this.connected) {
      throw new Error("Fake bridge transport is not connected.");
    }
    await this.#handlers.onFrame(encodedFrame);
  }

  disconnect(safeCode = "fake_disconnect"): void {
    this.connected = false;
    this.#handlers?.onDisconnect(safeCode);
  }
}

export class FakeStructuredHarnessDriver implements StructuredHarnessDriver {
  readonly profileId: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly calls: StructuredHarnessCommandContext[] = [];
  readonly callsByCommand = new Map<RunnerCommandName, number>();
  #result: StructuredHarnessCommandResult = {
    status: "completed",
    resultDigest: sha256("fake-driver:completed"),
  };
  #error: Error | undefined;

  constructor(input: {
    readonly profileId?: string;
    readonly capabilities: readonly CapabilityDescriptor[];
  }) {
    this.profileId = input.profileId ?? "hpf_fake_structured";
    this.capabilities = input.capabilities;
  }

  setResult(result: StructuredHarnessCommandResult): void {
    this.#result = result;
    this.#error = undefined;
  }

  setError(error: Error): void {
    this.#error = error;
  }

  #invoke(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    this.calls.push(context);
    const command = context.command.payload.command;
    this.callsByCommand.set(
      command,
      (this.callsByCommand.get(command) ?? 0) + 1,
    );
    return this.#error
      ? Promise.reject(this.#error)
      : Promise.resolve(this.#result);
  }

  resolveApproval(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  describeArtifact(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  grantArtifact(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  revokeArtifact(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  inspectProject(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  registerProject(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  revokeProject(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  diagnoseRunner(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  pauseSession(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  resumeSession(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  startSession(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  cancelTurn(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  followUpTurn(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  startTurn(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
  steerTurn(context: StructuredHarnessCommandContext) {
    return this.#invoke(context);
  }
}

export function fakeCapabilitySnapshotDigest(): Sha256Digest {
  return sha256("fake-capability-snapshot");
}
