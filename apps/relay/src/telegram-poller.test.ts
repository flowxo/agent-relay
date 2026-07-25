import { MemoryLogger, TransportError } from "@agent-relay/core";
import { describe, expect, it, vi } from "vitest";

import type {
  TelegramUpdateHandler,
  TelegramUpdateSource,
} from "./telegram-poller.js";
import { TelegramUpdatePoller } from "./telegram-poller.js";

function blockingSource(
  calls: Array<number | undefined>,
): TelegramUpdateSource {
  return {
    getUpdates: async (options) => {
      calls.push(options?.offset);
      await new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new TransportError(
        "Telegram request was cancelled",
        "telegram-aborted",
        false,
      );
    },
  };
}

describe("TelegramUpdatePoller", () => {
  it("routes ordered updates and confirms the highest handled id", async () => {
    const calls: Array<number | undefined> = [];
    const sourceAfterBatch = blockingSource(calls);
    const source: TelegramUpdateSource = {
      getUpdates: vi
        .fn<TelegramUpdateSource["getUpdates"]>()
        .mockImplementationOnce(async (options) => {
          calls.push(options?.offset);
          return [{ update_id: 12 }, { update_id: 11 }];
        })
        .mockImplementation((options) => sourceAfterBatch.getUpdates(options)),
    };
    const handled: number[] = [];
    const handler: TelegramUpdateHandler = {
      handle: async (update) => {
        handled.push((update as { update_id: number }).update_id);
      },
    };
    const controller = new AbortController();
    const running = new TelegramUpdatePoller({
      source,
      handler,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }).run(controller.signal);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    await running;

    expect(handled).toEqual([11, 12]);
    expect(calls).toEqual([undefined, 13]);
  });

  it("retries transient source failures and records diagnostics", async () => {
    const logger = new MemoryLogger();
    const controller = new AbortController();
    const source: TelegramUpdateSource = {
      getUpdates: vi
        .fn<TelegramUpdateSource["getUpdates"]>()
        .mockRejectedValueOnce(
          new TransportError("temporary outage", "telegram-network", true),
        )
        .mockImplementation(async () => {
          controller.abort();
          return [];
        }),
    };
    const sleeps: number[] = [];
    const poller = new TelegramUpdatePoller({
      source,
      handler: { handle: vi.fn() },
      logger,
      retryBaseMs: 5,
      retryMaxMs: 20,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    await poller.run(controller.signal);

    expect(sleeps).toEqual([5]);
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        code: "telegram.poll-failed",
        details: expect.objectContaining({
          errorCode: "telegram-network",
          retryable: true,
          retryDelayMs: 5,
        }),
      }),
    );
  });

  it("does not confirm a failed update and retries it after earlier successes", async () => {
    const offsets: Array<number | undefined> = [];
    const controller = new AbortController();
    let batch = 0;
    const source: TelegramUpdateSource = {
      getUpdates: async (options) => {
        offsets.push(options?.offset);
        batch += 1;
        if (batch === 1) {
          return [{ update_id: 20 }, { update_id: 21 }];
        }
        if (batch === 2) {
          return [{ update_id: 21 }];
        }
        controller.abort();
        return [];
      },
    };
    const handler = {
      handle: vi
        .fn<TelegramUpdateHandler["handle"]>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("database unavailable")),
    };
    const logger = new MemoryLogger();
    const sleeps: number[] = [];

    await new TelegramUpdatePoller({
      source,
      handler,
      logger,
      retryBaseMs: 1,
      retryMaxMs: 4,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    }).run(controller.signal);

    expect(offsets).toEqual([undefined, 21, 21]);
    expect(sleeps).toEqual([1, 2]);
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        code: "telegram.poll-handler-failed",
        details: { updateId: 21 },
      }),
    );
  });

  it("stops an active long poll without logging shutdown as a failure", async () => {
    const logger = new MemoryLogger();
    const calls: Array<number | undefined> = [];
    const controller = new AbortController();
    const running = new TelegramUpdatePoller({
      source: blockingSource(calls),
      handler: { handle: vi.fn() },
      logger,
    }).run(controller.signal);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await running;

    expect(logger.records.map((record) => record.code)).toEqual([
      "telegram.poll-started",
      "telegram.poll-stopped",
    ]);
  });
});
