import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeNotificationTransport } from "@agent-relay/core";
import { makeProjectRef } from "@agent-relay/protocol";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import type { TelegramCanaryClient } from "./canary.js";
import {
  assertTelegramCanaryReady,
  isWhooshBangCanaryAcknowledged,
  runFakeCanary,
  runTelegramCanary,
  runWhooshBangCanary,
  waitForTelegramCanaryReady,
} from "./canary.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function client(
  request:
    | {
        state: "open" | "answered" | "expired" | "cancelled" | "failed";
        resolvedBy?: "terminal" | "telegram" | "whooshbang";
        answer?: string;
      }
    | undefined,
  delivered = 1,
): TelegramCanaryClient {
  const record =
    request === undefined
      ? undefined
      : {
          correlationId: "correlation_telegram_canary_12345678",
          eventId: "evt_telegram_canary_12345678",
          machineId: "machine_telegram_canary_12345678",
          harness: "codex" as const,
          sessionId: "session_telegram_canary_12345678",
          state: request.state,
          requestKind: "input" as const,
          question: "Synthetic canary question",
          expiresAt: "2026-07-24T12:05:00.000Z",
          options: [],
          ...(delivered === 0 ? {} : { transportMessageId: "1001" }),
          ...(request.resolvedBy === undefined
            ? {}
            : { resolvedBy: request.resolvedBy }),
          ...(request.answer === undefined ? {} : { answer: request.answer }),
        };
  return {
    ingest: vi.fn(async (event) => ({
      eventId: event.eventId,
      inserted: true,
      status: "queued" as const,
    })),
    drain: vi.fn(async () => ({
      claimed: 1,
      delivered,
      retrying: delivered === 0 ? 1 : 0,
      deadLettered: 0,
    })),
    getRequest: vi.fn(async () => record),
    waitForAnswer: vi.fn(async (correlationId) =>
      record === undefined ? undefined : { ...record, correlationId },
    ),
  };
}

function fakeCanaryEvent(): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_fake_canary_12345678",
    occurredAt: "2026-07-24T12:00:00.000Z",
    sequence: 1,
    machineId: "machine_fake_canary_12345678",
    bridgeSessionId: "bridge_fake_canary_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "canary",
    sessionId: "session_fake_canary_12345678",
    project: makeProjectRef("/workspace/example"),
    type: "turn.stopped",
    summary: "Synthetic local canary",
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

