import { sha256 } from "./digests.js";
import type { RunnerBridgeStore } from "./store.js";

export interface RunnerBridgeStatus {
  readonly state: string;
  readonly protocolFamily: "runner.protocol/v1";
  readonly identityReference?: string;
  readonly bindingCount: number;
  readonly bindings: {
    readonly productManaged: number;
    readonly standaloneObserved: number;
  };
  readonly correlations: {
    readonly turns: number;
    readonly activeTurns: number;
    readonly items: number;
    readonly approvals: number;
    readonly pendingApprovals: number;
    readonly outcomeUnknownApprovals: number;
    readonly observations: number;
  };
  readonly adoptions: {
    readonly proposed: number;
    readonly claimed: number;
    readonly complete: number;
    readonly rejected: number;
    readonly blockedRecovery: number;
  };
  readonly capabilityCount: number;
  readonly cursors: {
    readonly inbound: Readonly<Record<"control" | "event" | "bulk", number>>;
    readonly acknowledgedOutbound: Readonly<
      Record<"control" | "event" | "bulk", number>
    >;
  };
  readonly pendingFrames: {
    readonly control: number;
    readonly event: number;
    readonly bulk: number;
  };
  readonly effects: {
    readonly accepted: number;
    readonly completed: number;
    readonly outcomeUnknown: number;
  };
  readonly lastErrorCode?: string;
}

export function runnerBridgeStatus(
  store: RunnerBridgeStore,
): RunnerBridgeStatus {
  const authority = store.authority();
  return {
    state: authority?.state ?? "disabled",
    protocolFamily: "runner.protocol/v1",
    ...(authority
      ? {
          identityReference: `sha256:${sha256(
            `${authority.workspaceId}\n${authority.runnerId}\n${authority.identityFingerprint}`,
          )}`,
        }
      : {}),
    bindingCount: store.bindingCount(),
    bindings: {
      productManaged: store.bindingCountByOwner("product-managed"),
      standaloneObserved: store.bindingCountByOwner("standalone-attention"),
    },
    correlations: {
      turns: store.turnCount(),
      activeTurns:
        store.turnCount("native_pending") + store.turnCount("running"),
      items: store.itemCount(),
      approvals: store.approvalCount(),
      pendingApprovals: store.approvalCount("pending"),
      outcomeUnknownApprovals: store.approvalCount("outcome_unknown"),
      observations: store.observationCount(),
    },
    adoptions: {
      proposed: store.adoptionCount("proposed"),
      claimed: store.adoptionCount("standalone_claimed"),
      complete: store.adoptionCount("complete"),
      rejected: store.adoptionCount("rejected"),
      blockedRecovery: store.adoptionCount("blocked_recovery"),
    },
    capabilityCount: authority?.capabilities.length ?? 0,
    cursors: {
      inbound: store.cursors("inbound"),
      acknowledgedOutbound: store.cursors("outbound_ack"),
    },
    pendingFrames: {
      control: store.pendingOutboundCount("control"),
      event: store.pendingOutboundCount("event"),
      bulk: store.pendingOutboundCount("bulk"),
    },
    effects: {
      accepted: store.outcomeCount("accepted"),
      completed: store.outcomeCount("completed"),
      outcomeUnknown: store.outcomeCount("outcome_unknown"),
    },
    ...(authority?.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: authority.lastErrorCode }),
  };
}

export interface RunnerBridgeDoctorResult {
  readonly ok: boolean;
  readonly facts: readonly {
    readonly code: string;
    readonly status: "pass" | "warn" | "fail";
  }[];
}

export function diagnoseRunnerBridge(
  store: RunnerBridgeStore,
): RunnerBridgeDoctorResult {
  const status = runnerBridgeStatus(store);
  const facts: Array<{
    readonly code: string;
    readonly status: "pass" | "warn" | "fail";
  }> = [
    {
      code: "runner_protocol_v1_pinned",
      status: "pass",
    },
    {
      code: "runner_authority",
      status:
        status.state === "revoked"
          ? "fail"
          : status.state === "disabled"
            ? "warn"
            : "pass",
    },
    {
      code: "runner_effect_outcome",
      status: status.effects.outcomeUnknown > 0 ? "warn" : "pass",
    },
    {
      code: "runner_approval_outcome",
      status: status.correlations.outcomeUnknownApprovals > 0 ? "warn" : "pass",
    },
    {
      code: "runner_adoption_recovery",
      status: status.adoptions.blockedRecovery > 0 ? "fail" : "pass",
    },
  ];
  return {
    ok: facts.every(({ status: factStatus }) => factStatus !== "fail"),
    facts,
  };
}
