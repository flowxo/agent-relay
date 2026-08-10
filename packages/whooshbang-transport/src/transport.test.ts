import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createWhooshBangContractMock,
} from "@whooshbang/contract-mock";
import { WhooshBangClient } from "@whooshbang/sdk";
import { describe, expect, it, vi } from "vitest";

import { WhooshBangContractTransport } from "./index.js";

import type { DeliveryMessage } from "@agent-relay/notification-contracts";
import type { WhooshBangContractMock } from "@whooshbang/contract-mock";

function fetchFor(mock: WhooshBangContractMock): typeof fetch {
  return async (input, init) => mock.fetch(new Request(input, init));
}

function delivery(text = "Waiting"): DeliveryMessage {
  return {
    eventId: "event_whooshbang_12345678",
    title: "Codex · synthetic",
    text,
    interaction: {
      type: "select",
      correlationId: "request_whooshbang_12345678",
      prompt: "Choose one",
      expiresAt: "2026-07-25T18:00:00.000Z",
      options: [
        { value: "decision_alpha_12345678", label: "Alpha" },
        { value: "decision_beta_12345678", label: "Beta" },
      ],
    },
  };
}

function transportFor(mock: WhooshBangContractMock, fetch = fetchFor(mock)) {
  return new WhooshBangContractTransport({
    baseUrl: "https://whooshbang.mock.test",
    credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
    machineClientId: "machine_client_synthetic_001",
    subscriberId: "agent_relay_operator",
    notifierId: "default",
    fetch,
  });
}

