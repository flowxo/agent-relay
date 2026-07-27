import {
  CONTRACT_MOCK_FIXTURE_CREDENTIALS,
  createNotificationsContractMock,
} from "@flowxo/notifications-contract-mock";
import { describe, expect, it, vi } from "vitest";

import { NotificationsMachineInteractionSource } from "./interaction-source.js";

import type { InteractionEvent } from "@flowxo/notifications-contracts";

const event: InteractionEvent = {
  schema: "notifications.interaction-event.v1",
  id: "event_interaction_source_12345678",
  cursor: "mcur_interaction_source_12345678",
  type: "interaction.received",
  message_id: "message_interaction_source_12345678",
  interaction_id: "interaction_source_12345678",
  correlation_id: "request_interaction_source_12345678",
  response: { type: "input", value: "bounded synthetic response" },
  channel_context: {
    binding_id: "binding_synthetic_relay",
    channel: "telegram",
    conversation_kind: "private_chat",
  },
  occurred_at: "2026-07-26T20:00:00.000Z",
  expires_at: "2026-07-26T20:30:00.000Z",
};

describe("Notifications machine interaction source", () => {
  it("polls and acknowledges the pinned authenticated contract", async () => {
    const mock = createNotificationsContractMock({ scenario: "nominal" });
    mock.control.enqueueMachineEvent({
      event,
      machineClientId: "machine_client_synthetic_001",
      quarantinable: true,
      signatureValid: true,
      streamIdentityValid: true,
    });
    const source = new NotificationsMachineInteractionSource({
      baseUrl: "https://notifications.mock.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      fetch: async (input, init) => await mock.fetch(new Request(input, init)),
    });
    const signal = new AbortController().signal;

    const batch = await source.poll({
      limit: 10,
      waitSeconds: 0,
      signal,
    });
    expect(batch).toMatchObject({
      committed_cursor: null,
      events: [{ id: event.id, cursor: event.cursor }],
    });
    await expect(
      source.acknowledge({
        eventId: event.id,
        cursor: event.cursor,
        disposition: "quarantined",
        reasonCode: "invalid_answer",
        signal,
      }),
    ).resolves.toMatchObject({
      event_id: event.id,
      cursor: event.cursor,
      disposition: "quarantined",
      committed_cursor: event.cursor,
      advanced: true,
    });
    expect(mock.inspect().cursorCommits).toHaveLength(1);
  });

  it("forces manual redirect handling and classifies transport failures", async () => {
    const redirects: Array<string | undefined> = [];
    const source = new NotificationsMachineInteractionSource({
      baseUrl: "https://notifications.example.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      fetch: vi.fn(async (_input, init) => {
        redirects.push(init?.redirect);
        return new Response(
          JSON.stringify({
            schema: "notifications.machine-events.v1",
            events: [],
            committed_cursor: null,
            server_time: "2026-07-26T20:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });
    await expect(
      source.poll({
        limit: 1,
        waitSeconds: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ events: [] });
    expect(redirects).toEqual(["manual"]);

    const unavailable = new NotificationsMachineInteractionSource({
      baseUrl: "https://notifications.example.test",
      credential: CONTRACT_MOCK_FIXTURE_CREDENTIALS.machineA,
      fetch: async () => {
        throw new Error("private synthetic network failure");
      },
    });
    await expect(
      unavailable.poll({
        limit: 1,
        waitSeconds: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "notifications-transport-unavailable",
      disposition: "retry_same_operation",
      retryable: true,
    });
  });
});
