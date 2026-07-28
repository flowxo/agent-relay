import type { IsoTimestamp } from "@session/contracts";
import type {
  RunnerCommandFrame,
  RunnerCommandName,
} from "@session/protocol-runner";
import {
  sha256,
  type StructuredHarnessCommandContext,
  type StructuredHarnessObservation,
} from "@agent-relay/runner-bridge";
import { beforeEach, describe, expect, test } from "vitest";

import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerDriver,
  type CodexAppServerInbound,
  type CodexAppServerMessageHandler,
  type CodexAppServerRpc,
  type CodexAppServerRpcStatus,
  type CodexCommandMaterialPort,
  type CodexRequestId,
} from "../src/index.js";

const now = "2026-07-27T12:00:00.000Z" as IsoTimestamp;
const digest = "a".repeat(64);
const threadId = "00000000-0000-7000-8000-000000000001";
const firstTurnId = "00000000-0000-7000-8000-000000000002";
const followUpTurnId = "00000000-0000-7000-8000-000000000003";

const requiredCapability: Record<RunnerCommandName, string> = {
  "approval.resolve": "approval.resolve",
  "artifact.describe": "artifact.describe",
  "artifact.grant": "artifact.grant",
  "artifact.revoke": "artifact.revoke",
  "project.inspect": "project.inspect",
  "project.register": "project.register",
  "project.revoke": "project.revoke",
  "runner.diagnose": "runner.diagnose",
  "session.pause": "session.lifecycle",
  "session.resume": "session.lifecycle",
  "session.start": "session.lifecycle",
  "turn.cancel": "turn.cancel",
  "turn.follow_up": "turn.follow_up",
  "turn.start": "turn.start",
  "turn.steer": "turn.steer.active",
};

function approvalBody(decision: "approve" | "deny") {
  return {
    schema: "runner.command/approval.resolve",
    schema_version: 1,
    approval_id: "apr_fixture_approval",
    binding: {
      workspace_id: "wsp_fixture_workspace",
      account_id: "acct_fixture_account",
      actor_id: "act_fixture_actor",
      runner_id: "run_fixture_runner",
      project_id: "prj_fixture_project",
      session_id: "ses_fixture_session",
      turn_id: "trn_fixture_turn",
      tool_call_id: "tool_fixture_tool_call",
      harness_profile_id: "hpf_codex_app_server_0_145_0",
      capability_snapshot_digest: digest,
      action: {
        schema: "actuator.action/v1",
        kind: "process.execute",
        target_digest: "b".repeat(64),
        parameters_digest: "c".repeat(64),
        summary: "Run a fixture command",
      },
      action_digest: "d".repeat(64),
      policy_id: "pol_fixture_policy",
      policy_version: 1,
      issued_at: "2026-07-27T11:59:00.000Z",
      expires_at: "2026-07-27T12:05:00.000Z",
      resolution_nonce_digest: "e".repeat(64),
    },
    decision,
    resolved_at: now,
    resolved_by_actor_id: "act_fixture_actor",
    resolution_nonce_digest: "e".repeat(64),
  };
}

function context(
  command: RunnerCommandName,
  input: {
    readonly nativeSessionReference?: string;
    readonly nativeTurnReference?: string;
    readonly nativeApprovalReference?: string;
    readonly body?: Readonly<Record<string, unknown>>;
  } = {},
): StructuredHarnessCommandContext {
  const body =
    input.body ??
    ({
      schema: `runner.command/${command}`,
      schema_version: 1,
      ...(command.startsWith("turn.") ? { instruction_digest: digest } : {}),
    } satisfies Readonly<Record<string, unknown>>);
  return {
    idempotencyKey: `cmd_fixture_${command.replaceAll(".", "_")}`,
    effectFingerprint: sha256(`fixture:${command}`),
    ...(input.nativeSessionReference === undefined
      ? {}
      : { nativeSessionReference: input.nativeSessionReference }),
    ...(input.nativeTurnReference === undefined
      ? {}
      : { nativeTurnReference: input.nativeTurnReference }),
    ...(input.nativeApprovalReference === undefined
      ? {}
      : { nativeApprovalReference: input.nativeApprovalReference }),
    command: {
      schema: "runner.protocol/command",
      schema_version: 1,
      message_id: `msg_fixture_${command.replaceAll(".", "_")}`,
      idempotency_key: `cmd_fixture_${command.replaceAll(".", "_")}`,
      workspace_id: "wsp_fixture_workspace",
      runner_id: "run_fixture_runner",
      project_id: "prj_fixture_project",
      session_id: "ses_fixture_session",
      turn_id: "trn_fixture_turn",
      aggregate_revision: 1,
      capability_snapshot_digest: digest,
      sequence: 1,
      lane: "control",
      sent_at: now,
      expires_at: "2026-07-27T12:05:00.000Z",
      trace_id: `trc_fixture_${command.replaceAll(".", "_")}`,
      payload: {
        command,
        required_capability: requiredCapability[command],
        body,
      },
    } as RunnerCommandFrame,
  };
}

