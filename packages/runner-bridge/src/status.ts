import { sha256 } from "./digests.js";
import type { RunnerBridgeStore } from "./store.js";

export interface RunnerBridgeStatus {
  readonly state: string;
  readonly protocolFamily: "runner.protocol/v1";
  readonly identityReference?: string;
  readonly bindingCount: number;
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
  ];
  return {
    ok: facts.every(({ status: factStatus }) => factStatus !== "fail"),
    facts,
  };
}
