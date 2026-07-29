import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FakeNotificationTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";
import {
  TelegramBotTransport,
  TelegramReplyRouter,
  type ReplyRouteOutcome,
} from "@agent-relay/telegram-transport";
import {
  isInteractionCapabilityTransport,
  type DeliveryContext,
  type DeliveryMessage,
  type DeliveryReceipt,
  type NotificationTransport,
} from "@agent-relay/notification-contracts";
import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createWhooshBangContractMock,
  type WhooshBangContractMock,
} from "@whooshbang/contract-mock";
import {
  WhooshBangContractTransport,
  WhooshBangMachineInteractionSource,
} from "@agent-relay/whooshbang-transport";
import { makeProjectRef } from "@agent-relay/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  WhooshBangInteractionPoller,
  whooshbangStreamKey,
} from "./whooshbang-poller.js";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

const BASE_TIME = "2026-07-25T17:45:00.000Z";
const DEFAULT_EXPIRY = "2026-07-25T18:30:00.000Z";
const MACHINE_ID = "machine_synthetic_a";
const OPERATOR_ID = 7_001;
const CHAT_ID = 9_001;
const BINDING_ID = "binding_synthetic_relay";
const MACHINE_CLIENT_ID = "machine_client_synthetic_001";
const WHOOSHBANG_BASE_URL = "https://whooshbang.mock.test";
const temporaryDirectories: string[] = [];
const activeRuntimes = new Set<ParityRuntime>();

type ProviderKind = "fake" | "telegram" | "whooshbang";
type ParityAnswer =
  | { type: "confirm"; value: boolean }
  | { type: "select"; optionId: string }
  | { type: "input"; value: string };

interface ParityClock {
  now(): Date;
  advance(milliseconds: number): void;
}

interface TelegramApiMessage {
  body: Record<string, unknown>;
  messageId: number;
}

class RecordingFakeTransport extends FakeNotificationTransport {
  public readonly deliveryKeys: string[] = [];

  public override async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    this.deliveryKeys.push(context.idempotencyKey);
    return await super.deliver(message, context);
  }
}

class TelegramApiHarness {
  public readonly messages: TelegramApiMessage[] = [];
  public readonly edits: Array<Record<string, unknown>> = [];
  private nextMessageId = 100;
  private nextTopicId = 1_000;
  private sendFailures = 0;

  public failNextSend(): void {
    this.sendFailures += 1;
  }

  public readonly fetch: typeof fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").at(-1);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (method === "createForumTopic") {
      const topicId = this.nextTopicId++;
      return this.response({
        ok: true,
        result: {
          message_thread_id: topicId,
          name: typeof body["name"] === "string" ? body["name"] : "topic",
        },
      });
    }
    if (method === "sendMessage") {
      if (this.sendFailures > 0) {
        this.sendFailures -= 1;
        return this.response(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
          },
          429,
        );
      }
      const messageId = this.nextMessageId++;
      this.messages.push({ body, messageId });
      return this.response({
        ok: true,
        result: { message_id: messageId, date: 0 },
      });
    }
    if (method === "editMessageText") {
      this.edits.push(body);
      return this.response({
        ok: true,
        result: {
          message_id:
            typeof body["message_id"] === "number" ? body["message_id"] : 0,
        },
      });
    }
    if (method === "answerCallbackQuery") {
      return this.response({ ok: true, result: true });
    }
    throw new Error(`unexpected synthetic Telegram method: ${method ?? ""}`);
  };

  private response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

class RecordingTelegramTransport extends TelegramBotTransport {
  public readonly deliveryKeys: string[] = [];

  public override async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    this.deliveryKeys.push(context.idempotencyKey);
    return await super.deliver(message, context);
  }
}

class RecordingWhooshBangTransport extends WhooshBangContractTransport {
  public readonly deliveryKeys: string[] = [];

  public override async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    this.deliveryKeys.push(context.idempotencyKey);
    return await super.deliver(message, context);
  }
}

