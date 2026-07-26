import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { TelegramReplyRouter } from "./reply-router.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { multiSelectCallbackData } from "./telegram-multi-select.js";

const baseTime = "2026-07-24T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function multiSelectEvent(
  correlationId: string,
  sessionId: string,
  sequence = 1,
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `evt_${correlationId}`,
    occurredAt: baseTime,
    sequence,
    machineId: "machine_multi_12345678",
    bridgeSessionId: "bridge_multi_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId,
    turnId: `turn_multi_${String(sequence).padStart(8, "0")}`,
    project: makeProjectRef(`/workspace/${sessionId}`),
    type: "input.required",
    summary: "Choose the units to exercise",
    request: {
      correlationId,
      kind: "multi-select",
      question: "Which units should run?",
      options: Array.from({ length: 4 }, (_, index) => ({
        id: `multi_option_${String(index + 1).padStart(2, "0")}`,
        label: `Unit ${String(index + 1)}`,
      })),
      minSelections: 1,
      maxSelections: 3,
      expiresAt: "2026-07-24T12:05:00.000Z",
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

function callback(
  delivery: InspectingTelegramTransport["deliveries"][number],
  updateId: number,
  data: string,
) {
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

describe("durable Telegram multi-select drafts", () => {
  it("keeps set-style toggles idempotent and submits one atomic answer", async () => {
    const testRuntime = runtime();
    const input = multiSelectEvent(
      "correlation_multi_submit",
      "session_multi_submit",
    );
    testRuntime.service.ingest(input);
    await testRuntime.service.drain();
    const delivery = testRuntime.transport.deliveries[0]!;
    const controls = delivery.message.multiSelect!;
    expect(controls.options).toHaveLength(4);
    expect(controls.options.every((option) => !option.selected)).toBe(true);
    expect(controls.submitToken).toMatch(/^draft_submit_/);
    expect(controls.cancelToken).toMatch(/^draft_cancel_/);

    testRuntime.transport.beforeAcknowledgement = () => {
      expect(
        testRuntime.store.getMultiSelectDraft("correlation_multi_submit")
          ?.selectedOptionIds,
      ).toEqual([]);
      expect(
        testRuntime.store.getPendingRequest("correlation_multi_submit")?.state,
      ).toBe("open");
    };
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          201,
          multiSelectCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 201 });

    const first = controls.options[0]!;
    testRuntime.transport.beforeAcknowledgement = () => {
      expect(
        testRuntime.store.getMultiSelectDraft("correlation_multi_submit")
          ?.selectedOptionIds,
      ).toEqual(["multi_option_01"]);
    };
    expect(
      await testRuntime.router.handle(
        callback(delivery, 202, multiSelectCallbackData("select", first.value)),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 202 });
    expect(
      testRuntime.transport.deliveryMessageEdits.at(-1)?.message.multiSelect
        ?.options[0]?.selected,
    ).toBe(true);
    expect(
      await testRuntime.router.handle(
        callback(delivery, 203, multiSelectCallbackData("select", first.value)),
      ),
    ).toEqual({ outcome: "draft-unchanged", updateId: 203 });

    const [second, third, fourth] = controls.options.slice(1);
    testRuntime.transport.beforeAcknowledgement = undefined;
    expect(
      (
        await Promise.all([
          testRuntime.router.handle(
            callback(
              delivery,
              204,
              multiSelectCallbackData("select", second!.value),
            ),
          ),
          testRuntime.router.handle(
            callback(
              delivery,
              205,
              multiSelectCallbackData("select", third!.value),
            ),
          ),
        ])
      )
        .map((result) => result.outcome)
        .sort(),
    ).toEqual(["draft-updated", "draft-updated"]);
    expect(
      testRuntime.store.getMultiSelectDraft("correlation_multi_submit")
        ?.selectedOptionIds,
    ).toEqual(["multi_option_01", "multi_option_02", "multi_option_03"]);
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          206,
          multiSelectCallbackData("select", fourth!.value),
        ),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 206 });

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          207,
          multiSelectCallbackData("unselect", third!.value),
        ),
      ),
    ).toEqual({ outcome: "draft-updated", updateId: 207 });
    testRuntime.transport.beforeAcknowledgement = () => {
      expect(
        testRuntime.store.getPendingRequest("correlation_multi_submit"),
      ).toMatchObject({
        state: "answered",
        answer: '["multi_option_01","multi_option_02"]',
        resolvedBy: "telegram",
      });
      expect(
        testRuntime.store.getMultiSelectDraft("correlation_multi_submit"),
      ).toMatchObject({ state: "submitted" });
    };
    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          208,
          multiSelectCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "answered", updateId: 208 });
    expect(testRuntime.transport.messageEdits.at(-1)?.text).toContain(
      "Answered",
    );
    expect(testRuntime.transport.messageEdits.at(-1)?.text).toContain(
      "Selected: Unit 1, Unit 2",
    );

    expect(
      await testRuntime.router.handle(
        callback(
          delivery,
          209,
          multiSelectCallbackData("submit", controls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "duplicate-answer", updateId: 209 });
    expect(
      testRuntime.store.getPendingRequest("correlation_multi_submit")?.answer,
    ).toBe('["multi_option_01","multi_option_02"]');
    expect(
      testRuntime.service.resolveTerminal({
        correlationId: "correlation_multi_submit",
        answer: "terminal writer lost",
        expected: {
          machineId: input.machineId,
          harness: input.harness,
          sessionId: input.sessionId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
      }),
    ).toMatchObject({ outcome: "duplicate" });
    testRuntime.store.close();
  });

  it("survives restart, preserves the draft, and cancels without an empty answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-relay-multi-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const firstRuntime = runtime(new RelayStore(databasePath));
    const input = multiSelectEvent(
      "correlation_multi_restart",
      "session_multi_restart",
    );
    firstRuntime.service.ingest(input);
    await firstRuntime.service.drain();
    const delivery = firstRuntime.transport.deliveries[0]!;
    const controls = delivery.message.multiSelect!;
    await firstRuntime.router.handle(
      callback(
        delivery,
        210,
        multiSelectCallbackData("select", controls.options[1]!.value),
      ),
    );
    firstRuntime.store.close();

    const secondStore = new RelayStore(databasePath);
    expect(
      secondStore.getMultiSelectDraft("correlation_multi_restart"),
    ).toMatchObject({
      state: "drafting",
      selectedOptionIds: ["multi_option_02"],
      revision: 1,
    });
    const secondTransport = new InspectingTelegramTransport();
    const secondRuntime = runtime(secondStore, secondTransport);
    const persistedDraft = secondStore.getMultiSelectDraft(
      "correlation_multi_restart",
    )!;
    expect(
      await secondRuntime.router.handle(
        callback(
          delivery,
          211,
          multiSelectCallbackData("cancel", persistedDraft.cancelToken),
        ),
      ),
    ).toEqual({ outcome: "cancelled", updateId: 211 });
    expect(
      secondStore.getPendingRequest("correlation_multi_restart"),
    ).toMatchObject({ state: "cancelled" });
    expect(
      secondStore.getPendingRequest("correlation_multi_restart")?.answer,
    ).toBeUndefined();
    expect(
      secondStore.getMultiSelectDraft("correlation_multi_restart"),
    ).toMatchObject({ state: "cancelled" });
    expect(secondTransport.messageEdits.at(-1)?.text).toContain("Canceled");
    expect(secondTransport.messageEdits.at(-1)?.text).toContain(
      "Selected: Unit 2",
    );

    const maintenance = new RelayService(secondStore, secondTransport, {
      now: () => new Date("2026-09-10T12:00:00.000Z"),
    }).maintainRetention();
    expect(maintenance).toMatchObject({
      pendingRequests: 1,
      interactionDrafts: 1,
    });
    expect(
      secondStore.getMultiSelectDraft("correlation_multi_restart"),
    ).toBeUndefined();
    secondStore.close();
  });

  it("expires late toggles and rejects a stale keyboard after another writer wins", async () => {
    const expiredRuntime = runtime();
    const expiredInput = multiSelectEvent(
      "correlation_multi_expired",
      "session_multi_expired",
    );
    expiredRuntime.service.ingest(expiredInput);
    await expiredRuntime.service.drain();
    const expiredDelivery = expiredRuntime.transport.deliveries[0]!;
    const expiredControls = expiredDelivery.message.multiSelect!;
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
          212,
          multiSelectCallbackData("select", expiredControls.options[0]!.value),
        ),
      ),
    ).toEqual({ outcome: "expired", updateId: 212 });
    expect(
      expiredRuntime.store.getMultiSelectDraft("correlation_multi_expired"),
    ).toMatchObject({ state: "expired", selectedOptionIds: [] });
    expiredRuntime.store.close();

    const staleRuntime = runtime();
    const staleInput = multiSelectEvent(
      "correlation_multi_stale",
      "session_multi_stale",
    );
    staleRuntime.service.ingest(staleInput);
    await staleRuntime.service.drain();
    const staleDelivery = staleRuntime.transport.deliveries[0]!;
    const staleControls = staleDelivery.message.multiSelect!;
    await staleRuntime.router.handle(
      callback(
        staleDelivery,
        213,
        multiSelectCallbackData("select", staleControls.options[0]!.value),
      ),
    );
    expect(
      staleRuntime.service.resolveTerminal({
        correlationId: "correlation_multi_stale",
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
      staleRuntime.store.getMultiSelectDraft("correlation_multi_stale"),
    ).toMatchObject({ state: "superseded" });
    expect(
      await staleRuntime.router.handle(
        callback(
          staleDelivery,
          214,
          multiSelectCallbackData("select", staleControls.options[1]!.value),
        ),
      ),
    ).toEqual({ outcome: "draft-rejected", updateId: 214 });
    expect(
      await staleRuntime.router.handle(
        callback(
          staleDelivery,
          215,
          multiSelectCallbackData("submit", staleControls.submitToken),
        ),
      ),
    ).toEqual({ outcome: "duplicate-answer", updateId: 215 });
    expect(
      staleRuntime.store.getPendingRequest("correlation_multi_stale")?.answer,
    ).toBe("terminal writer won");
    staleRuntime.store.close();
  });
});