describe("Fake local canary", () => {
  it("verifies durable delivery when the daemon background drain wins the race", async () => {
    const event = fakeCanaryEvent();
    const ingest = vi
      .fn()
      .mockResolvedValueOnce({
        eventId: event.eventId,
        inserted: true,
        status: "queued" as const,
      })
      .mockResolvedValueOnce({
        eventId: event.eventId,
        inserted: false,
        status: "delivering" as const,
      })
      .mockResolvedValueOnce({
        eventId: event.eventId,
        inserted: false,
        status: "delivered" as const,
      });
    const result = await runFakeCanary({
      client: {
        ingest,
        drain: vi.fn(async () => ({
          claimed: 0,
          delivered: 0,
          retrying: 0,
          deadLettered: 0,
        })),
      },
      event,
      waitMs: 100,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({
      outcome: "delivered",
      ingest: { inserted: true, status: "queued" },
      drain: { claimed: 0, delivered: 0 },
      verification: { inserted: false, status: "delivered" },
    });
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it("reports a durable retry instead of claiming a clean delivery", async () => {
    const event = fakeCanaryEvent();
    const ingest = vi
      .fn()
      .mockResolvedValueOnce({
        eventId: event.eventId,
        inserted: true,
        status: "queued" as const,
      })
      .mockResolvedValueOnce({
        eventId: event.eventId,
        inserted: false,
        status: "retry" as const,
      });
    await expect(
      runFakeCanary({
        client: {
          ingest,
          drain: vi.fn(async () => ({
            claimed: 1,
            delivered: 0,
            retrying: 1,
            deadLettered: 0,
          })),
        },
        event,
      }),
    ).resolves.toMatchObject({
      outcome: "retrying",
      verification: { status: "retry" },
    });
    expect(ingest).toHaveBeenCalledTimes(2);
  });
});

describe("Relay client Telegram canary activation", () => {
  it("allows the atomic delivery attempt to outlive the normal daemon timeout", async () => {
    const event = fakeCanaryEvent();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  ingest: {
                    eventId: event.eventId,
                    inserted: true,
                    status: "delivered",
                  },
                  drain: {
                    claimed: 1,
                    delivered: 1,
                    retrying: 0,
                    deadLettered: 0,
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
          }, 100);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const relayClient = new RelayClient({
      baseUrl: "http://127.0.0.1:4317",
      fetch: fetchMock,
      timeoutMs: 50,
    });

    await expect(relayClient.activateTelegramCanary(event)).resolves.toEqual({
      ingest: {
        eventId: event.eventId,
        inserted: true,
        status: "delivered",
      },
      drain: {
        claimed: 1,
        delivered: 1,
        retrying: 0,
        deadLettered: 0,
      },
    });
  });
});

describe("Telegram activation canary", () => {
  it("refuses before ingestion unless reply intake is active and locally owned", () => {
    const status = (intake: {
      mode: "poll";
      localOwnership: "held" | "not-held";
      state: "starting" | "active" | "blocked";
      replyReady: boolean;
    }) =>
      ({
        selectedTransport: "telegram" as const,
        transportRuntime: {
          telegram: {
            intake: {
              ...intake,
              lastSuccessfulPollAt: null,
              lastError: null,
            },
          },
        },
      }) as Parameters<typeof assertTelegramCanaryReady>[0];

    expect(() =>
      assertTelegramCanaryReady(
        status({
          mode: "poll",
          localOwnership: "held",
          state: "starting",
          replyReady: false,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "telegram-intake-not-ready" }));
    expect(() =>
      assertTelegramCanaryReady(
        status({
          mode: "poll",
          localOwnership: "held",
          state: "blocked",
          replyReady: false,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "telegram-intake-not-ready" }));
    expect(() =>
      assertTelegramCanaryReady(
        status({
          mode: "poll",
          localOwnership: "not-held",
          state: "active",
          replyReady: true,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "telegram-intake-not-ready" }));
    expect(() =>
      assertTelegramCanaryReady(
        status({
          mode: "poll",
          localOwnership: "held",
          state: "active",
          replyReady: true,
        }),
      ),
    ).not.toThrow();
  });

  it("refuses legacy and internally inconsistent status with one stable code", () => {
    const legacy = {
      selectedTransport: "telegram",
      transportRuntime: { selection: {} },
    } as unknown as Parameters<typeof assertTelegramCanaryReady>[0];
    expect(() => assertTelegramCanaryReady(legacy)).toThrow(
      expect.objectContaining({ code: "telegram-intake-not-ready" }),
    );

    const inconsistent = {
      selectedTransport: "telegram",
      transportRuntime: {
        telegram: {
          intake: {
            mode: "poll",
            localOwnership: "held",
            state: "blocked",
            replyReady: true,
            lastSuccessfulPollAt: null,
            lastError: null,
          },
        },
      },
    } as Parameters<typeof assertTelegramCanaryReady>[0];
    expect(() => assertTelegramCanaryReady(inconsistent)).toThrow(
      expect.objectContaining({ code: "telegram-intake-not-ready" }),
    );
  });

  it("waits locally for a starting poller without creating a request", async () => {
    let now = 0;
    const starting = {
      selectedTransport: "telegram",
      transportRuntime: {
        telegram: {
          intake: {
            mode: "poll",
            localOwnership: "held",
            state: "starting",
            replyReady: false,
            lastSuccessfulPollAt: null,
            lastError: null,
          },
        },
      },
    } as const;
    const active = {
      selectedTransport: "telegram",
      transportRuntime: {
        telegram: {
          intake: {
            mode: "poll",
            localOwnership: "held",
            state: "active",
            replyReady: true,
            lastSuccessfulPollAt: "2026-08-10T22:49:45.000Z",
            lastError: null,
          },
        },
      },
    } as const;
    const status = vi
      .fn()
      .mockResolvedValueOnce(starting)
      .mockResolvedValueOnce(active);
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });

    await expect(
      waitForTelegramCanaryReady({
        client: { status },
        waitMs: 1_000,
        pollIntervalMs: 100,
        now: () => now,
        sleep,
      }),
    ).resolves.toEqual(active);
    expect(status).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fails immediately when intake is blocked and times out while starting", async () => {
    const blocked = {
      selectedTransport: "telegram",
      transportRuntime: {
        telegram: {
          intake: {
            mode: "poll",
            localOwnership: "held",
            state: "blocked",
            replyReady: false,
            lastSuccessfulPollAt: null,
            lastError: {
              at: "2026-08-10T22:50:20.000Z",
              code: "telegram-polling-conflict",
            },
          },
        },
      },
    } as const;
    const blockedStatus = vi.fn(async () => blocked);
    const blockedSleep = vi.fn();
    await expect(
      waitForTelegramCanaryReady({
        client: { status: blockedStatus },
        sleep: blockedSleep,
      }),
    ).rejects.toMatchObject({ code: "telegram-intake-not-ready" });
    expect(blockedStatus).toHaveBeenCalledOnce();
    expect(blockedSleep).not.toHaveBeenCalled();

    let now = 0;
    const starting = {
      ...blocked,
      transportRuntime: {
        telegram: {
          intake: {
            ...blocked.transportRuntime.telegram.intake,
            state: "starting" as const,
            lastError: null,
          },
        },
      },
    };
    const startingStatus = vi.fn(async () => starting);
    await expect(
      waitForTelegramCanaryReady({
        client: { status: startingStatus },
        waitMs: 100,
        pollIntervalMs: 100,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      }),
    ).rejects.toMatchObject({ code: "telegram-intake-not-ready" });
    expect(startingStatus).toHaveBeenCalledTimes(2);
  });

  it("delivers a bounded correlated question and confirms a Telegram reply", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "relay-canary-ok",
    });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      randomId: () => "12345678-1234-1234-1234-123456789012",
    });

    expect(result).toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
      drain: { delivered: 1 },
    });
    const event = vi.mocked(fake.ingest).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "input.required",
      request: {
        kind: "input",
        question: expect.stringContaining("relay-canary-ok"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("relay-canary-ok");
  });

  it("activates a Telegram canary through the atomic daemon endpoint", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "relay-canary-ok",
    });
    const activateTelegramCanary = vi.fn(
      async (event: AgentAttentionEventV1) => ({
        ingest: {
          eventId: event.eventId,
          inserted: true,
          status: "queued" as const,
        },
        drain: {
          claimed: 1,
          delivered: 1,
          retrying: 0,
          deadLettered: 0,
        },
      }),
    );
    fake.activateTelegramCanary = activateTelegramCanary;
    vi.mocked(fake.ingest).mockRejectedValue(
      new Error("legacy ingest must not run"),
    );
    vi.mocked(fake.drain).mockRejectedValue(
      new Error("legacy drain must not run"),
    );

    await expect(
      runTelegramCanary({
        client: fake,
        machineId: "machine_telegram_canary_12345678",
        projectPath: "/workspace/example",
        waitMs: 1_000,
        pollIntervalMs: 50,
        now: () => new Date("2026-07-24T12:00:00.000Z"),
        randomId: () => "12345678-1234-1234-1234-123456789012",
      }),
    ).resolves.toMatchObject({
      outcome: "answered",
      drain: { delivered: 1 },
    });

    expect(activateTelegramCanary).toHaveBeenCalledOnce();
    expect(activateTelegramCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input.required",
        request: expect.objectContaining({ kind: "input" }),
      }),
    );
    expect(fake.ingest).not.toHaveBeenCalled();
    expect(fake.drain).not.toHaveBeenCalled();
  });

  it("fails before waiting when Telegram delivery is queued for retry", async () => {
    const fake = client({ state: "open" }, 0);

    await expect(
      runTelegramCanary({
        client: fake,
        machineId: "machine_telegram_canary_12345678",
        projectPath: "/workspace/example",
        waitMs: 1_000,
        pollIntervalMs: 50,
      }),
    ).resolves.toMatchObject({ outcome: "delivery-failed" });
    expect(fake.waitForAnswer).not.toHaveBeenCalled();
  });

  it("waits for a delivery receipt claimed by the daemon background worker", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "relay-canary-ok",
    });
    const delivered = await fake.getRequest(
      "correlation_telegram_canary_12345678",
    );
    expect(delivered).toBeDefined();
    const {
      transportMessageId: _receipt,
      resolvedBy: _resolvedBy,
      answer: _answer,
      ...record
    } = delivered!;
    const pending = { ...record, state: "open" as const };
    vi.mocked(fake.getRequest)
      .mockReset()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(delivered);

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result).toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
    });
    expect(fake.getRequest).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout without copying the reply or question into output", async () => {
    const fake = client({ state: "open" });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toBe("timeout");
    expect(result).not.toHaveProperty("answer");
    expect(result).not.toHaveProperty("question");
  });

  it("fails closed when the Telegram answer does not match the challenge", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "telegram",
      answer: "wrong reply",
    });

    const result = await runTelegramCanary({
      client: fake,
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toBe("unexpected-answer");
    expect(JSON.stringify(result)).not.toContain("wrong reply");
  });

  it("completes the full daemon loop through the fake Telegram transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-canary-"));
    temporaryDirectories.push(directory);
    const daemon = await startDaemon({
      databasePath: join(directory, "relay.sqlite"),
      port: 0,
      telegramOperatorUserId: 7001,
      telegramReplyChatId: 9001,
      drainIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    });
    const address = daemon.server.address() as AddressInfo;
    const relayClient = new RelayClient({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      timeoutMs: 10_000,
    });
    expect(daemon.service.transport).toBeInstanceOf(FakeNotificationTransport);
    const transport = daemon.service.transport as FakeNotificationTransport;
    const running = runTelegramCanary({
      client: {
        ingest: async (event) => await relayClient.ingest(event),
        drain: async (limit) => await relayClient.drain(limit),
        getRequest: async (correlationId) =>
          await relayClient.getRequest(correlationId),
        waitForAnswer: async (correlationId, timeoutMs, pollIntervalMs) =>
          await relayClient.waitForAnswer(
            correlationId,
            timeoutMs,
            pollIntervalMs,
          ),
      },
      machineId: "machine_telegram_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 10_000,
      pollIntervalMs: 50,
      randomId: () => "12345678-1234-1234-1234-123456789012",
    });

    await vi.waitFor(() => expect(transport.deliveries).toHaveLength(1), {
      timeout: 15_000,
    });
    await relayClient.handleTelegramUpdate({
      update_id: 909,
      message: {
        message_id: 808,
        message_thread_id: Number(transport.deliveries[0]?.context.topicId),
        from: { id: 7001 },
        chat: { id: 9001 },
        text: "relay-canary-ok",
        reply_to_message: {
          message_id: Number(transport.deliveries[0]?.receipt.messageId),
        },
      },
    });

    await expect(running).resolves.toMatchObject({
      outcome: "answered",
      resolvedBy: "telegram",
    });
    await daemon.close();
  }, 25_000);
});

