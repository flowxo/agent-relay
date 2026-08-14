import type { RelayService } from "@agent-relay/core";
import { makeProjectRef } from "@agent-relay/protocol";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

/**
 * Generated, redacted dashboard fixtures. Every identifier, path, and prompt is
 * obviously synthetic; nothing here comes from a real session, credential, or
 * machine.
 */
export interface DashboardSeed {
  runId: string;
  machineId: string;
  textRequestId: string;
  questionSetRequestId: string;
  selectRequestId: string;
  workingSessionId: string;
  failedSessionId: string;
  unknownSessionId: string;
  historySessionIds: string[];
  hostileLabel: string;
  projects: {
    duplicateOne: string;
    duplicateTwo: string;
    deepHistory: string;
    hostile: string;
  };
}

export const PRIVATE_TRANSCRIPT_SENTINEL =
  "SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL";
export const PRIVATE_BRANCH_SENTINEL = "feature/synthetic-private-branch";
export const PRIVATE_PATH_SENTINEL = "/synthetic-home/synthetic-operator";
export const HOSTILE_LABEL = '<img src=x onerror="window.__xss=1">';
export const HISTORY_SESSION_COUNT = 30;

const CAPABILITIES = {
  inlineContinue: true,
  lateResume: true,
  activeSteer: false,
  permissionDecision: true,
} as const;

function base(
  runId: string,
  index: number,
  overrides: Partial<AgentAttentionEventV1> & {
    sessionId: string;
    project: AgentAttentionEventV1["project"];
    type: AgentAttentionEventV1["type"];
  },
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `evt_dash_${runId}_${String(index).padStart(3, "0")}`,
    occurredAt: new Date().toISOString(),
    sequence: 1,
    machineId: `machine_dash_${runId}`,
    bridgeSessionId: `bridge_dash_${runId}_${String(index).padStart(3, "0")}`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "synthetic-dashboard",
    summary: "Synthetic bounded summary",
    capabilities: { ...CAPABILITIES },
    ...overrides,
  } as AgentAttentionEventV1;
}

