import type {
  CapabilityDescriptor,
  CommandId,
  MessageId,
  RunnerId,
  TraceId,
  WorkspaceId,
} from "@session/contracts";
import {
  decodeRunnerFrame,
  encodeRunnerFrame,
  type RunnerCommandFrame,
  type RunnerFrame,
} from "@session/protocol-runner";
import { beforeEach, describe, expect, test } from "vitest";

import {
  diagnoseRunnerBridge,
  FakeRunnerIdentityProof,
  FakeStructuredHarnessDriver,
  FixedBridgeClock,
  InMemoryRunnerBridgeTransport,
  RunnerBridge,
  RunnerBridgeStore,
  runnerBridgeStatus,
  sha256,
} from "../src/index.js";

const workspaceId = "wsp_bridge_fixture" as WorkspaceId;
const runnerId = "run_bridge_fixture" as RunnerId;
const capabilityDigest = sha256("bridge-capabilities");
const identityFingerprint = `sha256:${"a".repeat(64)}`;
const time = "2026-07-27T12:00:00.000Z";
const capabilities = [
  { name: "turn.cancel", version: 1, support: "native" },
  { name: "runner.diagnose", version: 1, support: "native" },
] as const satisfies readonly CapabilityDescriptor[];

let store: RunnerBridgeStore;
let transport: InMemoryRunnerBridgeTransport;
let clock: FixedBridgeClock;
let driver: FakeStructuredHarnessDriver;
let bridge: RunnerBridge;

function inbound(
  input: Omit<RunnerFrame, "workspace_id" | "runner_id">,
): RunnerFrame {
  return {
    ...input,
    workspace_id: workspaceId,
    runner_id: runnerId,
  } as RunnerFrame;
}

function encode(frame: RunnerFrame): string {
  return encodeRunnerFrame(frame);
}

function sentFrames(): RunnerFrame[] {
  return transport.sent.map((value) => {
    const decoded = decodeRunnerFrame(value);
    if (!decoded.ok) {
      throw new Error(decoded.error.code);
    }
    return decoded.value;
  });
}

async function handshake(): Promise<void> {
  await bridge.start();
  await transport.deliver(
    encode(
      inbound({
        schema: "runner.protocol/welcome",
        schema_version: 1,
        message_id: "msg_welcome_fixture",
        sequence: 0,
        lane: "control",
        sent_at: time,
        trace_id: "trc_welcome_fixture",
        payload: {
          selected_version: 1,
          session_lease: "lease_bridge_fixture",
          capability_ceiling: capabilities,
          heartbeat_interval_ms: 30_000,
          maximum_frame_bytes: 1_048_576,
          server_cursors: { control: 0, event: -1, bulk: -1 },
          clock_skew_tolerance_ms: 1_000,
        },
      } as unknown as Omit<RunnerFrame, "workspace_id" | "runner_id">),
    ),
  );
  await transport.deliver(
    encode(
      inbound({
        schema: "runner.protocol/reconcile_request",
        schema_version: 1,
        message_id: "msg_reconcile_request",
        sequence: 1,
        lane: "control",
        sent_at: time,
        trace_id: "trc_reconcile_request",
        payload: {
          reconciliation_id: "reconcile_bridge_fixture",
          session_lease: "lease_bridge_fixture",
          remote_cursors: { control: 0, event: -1, bulk: -1 },
          remote_command_cursor: -1,
          maximum_effect_outcomes: 64,
        },
      } as unknown as Omit<RunnerFrame, "workspace_id" | "runner_id">),
    ),
  );
  await transport.deliver(
    encode(
      inbound({
        schema: "runner.protocol/reconcile_complete",
        schema_version: 1,
        message_id: "msg_reconcile_complete",
        sequence: 2,
        lane: "control",
        sent_at: time,
        trace_id: "trc_reconcile_complete",
        payload: {
          reconciliation_id: "reconcile_bridge_fixture",
          session_lease: "lease_bridge_fixture",
          accepted_cursors: { control: 1, event: -1, bulk: -1 },
          accepted_command_cursor: -1,
        },
      } as unknown as Omit<RunnerFrame, "workspace_id" | "runner_id">),
    ),
  );
  expect(bridge.lifecycleState()).toBe("ready");
}

