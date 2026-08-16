import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { RelayService } from "@agent-relay/core";
import {
  AgentAttentionEventV1Schema,
  makeProjectRef,
} from "@agent-relay/protocol";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

export interface WebDemoSeed {
  runId: string;
  eventIds: string[];
  sessionIds: string[];
  textRequestId: string;
}

function demoProject(name: string, branch: string) {
  return {
    ...makeProjectRef(`/synthetic-agent-relay-demo/${name}`),
    branch,
  };
}

export function makeWebDemoEvents(
  options: {
    now?: Date;
    runId?: string;
  } = {},
): {
  events: AgentAttentionEventV1[];
  seed: WebDemoSeed;
} {
  const now = options.now ?? new Date();
  const runId = options.runId ?? randomUUID().replaceAll("-", "").slice(0, 12);
  if (!/^[a-z0-9]{8,24}$/i.test(runId)) {
    throw new Error("web demo run ID must be 8-24 ASCII letters or digits");
  }
  const occurredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  const startedAt = new Date(now.getTime() - 90_000).toISOString();
  const machineId = `machine_demo_${runId}`;
  const capabilities = {
    inlineContinue: true,
    lateResume: true,
    activeSteer: false,
    permissionDecision: true,
  };
  const textRequestId = `request_demo_text_${runId}`;
  const sessionIds = [
    `session_demo_running_${runId}`,
    `session_demo_waiting_${runId}`,
    `session_demo_select_${runId}`,
    `session_demo_questions_${runId}`,
    `session_demo_crashed_${runId}`,
  ];
  const candidates: AgentAttentionEventV1[] = [
    {
      schema: "agent-attention.v1",
      eventId: `evt_demo_running_${runId}`,
      occurredAt,
      sequence: 1,
      machineId,
      bridgeSessionId: `bridge_demo_running_${runId}`,
      harness: "codex",
      surface: "cli",
      harnessVersion: "synthetic-demo",
      sessionId: sessionIds[0] ?? "",
      turnId: `turn_demo_running_${runId}`,
      project: demoProject("payments-api", "demo/checkout-guard"),
      type: "turn.started",
      summary: "Synthetic session is implementing a checkout guard",
      capabilities,
    },
    {
      schema: "agent-attention.v1",
      eventId: `evt_demo_waiting_${runId}`,
      occurredAt,
      sequence: 2,
      machineId,
      bridgeSessionId: `bridge_demo_waiting_${runId}`,
      harness: "claude",
      surface: "cli",
      harnessVersion: "synthetic-demo",
      sessionId: sessionIds[1] ?? "",
      turnId: `turn_demo_waiting_${runId}`,
      project: demoProject("operator-console", "demo/attention-queue"),
      type: "input.required",
      summary: "Synthetic session needs a bounded operator response",
      request: {
        correlationId: textRequestId,
        kind: "input",
        question: "What synthetic task should this demo session take next?",
        expiresAt,
      },
      capabilities,
    },
    {
      schema: "agent-attention.v1",
      eventId: `evt_demo_select_${runId}`,
      occurredAt,
      sequence: 3,
      machineId,
      bridgeSessionId: `bridge_demo_select_${runId}`,
      harness: "codex",
      surface: "app-server",
      harnessVersion: "synthetic-demo",
      sessionId: sessionIds[2] ?? "",
      turnId: `turn_demo_select_${runId}`,
      project: demoProject("release-worker", "demo/release-policy"),
      type: "input.required",
      summary: "Synthetic release decision is waiting",
      request: {
        correlationId: `request_demo_select_${runId}`,
        kind: "select",
        question: "Choose a synthetic release lane",
        options: [
          {
            id: `option_demo_canary_${runId}`,
            label: "Canary",
          },
          {
            id: `option_demo_hold_${runId}`,
            label: "Hold",
          },
        ],
        expiresAt,
      },
      capabilities: { ...capabilities, activeSteer: true },
    },
    {
      schema: "agent-attention.v1",
      eventId: `evt_demo_questions_${runId}`,
      occurredAt,
      sequence: 4,
      machineId,
      bridgeSessionId: `bridge_demo_questions_${runId}`,
      harness: "claude",
      surface: "cli",
      harnessVersion: "synthetic-demo",
      sessionId: sessionIds[3] ?? "",
      turnId: `turn_demo_questions_${runId}`,
      project: demoProject("release-worker", "demo/release-policy"),
      type: "input.required",
      summary: "Synthetic questionnaire is waiting",
      request: {
        correlationId: `request_demo_questions_${runId}`,
        kind: "question-set",
        question: "Synthetic release questionnaire",
        interaction: {
          schema: "agent-interaction-request.v1",
          requestId: `request_demo_questions_${runId}`,
          createdAt: occurredAt,
          expiresAt,
          title: "Synthetic release questionnaire",
          lifecycle: "pending",
          questions: [
            {
              questionId: `question_demo_confirm_${runId}`,
              kind: "confirm",
              prompt: "Proceed with the synthetic release?",
              confirm: {
                optionId: `option_demo_proceed_${runId}`,
                label: "Proceed",
              },
              decline: {
                optionId: `option_demo_stop_${runId}`,
                label: "Stop",
              },
            },
            {
              questionId: `question_demo_note_${runId}`,
              kind: "free-text",
              prompt: "Add a synthetic release note",
              minLength: 3,
              maxLength: 80,
              multiline: false,
            },
          ],
          fallback: {
            preferredMode: "buttons",
            alternativeModes: ["direct-text"],
            whenUnavailable: "use-alternative",
          },
        },
        expiresAt,
      },
      capabilities,
    },
    {
      schema: "agent-attention.v1",
      eventId: `evt_demo_crashed_${runId}`,
      occurredAt,
      sequence: 5,
      machineId,
      bridgeSessionId: `bridge_demo_crashed_${runId}`,
      harness: "cursor",
      surface: "cli",
      harnessVersion: "synthetic-demo",
      sessionId: sessionIds[4] ?? "",
      project: demoProject("indexer", "demo/recovery"),
      type: "process.exited",
      summary: "Synthetic supervised child exited unexpectedly",
      failure: {
        class: "exit-code",
        message: "Synthetic process returned exit code 2",
      },
      processExit: {
        source: "owned-child",
        supervisorId: `supervisor_demo_${runId}`,
        startedAt,
        exitedAt: occurredAt,
        exitCode: 2,
        classification: "nonzero-exit",
        expected: false,
      },
      capabilities,
    },
  ];
  const events = candidates.map((event) =>
    AgentAttentionEventV1Schema.parse(event),
  );
  return {
    events,
    seed: {
      runId,
      eventIds: events.map(({ eventId }) => eventId),
      sessionIds,
      textRequestId,
    },
  };
}

export async function seedWebDemo(
  service: RelayService,
  options: { now?: Date; runId?: string } = {},
): Promise<WebDemoSeed> {
  const { events, seed } = makeWebDemoEvents(options);
  for (const event of events) {
    service.ingest(event);
  }
  await service.drain(events.length);
  return seed;
}

export async function resetWebDemoDatabase(
  databasePath: string,
): Promise<void> {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      await unlink(path);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}
