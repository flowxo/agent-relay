import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createNotificationsContractMock,
} from "@flowxo/notifications-contract-mock";
import { describe, expect, it, vi } from "vitest";

import { NotificationsContractTransport } from "./index.js";

import type { DeliveryMessage } from "@agent-relay/core/transport";
import type { NotificationsContractMock } from "@flowxo/notifications-contract-mock";

function fetchFor(mock: NotificationsContractMock): typeof fetch {
  return async (input, init) => mock.fetch(new Request(input, init));
}

function delivery(text = "Waiting"): DeliveryMessage {
  return {
    eventId: "event_notifications_12345678",
    title: "Codex · synthetic",
    text,
    interaction: {
      type: "select",
      correlationId: "request_notifications_12345678",
      prompt: "Choose one",
      expiresAt: "2026-07-25T18:00:00.000Z",
      options: [
        { value: "decision_alpha_12345678", label: "Alpha" },
        { value: "decision_beta_12345678", label: "Beta" },
      ],
    },
  };
}

function transportFor(mock: NotificationsContractMock, fetch = fetchFor(mock)) {
  return new NotificationsContractTransport({
    baseUrl: "https://notifications.mock.test",
    credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
    subscriberId: "agent_relay_operator",
    notifierId: "default",
    fetch,
  });
}

describe("Notifications contract transport", () => {
  it("uses one stable event identity for idempotency and correlation", async () => {
    const mock = createNotificationsContractMock({
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

  it("rejects a changed payload under the same event identity", async () => {
    const mock = createNotificationsContractMock({
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
      code: "notifications-idempotency-conflict",
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
    const mock = createNotificationsContractMock();
    const transport = transportFor(mock, fetchMock);
    const message = delivery();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        transport.deliver(message, { idempotencyKey: message.eventId }),
      ).rejects.toMatchObject({
        code: "notifications-transport-outcome-unknown",
        retryable: true,
        disposition: "retry_same_operation",
      });
    }
    expect(keys).toEqual([message.eventId, message.eventId]);
  });

  it("surfaces provider outcome_unknown as terminal for automatic sends", async () => {
    const mock = createNotificationsContractMock({
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
      code: "notifications-provider-outcome-unknown",
      retryable: false,
      disposition: "outcome_unknown",
    });
    expect(mock.inspect().messages).toHaveLength(1);
  });

  it("rejects any idempotency key other than the stable event ID before fetch", async () => {
    const mock = createNotificationsContractMock();
    const fetchMock = vi.fn(fetchFor(mock));
    const transport = transportFor(mock, fetchMock);
    await expect(
      transport.deliver(delivery(), {
        idempotencyKey: "event_other_12345678",
      }),
    ).rejects.toMatchObject({
      code: "notifications-idempotency-identity-mismatch",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported local projection as terminal before fetch", async () => {
    const mock = createNotificationsContractMock();
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
      code: "notifications-select-capability-unsupported",
      retryable: false,
      disposition: "terminal",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
