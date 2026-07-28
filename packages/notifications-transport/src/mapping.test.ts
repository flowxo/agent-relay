import { describe, expect, it } from "vitest";

import {
  mapDeliveryMessageToNotifications,
  renderNotificationsBody,
} from "./mapping.js";

import type { DeliveryMessage } from "@agent-relay/notification-contracts";
import type { NotificationsMappingError } from "./mapping.js";

const expiresAt = "2026-07-25T18:00:00.000Z";

function message(
  interaction: NonNullable<DeliveryMessage["interaction"]>,
): DeliveryMessage {
  return {
    eventId: "event_delivery_12345678",
    title: "Codex · synthetic",
    text: "Input required",
    interaction,
    actions: [
      {
        kind: "details",
        token: "card_0123456789abcdef0123456789abcdef",
        label: "rm -rf /tmp/private-session",
      },
    ],
  };
}

describe("Notifications delivery mapping", () => {
  it("projects confirm, select, and input without provider or executable data", () => {
    const confirm = mapDeliveryMessageToNotifications(
      message({
        type: "confirm",
        correlationId: "request_confirm_12345678",
        prompt: "Approve?",
        expiresAt,
        options: [
          { value: "decision_confirm_12345678", label: "Approve" },
          { value: "decision_decline_12345678", label: "Deny" },
        ],
      }),
      { subscriberId: "agent_relay_operator", notifierId: "default" },
    );
    const select = mapDeliveryMessageToNotifications(
      message({
        type: "select",
        correlationId: "request_select_12345678",
        prompt: "Choose one",
        expiresAt,
        options: [
          { value: "decision_alpha_12345678", label: "Alpha" },
          { value: "decision_beta_12345678", label: "Beta" },
        ],
      }),
      { subscriberId: "agent_relay_operator" },
    );
    const input = mapDeliveryMessageToNotifications(
      message({
        type: "input",
        correlationId: "request_input_12345678",
        prompt: "What next?",
        expiresAt,
      }),
      { subscriberId: "agent_relay_operator" },
    );

    expect(confirm).toMatchObject({
      correlation_id: "event_delivery_12345678",
      content: {
        type: "text",
        text: "Codex · synthetic\n\nInput required",
      },
      expires_at: expiresAt,
      interaction: {
        type: "confirm",
        correlation_id: "request_confirm_12345678",
        confirm_label: "Approve",
        deny_label: "Deny",
      },
    });
    expect(select.interaction).toMatchObject({
      type: "select",
      correlation_id: "request_select_12345678",
      options: [
        { value: "decision_alpha_12345678", label: "Alpha" },
        { value: "decision_beta_12345678", label: "Beta" },
      ],
    });
    expect(input.interaction).toMatchObject({
      type: "input",
      correlation_id: "request_input_12345678",
    });
    for (const request of [confirm, select, input]) {
      const serialized = JSON.stringify(request);
      expect(serialized).not.toContain("rm -rf");
      expect(serialized).not.toContain("/tmp/private-session");
      expect(serialized).not.toContain("card_0123456789");
      expect(request).not.toHaveProperty("metadata");
    }
  });

  it("renders title, exactly one blank line, and text deterministically", () => {
    const delivery = message({
      type: "input",
      correlationId: "request_input_12345678",
      prompt: "Continue?",
      expiresAt,
    });
    expect(renderNotificationsBody(delivery)).toBe(
      "Codex · synthetic\n\nInput required",
    );
    expect(renderNotificationsBody(delivery)).toBe(
      renderNotificationsBody(delivery),
    );
  });

  it("rejects multi-select and ordered-set flattening", () => {
    const multi: DeliveryMessage = {
      eventId: "event_multi_12345678",
      title: "Synthetic",
      text: "Choose several",
      multiSelect: {
        options: [
          {
            value: "decision_alpha_12345678",
            label: "Alpha",
            selected: false,
          },
          {
            value: "decision_beta_12345678",
            label: "Beta",
            selected: false,
          },
        ],
        minSelections: 1,
        maxSelections: 2,
        submitToken: "submit_multi_12345678",
        cancelToken: "cancel_multi_12345678",
      },
    };
    const ordered: DeliveryMessage = {
      ...message({
        type: "select",
        correlationId: "request_ordered_12345678",
        prompt: "First",
        expiresAt,
        options: [
          { value: "decision_alpha_12345678", label: "Alpha" },
          { value: "decision_beta_12345678", label: "Beta" },
        ],
      }),
      questionSet: {
        requestId: "request_ordered_12345678",
        questionId: "question_first_12345678",
        kind: "single-select",
        presentationMode: "buttons",
        requestTitle: "Ordered request",
        prompt: "First",
        position: 1,
        total: 2,
        options: [
          {
            value: "decision_alpha_12345678",
            label: "Alpha",
            selected: false,
          },
          {
            value: "decision_beta_12345678",
            label: "Beta",
            selected: false,
          },
        ],
        submitToken: "submit_ordered_12345678",
        cancelToken: "cancel_ordered_12345678",
      },
    };

    expect(() =>
      mapDeliveryMessageToNotifications(multi, {
        subscriberId: "agent_relay_operator",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationsMappingError>>({
        code: "notifications-multi-select-unsupported",
      }),
    );
    expect(() =>
      mapDeliveryMessageToNotifications(ordered, {
        subscriberId: "agent_relay_operator",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationsMappingError>>({
        code: "notifications-question-set-unsupported",
      }),
    );
  });

  it("rejects wider hosted selections and executable-looking option values", () => {
    const tooWide = message({
      type: "select",
      correlationId: "request_select_12345678",
      prompt: "Choose",
      expiresAt,
      options: Array.from({ length: 7 }, (_, index) => ({
        value: `decision_${String(index).padStart(16, "0")}`,
        label: `Choice ${String(index)}`,
      })),
    });
    const executable = message({
      type: "select",
      correlationId: "request_select_12345678",
      prompt: "Choose",
      expiresAt,
      options: [
        { value: "rm -rf /", label: "Unsafe" },
        { value: "decision_safe_12345678", label: "Safe" },
      ],
    });
    expect(() =>
      mapDeliveryMessageToNotifications(tooWide, {
        subscriberId: "agent_relay_operator",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationsMappingError>>({
        code: "notifications-select-capability-unsupported",
      }),
    );
    expect(() =>
      mapDeliveryMessageToNotifications(executable, {
        subscriberId: "agent_relay_operator",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationsMappingError>>({
        code: "notifications-unsafe-opaque-value",
      }),
    );
  });
});
