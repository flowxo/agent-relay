import { MemoryLogger } from "@agent-relay/core";
import { TransportError } from "@agent-relay/notification-contracts";
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

  it("blocks after one explicitly non-retryable polling conflict", async () => {
    const logger = new MemoryLogger();
    const privateProviderDetail = "synthetic-private-provider-detail";
    const source: TelegramUpdateSource = {
      getUpdates: vi
        .fn()
        .mockRejectedValue(
          new TransportError(
            privateProviderDetail,
            "telegram-polling-conflict",
            false,
            409,
          ),
        ),
    };
    const sleep = vi.fn();
    const poller = new TelegramUpdatePoller({
      source,
      handler: { handle: vi.fn() },
      logger,
      localOwnership: "held",
      sleep,
      now: () => new Date("2026-08-10T22:50:20.000Z"),
    });

    await poller.run(new AbortController().signal);

    expect(source.getUpdates).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(poller.status()).toEqual({
      mode: "poll",
      localOwnership: "held",
      state: "blocked",
      replyReady: false,
      lastSuccessfulPollAt: null,
      lastError: {
        at: "2026-08-10T22:50:20.000Z",
        code: "telegram-polling-conflict",
      },
    });
    expect(logger.records.map((record) => record.code)).toEqual([
      "telegram.poll-started",
      "telegram.poll-failed",
      "telegram.poll-blocked",
      "telegram.poll-stopped",
    ]);
    expect(JSON.stringify(logger.records)).not.toContain(privateProviderDetail);
  });

  it("reports reply readiness only after a complete successful poll", async () => {
    const controller = new AbortController();
    const source: TelegramUpdateSource = {
      getUpdates: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [];
      }),
    };
    const poller = new TelegramUpdatePoller({
      source,
      handler: { handle: vi.fn() },
      localOwnership: "held",
      now: () => new Date("2026-08-10T22:49:45.000Z"),
    });
    expect(poller.status()).toMatchObject({
      state: "not-started",
      replyReady: false,
    });

    await poller.run(controller.signal);

    expect(poller.status()).toEqual({
      mode: "poll",
      localOwnership: "held",
      state: "stopped",
      replyReady: false,
      lastSuccessfulPollAt: "2026-08-10T22:49:45.000Z",
      lastError: null,
    });
  });

  it("does not confirm a failed update and retries it after earlier successes", async () => {
    const privateHandlerDetail = "synthetic-private-handler-detail";
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
        .mockRejectedValue(new Error(privateHandlerDetail)),
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
    expect(JSON.stringify(logger.records)).not.toContain(privateHandlerDetail);
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
