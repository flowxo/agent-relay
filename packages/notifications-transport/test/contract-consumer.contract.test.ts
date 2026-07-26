import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import {
  FakeTelegramTransport,
  RelayService,
  RelayStore,
  TelegramReplyRouter,
} from "@agent-relay/core";
import { makeProjectRef } from "@agent-relay/protocol";
import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createNotificationsContractMock,
} from "@flowxo/notifications-contract-mock";
import { NotificationsClient } from "@flowxo/notifications";
import { afterEach, describe, expect, it } from "vitest";

import {
  NotificationsContractTransport,
  validateHostedAnswer,
} from "../src/index.js";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import type {
  ExpectedHostedRequestIdentity,
  HostedStreamProof,
} from "../src/index.js";
import type {
  InteractionEvent,
  MachineEventPollResponse,
} from "@flowxo/notifications-contracts";
import type {
  NotificationsContractMock,
  InteractionControlInput,
  InteractionControlResult,
} from "@flowxo/notifications-contract-mock";

const occurredAt = "2026-07-25T17:45:00.000Z";
const answeredAt = "2026-07-25T17:50:00.000Z";
const expiresAt = "2026-07-25T18:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function selectEvent(suffix: string): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `event_notifications_${suffix}_12345678`,
    occurredAt,
    sequence: 1,
    machineId: "machine_synthetic_a",
    bridgeSessionId: `bridge_notifications_${suffix}_12345678`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: `session_notifications_${suffix}_12345678`,
    turnId: `turn_notifications_${suffix}_12345678`,
    project: makeProjectRef("/workspace/synthetic-consumer"),
    type: "input.required",
    summary: "A bounded synthetic decision is required.",
    request: {
      correlationId: `request_notifications_${suffix}_12345678`,
      kind: "select",
      question: "Choose one synthetic option.",
      options: [
        { id: "option_alpha_12345678", label: "Alpha" },
        { id: "option_beta_12345678", label: "Beta" },
      ],
      expiresAt,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function continuationEvent(suffix: string): AgentAttentionEventV1 {
  const event = selectEvent(suffix);
  return {
    ...event,
    type: "turn.stopped",
    request: {
      correlationId: `request_notifications_${suffix}_12345678`,
      kind: "continuation",
      question: "What safe continuation should run?",
      expiresAt,
    },
  };
}

function fetchFor(mock: NotificationsContractMock): typeof fetch {
  return async (input, init) => mock.fetch(new Request(input, init));
}

function machineClient(baseUrl: string, fetchImplementation?: typeof fetch) {
  return new NotificationsClient({
    baseUrl,
    credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
  });
}

function streamProof(): HostedStreamProof {
  return {
    authenticatedMachineId: "machine_synthetic_a",
    configuredMachineId: "machine_synthetic_a",
    schemaValidated: true,
    signatureVerified: true,
    streamIdentityVerified: true,
  };
}

function expectedIdentity(
  event: AgentAttentionEventV1,
  transport: NotificationsContractTransport,
): ExpectedHostedRequestIdentity {
  const identity = transport.getHostedDeliveryIdentity(event.eventId);
  if (
    identity === undefined ||
    identity.interactionId === undefined ||
    event.request === undefined
  ) {
    throw new Error("Hosted delivery identity was not captured.");
  }
  return {
    correlationId: event.request.correlationId,
    eventId: event.eventId,
    hostedMessageId: identity.messageId,
    hostedInteractionId: identity.interactionId,
    machineId: event.machineId,
    harness: event.harness,
    sessionId: event.sessionId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    interactionType: event.request.kind === "continuation" ? "input" : "select",
    expiresAt: event.request.expiresAt,
  };
}

function createTransport(
  baseUrl: string,
  fetchImplementation?: typeof fetch,
): NotificationsContractTransport {
  return new NotificationsContractTransport({
    baseUrl,
    credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
    subscriberId: "agent_relay_operator",
    notifierId: "default",
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
  });
}

async function deliverAndSubmit(input: {
  event: AgentAttentionEventV1;
  store: RelayStore;
  transport: NotificationsContractTransport;
  submit: (
    messageId: string,
    response: InteractionControlInput["response"],
  ) => Promise<InteractionControlResult>;
}): Promise<ExpectedHostedRequestIdentity> {
  const service = new RelayService(input.store, input.transport, {
    now: () => new Date(occurredAt),
  });
  service.ingest(input.event);
  await expect(service.drain()).resolves.toMatchObject({
    delivered: 1,
    retrying: 0,
    deadLettered: 0,
  });
  const expected = expectedIdentity(input.event, input.transport);
  const request = input.store.getPendingRequest(expected.correlationId);
  const response: InteractionControlInput["response"] = (() => {
    if (request?.requestKind === "continuation") {
      return { type: "input", value: "continue with the safe path" };
    }
    const beta = request?.options.find(
      (option) => option.optionId === "option_beta_12345678",
    );
    if (beta === undefined) {
      throw new Error("Local beta option was not persisted.");
    }
    return { type: "select", value: beta.token };
  })();
  await expect(
    input.submit(expected.hostedMessageId, response),
  ).resolves.toEqual({
    eventCreated: true,
    outcome: "authorized",
  });
  return expected;
}

function requireInteractionEvent(batch: MachineEventPollResponse) {
  const hostedEvent = batch.events[0];
  if (hostedEvent === undefined) {
    throw new Error("Expected one hosted interaction event.");
  }
  return hostedEvent;
}

async function startPackedMock() {
  const require = createRequire(import.meta.url);
  const packageJson =
    require.resolve("@flowxo/notifications-contract-mock/package.json");
  const cli = resolve(dirname(packageJson), "dist/cli.js");
  const controlToken = "control-c0-07-12345678";
  const child = spawn(
    process.execPath,
    [
      cli,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--scenario",
      "interaction-select",
      "--control-token",
      controlToken,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.stdout === null || child.stderr === null) {
    throw new Error("Packed mock stdio was not available.");
  }
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, "line")) as [string];
  const started = JSON.parse(line) as {
    event: string;
    host: string;
    port: number;
    control_enabled: boolean;
  };
  if (
    started.event !== "contract_mock_started" ||
    !started.control_enabled ||
    started.host !== "127.0.0.1"
  ) {
    child.kill("SIGTERM");
    throw new Error("Packed mock did not start in guarded loopback mode.");
  }
  return {
    baseUrl: `http://${started.host}:${String(started.port)}`,
    cli,
    controlToken,
    close: async () => {
      lines.close();
      child.kill("SIGTERM");
      const [code] = (await once(child, "exit")) as [number | null];
      if (code !== 0) {
        throw new Error(`Packed mock failed: ${stderr.join("").slice(0, 500)}`);
      }
    },
  };
}