class FakeRpc implements CodexAppServerRpc {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: CodexRequestId; result: unknown }> = [];
  readonly rejections: Array<{ id: CodexRequestId; safeCode: string }> = [];
  readonly subscribers = new Set<CodexAppServerMessageHandler>();
  readonly queued = new Map<string, unknown[]>();
  starts = 0;
  stops = 0;
  state: CodexAppServerRpcStatus["state"] = "stopped";

  start(): Promise<void> {
    this.starts += 1;
    this.state = "ready";
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.state = "stopped";
    return Promise.resolve();
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const queue = this.queued.get(method);
    if (!queue || queue.length === 0) {
      return Promise.reject(new Error(`No fake response for ${method}`));
    }
    return Promise.resolve(queue.shift());
  }

  respond(id: CodexRequestId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
    return Promise.resolve();
  }

  reject(id: CodexRequestId, safeCode: string): Promise<void> {
    this.rejections.push({ id, safeCode });
    return Promise.resolve();
  }

  subscribe(handler: CodexAppServerMessageHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  status(): CodexAppServerRpcStatus {
    return {
      state: this.state,
      configuredVersion: CODEX_APP_SERVER_VERSION,
      processOwned: this.state === "ready",
      pendingRequestCount: 0,
    };
  }

  queue(method: string, result: unknown): void {
    const queue = this.queued.get(method) ?? [];
    queue.push(result);
    this.queued.set(method, queue);
  }

  async emit(message: CodexAppServerInbound): Promise<void> {
    await Promise.all(
      [...this.subscribers].map(async (subscriber) => {
        await subscriber(message);
      }),
    );
  }
}

class FakeMaterial implements CodexCommandMaterialPort {
  returnedDigest = digest;

