import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import type {
  CommandId,
  MessageId,
  RunnerId,
  SessionId,
  Sha256Digest,
  TraceId,
  WorkspaceId,
} from "@session/contracts";
import type { RunnerCommandFrame } from "@session/protocol-runner";
import { afterEach, describe, expect, test } from "vitest";

import {
  commandEffectFingerprint,
  RunnerBridgeStore,
  sha256,
} from "../src/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function command(
  overrides: Partial<RunnerCommandFrame> = {},
): RunnerCommandFrame {
  return {
    schema: "runner.protocol/command",
    schema_version: 1,
    message_id: "msg_store_command" as MessageId,
    idempotency_key: "cmd_store_command" as CommandId,
    workspace_id: "wsp_store" as WorkspaceId,
    runner_id: "run_store" as RunnerId,
    project_id: "prj_store" as RunnerCommandFrame["project_id"],
    worktree_id: "wkt_store" as RunnerCommandFrame["worktree_id"],
    session_id: "ses_store" as SessionId,
    turn_id: "trn_store" as RunnerCommandFrame["turn_id"],
    aggregate_revision: 1,
    capability_snapshot_digest: sha256("capability"),
    sequence: 0,
    lane: "control",
    sent_at: "2026-07-27T12:00:00.000Z" as RunnerCommandFrame["sent_at"],
    expires_at: "2026-07-27T12:05:00.000Z" as RunnerCommandFrame["expires_at"],
    trace_id: "trc_store_command" as TraceId,
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

describe("RunnerBridgeStore", () => {
  test("advances lane cursors monotonically and retains queued frames", () => {
    const store = new RunnerBridgeStore(":memory:");
    expect(store.inspectInbound("control", 0)).toBe("next");
    store.commitInbound("control", 0);
    expect(store.inspectInbound("control", 0)).toBe("duplicate");
    expect(store.inspectInbound("control", 2)).toBe("gap");
    expect(() => store.commitInbound("control", 2)).toThrow(
      "cannot skip or regress",
    );

    const frame = store.appendOutbound(
      "control",
      "2026-07-27T12:00:00.000Z",
      (sequence) =>
        ({
          schema: "runner.protocol/heartbeat",
          schema_version: 1,
          message_id: "msg_store_heartbeat",
          workspace_id: "wsp_store",
          runner_id: "run_store",
          sequence,
          lane: "control",
          sent_at: "2026-07-27T12:00:00.000Z",
          trace_id: "trc_store_heartbeat",
          payload: { session_lease: "lease_store_fixture" },
        }) as RunnerCommandFrame,
    );
    expect(frame.sequence).toBe(0);
    expect(store.pendingOutboundCount()).toBe(1);
    expect(store.acknowledgeOutbound("control", 1, "now")).toBe("invalid");
    expect(store.acknowledgeOutbound("control", 0, "now")).toBe("advanced");
    expect(store.acknowledgeOutbound("control", 0, "now")).toBe("duplicate");
    store.close();
  });

  test("deduplicates one effect and fails changed reuse closed", () => {
    const store = new RunnerBridgeStore(":memory:");
    const first = command();
    const fingerprint = commandEffectFingerprint(first);
    expect(store.acceptCommand(first, fingerprint, first.sent_at).kind).toBe(
      "accepted",
    );
    expect(store.acceptCommand(first, fingerprint, first.sent_at).kind).toBe(
      "duplicate",
    );
    expect(
      store.acceptCommand(first, "f".repeat(64) as Sha256Digest, first.sent_at)
        .kind,
    ).toBe("fingerprint_mismatch");

    store.finishCommand(
      first.idempotency_key,
      "completed",
      sha256("done"),
      first.sent_at,
    );
    expect(store.command(first.idempotency_key)?.status).toBe("completed");
    expect(() =>
      store.finishCommand(
        first.idempotency_key,
        "completed",
        sha256("again"),
        first.sent_at,
      ),
    ).toThrow("cannot transition");
    store.close();
  });

  test("survives restart and converts interrupted acceptance to unknown", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "runner-bridge-store-"));
    cleanup.push(directory);
    const path = resolve(directory, "bridge.sqlite");
    const firstStore = new RunnerBridgeStore(path);
    const accepted = command();
    firstStore.acceptCommand(
      accepted,
      commandEffectFingerprint(accepted),
      accepted.sent_at,
    );
    firstStore.close();

    const restarted = new RunnerBridgeStore(path);
    expect(
      restarted.recoverInterruptedCommands(
        sha256("restart"),
        "2026-07-27T12:01:00.000Z",
      ),
    ).toBe(1);
    expect(restarted.command(accepted.idempotency_key)).toMatchObject({
      status: "outcome_unknown",
      safeCode: "interrupted",
    });
    expect(restarted.effectOutcomes(1)[0]?.effect_fingerprint).toBe(
      commandEffectFingerprint(accepted),
    );
    restarted.close();
  });

  test("migrates v1 correlation state and enforces terminal transitions", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "runner-bridge-store-"));
    cleanup.push(directory);
    const path = resolve(directory, "bridge.sqlite");
    new RunnerBridgeStore(path).close();
    const prior = new Database(path);
    prior.exec(`
      DROP TABLE session_adoption;
      DROP TABLE observation_transition;
      DROP TABLE product_native_approval_binding;
      DROP TABLE product_native_item_binding;
      DROP TABLE product_native_turn_binding;
    `);
    prior.pragma("user_version = 1");
    prior.close();

    const store = new RunnerBridgeStore(path);
    store.putBinding({
      workspaceId: "wsp_store",
      runnerId: "run_store",
      projectId: "prj_store",
      sessionId: "ses_store",
      harnessProfileId: "hpf_store",
      nativeSessionReference: "native_store",
      capabilitySnapshotDigest: sha256("capability"),
      actuatorOwner: "product-managed",
      aggregateRevision: 1,
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
    store.putPendingTurn({
      sessionId: "ses_store",
      turnId: "trn_store",
      aggregateRevision: 1,
      state: "native_pending",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
    store.bindTurn(
      "trn_store",
      "native_turn_store",
      "2026-07-27T12:00:01.000Z",
    );
    store.putItem({
      sessionId: "ses_store",
      turnId: "trn_store",
      partId: "prt_store",
      nativeItemReference: "native_item_store",
      itemKind: "commandExecution",
      state: "running",
      createdAt: "2026-07-27T12:00:01.000Z",
      updatedAt: "2026-07-27T12:00:01.000Z",
    });
    expect(
      store.setItemState("prt_store", "completed", "2026-07-27T12:00:02.000Z"),
    ).toBe("advanced");
    expect(
      store.setItemState("prt_store", "failed", "2026-07-27T12:00:03.000Z"),
    ).toBe("invalid");
    expect(store.itemCount("completed")).toBe(1);
    store.close();
  });
});
