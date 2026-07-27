import type { CapabilityDescriptor, IsoTimestamp } from "@session/contracts";
import { isRunnerApprovalResolveBody } from "@session/protocol-runner";
import {
  sha256,
  type StructuredHarnessCommandContext,
  type StructuredHarnessCommandResult,
  type StructuredHarnessDriver,
  type StructuredHarnessObservation,
  type StructuredHarnessObserver,
} from "@agent-relay/runner-bridge";

import type { CodexAppServerInbound, CodexRequestId } from "./protocol.js";
import {
  ApprovalRequestSchema,
  codexRequestReference,
  EmptyResponseSchema,
  ErrorNotificationSchema,
  ItemNotificationSchema,
  ThreadResponseSchema,
  ThreadStartedNotificationSchema,
  TurnNotificationSchema,
  TurnResponseSchema,
  TurnSteerResponseSchema,
} from "./protocol.js";
import type { CodexAppServerRpc } from "./process.js";

export const CODEX_APP_SERVER_PROFILE_ID =
  "hpf_codex_app_server_0_145_0" as const;

export const CODEX_APP_SERVER_CAPABILITIES = Object.freeze([
  {
    name: "session.lifecycle",
    version: 1,
    support: "native",
    evidence: { profile: "codex-app-server-0.145.0" },
  },
  {
    name: "turn.start",
    version: 1,
    support: "native",
    evidence: { profile: "codex-app-server-0.145.0" },
  },
  {
    name: "turn.follow_up",
    version: 1,
    support: "native",
    evidence: { profile: "codex-app-server-0.145.0" },
  },
  {
    name: "turn.steer.active",
    version: 1,
    support: "native",
    limits: { while: ["running"] },
    evidence: { profile: "codex-app-server-0.145.0" },
  },
  {
    name: "turn.cancel",
    version: 1,
    support: "native",
    limits: { while: ["running"] },
    evidence: { profile: "codex-app-server-0.145.0" },
  },
  {
    name: "approval.resolve",
    version: 1,
    support: "native",
    limits: { kinds: ["commandExecution", "fileChange"] },
    evidence: { profile: "codex-app-server-0.145.0" },
  },
] as const satisfies readonly CapabilityDescriptor[]);

export interface CodexSessionMaterial {
  readonly cwd: string;
  readonly model?: string;
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly ephemeral?: boolean;
}

export interface CodexTurnMaterial {
  readonly instructionDigest: string;
  readonly input: readonly [
    {
      readonly type: "text";
      readonly text: string;
      readonly text_elements: readonly [];
    },
    ...Array<{
      readonly type: "text";
      readonly text: string;
      readonly text_elements: readonly [];
    }>,
  ];
}

export interface CodexCommandMaterialPort {
  resolveSession(
    context: StructuredHarnessCommandContext,
  ): Promise<CodexSessionMaterial>;
  resolveTurn(
    context: StructuredHarnessCommandContext,
    instructionDigest: string,
  ): Promise<CodexTurnMaterial>;
}

interface PendingApproval {
  readonly id: CodexRequestId;
  readonly reference: string;
  readonly method:
    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

export interface CodexAppServerDriverStatus {
  readonly rpc: ReturnType<CodexAppServerRpc["status"]>;
  readonly activeTurnCount: number;
  readonly pendingApprovalCount: number;
  readonly observerCount: number;
}

function completed(
  label: string,
  references: {
    readonly nativeSessionReference?: string;
    readonly nativeTurnReference?: string;
  } = {},
): StructuredHarnessCommandResult {
  return {
    status: "completed",
    resultDigest: sha256(`codex-app-server:${label}`),
    ...references,
  };
}

function unknown(
  safeCode: string,
  label = safeCode,
): StructuredHarnessCommandResult {
  return {
    status: "outcome_unknown",
    resultDigest: sha256(`codex-app-server:${label}`),
    safeCode,
  };
}

function safeCode(error: unknown): string {
  if (
    error instanceof Error &&
    "safeCode" in error &&
    typeof error.safeCode === "string"
  ) {
    return error.safeCode;
  }
  return "native_driver_error";
}

function nativeSession(
  context: StructuredHarnessCommandContext,
): string | undefined {
  const value = context.nativeSessionReference;
  return value && value.length <= 512 ? value : undefined;
}

function instructionDigest(
  context: StructuredHarnessCommandContext,
): string | undefined {
  const value = context.command.payload.body["instruction_digest"];
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value
    : undefined;
}

export class CodexAppServerDriver implements StructuredHarnessDriver {
  readonly profileId = CODEX_APP_SERVER_PROFILE_ID;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  readonly #rpc: CodexAppServerRpc;
  readonly #material: CodexCommandMaterialPort;
  readonly #now: () => IsoTimestamp;
  readonly #observers = new Set<StructuredHarnessObserver>();
  readonly #activeTurns = new Map<string, string>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  #unsubscribeRpc: (() => void) | undefined;

  constructor(input: {
    readonly rpc: CodexAppServerRpc;
    readonly material: CodexCommandMaterialPort;
    readonly now?: () => IsoTimestamp;
  }) {
    this.#rpc = input.rpc;
    this.#material = input.material;
    this.#now = input.now ?? (() => new Date().toISOString() as IsoTimestamp);
  }