function cancelCommand(
  sequence: number,
  overrides: Partial<RunnerCommandFrame> = {},
): RunnerCommandFrame {
  return {
    schema: "runner.protocol/command",
    schema_version: 1,
    message_id: `msg_cancel_${String(sequence)}` as MessageId,
    idempotency_key: "cmd_cancel_fixture" as CommandId,
    workspace_id: workspaceId,
    runner_id: runnerId,
    project_id: "prj_bridge_fixture" as RunnerCommandFrame["project_id"],
    worktree_id: "wkt_bridge_fixture" as RunnerCommandFrame["worktree_id"],
    session_id: "ses_bridge_fixture" as RunnerCommandFrame["session_id"],
    turn_id: "trn_bridge_fixture" as RunnerCommandFrame["turn_id"],
    aggregate_revision: 4,
    capability_snapshot_digest: capabilityDigest,
    sequence,
    lane: "control",
    sent_at: time as RunnerCommandFrame["sent_at"],
    expires_at: "2026-07-27T12:05:00.000Z" as RunnerCommandFrame["expires_at"],
    trace_id: `trc_cancel_${String(sequence)}` as TraceId,
    payload: {
      command: "turn.cancel",
      required_capability: "turn.cancel",
      body: {
        schema: "runner.command/turn.cancel",
        schema_version: 1,
        reason_code: "user_requested",
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  store = new RunnerBridgeStore(":memory:");
  transport = new InMemoryRunnerBridgeTransport();
  clock = new FixedBridgeClock(time as RunnerCommandFrame["sent_at"]);
  driver = new FakeStructuredHarnessDriver({ capabilities });
  bridge = new RunnerBridge({
    store,
    transport,
    identityProof: new FakeRunnerIdentityProof(),
    driver,
    clock,
    configuration: {
      workspaceId,
      runnerId,
      identityFingerprint,
      revocationEpoch: 0,
      capabilitySnapshotDigest: capabilityDigest,
      capabilities,
      authorizedProjectIds: new Set(["prj_bridge_fixture"]),
    },
  });
  bridge.registerProductManagedBinding({
    workspaceId,
    runnerId,
    projectId: "prj_bridge_fixture",
    worktreeId: "wkt_bridge_fixture",
    sessionId: "ses_bridge_fixture",
    harnessProfileId: driver.profileId,
    nativeSessionReference: "native-private-reference",
    capabilitySnapshotDigest: capabilityDigest,
    actuatorOwner: "product-managed",
    aggregateRevision: 4,
    createdAt: time,
    updatedAt: time,
  });
});

describe("RunnerBridge", () => {
  test("reconciles before executing and deduplicates one semantic effect", async () => {
    await handshake();
    await transport.deliver(encode(cancelCommand(3)));
    expect(driver.callsByCommand.get("turn.cancel")).toBe(1);
    expect(store.command("cmd_cancel_fixture")).toMatchObject({
      status: "completed",
    });
    expect(driver.calls[0]?.nativeSessionReference).toBe(
      "native-private-reference",
    );

    await transport.deliver(
      encode(
        cancelCommand(4, {
          message_id: "msg_cancel_duplicate" as MessageId,
          trace_id: "trc_cancel_duplicate" as TraceId,
        }),
      ),
    );
    expect(driver.callsByCommand.get("turn.cancel")).toBe(1);

    await transport.deliver(
      encode(
        cancelCommand(5, {
          message_id: "msg_cancel_changed" as MessageId,
          trace_id: "trc_cancel_changed" as TraceId,
          payload: {
            command: "turn.cancel",
            required_capability: "turn.cancel",
            body: {
              schema: "runner.command/turn.cancel",
              schema_version: 1,
              reason_code: "changed",
            },
          },
        }),
      ),
    );
    expect(driver.callsByCommand.get("turn.cancel")).toBe(1);
    expect(
      sentFrames().some(
        (frame) =>
          frame.schema === "runner.protocol/nack" &&
          frame.payload.error.code === "duplicate_effect",
      ),
    ).toBe(true);
  });

  test("rejects stale, expired, and cross-runner commands before the driver", async () => {
    await handshake();
    await transport.deliver(
      encode(
        cancelCommand(3, {
          aggregate_revision: 3,
          message_id: "msg_cancel_stale" as MessageId,
        }),
      ),
    );
    clock.set("2026-07-27T12:06:00.000Z" as RunnerCommandFrame["sent_at"]);
    await transport.deliver(
      encode(
        cancelCommand(4, {
          message_id: "msg_cancel_expired" as MessageId,
          sent_at: "2026-07-27T12:04:00.000Z" as RunnerCommandFrame["sent_at"],
        }),
      ),
    );
    expect(driver.calls).toHaveLength(0);
    expect(
      sentFrames()
        .filter((frame) => frame.schema === "runner.protocol/nack")
        .map((frame) => frame.payload.error.code),
    ).toEqual(expect.arrayContaining(["invalid_binding", "expired"]));

    const crossRunner = cancelCommand(5, {
      runner_id: "run_other" as RunnerId,
      message_id: "msg_cancel_cross_runner" as MessageId,
    });
    await transport.deliver(encode(crossRunner));
    expect(driver.calls).toHaveLength(0);
  });

  test("persists ambiguous outcomes without retrying the driver", async () => {
    driver.setError(new Error("native connection disappeared"));
    await handshake();
    await transport.deliver(encode(cancelCommand(3)));
    expect(store.command("cmd_cancel_fixture")).toMatchObject({
      status: "outcome_unknown",
      safeCode: "driver_error",
    });
    await transport.deliver(
      encode(
        cancelCommand(4, {
          message_id: "msg_cancel_unknown_duplicate" as MessageId,
        }),
      ),
    );
    expect(driver.callsByCommand.get("turn.cancel")).toBe(1);
  });

  test("retains paused event frames and redacts local references from status", async () => {
    await handshake();
    await transport.deliver(
      encode(
        inbound({
          schema: "runner.protocol/flow_control",
          schema_version: 1,
          message_id: "msg_flow_pause",
          sequence: 3,
          lane: "control",
          sent_at: time,
          trace_id: "trc_flow_pause",
          payload: {
            affected_lane: "event",
            state: "paused",
            reason: "receiver_busy",
          },
        } as unknown as Omit<RunnerFrame, "workspace_id" | "runner_id">),
      ),
    );
    driver.setError(new Error("synthetic ambiguous outcome"));
    await transport.deliver(encode(cancelCommand(4)));
    expect(store.pendingOutboundCount("event")).toBe(2);
    expect(
      sentFrames().filter(
        (frame) => frame.schema === "runner.protocol/event_batch",
      ),
    ).toHaveLength(0);

    const statusText = JSON.stringify(runnerBridgeStatus(store));
    expect(statusText).not.toContain("native-private-reference");
    expect(statusText).not.toContain(identityFingerprint);
    expect(diagnoseRunnerBridge(store).ok).toBe(true);
  });

  test("persists matching revocation before closing and refuses restart", async () => {
    await handshake();
    await transport.deliver(
      encode(
        inbound({
          schema: "runner.protocol/runner_revoked",
          schema_version: 1,
          message_id: "msg_revoke_bridge",
          sequence: 3,
          lane: "control",
          sent_at: time,
          trace_id: "trc_revoke_bridge",
          payload: {
            identity_fingerprint: identityFingerprint,
            revocation_epoch: 1,
            revoked_at: time,
          },
        } as unknown as Omit<RunnerFrame, "workspace_id" | "runner_id">),
      ),
    );
    expect(store.authority()).toMatchObject({
      state: "revoked",
      revocationEpoch: 1,
    });
    expect(transport.connected).toBe(false);
    await expect(bridge.start()).rejects.toThrow(
      "Revoked runner authority cannot reconnect",
    );
  });

  test("keeps a failed outbound frame durable for later reconciliation", async () => {
    transport.failNextSend = true;
    await bridge.start();
    expect(bridge.lifecycleState()).toBe("disconnected");
    expect(store.pendingOutboundCount("control")).toBe(1);
  });
});
