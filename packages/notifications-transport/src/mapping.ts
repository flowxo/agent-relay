import { validateCreateMessageRequest } from "@whooshbang/contracts";

import type { CreateMessageRequest } from "@whooshbang/sdk";
import type {
  DeliveryInteraction,
  DeliveryMessage,
} from "@agent-relay/notification-contracts";

const SAFE_OPAQUE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export class NotificationsMappingError extends Error {
  public override readonly name = "NotificationsMappingError";

  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export interface NotificationsMessageTarget {
  subscriberId: string;
  notifierId?: string;
}

function assertOpaqueValue(value: string, label: string): void {
  if (!SAFE_OPAQUE_VALUE.test(value)) {
    throw new NotificationsMappingError(
      `${label} must be an opaque, non-executable identifier.`,
      "notifications-unsafe-opaque-value",
    );
  }
}

function mapInteraction(
  interaction: DeliveryInteraction,
): NonNullable<CreateMessageRequest["interaction"]> {
  assertOpaqueValue(interaction.correlationId, "Interaction correlation");
  if (interaction.type === "input") {
    if (interaction.options !== undefined && interaction.options.length !== 0) {
      throw new NotificationsMappingError(
        "Input interactions cannot carry options.",
        "notifications-input-options-unsupported",
      );
    }
    return {
      type: "input",
      prompt: interaction.prompt,
      expires_at: interaction.expiresAt,
      correlation_id: interaction.correlationId,
    };
  }
  const options = interaction.options ?? [];
  if (interaction.type === "confirm") {
    if (options.length !== 2) {
      throw new NotificationsMappingError(
        "Confirm interactions require exactly two local choices.",
        "notifications-confirm-options-invalid",
      );
    }
    for (const option of options) {
      assertOpaqueValue(option.value, "Confirm option value");
    }
    return {
      type: "confirm",
      prompt: interaction.prompt,
      confirm_label: options[0]!.label,
      deny_label: options[1]!.label,
      expires_at: interaction.expiresAt,
      correlation_id: interaction.correlationId,
    };
  }
  if (options.length < 2 || options.length > 6) {
    throw new NotificationsMappingError(
      "WhooshBang select supports two through six options; a wider request must retain its negotiated local fallback.",
      "notifications-select-capability-unsupported",
    );
  }
  for (const option of options) {
    assertOpaqueValue(option.value, "Select option value");
  }
  return {
    type: "select",
    prompt: interaction.prompt,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
    })) as NonNullable<
      Extract<
        NonNullable<CreateMessageRequest["interaction"]>,
        { type: "select" }
      >["options"]
    >,
    expires_at: interaction.expiresAt,
    correlation_id: interaction.correlationId,
  };
}

export function renderNotificationsBody(message: DeliveryMessage): string {
  return `${message.title}\n\n${message.text}`;
}

export function mapDeliveryMessageToNotifications(
  message: DeliveryMessage,
  target: NotificationsMessageTarget,
): CreateMessageRequest {
  assertOpaqueValue(message.eventId, "Event ID");
  if (message.multiSelect !== undefined) {
    throw new NotificationsMappingError(
      "Multi-select remains on its negotiated local presentation until WhooshBang advertises equivalent capability.",
      "notifications-multi-select-unsupported",
    );
  }
  if (
    message.questionSet !== undefined &&
    (message.questionSet.total !== 1 ||
      message.questionSet.kind === "multi-select")
  ) {
    throw new NotificationsMappingError(
      "Ordered or multi-select question sets cannot be flattened into one hosted answer.",
      "notifications-question-set-unsupported",
    );
  }
  if (message.interaction === undefined && message.questionSet !== undefined) {
    throw new NotificationsMappingError(
      "The structured request has no compatible WhooshBang interaction projection.",
      "notifications-question-set-projection-missing",
    );
  }

  const request: CreateMessageRequest = {
    to: { subscriber_id: target.subscriberId },
    ...(target.notifierId === undefined
      ? {}
      : { notifier_id: target.notifierId }),
    content: {
      type: "text",
      text: renderNotificationsBody(message),
    },
    correlation_id: message.eventId,
    ...(message.interaction === undefined
      ? {}
      : {
          expires_at: message.interaction.expiresAt,
          interaction: mapInteraction(message.interaction),
        }),
  };
  if (!validateCreateMessageRequest(request)) {
    throw new NotificationsMappingError(
      "The Agent Relay projection does not match the pinned WhooshBang contract.",
      "notifications-request-contract-invalid",
    );
  }
  return request;
}
