import { randomUUID } from "node:crypto";

import {
  isCapabilityDescriptor,
  type CapabilityDescriptor,
  type ApprovalId,
  type EventId,
  type MessageId,
  type PartId,
  type RunnerId,
  type Sha256Digest,
  type ToolCallId,
  type TraceId,
  type TurnId,
  type WorkspaceId,
} from "@session/contracts";
import {
  decodeRunnerFrame,
  encodeRunnerFrame,
  isRunnerApprovalResolveCommandFrame,
  runnerProtocolV1Manifest,
  type RunnerAckFrame,
  type RunnerCommandFrame,
  type RunnerCommandName,
  type RunnerFrame,
  type RunnerLane,
  type RunnerNackFrame,
  type RunnerProtocolErrorCode,
  type RunnerReconcileRequestFrame,
  type RunnerReconcileSummaryFrame,
  type RunnerSemanticEvent,
} from "@session/protocol-runner";

import { canonicalJson, commandEffectFingerprint, sha256 } from "./digests.js";
import type {
  BridgeClock,
  RunnerBridgeConnection,
  RunnerBridgeTransport,
  RunnerIdentityProofPort,
  StructuredHarnessCommandContext,
  StructuredHarnessCommandResult,
  StructuredHarnessDriver,
  StructuredHarnessObservation,
} from "./ports.js";
import type {
  ProductNativeBinding,
  RunnerBridgeLifecycleState,
  RunnerBridgeStore,
} from "./store.js";

export interface RunnerBridgeConfiguration {
  readonly workspaceId: WorkspaceId;
  readonly runnerId: RunnerId;
  readonly identityFingerprint: string;
  readonly revocationEpoch: number;
  readonly capabilitySnapshotDigest: Sha256Digest;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly authorizedProjectIds: ReadonlySet<string>;
  readonly maximumFrameBytes?: number;
  readonly maximumEffectOutcomes?: number;
  readonly maximumPendingEventFrames?: number;
  readonly commandTimeoutMs?: number;
  readonly approvalTtlMs?: number;
}

interface PolicyFailure {
  readonly code: RunnerProtocolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

const lanes = [
  "control",
  "event",
  "bulk",
] as const satisfies readonly RunnerLane[];
const interruptedResultDigest = sha256("runner-bridge:interrupted");
const timeoutResultDigest = sha256("runner-bridge:driver-timeout");
const internalResultDigest = sha256("runner-bridge:driver-error");

function messageId(): MessageId {
  return `msg_${randomUUID().replaceAll("-", "")}` as MessageId;
}

function traceId(): TraceId {
  return `trc_${randomUUID().replaceAll("-", "")}` as TraceId;
}

function eventId(): EventId {
  return `evt_${randomUUID().replaceAll("-", "")}` as EventId;
}

function isSessionCommand(command: RunnerCommandName): boolean {
  return (
    command === "approval.resolve" ||
    command.startsWith("artifact.") ||
    command.startsWith("session.") ||
    command.startsWith("turn.")
  );
}

function supportedCapability(
  capabilities: readonly CapabilityDescriptor[],
  name: string,
): boolean {
  return capabilities.some(
    (capability) =>
      capability.name === name && capability.support !== "unsupported",
  );
}

function safeFailure(
  code: RunnerProtocolErrorCode,
  message: string,
  retryable = false,
): PolicyFailure {
  return { code, message, retryable };
}

export class RunnerBridge {
  readonly #store: RunnerBridgeStore;
  readonly #transport: RunnerBridgeTransport;
  readonly #identityProof: RunnerIdentityProofPort;
  readonly #driver: StructuredHarnessDriver;
  readonly #clock: BridgeClock;
  readonly #configuration: RunnerBridgeConfiguration;
  #connection: RunnerBridgeConnection | undefined;
  #sessionLease: string | undefined;
  #effectiveCapabilities: readonly CapabilityDescriptor[] = [];
  #maximumFrameBytes: number;
  #unsubscribeDriver: (() => void) | undefined;

  constructor(input: {
    readonly store: RunnerBridgeStore;
    readonly transport: RunnerBridgeTransport;
    readonly identityProof: RunnerIdentityProofPort;
    readonly driver: StructuredHarnessDriver;
    readonly clock: BridgeClock;
    readonly configuration: RunnerBridgeConfiguration;
  }) {
    this.#store = input.store;
    this.#transport = input.transport;
    this.#identityProof = input.identityProof;
    this.#driver = input.driver;
    this.#clock = input.clock;
    this.#configuration = input.configuration;
    this.#maximumFrameBytes =
      input.configuration.maximumFrameBytes ??
      runnerProtocolV1Manifest.limits.maximumFrameBytes;
    this.#validateConfiguration();
  }

  #validateConfiguration(): void {
    const configuration = this.#configuration;
    if (
      configuration.capabilities.length === 0 ||
      configuration.capabilities.length >
        runnerProtocolV1Manifest.limits.maximumCapabilities ||
      new Set(configuration.capabilities.map(({ name }) => name)).size !==
        configuration.capabilities.length ||
      !configuration.capabilities.every(isCapabilityDescriptor) ||
      !Number.isSafeInteger(configuration.revocationEpoch) ||
      configuration.revocationEpoch < 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(configuration.identityFingerprint) ||
      !Number.isSafeInteger(configuration.maximumFrameBytes ?? 1_048_576) ||
      (configuration.maximumFrameBytes ?? 1_048_576) < 1 ||
      !Number.isSafeInteger(configuration.maximumEffectOutcomes ?? 64) ||
      (configuration.maximumEffectOutcomes ?? 64) < 1 ||
      (configuration.maximumEffectOutcomes ?? 64) >
        runnerProtocolV1Manifest.limits.maximumReconciliationEffectOutcomes ||
      !Number.isSafeInteger(configuration.maximumPendingEventFrames ?? 256) ||
      (configuration.maximumPendingEventFrames ?? 256) < 2 ||
      !Number.isSafeInteger(configuration.commandTimeoutMs ?? 30_000) ||
      (configuration.commandTimeoutMs ?? 30_000) < 1 ||
      !Number.isSafeInteger(configuration.approvalTtlMs ?? 300_000) ||
      (configuration.approvalTtlMs ?? 300_000) < 1
    ) {
      throw new TypeError("Runner bridge configuration is invalid.");
    }
  }

