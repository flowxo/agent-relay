import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import type { FakeDelivery } from "./fake-transport.js";
import { FakeTelegramTransport } from "./fake-transport.js";
import { renderDeliveryText } from "./message.js";
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

function textQuestionSetEvent(
  correlationId: string,
  sessionId: string,
  sequence: number,
  textBounds: {
    minLength?: number;
    maxLength?: number;
    multiline?: boolean;
  } = {},
): AgentAttentionEventV1 {
  const interaction = {
    schema: "agent-interaction-request.v1" as const,
    requestId: correlationId,
    createdAt: baseTime,
    expiresAt: "2026-07-24T12:05:00.000Z",
    title: `Release notes ${String(sequence)}`,
    lifecycle: "pending" as const,
    questions: [
      {
        questionId: `question_text_${String(sequence).padStart(8, "0")}`,
        kind: "free-text" as const,
        prompt: "Describe the release note",
        minLength: textBounds.minLength ?? 3,
        maxLength: textBounds.maxLength ?? 80,
        multiline: textBounds.multiline ?? true,
      },
      {
        questionId: `question_confirm_${String(sequence).padStart(8, "0")}`,
        kind: "confirm" as const,
        prompt: "Submit this release note?",
        confirm: {
          optionId: `confirm_yes_${String(sequence).padStart(8, "0")}`,
          label: "Submit",
        },
        decline: {
          optionId: `confirm_no_${String(sequence).padStart(8, "0")}`,
          label: "Stop",
        },
      },
    ],
    fallback: {
      preferredMode: "direct-text" as const,
      alternativeModes: ["web-handoff" as const],
      whenUnavailable: "use-alternative" as const,
    },
  };
  return {
    schema: "agent-attention.v1",
    eventId: `evt_${correlationId}`,
    occurredAt: baseTime,
    sequence,
    machineId: "machine_text_set_12345678",
    bridgeSessionId: "bridge_text_set_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId,
    turnId: `turn_text_set_${String(sequence).padStart(8, "0")}`,
    project: makeProjectRef(`/workspace/${sessionId}`),
    type: "input.required",
    summary: "Structured release note requested",
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

function runtime(
  store = new RelayStore(),
  transport = new FakeTelegramTransport(),
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

function topicMessage(
  delivery: FakeDelivery,
  updateId: number,
  text: string,
  replyToCard = false,
) {
  return {
    update_id: updateId,
    message: {
      message_id: 10_000 + updateId,
      message_thread_id: Number(delivery.context.topicId),
      from: { id: 7001 },
      chat: { id: 9001 },
      text,
      ...(replyToCard
        ? {
            reply_to_message: {
              message_id: Number(delivery.receipt.messageId),
            },
          }
        : {}),
    },
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

describe("structured question-set free text", () => {
  it("captures, replaces, and submits a draft without echoing private text", async () => {
    const testRuntime = runtime();
    const input = textQuestionSetEvent(
      "correlation_text_submit",
      "session_text_submit",
      1,
    );
    testRuntime.service.ingest(input);
    await testRuntime.service.drain();
    const delivery = testRuntime.transport.deliveries[0]!;
    expect(delivery.message.questionSet).toMatchObject({
      requestTitle: "Release notes 1",
      prompt: "Describe the release note",
      position: 1,
      textInput: {
        minLength: 3,
        maxLength: 80,
        multiline: true,
        hasDraft: false,
      },
    });
    expect(renderDeliveryText(delivery.message)).toContain(
      "Send 3–80 characters (multiple lines allowed) in this topic",
    );

    const firstPrivateText = "Private release detail\nsecond line";
    expect(
      await testRuntime.router.handle(
        topicMessage(
          delivery,
          401,
          `  Private release detail\r\nsecond line  `,
        ),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 401 });
    expect(
      testRuntime.store.getPendingRequest("correlation_text_submit")?.state,
    ).toBe("open");
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_submit"),
    ).toMatchObject({
      state: "drafting",
      currentIndex: 0,
      revision: 1,
      answers: [
        {
          kind: "free-text",
          text: firstPrivateText,
        },
      ],
    });
    const edited = testRuntime.transport.deliveryMessageEdits.at(-1)!.message;
    expect(edited.questionSet?.textInput?.hasDraft).toBe(true);
    expect(renderDeliveryText(edited)).toContain(
      "A draft answer is saved; new text replaces it.",
    );
    expect(renderDeliveryText(edited)).not.toContain(firstPrivateText);
    expect(JSON.stringify(testRuntime.store.listDiagnostics())).not.toContain(
      firstPrivateText,
    );

    expect(
      await testRuntime.router.handle(
        topicMessage(delivery, 402, firstPrivateText),
      ),
    ).toEqual({ outcome: "draft-unchanged", updateId: 402 });
    const replacement = "Replacement private detail";
    expect(
      await testRuntime.router.handle(topicMessage(delivery, 403, replacement)),
    ).toEqual({ outcome: "draft-updated", updateId: 403 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_submit")
        ?.answers[0],
    ).toMatchObject({ text: replacement });

    let controls =
      testRuntime.transport.deliveryMessageEdits.at(-1)!.message.questionSet!;
    await testRuntime.router.handle(
      callback(
        delivery,
        404,
        questionSetCallbackData("next", controls.nextToken!),
      ),
    );
    expect(
      await testRuntime.router.handle(topicMessage(delivery, 405, "too late")),
    ).toEqual({ outcome: "no-eligible-request", updateId: 405 });
    expect(
      await testRuntime.router.handle(
        topicMessage(delivery, 406, "explicitly out of order", true),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 406 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_submit")
        ?.answers[0],
    ).toMatchObject({ text: replacement });

    controls =
      testRuntime.transport.deliveryMessageEdits.at(-1)!.message.questionSet!;
    const submitOption = controls.options.find(
      (option) => option.label === "Submit",
    )!;
    await testRuntime.router.handle(
      callback(
        delivery,
        407,
        questionSetCallbackData("choose", submitOption.value),
      ),
    );
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          408,
          questionSetCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "answered", updateId: 408 });
    expect(
      JSON.parse(
        testRuntime.store.getPendingRequest("correlation_text_submit")
          ?.answer ?? "",
      ),
    ).toMatchObject({
      answers: [
        {
          kind: "free-text",
          text: replacement,
        },
        {
          kind: "confirm",
          optionId: "confirm_yes_00000001",
        },
      ],
    });
    const finalText = testRuntime.transport.messageEdits.at(-1)!.text;
    expect(finalText).toContain("text saved (26 characters)");
    expect(finalText).not.toContain(replacement);
    testRuntime.store.close();
  });

  it("requires unambiguous topic correlation but accepts an explicit card reply", async () => {
    const testRuntime = runtime();
    const first = textQuestionSetEvent(
      "correlation_text_first",
      "session_text_shared",
      1,
    );
    const second = textQuestionSetEvent(
      "correlation_text_second",
      "session_text_shared",
      2,
    );
    testRuntime.service.ingest(first);
    testRuntime.service.ingest(second);
    await testRuntime.service.drain();
    const firstDelivery = testRuntime.transport.deliveries.find(
      (candidate) => candidate.message.eventId === first.eventId,
    )!;
    const secondDelivery = testRuntime.transport.deliveries.find(
      (candidate) => candidate.message.eventId === second.eventId,
    )!;
    expect(firstDelivery.context.topicId).toBe(secondDelivery.context.topicId);

    expect(
      await testRuntime.router.handle(
        topicMessage(firstDelivery, 410, "ambiguous private text"),
      ),
    ).toEqual({ outcome: "ambiguous-request", updateId: 410 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_first")?.answers,
    ).toEqual([]);
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_second")?.answers,
    ).toEqual([]);

    expect(
      await testRuntime.router.handle(
        topicMessage(firstDelivery, 411, "first private answer", true),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 411 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_first")
        ?.answers[0],
    ).toMatchObject({ text: "first private answer" });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_second")?.answers,
    ).toEqual([]);
    expect(
      await testRuntime.router.handle(
        topicMessage(secondDelivery, 412, "second private answer", true),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 412 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_second")
        ?.answers[0],
    ).toMatchObject({ text: "second private answer" });
    testRuntime.store.close();
  });

  it("rejects empty, bounded, multiline, duplicate, and late text safely", async () => {
    const testRuntime = runtime();
    const input = textQuestionSetEvent(
      "correlation_text_invalid",
      "session_text_invalid",
      3,
      { minLength: 3, maxLength: 10, multiline: false },
    );
    testRuntime.service.ingest(input);
    await testRuntime.service.drain();
    const delivery = testRuntime.transport.deliveries[0]!;

    expect(
      await testRuntime.router.handle(topicMessage(delivery, 420, "   ")),
    ).toEqual({ outcome: "draft-rejected", updateId: 420 });
    expect(
      await testRuntime.router.handle(topicMessage(delivery, 421, "ab")),
    ).toEqual({ outcome: "draft-rejected", updateId: 421 });
    expect(
      await testRuntime.router.handle(
        topicMessage(delivery, 422, "12345678901"),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 422 });
    expect(
      await testRuntime.router.handle(
        topicMessage(delivery, 423, "line\nbreak"),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 423 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_invalid")
        ?.answers,
    ).toEqual([]);

    expect(
      await testRuntime.router.handle(topicMessage(delivery, 424, "valid")),
    ).toEqual({ outcome: "draft-updated", updateId: 424 });
    expect(
      await testRuntime.router.handle(topicMessage(delivery, 424, "changed")),
    ).toEqual({ outcome: "duplicate-update", updateId: 424 });
    expect(
      testRuntime.store.getQuestionSetDraft("correlation_text_invalid")
        ?.answers[0],
    ).toMatchObject({ text: "valid" });
    testRuntime.store.close();

    const lateRuntime = runtime();
    lateRuntime.service.ingest(
      textQuestionSetEvent("correlation_text_late", "session_text_late", 4),
    );
    await lateRuntime.service.drain();
    const lateDelivery = lateRuntime.transport.deliveries[0]!;
    const lateRouter = new TelegramReplyRouter(
      lateRuntime.store,
      lateRuntime.transport,
      {
        operatorUserId: 7001,
        chatId: 9001,
        now: () => new Date("2026-07-24T12:06:00.000Z"),
      },
    );
    expect(
      await lateRouter.handle(
        topicMessage(lateDelivery, 425, "late private answer", true),
      ),
    ).toEqual({ outcome: "expired", updateId: 425 });
    expect(
      lateRuntime.store.getQuestionSetDraft("correlation_text_late"),
    ).toMatchObject({ state: "expired", answers: [] });
    lateRuntime.store.close();
  });

  it("retains a partial private draft across restart and removes it with retention", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-relay-text-set-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const firstRuntime = runtime(new RelayStore(databasePath));
    firstRuntime.service.ingest(
      textQuestionSetEvent(
        "correlation_text_restart",
        "session_text_restart",
        5,
      ),
    );
    await firstRuntime.service.drain();
    const delivery = firstRuntime.transport.deliveries[0]!;
    await firstRuntime.router.handle(
      topicMessage(delivery, 430, "restart private answer"),
    );
    firstRuntime.store.close();

    const secondStore = new RelayStore(databasePath);
    expect(
      secondStore.getQuestionSetDraft("correlation_text_restart"),
    ).toMatchObject({
      state: "drafting",
      answers: [{ text: "restart private answer" }],
    });
    const secondRuntime = runtime(secondStore, new FakeTelegramTransport());
    const cancelToken = secondStore.getQuestionSetDraft(
      "correlation_text_restart",
    )!.cancelToken;
    await secondRuntime.router.handle(
      callback(delivery, 431, questionSetCallbackData("cancel", cancelToken)),
    );
    const retention = new RelayService(secondStore, secondRuntime.transport, {
      now: () => new Date("2026-09-10T12:00:00.000Z"),
    }).maintainRetention();
    expect(retention).toMatchObject({
      pendingRequests: 1,
      questionSetDrafts: 1,
    });
    expect(
      secondStore.getQuestionSetDraft("correlation_text_restart"),
    ).toBeUndefined();
    secondStore.close();
  });
});