describe("WhooshBang contract transport", () => {
  it("advertises only interaction behavior proven by the pinned contract", () => {
    const transport = transportFor(createWhooshBangContractMock());

    expect(
      transport.observeInteractionCapabilities("2026-07-25T17:45:00.000Z"),
    ).toEqual({
      schema: "agent-interaction-provider-observation.v1",
      capabilities: {
        schema: "agent-interaction-capabilities.v1",
        providerId: "transport_flowxo_whooshbang",
        providerKind: "transport",
        observedAt: "2026-07-25T17:45:00.000Z",
        features: ["confirm", "single-select", "free-text"],
        presentationModes: ["buttons", "direct-text"],
        limits: {
          maxQuestions: 1,
          maxOptionsPerQuestion: 6,
          maxTextLength: 3_000,
          maxPayloadBytes: 8_192,
        },
      },
      status: "proven",
      evidence: "official-docs",
      observedVersion: "@whooshbang/sdk@1.0.0-rc.13",
      fixture: "interaction-machine-semantic-scenarios@1.0.0-rc.12",
      note: "The pinned hosted contract proves confirm, single-select, and input. It does not expose durable drafts, ordered or multi-select sets, or resolved-message updates.",
    });
  });

  it("uses one stable event identity for idempotency and correlation", async () => {
    const mock = createWhooshBangContractMock({
      scenario: "repeated-idempotent-message",
    });
    const transport = transportFor(mock);
    const message = delivery();

    const first = await transport.deliver(message, {
      idempotencyKey: message.eventId,
    });
    const second = await transport.deliver(message, {
      idempotencyKey: message.eventId,
    });
    expect(second).toEqual(first);
    expect(mock.inspect().messages).toHaveLength(1);
    expect(mock.inspect().messages[0]).toMatchObject({
      id: first.messageId,
      correlation_id: message.eventId,
    });
    expect(transport.getHostedDeliveryIdentity(message.eventId)).toMatchObject({
      eventId: message.eventId,
      messageId: first.messageId,
      interactionId: mock.inspect().messages[0]?.interaction?.id,
    });
  });

  it("ignores unknown optional response fields while retaining known identity", async () => {
    const mock = createWhooshBangContractMock();
    const additiveFetch: typeof fetch = async (input, init) => {
      const response = await fetchFor(mock)(input, init);
      const body = (await response.json()) as Record<string, unknown>;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(
        JSON.stringify({
          ...body,
          future_optional_response: {
            synthetic: true,
          },
        }),
        {
          headers,
          status: response.status,
        },
      );
    };
    const transport = transportFor(mock, additiveFetch);
    const message = delivery();
    const receipt = await transport.deliver(message, {
      idempotencyKey: message.eventId,
    });

    expect(receipt).toMatchObject({
      transport: "whooshbang",
      messageId: mock.inspect().messages[0]?.id,
    });
    expect(transport.getHostedDeliveryIdentity(message.eventId)).toMatchObject({
      eventId: message.eventId,
      messageId: receipt.messageId,
    });
  });

  it("tolerates additive fields on a known machine event", async () => {
    const additiveEvent = {
      schema: "whooshbang.interaction-event.v1",
      id: "event_additive_12345678",
      cursor: "mcur_additive_12345678",
      type: "interaction.received",
      message_id: "message_additive_12345678",
      interaction_id: "interaction_additive_12345678",
      correlation_id: "request_additive_12345678",
      response: {
        type: "input",
        value: "continue safely",
        future_response_evidence: "synthetic",
      },
      channel_context: {
        binding_id: "binding_additive_12345678",
        channel: "telegram",
        conversation_kind: "private_chat",
        future_channel_evidence: "synthetic",
      },
      occurred_at: "2026-07-25T17:50:00.000Z",
      expires_at: "2026-07-25T18:00:00.000Z",
      future_event_evidence: "synthetic",
    };
    const client = new WhooshBangClient({
      baseUrl: "https://whooshbang.mock.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      fetch: async () =>
        new Response(
          JSON.stringify({
            schema: "whooshbang.machine-events.v1",
            events: [additiveEvent],
            committed_cursor: null,
            server_time: "2026-07-25T17:50:00.000Z",
            future_batch_evidence: "synthetic",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    });

    const batch = await client.pollMachineEvents({ wait: 0 });
    expect(batch).toMatchObject({
      future_batch_evidence: "synthetic",
      events: [
        {
          id: additiveEvent.id,
          future_event_evidence: "synthetic",
          response: {
            type: "input",
            value: "continue safely",
          },
        },
      ],
    });
  });

  it("rejects a changed payload under the same event identity", async () => {
    const mock = createWhooshBangContractMock({
      scenario: "idempotency-conflict",
    });
    const transport = transportFor(mock);
    const message = delivery();
    await transport.deliver(message, { idempotencyKey: message.eventId });
    await expect(
      transport.deliver(delivery("Different"), {
        idempotencyKey: message.eventId,
      }),
    ).rejects.toMatchObject({
      code: "whooshbang-idempotency-conflict",
      retryable: false,
      disposition: "terminal",
    });
    expect(mock.inspect().messages).toHaveLength(1);
  });

  it("retries an uncertain connection only with the unchanged idempotency key", async () => {
    const keys: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      throw new Error("synthetic connection loss");
    });
    const mock = createWhooshBangContractMock();
    const transport = transportFor(mock, fetchMock);
    const message = delivery();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        transport.deliver(message, { idempotencyKey: message.eventId }),
      ).rejects.toMatchObject({
        code: "whooshbang-transport-outcome-unknown",
        retryable: true,
        disposition: "retry_same_operation",
      });
    }
    expect(keys).toEqual([message.eventId, message.eventId]);
    expect(transport.circuitState()).toEqual({
      blocked: false,
      suppressedDeliveries: 0,
    });
  });

  it("blocks repeated network calls after a terminal credential failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(
        JSON.stringify({
          type: "https://whooshbang.flowxo.com/problems/credential_invalid",
          title: "Credential invalid",
          status: 401,
          detail: "synthetic private provider detail",
          code: "credential_invalid",
          diagnostic_id: "diagnostic_transport_12345678",
          retryable: false,
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 401,
        },
      );
    });
    const transport = transportFor(createWhooshBangContractMock(), fetchMock);
    const first = delivery();
    const second = {
      ...delivery(),
      eventId: "event_whooshbang_second_12345678",
    };

    await expect(
      transport.deliver(first, { idempotencyKey: first.eventId }),
    ).rejects.toMatchObject({
      code: "whooshbang-credential-invalid",
      retryable: false,
    });
    await expect(
      transport.deliver(second, { idempotencyKey: second.eventId }),
    ).rejects.toMatchObject({
      code: "whooshbang-credential-invalid",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.circuitState()).toEqual({
      blocked: true,
      errorCode: "whooshbang-credential-invalid",
      suppressedDeliveries: 1,
    });
  });

  it("stops new hosted sends after the local connection becomes inactive", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const transport = new WhooshBangContractTransport({
      baseUrl: "https://whooshbang.example.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      machineClientId: "machine_client_synthetic_001",
      subscriberId: "agent_relay_operator",
      connectionGuard: async () => false,
      fetch: fetchMock,
    });
    const message = delivery();
    await expect(
      transport.deliver(message, { idempotencyKey: message.eventId }),
    ).rejects.toMatchObject({
      code: "whooshbang-connection-inactive",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transport.circuitState()).toEqual({
      blocked: true,
      errorCode: "whooshbang-connection-inactive",
      suppressedDeliveries: 0,
    });
  });

  it("refuses remote HTTP and never follows a credential-bearing redirect", async () => {
    expect(
      () =>
        new WhooshBangContractTransport({
          baseUrl: "http://whooshbang.example.test",
          credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
          machineClientId: "machine_client_synthetic_001",
          subscriberId: "agent_relay_operator",
        }),
    ).toThrow("HTTPS");

    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: { location: "https://untrusted.example.test/capture" },
        status: 307,
      });
    });
    const transport = transportFor(createWhooshBangContractMock(), fetchMock);
    const message = delivery();
    await expect(
      transport.deliver(message, { idempotencyKey: message.eventId }),
    ).rejects.toMatchObject({
      code: "whooshbang-redirect-refused",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider outcome_unknown as terminal for automatic sends", async () => {
    const mock = createWhooshBangContractMock({
      scenario: "ambiguous-provider-outcome",
    });
    const transport = transportFor(mock);
    const message = delivery();

    const receipt = await transport.deliver(message, {
      idempotencyKey: message.eventId,
    });
    await mock.control.runPending();
    await expect(
      transport.diagnoseMessage(receipt.messageId),
    ).rejects.toMatchObject({
      code: "whooshbang-provider-outcome-unknown",
      retryable: false,
      disposition: "outcome_unknown",
    });
    expect(mock.inspect().messages).toHaveLength(1);
  });

  it("rejects any idempotency key other than the stable event ID before fetch", async () => {
    const mock = createWhooshBangContractMock();
    const fetchMock = vi.fn(fetchFor(mock));
    const transport = transportFor(mock, fetchMock);
    await expect(
      transport.deliver(delivery(), {
        idempotencyKey: "event_other_12345678",
      }),
    ).rejects.toMatchObject({
      code: "whooshbang-idempotency-identity-mismatch",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported local projection as terminal before fetch", async () => {
    const mock = createWhooshBangContractMock();
    const fetchMock = vi.fn(fetchFor(mock));
    const transport = transportFor(mock, fetchMock);
    const message = delivery();
    message.interaction = {
      ...message.interaction!,
      options: Array.from({ length: 7 }, (_, index) => ({
        value: `decision_${String(index).padStart(16, "0")}`,
        label: `Choice ${String(index)}`,
      })),
    };

    await expect(
      transport.deliver(message, { idempotencyKey: message.eventId }),
    ).rejects.toMatchObject({
      code: "whooshbang-select-capability-unsupported",
      retryable: false,
      disposition: "terminal",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