function clock(): ParityClock {
  let current = new Date(BASE_TIME);
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function attentionEvent(
  suffix: string,
  request:
    | { kind: "confirm"; expiresAt?: string }
    | {
        kind: "select";
        expiresAt?: string;
        options?: Array<{ id: string; label: string }>;
      }
    | { kind: "input" | "continuation"; expiresAt?: string }
    | undefined,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  const sessionId =
    overrides.sessionId ?? `session_transport_parity_${suffix}_12345678`;
  const bridgeSessionId =
    overrides.bridgeSessionId ?? `bridge_transport_parity_${suffix}_12345678`;
  const eventId =
    overrides.eventId ?? `event_transport_parity_${suffix}_12345678`;
  const requestValue =
    request === undefined
      ? undefined
      : {
          correlationId: `request_transport_parity_${suffix}_12345678`,
          kind: request.kind,
          question: `Synthetic ${request.kind} request for ${suffix}.`,
          ...(request.kind === "select"
            ? {
                options: request.options ?? [
                  {
                    id: "option_transport_alpha_12345678",
                    label: "Alpha",
                  },
                  {
                    id: "option_transport_beta_12345678",
                    label: "Beta",
                  },
                ],
              }
            : {}),
          expiresAt: request.expiresAt ?? DEFAULT_EXPIRY,
        };
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: overrides.occurredAt ?? BASE_TIME,
    sequence: overrides.sequence ?? 1,
    machineId: overrides.machineId ?? MACHINE_ID,
    bridgeSessionId,
    harness: overrides.harness ?? "codex",
    surface: overrides.surface ?? "cli",
    harnessVersion: overrides.harnessVersion ?? "test",
    sessionId,
    turnId: overrides.turnId ?? `turn_transport_parity_${suffix}_12345678`,
    project: overrides.project ?? makeProjectRef(`/workspace/parity/${suffix}`),
    type:
      overrides.type ??
      (request?.kind === "continuation"
        ? "turn.stopped"
        : request === undefined
          ? "turn.stopped"
          : "input.required"),
    summary: overrides.summary ?? `Synthetic parity event ${suffix}.`,
    capabilities: overrides.capabilities ?? {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
    ...(overrides.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: overrides.lastAssistantMessage }),
    ...(requestValue === undefined ? {} : { request: requestValue }),
  };
}

class ParityRuntime {
  public store: RelayStore;
  public service: RelayService;
  public readonly transport: NotificationTransport;
  public readonly presentationCapability: "supported" | "unsupported";
  private router: TelegramReplyRouter | undefined;
  private updateId = 1_000;
  private readonly fakeTransport: RecordingFakeTransport | undefined;
  private readonly telegramTransport: RecordingTelegramTransport | undefined;
  private readonly telegramApi: TelegramApiHarness | undefined;
  private readonly whooshbangTransport:
    RecordingWhooshBangTransport | undefined;
  private readonly whooshbangMock: WhooshBangContractMock | undefined;
  private readonly whooshbangBodies: string[] = [];
  private whooshbangSendFailures = 0;
  private closed = false;