describe("C0 Notifications consumer contract", () => {
  it("survives SQLite resolution, crash-before-ack replay, and cursor advance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-relay-c0-07-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const mock = createNotificationsContractMock({
      scenario: "interaction-input",
    });
    const mockFetch = fetchFor(mock);
    const transport = createTransport(
      "https://notifications.mock.test",
      mockFetch,
    );
    const event = continuationEvent("crash");
    let store = new RelayStore(databasePath);
    const expected = await deliverAndSubmit({
      event,
      store,
      transport,
      submit: async (messageId, response) =>
        mock.control.submitInteraction({
          messageId,
          response,
        }),
    });
    const client = machineClient("https://notifications.mock.test", mockFetch);
    const firstPoll = await client.pollMachineEvents({ wait: 0 });
    const hostedEvent = requireInteractionEvent(firstPoll);
    const local = store.getPendingRequest(expected.correlationId);
    const validated = validateHostedAnswer({
      event: hostedEvent,
      localRequest: local,
      expected,
      stream: streamProof(),
    });
    expect(validated.outcome).toBe("ready");
    if (validated.outcome !== "ready") {
      throw new Error("Expected the first hosted answer to resolve.");
    }
    expect(store.resolveRequest(validated.resolution)).toMatchObject({
      outcome: "answered",
      request: {
        answer: "continue with the safe path",
        resolvedBy: "notifications",
      },
    });
    const claimingService = new RelayService(store, transport, {
      now: () => new Date(answeredAt),
    });
    expect(
      claimingService.claimNextResume({
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        ownerId: "supervisor_notifications_first",
      }),
    ).toMatchObject({
      outcome: "claimed",
      command: {
        correlationId: expected.correlationId,
        answer: "continue with the safe path",
        ownerId: "supervisor_notifications_first",
        state: "claimed",
      },
    });
    expect(store.listResumeCommands()).toHaveLength(1);

    store.close();
    store = new RelayStore(databasePath);
    const replay = requireInteractionEvent(
      await client.pollMachineEvents({ wait: 0 }),
    );
    expect(replay).toEqual(hostedEvent);
    expect(
      validateHostedAnswer({
        event: replay,
        localRequest: store.getPendingRequest(expected.correlationId),
        expected,
        stream: streamProof(),
      }),
    ).toEqual({
      outcome: "duplicate",
      acknowledgement: "processed",
      reasonCode: "already_resolved",
    });
    const restartedService = new RelayService(store, transport, {
      now: () => new Date(answeredAt),
    });
    expect(
      restartedService.claimNextResume({
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        ownerId: "supervisor_notifications_second",
      }),
    ).toEqual({ outcome: "none" });
    expect(store.listResumeCommands()).toEqual([
      expect.objectContaining({
        correlationId: expected.correlationId,
        ownerId: "supervisor_notifications_first",
        answer: "continue with the safe path",
      }),
    ]);

    const acknowledgement = await client.acknowledgeMachineEvent(
      replay.id,
      {
        cursor: replay.cursor,
        disposition: "processed",
        reason_code: null,
      },
      { idempotencyKey: `ack_${replay.id}` },
    );
    expect(acknowledgement).toMatchObject({
      advanced: true,
      committed_cursor: replay.cursor,
      acknowledgement_status: "recorded",
    });
    const after = await client.pollMachineEvents({
      after: replay.cursor,
      wait: 0,
    });
    expect(after).toMatchObject({
      committed_cursor: replay.cursor,
      events: [],
    });
    expect(mock.inspect().messages).toHaveLength(1);
    expect(mock.inspect().cursorCommits).toHaveLength(1);
    expect(store.getPendingRequest(expected.correlationId)).toMatchObject({
      answer: "continue with the safe path",
      resolvedBy: "notifications",
      state: "answered",
    });
    store.close();
  });

  it("runs the exact packed mock as a guarded separate process", async () => {
    const running = await startPackedMock();
    expect(running.cli).toContain(
      "@flowxo+notifications-contract-mock@file+vendor+notifications-c0+flowxo-notifications-contract-mock-1.0.0-draft.1.tgz",
    );
    const event = selectEvent("packed");
    const store = new RelayStore();
    try {
      const transport = createTransport(running.baseUrl);
      const expected = await deliverAndSubmit({
        event,
        store,
        transport,
        submit: async (messageId, responseValue) => {
          const response = await fetch(
            `${running.baseUrl}/__contract-mock/interactions`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-contract-mock-token": running.controlToken,
              },
              body: JSON.stringify({
                messageId,
                response: responseValue,
              }),
            },
          );
          return response.json() as Promise<InteractionControlResult>;
        },
      });
      const client = machineClient(running.baseUrl);
      const hostedEvent = requireInteractionEvent(
        await client.pollMachineEvents({ wait: 0 }),
      );
      const validated = validateHostedAnswer({
        event: hostedEvent,
        localRequest: store.getPendingRequest(expected.correlationId),
        expected,
        stream: streamProof(),
      });
      expect(validated.outcome).toBe("ready");
      if (validated.outcome !== "ready") {
        throw new Error("Packed mock answer did not validate.");
      }
      expect(store.resolveRequest(validated.resolution)).toMatchObject({
        outcome: "answered",
        request: { resolvedBy: "notifications" },
      });
      await expect(
        client.acknowledgeMachineEvent(
          hostedEvent.id,
          {
            cursor: hostedEvent.cursor,
            disposition: "processed",
            reason_code: null,
          },
          { idempotencyKey: `ack_${hostedEvent.id}` },
        ),
      ).resolves.toMatchObject({ advanced: true });
    } finally {
      store.close();
      await running.close();
    }
  });

  it("records a safe durable quarantine before acknowledging poison data", async () => {
    const mock = createNotificationsContractMock({
      scenario: "nominal",
    });
    const mockFetch = fetchFor(mock);
    const client = machineClient("https://notifications.mock.test", mockFetch);
    const store = new RelayStore();
    const event = selectEvent("quarantine");
    store.ingestEvent(event);
    const local = store.getPendingRequest(event.request!.correlationId)!;
    const poison: InteractionEvent = {
      schema: "notifications.interaction-event.v1",
      id: "event_poison_answer_12345678",
      cursor: "mcur_poison_answer_12345678",
      type: "interaction.received",
      message_id: "message_poison_12345678",
      interaction_id: "interaction_poison_12345678",
      correlation_id: local.correlationId,
      response: { type: "select", value: "decision_unknown_12345678" },
      channel_context: {
        binding_id: "binding_synthetic_relay",
        channel: "telegram",
        conversation_kind: "private_chat",
      },
      occurred_at: answeredAt,
      expires_at: expiresAt,
    };
    mock.control.enqueueMachineEvent({
      event: poison,
      machineClientId: "machine_client_synthetic_001",
      quarantinable: true,
      signatureValid: true,
      streamIdentityValid: true,
    });
    const expected: ExpectedHostedRequestIdentity = {
      correlationId: local.correlationId,
      eventId: local.eventId,
      hostedMessageId: poison.message_id,
      hostedInteractionId: poison.interaction_id,
      machineId: local.machineId,
      harness: local.harness,
      sessionId: local.sessionId,
      ...(local.turnId === undefined ? {} : { turnId: local.turnId }),
      interactionType: "select",
      expiresAt: local.expiresAt,
    };
    const validation = validateHostedAnswer({
      event: requireInteractionEvent(
        await client.pollMachineEvents({ wait: 0 }),
      ),
      localRequest: local,
      expected,
      stream: streamProof(),
    });
    expect(validation).toEqual({
      outcome: "quarantine",
      acknowledgement: "quarantined",
      reasonCode: "invalid_option",
    });
    expect(store.getPendingRequest(local.correlationId)?.state).toBe("open");
    store.recordDiagnostic({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: "diagnostic_quarantine_12345678",
      recordedAt: answeredAt,
      source: "daemon",
      level: "warn",
      code: "notifications.quarantine.invalid-option",
      message:
        "A hosted interaction was durably quarantined with a safe reason.",
    });
    expect(store.listDiagnostics()).toEqual([
      expect.objectContaining({
        diagnosticId: "diagnostic_quarantine_12345678",
        code: "notifications.quarantine.invalid-option",
      }),
    ]);
    await expect(
      client.acknowledgeMachineEvent(
        poison.id,
        {
          cursor: poison.cursor,
          disposition: "quarantined",
          reason_code: "invalid_option",
        },
        { idempotencyKey: `ack_${poison.id}` },
      ),
    ).resolves.toMatchObject({
      advanced: true,
      disposition: "quarantined",
    });
    store.close();
  });

  it("keeps first-writer-wins and direct Telegram behavior equivalent", async () => {
    const event = selectEvent("parity");
    const hostedStore = new RelayStore();
    hostedStore.ingestEvent(event);
    const local = hostedStore.getPendingRequest(event.request!.correlationId)!;
    const beta = local.options.find(
      (option) => option.optionId === "option_beta_12345678",
    )!;
    const hostedEvent: InteractionEvent = {
      schema: "notifications.interaction-event.v1",
      id: "event_hosted_parity_12345678",
      cursor: "mcur_hosted_parity_12345678",
      type: "interaction.received",
      message_id: "message_hosted_parity_12345678",
      interaction_id: "interaction_hosted_parity_12345678",
      correlation_id: local.correlationId,
      response: { type: "select", value: beta.token },
      channel_context: {
        binding_id: "binding_synthetic_relay",
        channel: "telegram",
        conversation_kind: "private_chat",
      },
      occurred_at: answeredAt,
      expires_at: expiresAt,
    };
    const expected: ExpectedHostedRequestIdentity = {
      correlationId: local.correlationId,
      eventId: local.eventId,
      hostedMessageId: hostedEvent.message_id,
      hostedInteractionId: hostedEvent.interaction_id,
      machineId: local.machineId,
      harness: local.harness,
      sessionId: local.sessionId,
      ...(local.turnId === undefined ? {} : { turnId: local.turnId }),
      interactionType: "select",
      expiresAt,
    };
    const hosted = validateHostedAnswer({
      event: hostedEvent,
      localRequest: local,
      expected,
      stream: streamProof(),
    });
    if (hosted.outcome !== "ready") {
      throw new Error("Hosted parity answer did not validate.");
    }
    expect(hostedStore.resolveRequest(hosted.resolution)).toMatchObject({
      outcome: "answered",
    });
    expect(
      hostedStore.resolveRequest({
        ...hosted.resolution,
        answer: "terminal tried second",
        resolvedBy: "terminal",
      }),
    ).toMatchObject({ outcome: "duplicate" });

    const terminalStore = new RelayStore();
    terminalStore.ingestEvent(event);
    expect(
      terminalStore.resolveRequest({
        correlationId: local.correlationId,
        answer: "terminal won first",
        resolvedBy: "terminal",
        now: answeredAt,
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      validateHostedAnswer({
        event: hostedEvent,
        localRequest: terminalStore.getPendingRequest(local.correlationId),
        expected,
        stream: streamProof(),
      }),
    ).toEqual({
      outcome: "duplicate",
      acknowledgement: "processed",
      reasonCode: "already_resolved",
    });

    const telegramStore = new RelayStore();
    const telegramTransport = new FakeTelegramTransport();
    const telegramService = new RelayService(telegramStore, telegramTransport, {
      now: () => new Date(occurredAt),
    });
    const telegramRouter = new TelegramReplyRouter(
      telegramStore,
      telegramTransport,
      {
        operatorUserId: 7001,
        chatId: 9001,
        now: () => new Date(answeredAt),
      },
    );
    telegramService.ingest(event);
    await telegramService.drain();
    const delivery = telegramTransport.deliveries[0]!;
    const directBeta = delivery.message.interaction?.options?.find(
      (option) => option.label === "Beta",
    );
    expect(
      await telegramRouter.handle({
        update_id: 7_001,
        callback_query: {
          id: "callback_parity_12345678",
          from: { id: 7001 },
          data: `relay:${directBeta?.value ?? ""}`,
          message: {
            message_id: Number(delivery.receipt.messageId),
            message_thread_id: Number(delivery.context.topicId),
            chat: { id: 9001 },
          },
        },
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(telegramStore.getPendingRequest(local.correlationId)).toMatchObject({
      answer: "option_beta_12345678",
      resolvedBy: "telegram",
      state: "answered",
    });
    expect(hostedStore.getPendingRequest(local.correlationId)).toMatchObject({
      answer: "option_beta_12345678",
      resolvedBy: "notifications",
      state: "answered",
    });

    telegramStore.close();
    terminalStore.close();
    hostedStore.close();
  });
});