export function makeDashboardEvents(runId: string): {
  events: AgentAttentionEventV1[];
  seed: DashboardSeed;
} {
  if (!/^[a-z0-9]{8,24}$/i.test(runId)) {
    throw new Error("dashboard fixture run ID must be 8-24 letters or digits");
  }
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const duplicateOne = makeProjectRef(
    `${PRIVATE_PATH_SENTINEL}/one/checkout-service`,
  );
  const duplicateTwo = makeProjectRef(
    `${PRIVATE_PATH_SENTINEL}/two/checkout-service`,
  );
  const deepHistory = makeProjectRef(
    `${PRIVATE_PATH_SENTINEL}/archive/release-worker`,
  );
  const hostile = {
    ...makeProjectRef(`${PRIVATE_PATH_SENTINEL}/hostile/label-probe`),
    displayName: HOSTILE_LABEL,
  };

  const textRequestId = `request_dash_text_${runId}`;
  const questionSetRequestId = `request_dash_set_${runId}`;
  const selectRequestId = `request_dash_select_${runId}`;
  const workingSessionId = `session_dash_working_${runId}`;
  const failedSessionId = `session_dash_failed_${runId}`;
  const unknownSessionId = `session_dash_unknown_${runId}`;
  const historySessionIds = Array.from(
    { length: HISTORY_SESSION_COUNT },
    (_, index) =>
      `session_dash_history_${String(index).padStart(2, "0")}_${runId}`,
  );

  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: questionSetRequestId,
    createdAt: new Date().toISOString(),
    expiresAt,
    title: "Synthetic release questionnaire",
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: `question_dash_confirm_${runId}`,
        kind: "confirm" as const,
        prompt: "Proceed with the synthetic release?",
        confirm: { optionId: `option_dash_yes_${runId}`, label: "Proceed" },
        decline: { optionId: `option_dash_no_${runId}`, label: "Stop" },
      },
      {
        questionId: `question_dash_note_${runId}`,
        kind: "free-text" as const,
        prompt: "Add a synthetic release note",
        minLength: 3,
        maxLength: 80,
        multiline: false,
      },
    ],
    fallback: {
      preferredMode: "web-handoff" as const,
      alternativeModes: [],
      whenUnavailable: "reject" as const,
    },
  };

  const events: AgentAttentionEventV1[] = [
    base(runId, 1, {
      sessionId: workingSessionId,
      project: { ...duplicateOne, branch: PRIVATE_BRANCH_SENTINEL },
      type: "turn.started",
      turnId: `turn_dash_working_${runId}`,
      lastAssistantMessage: PRIVATE_TRANSCRIPT_SENTINEL,
    }),
    base(runId, 2, {
      sessionId: `session_dash_text_${runId}`,
      project: { ...duplicateOne, branch: PRIVATE_BRANCH_SENTINEL },
      type: "input.required",
      turnId: `turn_dash_text_${runId}`,
      request: {
        correlationId: textRequestId,
        kind: "input",
        question: "Which synthetic lane should this run take?",
        expiresAt,
      },
    }),
    base(runId, 3, {
      sessionId: `session_dash_set_${runId}`,
      project: duplicateTwo,
      type: "input.required",
      turnId: `turn_dash_set_${runId}`,
      request: {
        correlationId: questionSetRequestId,
        kind: "question-set",
        question: interaction.title,
        interaction,
        expiresAt,
      },
    }),
    base(runId, 4, {
      sessionId: `session_dash_select_${runId}`,
      harness: "codex",
      surface: "app-server",
      project: duplicateTwo,
      type: "input.required",
      turnId: `turn_dash_select_${runId}`,
      request: {
        correlationId: selectRequestId,
        kind: "select",
        question: "Choose a synthetic release lane",
        options: [
          { id: `option_dash_canary_${runId}`, label: "Canary" },
          { id: `option_dash_hold_${runId}`, label: "Hold" },
        ],
        expiresAt,
      },
    }),
    base(runId, 5, {
      sessionId: failedSessionId,
      harness: "claude",
      project: hostile,
      type: "turn.failed",
      turnId: `turn_dash_failed_${runId}`,
      failure: {
        class: "turn-failure",
        message: "Synthetic turn failure for dashboard evidence",
      },
    }),
    base(runId, 6, {
      sessionId: unknownSessionId,
      harness: "cursor",
      project: deepHistory,
      type: "process.stale",
    }),
    base(runId, 7, {
      sessionId: `session_dash_idle_${runId}`,
      harness: "claude",
      project: deepHistory,
      type: "turn.stopped",
      turnId: `turn_dash_idle_${runId}`,
    }),
    ...historySessionIds.map((sessionId, index) =>
      base(runId, 20 + index, {
        sessionId,
        surface: "app-server",
        project: deepHistory,
        type: "session.ended",
      }),
    ),
  ];

  return {
    events,
    seed: {
      runId,
      machineId: `machine_dash_${runId}`,
      textRequestId,
      questionSetRequestId,
      selectRequestId,
      workingSessionId,
      failedSessionId,
      unknownSessionId,
      historySessionIds,
      hostileLabel: HOSTILE_LABEL,
      projects: {
        duplicateOne: duplicateOne.cwdHash,
        duplicateTwo: duplicateTwo.cwdHash,
        deepHistory: deepHistory.cwdHash,
        hostile: hostile.cwdHash,
      },
    },
  };
}

export async function seedDashboard(
  service: RelayService,
  runId: string,
): Promise<DashboardSeed> {
  const { events, seed } = makeDashboardEvents(runId);
  for (const event of events) {
    service.ingest(event);
  }
  await service.drain(events.length);
  return seed;
}

/** One additional synthetic session, used to prove live change handling. */
export async function seedExtraSession(
  service: RelayService,
  runId: string,
  suffix: string,
): Promise<string> {
  const sessionId = `session_dash_extra_${suffix}_${runId}`;
  service.ingest(
    base(runId, 900, {
      eventId: `evt_dash_extra_${suffix}_${runId}`,
      bridgeSessionId: `bridge_dash_extra_${suffix}_${runId}`,
      sessionId,
      project: makeProjectRef(`${PRIVATE_PATH_SENTINEL}/one/checkout-service`),
      type: "turn.started",
      turnId: `turn_dash_extra_${suffix}_${runId}`,
    } as Partial<AgentAttentionEventV1> & {
      sessionId: string;
      project: AgentAttentionEventV1["project"];
      type: AgentAttentionEventV1["type"];
    }),
  );
  await service.drain(1);
  return sessionId;
}