  status(): CodexAppServerDriverStatus {
    return {
      rpc: this.#rpc.status(),
      activeTurnCount: this.#activeTurns.size,
      pendingApprovalCount: this.#pendingApprovals.size,
      observerCount: this.#observers.size,
    };
  }

  subscribe(observer: StructuredHarnessObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  async start(): Promise<void> {
    if (!this.#unsubscribeRpc) {
      this.#unsubscribeRpc = this.#rpc.subscribe(async (message) => {
        await this.#acceptNativeMessage(message);
      });
    }
    try {
      await this.#rpc.start();
    } catch (error) {
      this.#unsubscribeRpc?.();
      this.#unsubscribeRpc = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#rpc.stop();
    } finally {
      this.#unsubscribeRpc?.();
      this.#unsubscribeRpc = undefined;
      this.#activeTurns.clear();
      this.#pendingApprovals.clear();
    }
  }

  async startSession(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    try {
      const material = await this.#material.resolveSession(context);
      const response = ThreadResponseSchema.parse(
        await this.#rpc.request("thread/start", {
          cwd: material.cwd,
          ...(material.model === undefined ? {} : { model: material.model }),
          approvalPolicy: material.approvalPolicy ?? "on-request",
          sandbox: material.sandbox ?? "workspace-write",
          ephemeral: material.ephemeral ?? false,
        }),
      );
      return completed("session.start", {
        nativeSessionReference: response.thread.id,
      });
    } catch (error) {
      return unknown(safeCode(error), "session.start");
    }
  }

  async resumeSession(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    const threadId = nativeSession(context);
    if (!threadId) {
      return unknown("native_session_reference_missing");
    }
    try {
      const response = ThreadResponseSchema.parse(
        await this.#rpc.request("thread/resume", {
          threadId,
          excludeTurns: true,
        }),
      );
      if (response.thread.id !== threadId) {
        return unknown("native_session_reference_mismatch");
      }
      await this.#emit({
        kind: "session.resumed",
        observedAt: this.#now(),
        nativeSessionReference: threadId,
      });
      return completed("session.resume", {
        nativeSessionReference: threadId,
      });
    } catch (error) {
      return unknown(safeCode(error), "session.resume");
    }
  }

  startTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return this.#startTurn(context, "turn.start");
  }

  followUpTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    return this.#startTurn(context, "turn.follow_up");
  }

  async steerTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    const threadId = nativeSession(context);
    const digest = instructionDigest(context);
    if (!threadId || !digest) {
      return unknown("native_turn_material_missing");
    }
    const activeTurn = this.#activeTurns.get(threadId);
    if (!activeTurn) {
      return unknown("native_active_turn_missing");
    }
    try {
      const material = await this.#material.resolveTurn(context, digest);
      if (material.instructionDigest !== digest) {
        return unknown("native_turn_material_mismatch");
      }
      const response = TurnSteerResponseSchema.parse(
        await this.#rpc.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurn,
          input: material.input,
        }),
      );
      if (response.turnId !== activeTurn) {
        return unknown("native_active_turn_mismatch");
      }
      return completed("turn.steer", {
        nativeSessionReference: threadId,
        nativeTurnReference: activeTurn,
      });
    } catch (error) {
      return unknown(safeCode(error), "turn.steer");
    }
  }

  async cancelTurn(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    const threadId = nativeSession(context);
    if (!threadId) {
      return unknown("native_session_reference_missing");
    }
    const activeTurn = this.#activeTurns.get(threadId);
    if (!activeTurn) {
      return unknown("native_active_turn_missing");
    }
    try {
      EmptyResponseSchema.parse(
        await this.#rpc.request("turn/interrupt", {
          threadId,
          turnId: activeTurn,
        }),
      );
      return completed("turn.cancel", {
        nativeSessionReference: threadId,
        nativeTurnReference: activeTurn,
      });
    } catch (error) {
      return unknown(safeCode(error), "turn.cancel");
    }
  }

  async resolveApproval(
    context: StructuredHarnessCommandContext,
  ): Promise<StructuredHarnessCommandResult> {
    const threadId = nativeSession(context);
    const reference = context.nativeApprovalReference;
    const body = context.command.payload.body;
    if (!threadId || !reference || !isRunnerApprovalResolveBody(body)) {
      return unknown("native_approval_reference_missing");
    }
    const pending = this.#pendingApprovals.get(reference);
    if (!pending || pending.threadId !== threadId) {
      return unknown("native_approval_reference_mismatch");
    }
    if (
      context.nativeTurnReference !== undefined &&
      context.nativeTurnReference !== pending.turnId
    ) {
      return unknown("native_approval_turn_mismatch");
    }
    const decision = body.decision === "approve" ? "accept" : "decline";
    try {
      await this.#rpc.respond(pending.id, { decision });
      this.#pendingApprovals.delete(reference);
      return completed("approval.resolve", {
        nativeSessionReference: threadId,
        nativeTurnReference: pending.turnId,
      });
    } catch (error) {
      return unknown(safeCode(error), "approval.resolve");
    }
  }

  describeArtifact(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  grantArtifact(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  revokeArtifact(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  inspectProject(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  registerProject(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  revokeProject(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  diagnoseRunner(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  pauseSession(): Promise<StructuredHarnessCommandResult> {
    return Promise.resolve(unknown("unsupported_native_operation"));
  }

  async #startTurn(
    context: StructuredHarnessCommandContext,
    label: "turn.start" | "turn.follow_up",
  ): Promise<StructuredHarnessCommandResult> {
    const threadId = nativeSession(context);
    const digest = instructionDigest(context);
    if (!threadId || !digest) {
      return unknown("native_turn_material_missing");
    }
    if (this.#activeTurns.has(threadId)) {
      return unknown("native_turn_already_active");
    }
    try {
      const material = await this.#material.resolveTurn(context, digest);
      if (material.instructionDigest !== digest) {
        return unknown("native_turn_material_mismatch");
      }
      const response = TurnResponseSchema.parse(
        await this.#rpc.request("turn/start", {
          threadId,
          input: material.input,
        }),
      );
      this.#activeTurns.set(threadId, response.turn.id);
      return completed(label, {
        nativeSessionReference: threadId,
        nativeTurnReference: response.turn.id,
      });
    } catch (error) {
      return unknown(safeCode(error), label);
    }
  }

  async #acceptNativeMessage(message: CodexAppServerInbound): Promise<void> {
    if (message.kind === "process_exited") {
      this.#activeTurns.clear();
      this.#pendingApprovals.clear();
      await this.#emit({
        kind: "process.exited",
        observedAt: this.#now(),
        status: message.intentional ? "intentional" : "unexpected",
        safeCode: message.intentional
          ? "native_process_stopped"
          : "native_process_exited",
      });
      return;
    }
    if (message.kind === "request") {
      await this.#acceptServerRequest(message);
      return;
    }
    if (message.kind !== "notification") {
      return;
    }
    switch (message.method) {
      case "thread/started": {
        const params = ThreadStartedNotificationSchema.parse(message.params);
        await this.#emit({
          kind: "session.started",
          observedAt: this.#now(),
          nativeSessionReference: params.thread.id,
        });
        return;
      }
      case "turn/started": {
        const params = TurnNotificationSchema.parse(message.params);
        this.#activeTurns.set(params.threadId, params.turn.id);
        await this.#emit({
          kind: "turn.started",
          observedAt: this.#now(),
          nativeSessionReference: params.threadId,
          nativeTurnReference: params.turn.id,
          status: params.turn.status,
        });
        return;
      }
      case "turn/completed": {
        const params = TurnNotificationSchema.parse(message.params);
        if (this.#activeTurns.get(params.threadId) === params.turn.id) {
          this.#activeTurns.delete(params.threadId);
        }
        await this.#emit({
          kind: "turn.completed",
          observedAt: this.#now(),
          nativeSessionReference: params.threadId,
          nativeTurnReference: params.turn.id,
          status: params.turn.status,
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        const params = ItemNotificationSchema.parse(message.params);
        await this.#emit({
          kind:
            message.method === "item/started"
              ? "item.started"
              : "item.completed",
          observedAt: this.#now(),
          nativeSessionReference: params.threadId,
          nativeTurnReference: params.turnId,
          nativeItemReference: params.item.id,
          itemKind: params.item.type,
        });
        return;
      }
      case "error": {
        const params = ErrorNotificationSchema.parse(message.params);
        await this.#emit({
          kind: "native.error",
          observedAt: this.#now(),
          nativeSessionReference: params.threadId,
          nativeTurnReference: params.turnId,
          status: params.willRetry ? "retrying" : "terminal",
          safeCode: "native_error_notification",
        });
        return;
      }
      default:
        return;
    }
  }

  async #acceptServerRequest(
    message: Extract<CodexAppServerInbound, { kind: "request" }>,
  ): Promise<void> {
    if (
      message.method !== "item/commandExecution/requestApproval" &&
      message.method !== "item/fileChange/requestApproval"
    ) {
      await this.#rpc.reject(message.id, "unsupported_server_request");
      await this.#emit({
        kind: "native.error",
        observedAt: this.#now(),
        status: "terminal",
        safeCode: "unsupported_server_request",
      });
      return;
    }
    const params = ApprovalRequestSchema.parse(message.params);
    const reference = codexRequestReference(message.id);
    this.#pendingApprovals.set(reference, {
      id: message.id,
      reference,
      method: message.method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
    });
    await this.#emit({
      kind: "approval.requested",
      observedAt: this.#now(),
      nativeSessionReference: params.threadId,
      nativeTurnReference: params.turnId,
      nativeItemReference: params.itemId,
      nativeApprovalReference: reference,
      approvalKind:
        message.method === "item/commandExecution/requestApproval"
          ? "commandExecution"
          : "fileChange",
      status: "pending",
    });
  }

  async #emit(observation: StructuredHarnessObservation): Promise<void> {
    await Promise.all(
      [...this.#observers].map(async (observer) => {
        await observer(observation);
      }),
    );
  }
}