  resolveSession(): Promise<{
    cwd: string;
    approvalPolicy: "on-request";
    sandbox: "workspace-write";
  }> {
    return Promise.resolve({
      cwd: "/synthetic/project",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  }

  resolveTurn(
    _context: StructuredHarnessCommandContext,
    _instructionDigest: string,
  ) {
    return Promise.resolve({
      instructionDigest: this.returnedDigest,
      input: [
        {
          type: "text" as const,
          text: "Synthetic fixture instruction.",
          text_elements: [] as const,
        },
      ] as const,
    });
  }
}

let rpc: FakeRpc;
let material: FakeMaterial;
let driver: CodexAppServerDriver;
let observations: StructuredHarnessObservation[];

beforeEach(async () => {
  rpc = new FakeRpc();
  material = new FakeMaterial();
  driver = new CodexAppServerDriver({ rpc, material, now: () => now });
  observations = [];
  driver.subscribe((observation) => {
    observations.push(observation);
  });
  await driver.start();
});

describe("CodexAppServerDriver", () => {
  test("maps the verified structured lifecycle and approval path", async () => {
    rpc.queue("thread/start", { thread: { id: threadId } });
    await expect(
      driver.startSession(context("session.start")),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        nativeSessionReference: threadId,
      }),
    );
    expect(rpc.calls.at(-1)).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/synthetic/project",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });

    rpc.queue("turn/start", {
      turn: { id: firstTurnId, status: "inProgress" },
    });
    await expect(
      driver.startTurn(
        context("turn.start", { nativeSessionReference: threadId }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        nativeTurnReference: firstTurnId,
      }),
    );

    await rpc.emit({
      kind: "notification",
      method: "turn/started",
      params: {
        threadId,
        turn: { id: firstTurnId, status: "inProgress" },
      },
    });
    await rpc.emit({
      kind: "notification",
      method: "item/started",
      params: {
        threadId,
        turnId: firstTurnId,
        item: { id: "item_fixture_0001", type: "commandExecution" },
        startedAtMs: 1,
      },
    });
    await rpc.emit({
      kind: "request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: firstTurnId,
        itemId: "item_fixture_0001",
        startedAtMs: 1,
      },
    });
    const approval = observations.find(
      ({ kind }) => kind === "approval.requested",
    );
    expect(approval).toMatchObject({
      approvalKind: "commandExecution",
      nativeApprovalReference: "number:7",
    });
    await expect(
      driver.resolveApproval(
        context("approval.resolve", {
          nativeSessionReference: threadId,
          nativeTurnReference: firstTurnId,
          nativeApprovalReference: approval?.nativeApprovalReference,
          body: approvalBody("approve"),
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(rpc.responses).toEqual([{ id: 7, result: { decision: "accept" } }]);
    await rpc.emit({
      kind: "request",
      id: "file-approval-fixture",
      method: "item/fileChange/requestApproval",
      params: {
        threadId,
        turnId: firstTurnId,
        itemId: "item_fixture_0002",
        startedAtMs: 2,
      },
    });
    const fileApproval = observations.find(
      ({ nativeApprovalReference }) =>
        nativeApprovalReference === "string:file-approval-fixture",
    );
    await expect(
      driver.resolveApproval(
        context("approval.resolve", {
          nativeSessionReference: threadId,
          nativeTurnReference: firstTurnId,
          nativeApprovalReference: fileApproval?.nativeApprovalReference,
          body: approvalBody("deny"),
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(rpc.responses.at(-1)).toEqual({
      id: "file-approval-fixture",
      result: { decision: "decline" },
    });

    await rpc.emit({
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: firstTurnId, status: "completed" },
      },
    });
    rpc.queue("turn/start", {
      turn: { id: followUpTurnId, status: "inProgress" },
    });
    await expect(
      driver.followUpTurn(
        context("turn.follow_up", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      nativeTurnReference: followUpTurnId,
    });

    rpc.queue("turn/steer", { turnId: followUpTurnId });
    await expect(
      driver.steerTurn(
        context("turn.steer", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(rpc.calls.at(-1)).toMatchObject({
      method: "turn/steer",
      params: { threadId, expectedTurnId: followUpTurnId },
    });

    rpc.queue("turn/interrupt", {});
    await expect(
      driver.cancelTurn(
        context("turn.cancel", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(rpc.calls.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId, turnId: followUpTurnId },
    });

    rpc.queue("thread/resume", { thread: { id: threadId } });
    await expect(
      driver.resumeSession(
        context("session.resume", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({ status: "completed" });

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "turn.started" }),
        expect.objectContaining({
          kind: "item.started",
          itemKind: "commandExecution",
        }),
        expect.objectContaining({ kind: "approval.requested" }),
        expect.objectContaining({
          kind: "turn.completed",
          status: "completed",
        }),
        expect.objectContaining({ kind: "session.resumed" }),
      ]),
    );
  });

  test("fails stale material, absent turns, approvals, and unsupported methods", async () => {
    material.returnedDigest = "f".repeat(64);
    await expect(
      driver.startTurn(
        context("turn.start", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      safeCode: "native_turn_material_mismatch",
    });
    await expect(
      driver.steerTurn(
        context("turn.steer", { nativeSessionReference: threadId }),
      ),
    ).resolves.toMatchObject({
      safeCode: "native_active_turn_missing",
    });
    await expect(
      driver.resolveApproval(
        context("approval.resolve", {
          nativeSessionReference: threadId,
          nativeApprovalReference: "number:404",
          body: approvalBody("deny"),
        }),
      ),
    ).resolves.toMatchObject({
      safeCode: "native_approval_reference_mismatch",
    });
    await expect(driver.pauseSession()).resolves.toMatchObject({
      safeCode: "unsupported_native_operation",
    });
    expect(rpc.calls).toHaveLength(0);
  });

  test("publishes explicit owned-process exit without native content", async () => {
    await rpc.emit({
      kind: "request",
      id: 99,
      method: "item/permissions/requestApproval",
      params: {},
    });
    expect(rpc.rejections).toEqual([
      { id: 99, safeCode: "unsupported_server_request" },
    ]);
    await rpc.emit({
      kind: "notification",
      method: "error",
      params: {
        threadId,
        turnId: firstTurnId,
        willRetry: false,
        error: { message: "synthetic provider detail" },
      },
    });
    await rpc.emit({
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: firstTurnId, status: "failed" },
      },
    });
    await rpc.emit({
      kind: "process_exited",
      exitCode: 1,
      signal: null,
      intentional: false,
    });
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "native.error",
          safeCode: "unsupported_server_request",
        }),
        expect.objectContaining({
          kind: "native.error",
          status: "terminal",
          safeCode: "native_error_notification",
        }),
        expect.objectContaining({
          kind: "turn.completed",
          status: "failed",
        }),
      ]),
    );
    expect(observations.at(-1)).toEqual({
      kind: "process.exited",
      observedAt: now,
      status: "unexpected",
      safeCode: "native_process_exited",
    });
    expect(JSON.stringify(observations)).not.toContain(
      "Synthetic fixture instruction.",
    );
  });

  test("owns RPC lifecycle and clears correlation on stop", async () => {
    expect(rpc.starts).toBe(1);
    expect(driver.status().observerCount).toBe(1);
    await driver.stop();
    expect(rpc.stops).toBe(1);
    expect(driver.status()).toMatchObject({
      activeTurnCount: 0,
      pendingApprovalCount: 0,
    });
  });
});
