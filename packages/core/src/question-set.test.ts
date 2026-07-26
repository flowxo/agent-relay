import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import {
  makeProjectRef,
  validateInteractionAnswer,
} from "@agent-relay/protocol";

import type { FakeDelivery } from "./fake-transport.js";
import { FakeTelegramTransport } from "./fake-transport.js";
import { TelegramReplyRouter } from "./reply-router.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { questionSetCallbackData } from "./telegram-question-set.js";

const baseTime = "2026-07-24T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function questionSetEvent(
  correlationId: string,
  sessionId: string,
  sequence = 1,
): AgentAttentionEventV1 {
  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: correlationId,
    createdAt: baseTime,
    expiresAt: "2026-07-24T12:05:00.000Z",
    title: "Release configuration",
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: "question_confirm_0001",
        kind: "confirm" as const,
        prompt: "Proceed with this release?",
        confirm: { optionId: "confirm_proceed_0001", label: "Proceed" },
        decline: { optionId: "confirm_stop_000001", label: "Stop" },
      },
      {
        questionId: "question_units_000001",
        kind: "multi-select" as const,
        prompt: "Which units should run?",
        options: [
          { optionId: "unit_core_00000001", label: "Core" },
          { optionId: "unit_ui_0000000001", label: "UI" },
          { optionId: "unit_docs_00000001", label: "Docs" },
        ],
        minSelections: 1,
        maxSelections: 2,
      },
      {
        questionId: "question_mode_0000001",
        kind: "single-select" as const,
        prompt: "Choose a rollout mode",
        options: [
          { optionId: "mode_fast_00000001", label: "Fast" },
          { optionId: "mode_safe_00000001", label: "Safe" },
        ],
      },
    ],
    fallback: {
      preferredMode: "buttons" as const,
      alternativeModes: ["web-handoff" as const],
      whenUnavailable: "use-alternative" as const,
    },
  };
  return {
    schema: "agent-attention.v1",
    eventId: `evt_${correlationId}`,
    occurredAt: baseTime,
    sequence,
    machineId: "machine_wizard_12345678",
    bridgeSessionId: "bridge_wizard_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId,
    turnId: `turn_wizard_${String(sequence).padStart(8, "0")}`,
    project: makeProjectRef(`/workspace/${sessionId}`),
    type: "input.required",
    summary: "Answer the release questions",
    request: {
      correlationId,
      kind: "question-set",
      question: interaction.title,
      interaction,
      expiresAt: interaction.expiresAt,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

class InspectingTelegramTransport extends FakeTelegramTransport {
  public beforeAcknowledgement: ((text: string) => void) | undefined;

  public override async acknowledgeCallback(
    callbackId: string,
    text: string,
  ): Promise<void> {
    this.beforeAcknowledgement?.(text);
    await super.acknowledgeCallback(callbackId, text);
  }
}

function runtime(
  store = new RelayStore(),
  transport = new InspectingTelegramTransport(),
  now: () => Date = () => new Date(baseTime),
) {
  return {
    store,
    transport,
    service: new RelayService(store, transport, { now }),
    router: new TelegramReplyRouter(store, transport, {
      operatorUserId: 7001,
      chatId: 9001,
      now,
    }),
  };
}

function callback(delivery: FakeDelivery, updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback_${String(updateId)}`,
      from: { id: 7001 },
      data,
      message: {
        message_id: Number(delivery.receipt.messageId),
        message_thread_id: Number(delivery.context.topicId),
        chat: { id: 9001 },
      },
    },
  };
}

function currentControls(testRuntime: ReturnType<typeof runtime>) {
  const edited =
    testRuntime.transport.deliveryMessageEdits.at(-1)?.message.questionSet;
  return edited ?? testRuntime.transport.deliveries[0]?.message.questionSet;
}

function optionToken(
  controls: NonNullable<ReturnType<typeof currentControls>>,
  label: string,
): string {
  const option = controls.options.find(
    (candidate) => candidate.label === label,
  );
  if (option === undefined) {
    throw new Error(`missing option ${label}`);
  }
  return option.token;
}

describe("durable ordered Telegram question sets", () => {
  it("navigates, reviews, edits, and submits one ordered answer atomically", async () => {
    const testRuntime = runtime();
    const input = questionSetEvent(
      "correlation_wizard_submit",
      "session_wizard_submit",
    );
    testRuntime.service.ingest(input);
    await expect(testRuntime.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    const delivery = testRuntime.transport.deliveries[0]!;
    let controls = currentControls(testRuntime)!;
    expect(controls).toMatchObject({
      questionId: "question_confirm_0001",
      kind: "confirm",
      position: 1,
      total: 3,
    });
    expect(controls.backToken).toBeUndefined();
    expect(controls.nextToken).toMatch(/^wizard_next_/);

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          301,
          questionSetCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 301 });
    expect(
      testRuntime.store.getPendingRequest("correlation_wizard_submit")?.state,
    ).toBe("open");

    testRuntime.transport.beforeAcknowledgement = () => {
      expect(
        testRuntime.store.getQuestionSetDraft("correlation_wizard_submit")
          ?.answers,
      ).toEqual([
        {
          questionId: "question_confirm_0001",
          kind: "confirm",
          optionId: "confirm_proceed_0001",
        },
      ]);
    };
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          302,
          questionSetCallbackData("choose", optionToken(controls, "Proceed")),
        ),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 302 });

    const firstNextToken = controls.nextToken!;
    testRuntime.transport.beforeAcknowledgement = undefined;
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          303,
          questionSetCallbackData("next", firstNextToken),
        ),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 303 });
    controls = currentControls(testRuntime)!;
    expect(controls).toMatchObject({
      questionId: "question_units_000001",
      kind: "multi-select",
      position: 2,
    });

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          304,
          questionSetCallbackData("next", firstNextToken),
        ),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 304 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_submit")
        ?.currentIndex,
    ).toBe(1);

    for (const [index, label] of ["Core", "UI"].entries()) {
      expect(
        await testRuntime.router.handle(
          callback(
            delivery,
            305 + index,
            questionSetCallbackData(
              "select",
              optionToken(currentControls(testRuntime)!, label),
            ),
          ),
        ),
      ).toMatchObject({ outcome: "draft-updated" });
    }
    controls = currentControls(testRuntime)!;
    expect(
      controls.options
        .filter((option) => option.selected)
        .map((option) => option.label),
    ).toEqual(["Core", "UI"]);

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          307,
          questionSetCallbackData("back", controls.backToken!),
        ),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 307 });
    controls = currentControls(testRuntime)!;
    expect(controls.position).toBe(1);
    expect(
      controls.options.find((option) => option.label === "Proceed")?.selected,
    ).toBe(true);
    await testRuntime.router.handle(
      callback(
        delivery,
        308,
        questionSetCallbackData("choose", optionToken(controls, "Stop")),
      ),
    );
    controls = currentControls(testRuntime)!;
    await testRuntime.router.handle(
      callback(
        delivery,
        309,
        questionSetCallbackData("next", controls.nextToken!),
      ),
    );
    controls = currentControls(testRuntime)!;
    expect(
      controls.options
        .filter((option) => option.selected)
        .map((option) => option.label),
    ).toEqual(["Core", "UI"]);
    await testRuntime.router.handle(
      callback(
        delivery,
        310,
        questionSetCallbackData("next", controls.nextToken!),
      ),
    );
    controls = currentControls(testRuntime)!;
    expect(controls).toMatchObject({
      questionId: "question_mode_0000001",
      kind: "single-select",
      position: 3,
    });
    expect(controls.nextToken).toBeUndefined();
    await testRuntime.router.handle(
      callback(
        delivery,
        311,
        questionSetCallbackData("choose", optionToken(controls, "Safe")),
      ),
    );

    testRuntime.transport.beforeAcknowledgement = () => {
      expect(
        testRuntime.store.getPendingRequest("correlation_wizard_submit"),
      ).toMatchObject({ state: "answered", resolvedBy: "telegram" });
      expect(
        testRuntime.store.getQuestionSetDraft("correlation_wizard_submit"),
      ).toMatchObject({ state: "submitted" });
    };
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          312,
          questionSetCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "answered", updateId: 312 });

    const answerJson = testRuntime.store.getPendingRequest(
      "correlation_wizard_submit",
    )?.answer;
    expect(answerJson).toBeDefined();
    const answer = JSON.parse(answerJson!) as unknown;
    const interaction = input.request?.interaction;
    expect(validateInteractionAnswer(interaction, answer)).toMatchObject({
      ok: true,
    });
    expect(answer).toMatchObject({
      schema: "agent-interaction-answer.v1",
      requestId: "correlation_wizard_submit",
      answers: [
        {
          questionId: "question_confirm_0001",
          kind: "confirm",
          optionId: "confirm_stop_000001",
        },
        {
          questionId: "question_units_000001",
          kind: "multi-select",
          optionIds: ["unit_core_00000001", "unit_ui_0000000001"],
        },
        {
          questionId: "question_mode_0000001",
          kind: "single-select",
          optionId: "mode_safe_00000001",
        },
      ],
    });
    expect(testRuntime.transport.messageEdits.at(-1)?.text).toContain(
      "1. Proceed with this release?: Stop",
    );
    expect(testRuntime.transport.messageEdits.at(-1)?.text).toContain(
      "2. Which units should run?: Core, UI",
    );
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          313,
          questionSetCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "duplicate-answer", updateId: 313 });
    testRuntime.store.close();
  });

  it("materializes a valid empty answer for an optional multi-select step", async () => {
    const testRuntime = runtime();
    const base = questionSetEvent(
      "correlation_wizard_optional",
      "session_wizard_optional",
    );
    const interaction = {
      ...base.request!.interaction!,
      questions: [
        {
          questionId: "question_optional_0001",
          kind: "multi-select" as const,
          prompt: "Choose optional extras",
          options: [
            { optionId: "optional_logs_000001", label: "Logs" },
            { optionId: "optional_trace_00001", label: "Trace" },
          ],
          minSelections: 0,
          maxSelections: 2,
        },
      ],
    };
    const input: AgentAttentionEventV1 = {
      ...base,
      request: {
        correlationId: interaction.requestId,
        kind: "question-set",
        question: interaction.title,
        interaction,
        expiresAt: interaction.expiresAt,
      },
    };
    testRuntime.service.ingest(input);
    await testRuntime.service.drain();
    const delivery = testRuntime.transport.deliveries[0]!;
    const controls = delivery.message.questionSet!;

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          314,
          questionSetCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "answered", updateId: 314 });
    expect(
      JSON.parse(
        testRuntime.store.getPendingRequest("correlation_wizard_optional")
          ?.answer ?? "",
      ),
    ).toMatchObject({
      answers: [
        {
          questionId: "question_optional_0001",
          kind: "multi-select",
          optionIds: [],
        },
      ],
    });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_optional"),
    ).toMatchObject({
      state: "submitted",
      answers: [
        {
          questionId: "question_optional_0001",
          optionIds: [],
        },
      ],
    });
    testRuntime.store.close();
  });

  it("restores a partial draft after restart and cancels without synthesizing an answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-relay-wizard-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const firstRuntime = runtime(new RelayStore(databasePath));
    firstRuntime.service.ingest(
      questionSetEvent("correlation_wizard_restart", "session_wizard_restart"),
    );
    await firstRuntime.service.drain();
    const delivery = firstRuntime.transport.deliveries[0]!;
    let controls = currentControls(firstRuntime)!;
    await firstRuntime.router.handle(
      callback(
        delivery,
        320,
        questionSetCallbackData("choose", optionToken(controls, "Proceed")),
      ),
    );
    await firstRuntime.router.handle(
      callback(
        delivery,
        321,
        questionSetCallbackData("next", controls.nextToken!),
      ),
    );
    controls = currentControls(firstRuntime)!;
    await firstRuntime.router.handle(
      callback(
        delivery,
        322,
        questionSetCallbackData("select", optionToken(controls, "Docs")),
      ),
    );
    firstRuntime.store.close();

    const secondStore = new RelayStore(databasePath);
    const persisted = secondStore.getQuestionSetDraft(
      "correlation_wizard_restart",
    )!;
    expect(persisted).toMatchObject({
      state: "drafting",
      currentIndex: 1,
      revision: 3,
      answers: [
        {
          questionId: "question_confirm_0001",
          optionId: "confirm_proceed_0001",
        },
        {
          questionId: "question_units_000001",
          optionIds: ["unit_docs_00000001"],
        },
      ],
    });
    const secondRuntime = runtime(
      secondStore,
      new InspectingTelegramTransport(),
    );
    expect(
      await secondRuntime.router.handle(
        callback(
          delivery,
          323,
          questionSetCallbackData("cancel", persisted.cancelToken),
        ),
      ),
    ).toEqual({ outcome: "cancelled", updateId: 323 });
    expect(
      secondStore.getPendingRequest("correlation_wizard_restart"),
    ).toMatchObject({ state: "cancelled" });
    expect(
      secondStore.getPendingRequest("correlation_wizard_restart")?.answer,
    ).toBeUndefined();
    expect(
      secondStore.getQuestionSetDraft("correlation_wizard_restart"),
    ).toMatchObject({
      state: "cancelled",
      currentIndex: 1,
      answers: persisted.answers,
    });

    const maintenance = new RelayService(secondStore, secondRuntime.transport, {
      now: () => new Date("2026-09-10T12:00:00.000Z"),
    }).maintainRetention();
    expect(maintenance).toMatchObject({
      pendingRequests: 1,
      questionSetDrafts: 1,
    });
    expect(
      secondStore.getQuestionSetDraft("correlation_wizard_restart"),
    ).toBeUndefined();
    secondStore.close();
  });

  it("preserves partial answers on timeout and makes terminal supersession explicit", async () => {
    const expiredRuntime = runtime();
    const expiredInput = questionSetEvent(
      "correlation_wizard_expired",
      "session_wizard_expired",
    );
    expiredRuntime.service.ingest(expiredInput);
    await expiredRuntime.service.drain();
    const expiredDelivery = expiredRuntime.transport.deliveries[0]!;
    const expiredControls = currentControls(expiredRuntime)!;
    await expiredRuntime.router.handle(
      callback(
        expiredDelivery,
        330,
        questionSetCallbackData(
          "choose",
          optionToken(expiredControls, "Proceed"),
        ),
      ),
    );
    const lateRouter = new TelegramReplyRouter(
      expiredRuntime.store,
      expiredRuntime.transport,
      {
        operatorUserId: 7001,
        chatId: 9001,
        now: () => new Date("2026-07-24T12:06:00.000Z"),
      },
    );
    expect(
      await lateRouter.handle(
        callback(
          expiredDelivery,
          331,
          questionSetCallbackData("next", expiredControls.nextToken!),
        ),
      ),
    ).toEqual({ outcome: "expired", updateId: 331 });
    expect(
      expiredRuntime.store.getQuestionSetDraft("correlation_wizard_expired"),
    ).toMatchObject({
      state: "expired",
      currentIndex: 0,
      answers: [{ optionId: "confirm_proceed_0001" }],
    });
    expiredRuntime.store.close();

    const staleRuntime = runtime();
    const staleInput = questionSetEvent(
      "correlation_wizard_stale",
      "session_wizard_stale",
    );
    staleRuntime.service.ingest(staleInput);
    await staleRuntime.service.drain();
    const staleDelivery = staleRuntime.transport.deliveries[0]!;
    const staleControls = currentControls(staleRuntime)!;
    await staleRuntime.router.handle(
      callback(
        staleDelivery,
        332,
        questionSetCallbackData(
          "choose",
          optionToken(staleControls, "Proceed"),
        ),
      ),
    );
    expect(
      staleRuntime.service.resolveTerminal({
        correlationId: "correlation_wizard_stale",
        answer: "terminal writer won",
        expected: {
          machineId: staleInput.machineId,
          harness: staleInput.harness,
          sessionId: staleInput.sessionId,
          ...(staleInput.turnId === undefined
            ? {}
            : { turnId: staleInput.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      staleRuntime.store.getQuestionSetDraft("correlation_wizard_stale"),
    ).toMatchObject({ state: "superseded" });
    expect(
      await staleRuntime.router.handle(
        callback(
          staleDelivery,
          333,
          questionSetCallbackData("choose", optionToken(staleControls, "Stop")),
        ),
      ),
    ).toEqual({ outcome: "duplicate-answer", updateId: 333 });
    expect(staleRuntime.transport.messageEdits.at(-1)?.text).toContain(
      "Superseded",
    );
    expect(
      staleRuntime.store.getPendingRequest("correlation_wizard_stale")?.answer,
    ).toBe("terminal writer won");
    staleRuntime.store.close();
  });

  it("isolates concurrent sets by exact message, session, and topic", async () => {
    const testRuntime = runtime();
    const first = questionSetEvent(
      "correlation_wizard_first",
      "session_wizard_first",
      1,
    );
    const second = questionSetEvent(
      "correlation_wizard_second",
      "session_wizard_second",
      2,
    );
    testRuntime.service.ingest(first);
    testRuntime.service.ingest(second);
    await expect(testRuntime.service.drain()).resolves.toMatchObject({
      delivered: 2,
    });
    const firstDelivery = testRuntime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === first.eventId,
    )!;
    const secondDelivery = testRuntime.transport.deliveries.find(
      (delivery) => delivery.message.eventId === second.eventId,
    )!;
    expect(firstDelivery.context.topicId).not.toBe(
      secondDelivery.context.topicId,
    );
    const firstToken = optionToken(
      firstDelivery.message.questionSet!,
      "Proceed",
    );
    expect(
      await testRuntime.router.handle(
        callback(
          secondDelivery,
          340,
          questionSetCallbackData("choose", firstToken),
        ),
      ),
    ).toEqual({ outcome: "uncorrelated", updateId: 340 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_first")
        ?.answers,
    ).toEqual([]);
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_second")
        ?.answers,
    ).toEqual([]);

    const [firstResult, secondResult] = await Promise.all([
      testRuntime.router.handle(
        callback(
          firstDelivery,
          341,
          questionSetCallbackData("choose", firstToken),
        ),
      ),
      testRuntime.router.handle(
        callback(
          secondDelivery,
          342,
          questionSetCallbackData(
            "choose",
            optionToken(secondDelivery.message.questionSet!, "Stop"),
          ),
        ),
      ),
    ]);
    expect([firstResult.outcome, secondResult.outcome]).toEqual([
      "draft-updated",
      "draft-updated",
    ]);
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_first")
        ?.answers[0],
    ).toMatchObject({ optionId: "confirm_proceed_0001" });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_wizard_second")
        ?.answers[0],
    ).toMatchObject({ optionId: "confirm_stop_000001" });
    testRuntime.store.close();
  });
});