  public constructor(
    public readonly provider: ProviderKind,
    public readonly databasePath: string,
    public readonly testClock: ParityClock,
  ) {
    if (provider === "fake") {
      this.fakeTransport = new RecordingFakeTransport();
      this.transport = this.fakeTransport;
      this.presentationCapability = "supported";
    } else if (provider === "telegram") {
      this.telegramApi = new TelegramApiHarness();
      this.telegramTransport = new RecordingTelegramTransport({
        token: "123456:synthetic-token-value",
        chatId: String(CHAT_ID),
        fetch: this.telegramApi.fetch,
      });
      this.transport = this.telegramTransport;
      this.presentationCapability = "supported";
    } else {
      this.whooshbangMock = createWhooshBangContractMock();
      const hostedFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const isMessageCreate =
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/messages");
        if (isMessageCreate && this.whooshbangSendFailures > 0) {
          this.whooshbangSendFailures -= 1;
          throw new Error("synthetic hosted connection loss");
        }
        if (isMessageCreate) {
          const body = (await request.clone().json()) as {
            content?: { type?: unknown; text?: unknown };
          };
          if (
            body.content?.type === "text" &&
            typeof body.content.text === "string"
          ) {
            this.whooshbangBodies.push(body.content.text);
          }
        }
        return await this.whooshbangMock!.fetch(request);
      };
      this.whooshbangTransport = new RecordingWhooshBangTransport({
        baseUrl: WHOOSHBANG_BASE_URL,
        credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
        machineClientId: MACHINE_CLIENT_ID,
        subscriberId: "agent_relay_operator",
        notifierId: "default",
        fetch: hostedFetch,
      });
      this.transport = this.whooshbangTransport;
      this.presentationCapability = "unsupported";
    }
    this.store = new RelayStore(databasePath);
    this.service = this.createService();
  }

  private createService(): RelayService {
    const service = new RelayService(this.store, this.transport, {
      now: this.testClock.now,
      coalescingWindowMs: 0,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
      },
    });
    this.router =
      this.provider === "whooshbang"
        ? undefined
        : new TelegramReplyRouter(this.store, this.transport, {
            operatorUserId: OPERATOR_ID,
            chatId: CHAT_ID,
            now: this.testClock.now,
          });
    return service;
  }

  public failNextDelivery(): void {
    if (this.fakeTransport !== undefined) {
      this.fakeTransport.failNext(1);
      return;
    }
    if (this.telegramApi !== undefined) {
      this.telegramApi.failNextSend();
      return;
    }
    this.whooshbangSendFailures += 1;
  }

  public deliveryKeys(): string[] {
    return [
      ...(this.fakeTransport?.deliveryKeys ?? []),
      ...(this.telegramTransport?.deliveryKeys ?? []),
      ...(this.whooshbangTransport?.deliveryKeys ?? []),
    ];
  }

  public logicalMessageCount(): number {
    if (this.fakeTransport !== undefined) {
      return this.fakeTransport.deliveries.length;
    }
    if (this.telegramApi !== undefined) {
      return this.telegramApi.messages.length;
    }
    return this.whooshbangMock?.inspect().messages.length ?? 0;
  }

  public deliveredBodies(): string[] {
    if (this.fakeTransport !== undefined) {
      return this.fakeTransport.deliveries.map(
        (delivery) => delivery.message.text,
      );
    }
    if (this.telegramApi !== undefined) {
      return this.telegramApi.messages.map((message) =>
        String(message.body["text"] ?? ""),
      );
    }
    return [...this.whooshbangBodies];
  }

  public presentationUpdateCount(): number {
    if (this.fakeTransport !== undefined) {
      return this.fakeTransport.messageEdits.length;
    }
    if (this.telegramApi !== undefined) {
      return this.telegramApi.edits.length;
    }
    return (
      this.store.hostedPollStatus(
        whooshbangStreamKey(WHOOSHBANG_BASE_URL, MACHINE_CLIENT_ID),
      ).messageUpdates.updated ?? 0
    );
  }

  public async answer(
    event: AgentAttentionEventV1,
    answer: ParityAnswer,
  ): Promise<ReplyRouteOutcome> {
    return this.provider === "whooshbang"
      ? await this.answerWhooshBang(event, answer)
      : await this.answerTelegram(event, answer);
  }

  private async answerTelegram(
    event: AgentAttentionEventV1,
    answer: ParityAnswer,
  ): Promise<ReplyRouteOutcome> {
    const router = this.router;
    const request = this.store.getPendingRequest(
      event.request?.correlationId ?? "",
    );
    const receipt = this.store.getDeliveryReceiptForEvent(event.eventId);
    const topic = this.store
      .listSessionTopics()
      .find(
        (candidate) =>
          candidate.machineId === event.machineId &&
          candidate.harness === event.harness &&
          candidate.sessionId === event.sessionId,
      );
    if (
      router === undefined ||
      request === undefined ||
      receipt === undefined ||
      topic?.topicId === undefined
    ) {
      throw new Error("Telegram parity answer identity is unavailable");
    }
    const updateId = this.updateId++;
    if (answer.type === "input") {
      return (
        await router.handle({
          update_id: updateId,
          message: {
            message_id: updateId + 10_000,
            message_thread_id: Number(topic.topicId),
            from: { id: OPERATOR_ID },
            chat: { id: CHAT_ID },
            text: answer.value,
            reply_to_message: {
              message_id: Number(receipt.messageId),
            },
          },
        })
      ).outcome;
    }
    const optionId =
      answer.type === "confirm"
        ? answer.value
          ? "yes_option"
          : "no_option"
        : answer.optionId;
    const option = request.options.find(
      (candidate) => candidate.optionId === optionId,
    );
    if (option === undefined) {
      throw new Error("Telegram parity option token is unavailable");
    }
    return (
      await router.handle({
        update_id: updateId,
        callback_query: {
          id: `callback_transport_parity_${String(updateId)}`,
          from: { id: OPERATOR_ID },
          data: `relay:${option.token}`,
          message: {
            message_id: Number(receipt.messageId),
            message_thread_id: Number(topic.topicId),
            chat: { id: CHAT_ID },
          },
        },
      })
    ).outcome;
  }

  private async answerWhooshBang(
    event: AgentAttentionEventV1,
    answer: ParityAnswer,
  ): Promise<ReplyRouteOutcome> {
    const mock = this.whooshbangMock;
    const request = this.store.getPendingRequest(
      event.request?.correlationId ?? "",
    );
    const receipt = this.store.getDeliveryReceiptForEvent(event.eventId);
    if (mock === undefined || request === undefined || receipt === undefined) {
      throw new Error("WhooshBang parity answer identity is unavailable");
    }
    const response =
      answer.type === "confirm"
        ? ({ type: "confirm", value: answer.value } as const)
        : answer.type === "input"
          ? ({ type: "input", value: answer.value } as const)
          : (() => {
              const option = request.options.find(
                (candidate) => candidate.optionId === answer.optionId,
              );
              if (option === undefined) {
                throw new Error(
                  "WhooshBang parity option token is unavailable",
                );
              }
              return { type: "select", value: option.token } as const;
            })();
    const priorState = request.state;
    const submitted = await mock.control.submitInteraction({
      messageId: receipt.messageId,
      response,
    });
    if (submitted.eventCreated) {
      await this.pollWhooshBangUntilIdle();
    }
    const resultingState = this.store.getPendingRequest(
      event.request?.correlationId ?? "",
    )?.state;
    if (
      submitted.eventCreated &&
      priorState === "open" &&
      resultingState === "open"
    ) {
      throw new Error(
        `WhooshBang parity event was not resolved: ${JSON.stringify({
          cursorCommits: mock.inspect().cursorCommits,
          poll: this.store.hostedPollStatus(
            whooshbangStreamKey(WHOOSHBANG_BASE_URL, MACHINE_CLIENT_ID),
          ),
          submitted,
        })}`,
      );
    }
    if (submitted.outcome === "duplicate") {
      return "duplicate-answer";
    }
    if (priorState === "expired") {
      return "expired";
    }
    return priorState === "open" ? "answered" : "duplicate-answer";
  }

  private async pollWhooshBangUntilIdle(): Promise<void> {
    const mock = this.whooshbangMock;
    if (mock === undefined) {
      throw new Error("WhooshBang mock is unavailable");
    }
    const baseSource = new WhooshBangMachineInteractionSource({
      baseUrl: WHOOSHBANG_BASE_URL,
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      fetch: async (input, init) => await mock.fetch(new Request(input, init)),
    });
    const controller = new AbortController();
    const source = {
      poll: async (
        options: Parameters<typeof baseSource.poll>[0],
      ): ReturnType<typeof baseSource.poll> => {
        const batch = await baseSource.poll(options);
        if (batch.events.length === 0) {
          controller.abort();
        }
        return batch;
      },
      acknowledge: async (
        input: Parameters<typeof baseSource.acknowledge>[0],
      ): ReturnType<typeof baseSource.acknowledge> =>
        await baseSource.acknowledge(input),
    };
    await new WhooshBangInteractionPoller({
      store: this.store,
      source,
      streamKey: whooshbangStreamKey(WHOOSHBANG_BASE_URL, MACHINE_CLIENT_ID),
      machineId: MACHINE_ID,
      bindingId: BINDING_ID,
      waitSeconds: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
      now: this.testClock.now,
    }).run(controller.signal);
  }

  public restart(): void {
    this.store.close();
    this.store = new RelayStore(this.databasePath);
    this.service = this.createService();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.store.close();
    activeRuntimes.delete(this);
  }
}