  lifecycleState(): RunnerBridgeLifecycleState {
    return this.#store.authority()?.state ?? "disabled";
  }

  registerProductManagedBinding(binding: ProductNativeBinding): void {
    if (
      binding.workspaceId !== this.#configuration.workspaceId ||
      binding.runnerId !== this.#configuration.runnerId ||
      binding.harnessProfileId !== this.#driver.profileId ||
      binding.capabilitySnapshotDigest !==
        this.#configuration.capabilitySnapshotDigest ||
      !this.#configuration.authorizedProjectIds.has(binding.projectId)
    ) {
      throw new Error("Product/native binding is outside local authority.");
    }
    this.#store.putBinding(binding);
  }

  registerStandaloneObservedBinding(binding: ProductNativeBinding): void {
    if (
      binding.actuatorOwner !== "standalone-attention" ||
      binding.workspaceId !== this.#configuration.workspaceId ||
      binding.runnerId !== this.#configuration.runnerId ||
      binding.harnessProfileId !== this.#driver.profileId ||
      !this.#configuration.authorizedProjectIds.has(binding.projectId)
    ) {
      throw new Error("Standalone observation binding is outside authority.");
    }
    this.#store.putBinding(binding);
  }

  async start(): Promise<void> {
    const now = this.#clock.now();
    const existing = this.#store.authority();
    if (existing?.state === "revoked") {
      throw new Error("Revoked runner authority cannot reconnect.");
    }
    if (
      existing &&
      (existing.workspaceId !== this.#configuration.workspaceId ||
        existing.runnerId !== this.#configuration.runnerId ||
        existing.identityFingerprint !==
          this.#configuration.identityFingerprint)
    ) {
      throw new Error("Runner authority cannot be replaced in place.");
    }
    this.#store.saveAuthority({
      workspaceId: this.#configuration.workspaceId,
      runnerId: this.#configuration.runnerId,
      identityFingerprint: this.#configuration.identityFingerprint,
      revocationEpoch: this.#configuration.revocationEpoch,
      capabilitySnapshotDigest: this.#configuration.capabilitySnapshotDigest,
      capabilities: this.#configuration.capabilities,
      state: "connecting",
      updatedAt: now,
    });
    this.#store.recoverInterruptedCommands(interruptedResultDigest, now);
    this.#store.recoverDispatchingApprovals(now);
    this.#store.expireApprovals(now);
    this.#store.invalidatePendingApprovals(now);
    this.#unsubscribeDriver = this.#driver.subscribe(async (observation) => {
      try {
        await this.#handleObservation(observation);
      } catch {
        this.#store.setLifecycle(
          this.lifecycleState(),
          this.#clock.now(),
          "observation_projection_failed",
        );
      }
    });
    try {
      await this.#driver.start();
      this.#connection = await this.#transport.connect({
        onFrame: async (encodedFrame) => {
          await this.receive(encodedFrame);
        },
        onDisconnect: (safeCode) => {
          if (this.lifecycleState() !== "revoked") {
            this.#store.setLifecycle(
              "disconnected",
              this.#clock.now(),
              safeCode,
            );
          }
          this.#connection = undefined;
          this.#sessionLease = undefined;
        },
      });
      await this.#sendHello();
    } catch (error) {
      this.#unsubscribeDriver?.();
      this.#unsubscribeDriver = undefined;
      await this.#driver.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#sessionLease = undefined;
    try {
      if (connection) {
        await connection.close();
      }
    } finally {
      this.#unsubscribeDriver?.();
      this.#unsubscribeDriver = undefined;
      await this.#driver.stop();
      if (this.lifecycleState() !== "revoked") {
        this.#store.setLifecycle("configured", this.#clock.now());
      }
    }
  }

  async #sendHello(): Promise<void> {
    const cursors = this.#store.cursors("inbound");
    const proof = await this.#identityProof.createHelloProof({
      workspaceId: this.#configuration.workspaceId,
      runnerId: this.#configuration.runnerId,
      revocationEpoch: this.#configuration.revocationEpoch,
      cursors,
    });
    await this.#queueAndSend(
      "control",
      (sequence) =>
        ({
          schema: "runner.protocol/hello",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "control",
          sent_at: this.#clock.now(),
          trace_id: traceId(),
          payload: {
            supported_versions: [runnerProtocolV1Manifest.version],
            capabilities: this.#configuration.capabilities,
            cursors,
            nonce: proof.nonce,
            proof: proof.proof,
            revocation_epoch: this.#configuration.revocationEpoch,
          },
        }) as RunnerFrame,
    );
  }

  async receive(encodedFrame: string): Promise<void> {
    const decoded = decodeRunnerFrame(encodedFrame, this.#maximumFrameBytes);
    if (!decoded.ok) {
      this.#store.setLifecycle(
        this.lifecycleState(),
        this.#clock.now(),
        decoded.error.code,
      );
      return;
    }
    const frame = decoded.value;
    if (
      frame.workspace_id !== this.#configuration.workspaceId ||
      frame.runner_id !== this.#configuration.runnerId
    ) {
      await this.#sendNack(
        frame.message_id,
        safeFailure("invalid_binding", "Runner boundary does not match."),
      );
      return;
    }
    const sequence = this.#store.inspectInbound(frame.lane, frame.sequence);
    if (sequence === "duplicate") {
      return;
    }
    if (sequence === "gap") {
      await this.#sendNack(
        frame.message_id,
        safeFailure("sequence_gap", "Runner lane sequence has a gap.", true),
      );
      return;
    }

    switch (frame.schema) {
      case "runner.protocol/welcome":
        await this.#handleWelcome(frame);
        break;
      case "runner.protocol/reconcile_request":
        await this.#handleReconcileRequest(frame);
        break;
      case "runner.protocol/reconcile_complete":
        await this.#handleReconcileComplete(frame);
        break;
      case "runner.protocol/command":
        await this.#handleCommand(frame);
        break;
      case "runner.protocol/ack":
        await this.#handleAck(frame);
        break;
      case "runner.protocol/flow_control":
        this.#store.setLanePaused(
          frame.payload.affected_lane,
          frame.payload.state === "paused",
        );
        this.#store.commitInbound(frame.lane, frame.sequence);
        break;
      case "runner.protocol/runner_revoked":
        await this.#handleRevocation(frame);
        break;
      case "runner.protocol/heartbeat":
      case "runner.protocol/nack":
        this.#store.commitInbound(frame.lane, frame.sequence);
        if (frame.schema === "runner.protocol/nack") {
          this.#store.setLifecycle(
            this.lifecycleState(),
            this.#clock.now(),
            frame.payload.error.code,
          );
        }
        break;
      case "runner.protocol/hello":
      case "runner.protocol/event_batch":
      case "runner.protocol/reconcile_summary":
        this.#store.commitInbound(frame.lane, frame.sequence);
        await this.#sendNack(
          frame.message_id,
          safeFailure(
            "unsupported_capability",
            "Frame direction is unsupported.",
          ),
        );
        break;
    }
  }

  async #handleWelcome(
    frame: Extract<RunnerFrame, { schema: "runner.protocol/welcome" }>,
  ): Promise<void> {
    if (
      this.lifecycleState() !== "connecting" ||
      frame.payload.selected_version !== runnerProtocolV1Manifest.version
    ) {
      this.#store.commitInbound(frame.lane, frame.sequence);
      await this.#sendNack(
        frame.message_id,
        safeFailure("version_unsupported", "Runner version is unsupported."),
      );
      return;
    }
    this.#effectiveCapabilities = frame.payload.capability_ceiling.filter(
      (ceiling) =>
        supportedCapability(this.#configuration.capabilities, ceiling.name) &&
        supportedCapability(this.#driver.capabilities, ceiling.name),
    );
    this.#sessionLease = frame.payload.session_lease;
    this.#maximumFrameBytes = Math.min(
      this.#maximumFrameBytes,
      frame.payload.maximum_frame_bytes,
    );
    this.#store.commitInbound(frame.lane, frame.sequence);
    this.#store.setLifecycle("reconciling", this.#clock.now());
  }

  async #handleReconcileRequest(
    frame: RunnerReconcileRequestFrame,
  ): Promise<void> {
    if (
      this.lifecycleState() !== "reconciling" ||
      this.#sessionLease === undefined ||
      frame.payload.session_lease !== this.#sessionLease
    ) {
      this.#store.commitInbound(frame.lane, frame.sequence);
      await this.#sendNack(
        frame.message_id,
        safeFailure("invalid_binding", "Reconciliation lease does not match."),
      );
      return;
    }
    this.#store.beginReconciliation(
      frame.payload.reconciliation_id,
      frame.payload.session_lease,
      this.#clock.now(),
    );
    this.#store.commitInbound(frame.lane, frame.sequence);

    let replayCount = 0;
    for (const lane of lanes) {
      const pending = this.#store.pendingOutboundAfter(
        lane,
        frame.payload.remote_cursors[lane],
      );
      replayCount += pending.length;
      for (const outbound of pending) {
        await this.#sendPersisted(outbound);
      }
    }

    const limit = Math.min(
      frame.payload.maximum_effect_outcomes,
      this.#configuration.maximumEffectOutcomes ?? 64,
    );
    const outcomes = this.#store.effectOutcomes(limit);
    const totalOutcomes =
      this.#store.outcomeCount("accepted") +
      this.#store.outcomeCount("completed") +
      this.#store.outcomeCount("outcome_unknown");
    await this.#queueAndSend(
      "control",
      (sequence): RunnerReconcileSummaryFrame =>
        ({
          schema: "runner.protocol/reconcile_summary",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "control",
          sent_at: this.#clock.now(),
          trace_id: frame.trace_id,
          payload: {
            reconciliation_id: frame.payload.reconciliation_id,
            session_lease: frame.payload.session_lease,
            local_cursors: this.#store.cursors("inbound"),
            command_cursor: this.#store.commandCursor(),
            replay_count: replayCount,
            effect_outcomes: outcomes,
            outcomes_truncated: totalOutcomes > outcomes.length,
          },
        }) as RunnerReconcileSummaryFrame,
    );
  }

  async #handleReconcileComplete(
    frame: Extract<
      RunnerFrame,
      { schema: "runner.protocol/reconcile_complete" }
    >,
  ): Promise<void> {
    const reconciliation = this.#store.reconciliation();
    if (
      !reconciliation ||
      reconciliation.state !== "requested" ||
      reconciliation.reconciliationId !== frame.payload.reconciliation_id ||
      reconciliation.sessionLease !== frame.payload.session_lease ||
      this.#sessionLease !== frame.payload.session_lease
    ) {
      this.#store.commitInbound(frame.lane, frame.sequence);
      await this.#sendNack(
        frame.message_id,
        safeFailure(
          "invalid_binding",
          "Reconciliation completion does not match.",
        ),
      );
      return;
    }
    for (const lane of lanes) {
      if (
        frame.payload.accepted_cursors[lane] >
        this.#store.lane(lane).outbound_cursor
      ) {
        this.#store.commitInbound(frame.lane, frame.sequence);
        await this.#sendNack(
          frame.message_id,
          safeFailure(
            "sequence_gap",
            "Reconciliation cursor exceeds local state.",
            true,
          ),
        );
        return;
      }
    }
    for (const lane of lanes) {
      if (
        this.#store.acknowledgeOutbound(
          lane,
          frame.payload.accepted_cursors[lane],
          this.#clock.now(),
        ) === "invalid"
      ) {
        this.#store.commitInbound(frame.lane, frame.sequence);
        await this.#sendNack(
          frame.message_id,
          safeFailure(
            "sequence_gap",
            "Reconciliation cursor exceeds local state.",
            true,
          ),
        );
        return;
      }
    }
    if (
      frame.payload.accepted_command_cursor > this.#store.commandCursor() ||
      !this.#store.completeReconciliation(
        frame.payload.reconciliation_id,
        frame.payload.session_lease,
        this.#clock.now(),
      )
    ) {
      this.#store.commitInbound(frame.lane, frame.sequence);
      await this.#sendNack(
        frame.message_id,
        safeFailure(
          "sequence_gap",
          "Reconciliation command cursor is not local.",
          true,
        ),
      );
      return;
    }
    this.#store.commitInbound(frame.lane, frame.sequence);
    this.#store.setLifecycle("ready", this.#clock.now());
  }

  async #handleAck(frame: RunnerAckFrame): Promise<void> {
    const result = this.#store.acknowledgeOutbound(
      frame.payload.acknowledged_lane,
      frame.payload.through_sequence,
      this.#clock.now(),
    );
    this.#store.commitInbound(frame.lane, frame.sequence);
    if (result === "invalid") {
      await this.#sendNack(
        frame.message_id,
        safeFailure(
          "sequence_gap",
          "Acknowledgment exceeds local state.",
          true,
        ),
      );
    }
  }

  #commandPolicy(command: RunnerCommandFrame): PolicyFailure | undefined {
    if (this.lifecycleState() !== "ready") {
      return safeFailure(
        "unauthorized",
        "Runner bridge is not ready for commands.",
        true,
      );
    }
    if (Date.parse(command.expires_at) <= Date.parse(this.#clock.now())) {
      return safeFailure("expired", "Runner command has expired.");
    }
    if (
      command.capability_snapshot_digest !==
      this.#configuration.capabilitySnapshotDigest
    ) {
      return safeFailure(
        "invalid_binding",
        "Capability snapshot does not match.",
      );
    }
    if (
      !supportedCapability(
        this.#effectiveCapabilities,
        command.payload.required_capability,
      )
    ) {
      return safeFailure(
        "unsupported_capability",
        "Required capability is unavailable.",
      );
    }
    if (
      this.#store.pendingOutboundCount("event") + 2 >
      (this.#configuration.maximumPendingEventFrames ?? 256)
    ) {
      return safeFailure(
        "spool_exhausted",
        "Runner event spool has no effect-fact capacity.",
        true,
      );
    }
    if (command.payload.command === "runner.diagnose") {
      return undefined;
    }
    if (
      command.project_id === undefined ||
      !this.#configuration.authorizedProjectIds.has(command.project_id)
    ) {
      return safeFailure("unauthorized", "Project is not locally authorized.");
    }
    if (!isSessionCommand(command.payload.command)) {
      if (
        command.payload.command !== "project.register" &&
        !this.#store.hasProject(command.project_id)
      ) {
        return safeFailure("invalid_binding", "Project binding is missing.");
      }
      return undefined;
    }
    if (command.session_id === undefined) {
      return safeFailure("invalid_binding", "Session scope is missing.");
    }
    const binding = this.#store.binding(command.session_id);
    if (command.payload.command === "session.start") {
      if (!binding) {
        return undefined;
      }
      if (this.#store.command(command.idempotency_key) === undefined) {
        return safeFailure(
          "invalid_binding",
          "Session already has a native binding.",
        );
      }
    }
    if (
      !binding ||
      binding.actuatorOwner !== "product-managed" ||
      binding.workspaceId !== command.workspace_id ||
      binding.runnerId !== command.runner_id ||
      binding.projectId !== command.project_id ||
      binding.worktreeId !== command.worktree_id ||
      binding.aggregateRevision !== command.aggregate_revision ||
      binding.capabilitySnapshotDigest !== command.capability_snapshot_digest ||
      binding.harnessProfileId !== this.#driver.profileId
    ) {
      return safeFailure("invalid_binding", "Session binding does not match.");
    }
    if (
      command.payload.command === "approval.resolve" &&
      !isRunnerApprovalResolveCommandFrame(command)
    ) {
      return safeFailure("invalid_binding", "Approval binding does not match.");
    }
    if (
      command.turn_id !== undefined &&
      command.payload.command !== "turn.start" &&
      command.payload.command !== "turn.follow_up" &&
      command.payload.command !== "approval.resolve"
    ) {
      const turn = this.#store.turn(command.turn_id);
      if (
        !turn ||
        turn.sessionId !== command.session_id ||
        turn.aggregateRevision !== command.aggregate_revision ||
        turn.nativeTurnReference === undefined ||
        turn.state !== "running"
      ) {
        return safeFailure("invalid_binding", "Turn binding does not match.");
      }
    }
    if (
      command.turn_id !== undefined &&
      (command.payload.command === "turn.start" ||
        command.payload.command === "turn.follow_up") &&
      this.#store.turn(command.turn_id) !== undefined &&
      this.#store.command(command.idempotency_key) === undefined
    ) {
      return safeFailure(
        "invalid_binding",
        "Product turn already has a native binding attempt.",
      );
    }
    if (
      command.payload.command === "approval.resolve" &&
      isRunnerApprovalResolveCommandFrame(command)
    ) {
      const body = command.payload.body;
      const approval = this.#store.approval(body.approval_id);
      if (
        !approval ||
        approval.state !== "pending" ||
        Date.parse(approval.expiresAt) <= Date.parse(this.#clock.now()) ||
        approval.sessionId !== command.session_id ||
        approval.turnId !== command.turn_id ||
        approval.toolCallId !== body.binding.tool_call_id ||
        approval.capabilitySnapshotDigest !==
          body.binding.capability_snapshot_digest ||
        approval.capabilitySnapshotDigest !==
          command.capability_snapshot_digest ||
        approval.actionDigest !== body.binding.action_digest ||
        canonicalJson(approval.action) !== canonicalJson(body.binding.action) ||
        body.binding.workspace_id !== command.workspace_id ||
        body.binding.runner_id !== command.runner_id ||
        body.binding.project_id !== command.project_id ||
        body.binding.worktree_id !== command.worktree_id ||
        body.binding.session_id !== command.session_id ||
        body.binding.turn_id !== command.turn_id ||
        body.binding.harness_profile_id !== this.#driver.profileId ||
        body.binding.expires_at !== approval.expiresAt
      ) {
        return safeFailure(
          "invalid_binding",
          "Approval binding does not match.",
        );
      }
    }
    return undefined;
  }

  async #handleCommand(command: RunnerCommandFrame): Promise<void> {
    const failure = this.#commandPolicy(command);
    if (failure) {
      this.#store.commitInbound(command.lane, command.sequence);
      await this.#sendNack(command.message_id, failure);
      return;
    }
    const fingerprint = commandEffectFingerprint(command);
    const acceptance = this.#store.acceptCommand(
      command,
      fingerprint,
      this.#clock.now(),
    );
    this.#store.commitInbound(command.lane, command.sequence);
    if (acceptance.kind === "fingerprint_mismatch") {
      await this.#sendNack(
        command.message_id,
        safeFailure(
          "duplicate_effect",
          "Command identity was reused for another effect.",
        ),
      );
      return;
    }
    await this.#sendAck(command.lane, command.sequence, command.trace_id);
    if (acceptance.kind === "duplicate") {
      return;
    }
    await this.#sendCommandEvent(
      "runner.event/command.accepted",
      command,
      "accepted",
    );
    const binding =
      command.session_id === undefined
        ? undefined
        : this.#store.binding(command.session_id);
    if (
      (command.payload.command === "turn.start" ||
        command.payload.command === "turn.follow_up") &&
      command.session_id !== undefined &&
      command.turn_id !== undefined &&
      command.aggregate_revision !== undefined
    ) {
      try {
        this.#store.putPendingTurn({
          sessionId: command.session_id,
          turnId: command.turn_id,
          aggregateRevision: command.aggregate_revision,
          state: "native_pending",
          createdAt: this.#clock.now(),
          updatedAt: this.#clock.now(),
        });
      } catch {
        this.#store.finishCommand(
          command.idempotency_key,
          "outcome_unknown",
          internalResultDigest,
          this.#clock.now(),
          "native_turn_pending_commit_failed",
        );
        await this.#sendCommandEvent(
          "runner.event/command.outcome_unknown",
          command,
          "outcome_unknown",
        );
        return;
      }
    }
    const turn =
      command.turn_id === undefined
        ? undefined
        : this.#store.turn(command.turn_id);
    const approval =
      command.payload.command === "approval.resolve" &&
      isRunnerApprovalResolveCommandFrame(command)
        ? this.#store.approval(command.payload.body.approval_id)
        : undefined;
    if (
      command.payload.command === "approval.resolve" &&
      isRunnerApprovalResolveCommandFrame(command) &&
      (!approval ||
        !this.#store.beginApprovalDispatch(
          approval.approvalId,
          command.payload.body.decision,
          this.#clock.now(),
        ))
    ) {
      this.#store.finishCommand(
        command.idempotency_key,
        "outcome_unknown",
        internalResultDigest,
        this.#clock.now(),
        "approval_dispatch_transition_failed",
      );
      await this.#sendCommandEvent(
        "runner.event/command.outcome_unknown",
        command,
        "outcome_unknown",
      );
      return;
    }
    const context: StructuredHarnessCommandContext = {
      idempotencyKey: command.idempotency_key,
      effectFingerprint: fingerprint,
      ...(binding
        ? { nativeSessionReference: binding.nativeSessionReference }
        : {}),
      ...(turn?.nativeTurnReference === undefined
        ? {}
        : { nativeTurnReference: turn.nativeTurnReference }),
      ...(approval === undefined
        ? {}
        : { nativeApprovalReference: approval.nativeApprovalReference }),
      command,
    };
    const result = await this.#invokeDriver(context);
    let finalResult = result;
    if (
      command.payload.command === "session.start" &&
      result.status === "completed"
    ) {
      const nativeSessionReference = result.nativeSessionReference;
      if (
        nativeSessionReference === undefined ||
        nativeSessionReference.length < 1 ||
        nativeSessionReference.length > 512
      ) {
        finalResult = {
          status: "outcome_unknown",
          resultDigest: result.resultDigest,
          safeCode: "native_session_reference_missing",
        };
      } else {
        try {
          this.registerProductManagedBinding({
            workspaceId: command.workspace_id,
            runnerId: command.runner_id,
            projectId: command.project_id!,
            ...(command.worktree_id === undefined
              ? {}
              : { worktreeId: command.worktree_id }),
            sessionId: command.session_id!,
            harnessProfileId: this.#driver.profileId,
            nativeSessionReference,
            capabilitySnapshotDigest: command.capability_snapshot_digest,
            actuatorOwner: "product-managed",
            aggregateRevision: command.aggregate_revision!,
            createdAt: this.#clock.now(),
            updatedAt: this.#clock.now(),
          });
          await this.#sendStateEvent(
            "runner.event/session.state_changed",
            command,
            { state: "running" },
          );
        } catch {
          finalResult = {
            status: "outcome_unknown",
            resultDigest: result.resultDigest,
            safeCode: "native_binding_commit_failed",
          };
        }
      }
    }
    if (
      (command.payload.command === "turn.start" ||
        command.payload.command === "turn.follow_up") &&
      result.status === "completed"
    ) {
      if (
        command.turn_id === undefined ||
        result.nativeTurnReference === undefined ||
        result.nativeTurnReference.length < 1 ||
        result.nativeTurnReference.length > 512
      ) {
        finalResult = {
          status: "outcome_unknown",
          resultDigest: result.resultDigest,
          safeCode: "native_turn_reference_missing",
        };
        if (command.turn_id !== undefined) {
          this.#store.setTurnState(
            command.turn_id,
            "outcome_unknown",
            this.#clock.now(),
          );
        }
      } else {
        try {
          this.#store.bindTurn(
            command.turn_id,
            result.nativeTurnReference,
            this.#clock.now(),
          );
          await this.#sendStateEvent(
            "runner.event/turn.state_changed",
            command,
            { state: "running" },
          );
        } catch {
          finalResult = {
            status: "outcome_unknown",
            resultDigest: result.resultDigest,
            safeCode: "native_turn_binding_commit_failed",
          };
          this.#store.setTurnState(
            command.turn_id,
            "outcome_unknown",
            this.#clock.now(),
          );
        }
      }
    }
    if (
      command.payload.command === "approval.resolve" &&
      approval !== undefined
    ) {
      this.#store.finishApprovalDispatch(
        approval.approvalId,
        finalResult.status === "completed" ? "resolved" : "outcome_unknown",
        this.#clock.now(),
      );
    }
    this.#store.finishCommand(
      command.idempotency_key,
      finalResult.status,
      finalResult.resultDigest,
      this.#clock.now(),
      finalResult.status === "outcome_unknown"
        ? finalResult.safeCode
        : undefined,
    );
    if (finalResult.status === "outcome_unknown") {
      await this.#sendCommandEvent(
        "runner.event/command.outcome_unknown",
        command,
        finalResult.status,
      );
    }
  }

  async #handleObservation(
    observation: StructuredHarnessObservation,
  ): Promise<void> {
    const nativeSessionReference = observation.nativeSessionReference;
    if (!nativeSessionReference) {
      return;
    }
    const binding = this.#store.bindingByNativeReference(
      this.#driver.profileId,
      nativeSessionReference,
    );
    if (!binding) {
      return;
    }
    const nativeTurnReference = observation.nativeTurnReference;
    const turn =
      nativeTurnReference === undefined
        ? undefined
        : this.#store.turnByNativeReference(
            binding.sessionId,
            nativeTurnReference,
          );
    const fingerprint = sha256(
      canonicalJson({
        profile: this.#driver.profileId,
        kind: observation.kind,
        native_session: nativeSessionReference,
        native_turn: nativeTurnReference ?? null,
        native_item: observation.nativeItemReference ?? null,
        native_approval: observation.nativeApprovalReference ?? null,
        status: observation.status ?? null,
        safe_code: observation.safeCode ?? null,
        observed_at: observation.observedAt,
      }),
    );
    const idSuffix = fingerprint.slice(0, 32);
    let schema: RunnerSemanticEvent["schema"] = "runner.event/diagnostic.fact";
    let payload: Readonly<Record<string, unknown>> = {
      fact: "native_observation",
      observation: observation.kind,
    };
    const turnId: string | undefined = turn?.turnId;
    let persistTransition: (() => void) | undefined;

    switch (observation.kind) {
      case "session.started":
      case "session.resumed":
        schema = "runner.event/session.state_changed";
        payload = {
          state: observation.kind === "session.started" ? "running" : "resumed",
        };
        break;
      case "turn.started":
        if (!turn) {
          return;
        }
        if (
          turn.state === "completed" ||
          turn.state === "failed" ||
          turn.state === "interrupted" ||
          turn.state === "outcome_unknown"
        ) {
          return;
        }
        if (turn.state !== "running") {
          persistTransition = () => {
            if (
              this.#store.setTurnState(
                turn.turnId,
                "running",
                observation.observedAt,
              ) !== "advanced"
            ) {
              throw new Error("Native turn start did not advance.");
            }
          };
        }
        schema = "runner.event/turn.state_changed";
        payload = { state: "running" };
        break;
      case "turn.completed":
        if (
          !turn ||
          turn.state === "completed" ||
          turn.state === "failed" ||
          turn.state === "interrupted" ||
          turn.state === "outcome_unknown"
        ) {
          return;
        }
        persistTransition = () => {
          if (
            this.#store.setTurnState(
              turn.turnId,
              observation.status === "failed" ? "failed" : "completed",
              observation.observedAt,
            ) !== "advanced"
          ) {
            throw new Error("Native turn completion did not advance.");
          }
        };
        schema = "runner.event/turn.state_changed";
        payload = {
          state: observation.status === "failed" ? "failed" : "completed",
        };
        break;
      case "item.started": {
        if (!turn || !observation.nativeItemReference) {
          return;
        }
        if (
          this.#store.itemByNativeReference(
            binding.sessionId,
            observation.nativeItemReference,
          )
        ) {
          return;
        }
        const partId = `prt_${idSuffix}` as PartId;
        persistTransition = () => {
          this.#store.putItem({
            sessionId: binding.sessionId,
            turnId: turn.turnId,
            partId,
            nativeItemReference: observation.nativeItemReference!,
            itemKind: observation.itemKind ?? "native",
            state: "running",
            createdAt: observation.observedAt,
            updatedAt: observation.observedAt,
          });
        };
        schema = "runner.event/part.started";
        payload = {
          part_id: partId,
          kind: observation.itemKind ?? "native",
        };
        break;
      }
      case "item.completed": {
        if (!turn || !observation.nativeItemReference) {
          return;
        }
        const item = this.#store.itemByNativeReference(
          binding.sessionId,
          observation.nativeItemReference,
        );
        if (!item || item.turnId !== turn.turnId) {
          return;
        }
        if (item.state !== "running") {
          return;
        }
        persistTransition = () => {
          if (
            this.#store.setItemState(
              item.partId,
              observation.status === "failed" ? "failed" : "completed",
              observation.observedAt,
            ) !== "advanced"
          ) {
            throw new Error("Native item completion did not advance.");
          }
        };
        schema = "runner.event/part.completed";
        payload = {
          part_id: item.partId,
          state: observation.status === "failed" ? "failed" : "completed",
        };
        break;
      }
      case "approval.requested": {
        if (
          !turn ||
          !observation.nativeApprovalReference ||
          !observation.nativeItemReference ||
          !observation.action ||
          !observation.actionDigest
        ) {
          return;
        }
        if (
          this.#store.approvalByNativeReference(
            binding.sessionId,
            observation.nativeApprovalReference,
          )
        ) {
          return;
        }
        const approvalId = `apr_${idSuffix}` as ApprovalId;
        const toolCallId = `tool_${idSuffix}` as ToolCallId;
        const expiresAt = new Date(
          Date.parse(observation.observedAt) +
            (this.#configuration.approvalTtlMs ?? 300_000),
        ).toISOString();
        persistTransition = () => {
          this.#store.putApproval({
            approvalId,
            toolCallId,
            sessionId: binding.sessionId,
            turnId: turn.turnId,
            nativeApprovalReference: observation.nativeApprovalReference!,
            nativeItemReference: observation.nativeItemReference!,
            action: observation.action!,
            actionDigest: observation.actionDigest!,
            capabilitySnapshotDigest: binding.capabilitySnapshotDigest,
            expiresAt,
            state: "pending",
            createdAt: observation.observedAt,
            updatedAt: observation.observedAt,
          });
        };
        schema = "runner.event/approval.requested";
        payload = {
          approval_id: approvalId,
          tool_call_id: toolCallId,
          action: observation.action,
          action_digest: observation.actionDigest,
          capability_snapshot_digest: binding.capabilitySnapshotDigest,
          expires_at: expiresAt,
        };
        break;
      }
      case "attention.required":
        schema = "runner.event/diagnostic.fact";
        payload = { fact: "attention_required" };
        break;
      case "native.error":
        schema = "runner.event/diagnostic.fact";
        payload = {
          fact: "native_error",
          safe_code: observation.safeCode ?? "native_error",
        };
        break;
      case "process.exited":
        persistTransition = () => {
          this.#store.invalidatePendingApprovals(
            observation.observedAt,
            binding.sessionId,
          );
          this.#store.interruptActiveTurns(
            binding.sessionId,
            observation.observedAt,
          );
        };
        schema = "runner.event/session.state_changed";
        payload = { state: "exited" };
        break;
    }

    const event = {
      schema,
      schema_version: 1,
      event_id: `evt_${idSuffix}` as EventId,
      project_id: binding.projectId,
      ...(binding.worktreeId === undefined
        ? {}
        : { worktree_id: binding.worktreeId }),
      session_id: binding.sessionId,
      aggregate_revision: binding.aggregateRevision,
      ...(turnId === undefined ? {} : { turn_id: turnId as TurnId }),
      occurred_at: observation.observedAt,
      classification: "metadata",
      payload,
    } as RunnerSemanticEvent;
    const frame = this.#store.appendObservationOutbound(
      fingerprint,
      observation.kind,
      observation.observedAt,
      (sequence) =>
        ({
          schema: "runner.protocol/event_batch",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "event",
          sent_at: observation.observedAt,
          trace_id: traceId(),
          payload: { events: [event], classification: "metadata" },
        }) as RunnerFrame,
      persistTransition,
    );
    if (frame && !this.#store.isLanePaused("event")) {
      await this.#sendPersisted(frame);
    }
  }

  async #invokeDriver(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    const command = context.command.payload.command;
    const invocation = (() => {
      switch (command) {
        case "approval.resolve":
          return this.#driver.resolveApproval(context);
        case "artifact.describe":
          return this.#driver.describeArtifact(context);
        case "artifact.grant":
          return this.#driver.grantArtifact(context);
        case "artifact.revoke":
          return this.#driver.revokeArtifact(context);
        case "project.inspect":
          return this.#driver.inspectProject(context);
        case "project.register":
          return this.#driver.registerProject(context);
        case "project.revoke":
          return this.#driver.revokeProject(context);
        case "runner.diagnose":
          return this.#driver.diagnoseRunner(context);
        case "session.pause":
          return this.#driver.pauseSession(context);
        case "session.resume":
          return this.#driver.resumeSession(context);
        case "session.start":
          return this.#driver.startSession(context);
        case "turn.cancel":
          return this.#driver.cancelTurn(context);
        case "turn.follow_up":
          return this.#driver.followUpTurn(context);
        case "turn.start":
          return this.#driver.startTurn(context);
        case "turn.steer":
          return this.#driver.steerTurn(context);
      }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invocation,
        new Promise<StructuredHarnessCommandResult>((resolve) => {
          timeout = setTimeout(() => {
            resolve({
              status: "outcome_unknown",
              resultDigest: timeoutResultDigest,
              safeCode: "driver_timeout",
            });
          }, this.#configuration.commandTimeoutMs ?? 30_000);
        }),
      ]);
    } catch {
      return {
        status: "outcome_unknown",
        resultDigest: internalResultDigest,
        safeCode: "driver_error",
      };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async #sendCommandEvent(
    schema:
      "runner.event/command.accepted" | "runner.event/command.outcome_unknown",
    command: RunnerCommandFrame,
    status: "accepted" | "completed" | "outcome_unknown",
  ): Promise<void> {
    const event = {
      schema,
      schema_version: 1,
      event_id: eventId(),
      ...(command.project_id === undefined
        ? {}
        : { project_id: command.project_id }),
      ...(command.worktree_id === undefined
        ? {}
        : { worktree_id: command.worktree_id }),
      ...(command.session_id === undefined
        ? {}
        : {
            session_id: command.session_id,
            aggregate_revision: command.aggregate_revision,
          }),
      ...(command.turn_id === undefined ? {} : { turn_id: command.turn_id }),
      occurred_at: this.#clock.now(),
      classification: "metadata",
      payload: {
        command: command.payload.command,
        status,
        idempotency_key_digest: sha256(command.idempotency_key),
      },
    } as RunnerSemanticEvent;
    await this.sendEvents([event]);
  }

  async #sendStateEvent(
    schema:
      "runner.event/session.state_changed" | "runner.event/turn.state_changed",
    command: RunnerCommandFrame,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (
      command.project_id === undefined ||
      command.session_id === undefined ||
      command.aggregate_revision === undefined
    ) {
      throw new Error("Runner state event scope is incomplete.");
    }
    await this.sendEvents([
      {
        schema,
        schema_version: 1,
        event_id: eventId(),
        project_id: command.project_id,
        ...(command.worktree_id === undefined
          ? {}
          : { worktree_id: command.worktree_id }),
        session_id: command.session_id,
        aggregate_revision: command.aggregate_revision,
        ...(command.turn_id === undefined ? {} : { turn_id: command.turn_id }),
        occurred_at: this.#clock.now(),
        classification: "metadata",
        payload,
      },
    ]);
  }

  async sendEvents(events: readonly RunnerSemanticEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const classification = events[0]?.classification;
    if (
      classification === undefined ||
      events.some((event) => event.classification !== classification)
    ) {
      throw new TypeError("Runner event batch classifications must match.");
    }
    const frame = this.#store.appendOutbound(
      "event",
      this.#clock.now(),
      (sequence) =>
        ({
          schema: "runner.protocol/event_batch",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "event",
          sent_at: this.#clock.now(),
          trace_id: traceId(),
          payload: { events, classification },
        }) as RunnerFrame,
    );
    if (!this.#store.isLanePaused("event")) {
      await this.#sendPersisted(frame);
    }
  }

  async #handleRevocation(
    frame: Extract<RunnerFrame, { schema: "runner.protocol/runner_revoked" }>,
  ): Promise<void> {
    if (
      frame.payload.identity_fingerprint !==
        this.#configuration.identityFingerprint ||
      frame.payload.revocation_epoch < this.#configuration.revocationEpoch
    ) {
      this.#store.commitInbound(frame.lane, frame.sequence);
      await this.#sendNack(
        frame.message_id,
        safeFailure("invalid_binding", "Revocation boundary does not match."),
      );
      return;
    }
    this.#store.commitInbound(frame.lane, frame.sequence);
    this.#store.revoke(frame.payload.revocation_epoch, this.#clock.now());
    const connection = this.#connection;
    this.#connection = undefined;
    this.#sessionLease = undefined;
    if (connection) {
      await connection.close();
    }
    this.#unsubscribeDriver?.();
    this.#unsubscribeDriver = undefined;
    await this.#driver.stop();
  }

  async #sendAck(
    lane: RunnerLane,
    throughSequence: number,
    trace: TraceId,
  ): Promise<void> {
    await this.#queueAndSend(
      "control",
      (sequence): RunnerAckFrame =>
        ({
          schema: "runner.protocol/ack",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "control",
          sent_at: this.#clock.now(),
          trace_id: trace,
          payload: {
            acknowledged_lane: lane,
            through_sequence: throughSequence,
          },
        }) as RunnerAckFrame,
    );
  }

  async #sendNack(
    rejectedMessageId: MessageId,
    failure: PolicyFailure,
  ): Promise<void> {
    await this.#queueAndSend(
      "control",
      (sequence): RunnerNackFrame =>
        ({
          schema: "runner.protocol/nack",
          schema_version: 1,
          message_id: messageId(),
          workspace_id: this.#configuration.workspaceId,
          runner_id: this.#configuration.runnerId,
          sequence,
          lane: "control",
          sent_at: this.#clock.now(),
          trace_id: traceId(),
          payload: {
            rejected_message_id: rejectedMessageId,
            error: {
              code: failure.code,
              message: failure.message.slice(
                0,
                runnerProtocolV1Manifest.limits.maximumSafeMessageCharacters,
              ),
              retryable: failure.retryable,
            },
          },
        }) as RunnerNackFrame,
    );
  }

  async #queueAndSend(
    lane: RunnerLane,
    build: (sequence: number) => RunnerFrame,
  ): Promise<void> {
    const frame = this.#store.appendOutbound(lane, this.#clock.now(), build);
    await this.#sendPersisted(frame);
  }

  async #sendPersisted(frame: RunnerFrame): Promise<void> {
    const connection = this.#connection;
    if (!connection) {
      return;
    }
    try {
      await connection.send(encodeRunnerFrame(frame, this.#maximumFrameBytes));
    } catch {
      this.#store.setLifecycle(
        "disconnected",
        this.#clock.now(),
        "transport_send_failed",
      );
      this.#connection = undefined;
      this.#sessionLease = undefined;
    }
  }
}