describe("WhooshBang activation canary", () => {
  it("requires this canary to advance the cursor before accepting acknowledgement", () => {
    expect(
      isWhooshBangCanaryAcknowledged("cursor_prior", {
        committedCursorRef: "cursor_prior",
        unacknowledgedEventCount: 0,
      }),
    ).toBe(false);
    expect(
      isWhooshBangCanaryAcknowledged("cursor_prior", {
        committedCursorRef: "cursor_next",
        unacknowledgedEventCount: 1,
      }),
    ).toBe(false);
    expect(
      isWhooshBangCanaryAcknowledged("cursor_prior", {
        committedCursorRef: "cursor_next",
        unacknowledgedEventCount: 0,
      }),
    ).toBe(true);
  });

  it("requires the answer to arrive through the hosted resolution path", async () => {
    const fake = client({
      state: "answered",
      resolvedBy: "whooshbang",
      answer: "relay-canary-ok",
    });

    const result = await runWhooshBangCanary({
      client: fake,
      machineId: "machine_whooshbang_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      randomId: () => "12345678-1234-1234-1234-123456789012",
    });

    expect(result).toMatchObject({
      outcome: "answered",
      resolvedBy: "whooshbang",
    });
    expect(vi.mocked(fake.ingest).mock.calls[0]?.[0]).toMatchObject({
      request: { question: expect.stringContaining("WhooshBang") },
    });
    expect(JSON.stringify(result)).not.toContain("relay-canary-ok");
  });

  it("fails closed when another resolver supplies the answer", async () => {
    const result = await runWhooshBangCanary({
      client: client({
        state: "answered",
        resolvedBy: "telegram",
        answer: "relay-canary-ok",
      }),
      machineId: "machine_whooshbang_canary_12345678",
      projectPath: "/workspace/example",
      waitMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toBe("unexpected-answer");
  });
});