async function runtime(provider: ProviderKind): Promise<ParityRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-parity-"));
  temporaryDirectories.push(directory);
  const result = new ParityRuntime(
    provider,
    join(directory, "relay.sqlite"),
    clock(),
  );
  activeRuntimes.add(result);
  return result;
}

afterEach(async () => {
  for (const candidate of [...activeRuntimes]) {
    candidate.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

const providers = [
  { provider: "fake", resolvedBy: "telegram" },
  { provider: "telegram", resolvedBy: "telegram" },
  { provider: "whooshbang", resolvedBy: "whooshbang" },
] as const;

describe.each(providers)(
  "$provider transport-neutral behavior",
  ({ provider, resolvedBy }) => {
    it("bounds delivery, deduplicates ingestion, and retries the same local identity", async () => {
      const relay = await runtime(provider);
      const hiddenTail = "TAIL_MUST_NOT_CROSS_THE_DELIVERY_BOUND";
      const event = attentionEvent("bounded_retry", undefined, {
        lastAssistantMessage: `${"bounded result ".repeat(250)}${hiddenTail}`,
      });

      expect(relay.service.ingest(event).inserted).toBe(true);
      expect(relay.service.ingest(event).inserted).toBe(false);
      relay.failNextDelivery();
      await expect(relay.service.drain()).resolves.toMatchObject({
        claimed: 1,
        delivered: 0,
        retrying: 1,
      });
      relay.testClock.advance(1_000);
      await expect(relay.service.drain()).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
        retrying: 0,
      });

      expect(relay.deliveryKeys()).toEqual([event.eventId, event.eventId]);
      expect(relay.logicalMessageCount()).toBe(1);
      expect(relay.store.getEvent(event.eventId)?.status).toBe("delivered");
      expect(relay.deliveredBodies()).toEqual([
        expect.stringContaining("…[truncated]"),
      ]);
      expect(relay.deliveredBodies().join("")).not.toContain(hiddenTail);
    });

    it("resolves confirm, select, and input with explicit presentation capability", async () => {
      const relay = await runtime(provider);
      const confirm = attentionEvent("confirm", {
        kind: "confirm",
      });
      const select = attentionEvent("select", {
        kind: "select",
      });
      const input = attentionEvent("input", {
        kind: "input",
      });
      for (const event of [confirm, select, input]) {
        relay.service.ingest(event);
      }
      await expect(relay.service.drain()).resolves.toMatchObject({
        delivered: 3,
      });

      await expect(
        relay.answer(confirm, { type: "confirm", value: true }),
      ).resolves.toBe("answered");
      await expect(
        relay.answer(select, {
          type: "select",
          optionId: "option_transport_beta_12345678",
        }),
      ).resolves.toBe("answered");
      await expect(
        relay.answer(input, {
          type: "input",
          value: "continue with the bounded parity path",
        }),
      ).resolves.toBe("answered");

      expect(
        relay.store.getPendingRequest(confirm.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "yes_option",
        resolvedBy,
      });
      expect(
        relay.store.getPendingRequest(select.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "option_transport_beta_12345678",
        resolvedBy,
      });
      expect(
        relay.store.getPendingRequest(input.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "continue with the bounded parity path",
        resolvedBy,
      });

      expect(isInteractionCapabilityTransport(relay.transport)).toBe(true);
      if (!isInteractionCapabilityTransport(relay.transport)) {
        throw new Error("parity transport did not declare capabilities");
      }
      const capabilities =
        relay.transport.observeInteractionCapabilities(BASE_TIME).capabilities
          .features;
      expect(capabilities).toEqual(
        expect.arrayContaining(["confirm", "single-select", "free-text"]),
      );
      expect(capabilities.includes("message-updates")).toBe(
        relay.presentationCapability === "supported",
      );
      expect(relay.presentationUpdateCount()).toBe(
        relay.presentationCapability === "supported" ? 3 : 0,
      );
      if (provider === "whooshbang") {
        expect(
          relay.store.hostedPollStatus(
            whooshbangStreamKey(WHOOSHBANG_BASE_URL, MACHINE_CLIENT_ID),
          ).messageUpdates,
        ).toMatchObject({
          blocked: 3,
          updated: 0,
        });
      }
    });

    it("keeps identity, expiry, duplicate, and terminal races under local authority", async () => {
      const relay = await runtime(provider);
      const identity = attentionEvent("identity", { kind: "select" });
      const expiring = attentionEvent("expiry", {
        kind: "confirm",
        expiresAt: "2026-07-25T17:46:00.000Z",
      });
      const duplicate = attentionEvent("duplicate", { kind: "confirm" });
      const terminalFirst = attentionEvent("terminal_first", {
        kind: "confirm",
      });
      const phoneFirst = attentionEvent("phone_first", { kind: "confirm" });
      for (const event of [
        identity,
        expiring,
        duplicate,
        terminalFirst,
        phoneFirst,
      ]) {
        relay.service.ingest(event);
      }
      await expect(relay.service.drain()).resolves.toMatchObject({
        delivered: 5,
      });

      expect(
        relay.store.resolveRequest({
          correlationId: identity.request!.correlationId,
          answer: "option_transport_beta_12345678",
          resolvedBy: "terminal",
          now: BASE_TIME,
          expected: {
            machineId: identity.machineId,
            harness: identity.harness,
            sessionId: "session_transport_parity_wrong_12345678",
            turnId: identity.turnId!,
          },
        }),
      ).toMatchObject({ outcome: "identity_mismatch" });
      expect(
        relay.store.getPendingRequest(identity.request!.correlationId)?.state,
      ).toBe("open");

      relay.testClock.advance(120_000);
      expect(
        relay.store.expireRequests(relay.testClock.now().toISOString()),
      ).toBe(1);
      await expect(
        relay.answer(expiring, { type: "confirm", value: true }),
      ).resolves.toBe("expired");
      expect(
        relay.store.getPendingRequest(expiring.request!.correlationId)?.state,
      ).toBe("expired");

      await expect(
        relay.answer(duplicate, { type: "confirm", value: true }),
      ).resolves.toBe("answered");
      await expect(
        relay.answer(duplicate, { type: "confirm", value: true }),
      ).resolves.toBe("duplicate-answer");
      expect(
        relay.store.getPendingRequest(duplicate.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "yes_option",
        resolvedBy,
      });

      expect(
        relay.service.resolveTerminal({
          correlationId: terminalFirst.request!.correlationId,
          answer: "no_option",
          expected: {
            machineId: terminalFirst.machineId,
            harness: terminalFirst.harness,
            sessionId: terminalFirst.sessionId,
            turnId: terminalFirst.turnId!,
          },
        }),
      ).toMatchObject({ outcome: "answered" });
      await expect(
        relay.answer(terminalFirst, { type: "confirm", value: true }),
      ).resolves.toBe("duplicate-answer");
      expect(
        relay.store.getPendingRequest(terminalFirst.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "no_option",
        resolvedBy: "terminal",
      });

      await expect(
        relay.answer(phoneFirst, { type: "confirm", value: true }),
      ).resolves.toBe("answered");
      expect(
        relay.service.resolveTerminal({
          correlationId: phoneFirst.request!.correlationId,
          answer: "no_option",
          expected: {
            machineId: phoneFirst.machineId,
            harness: phoneFirst.harness,
            sessionId: phoneFirst.sessionId,
            turnId: phoneFirst.turnId!,
          },
        }),
      ).toMatchObject({ outcome: "duplicate" });
      expect(
        relay.store.getPendingRequest(phoneFirst.request!.correlationId),
      ).toMatchObject({
        state: "answered",
        answer: "yes_option",
        resolvedBy,
      });
    });

    it("answers after restart and exposes exactly one resume claim", async () => {
      const relay = await runtime(provider);
      const continuation = attentionEvent("restart_resume", {
        kind: "continuation",
      });
      relay.service.ingest(continuation);
      await expect(relay.service.drain()).resolves.toMatchObject({
        delivered: 1,
      });

      relay.restart();
      await expect(
        relay.answer(continuation, {
          type: "input",
          value: "resume only this exact session",
        }),
      ).resolves.toBe("answered");
      relay.restart();

      expect(
        relay.service.claimNextResume({
          machineId: continuation.machineId,
          bridgeSessionId: continuation.bridgeSessionId,
          harness: continuation.harness,
          ownerId: "supervisor_transport_parity_one",
        }),
      ).toMatchObject({
        outcome: "claimed",
        command: {
          answer: "resume only this exact session",
          correlationId: continuation.request!.correlationId,
          ownerId: "supervisor_transport_parity_one",
          sessionId: continuation.sessionId,
        },
      });
      expect(
        relay.service.claimNextResume({
          machineId: continuation.machineId,
          bridgeSessionId: continuation.bridgeSessionId,
          harness: continuation.harness,
          ownerId: "supervisor_transport_parity_two",
        }),
      ).toEqual({ outcome: "none" });
      expect(relay.store.listResumeCommands()).toHaveLength(1);
    });
  },
);
