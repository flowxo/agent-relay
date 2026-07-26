import {
  NotificationsContractError,
  NotificationsProblemError,
  NotificationsProtocolError,
  NotificationsTransportError,
} from "@flowxo/notifications";
import { TransportError } from "@agent-relay/core/transport";

import { NotificationsMappingError } from "./mapping.js";

export type NotificationsFailureDisposition =
  "retry_same_operation" | "terminal" | "outcome_unknown";

export class NotificationsDeliveryError extends TransportError {
  public override readonly name = "NotificationsDeliveryError";
  public readonly diagnosticId?: string;
  public readonly hostedMessageId?: string;
  public readonly retryAt?: string;

  public constructor(
    message: string,
    code: string,
    retryable: boolean,
    public readonly disposition: NotificationsFailureDisposition,
    options: {
      diagnosticId?: string;
      hostedMessageId?: string;
      retryAt?: string;
      status?: number;
    } = {},
  ) {
    super(message, code, retryable, options.status);
    if (options.diagnosticId !== undefined) {
      this.diagnosticId = options.diagnosticId;
    }
    if (options.hostedMessageId !== undefined) {
      this.hostedMessageId = options.hostedMessageId;
    }
    if (options.retryAt !== undefined) {
      this.retryAt = options.retryAt;
    }
  }
}

const SAFE_PROBLEM_MESSAGES = {
  authentication_required: "Notifications authentication is required.",
  cancellation_too_late:
    "The Notifications operation can no longer be canceled.",
  credential_invalid: "The Notifications credential is invalid or revoked.",
  environment_mismatch:
    "The Notifications credential targets another environment.",
  idempotency_conflict:
    "Notifications rejected a conflicting idempotent operation.",
  idempotency_key_required: "Notifications requires an idempotency key.",
  provider_outcome_unknown:
    "Notifications cannot prove the provider outcome; no new hosted send is permitted.",
  provider_retryable: "Notifications reported a retryable provider failure.",
  provider_terminal: "Notifications reported a terminal provider rejection.",
  rate_limited: "Notifications rate limited the request.",
  request_invalid: "Notifications rejected the request contract.",
  resource_expired: "The Notifications resource has expired.",
  resource_not_found: "The Notifications resource was not found.",
  scope_forbidden: "The Notifications credential lacks the required scope.",
  subscriber_unbound: "The Notifications subscriber is not bound.",
} as const;

export function asNotificationsDeliveryError(
  error: unknown,
): NotificationsDeliveryError {
  if (error instanceof NotificationsDeliveryError) {
    return error;
  }
  if (error instanceof NotificationsProblemError) {
    const outcomeUnknown = error.problem.code === "provider_outcome_unknown";
    const retryable = !outcomeUnknown && error.retryable;
    return new NotificationsDeliveryError(
      SAFE_PROBLEM_MESSAGES[error.problem.code],
      `notifications-${error.problem.code.replaceAll("_", "-")}`,
      retryable,
      outcomeUnknown
        ? "outcome_unknown"
        : retryable
          ? "retry_same_operation"
          : "terminal",
      {
        diagnosticId: error.diagnosticId,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        status: error.status,
      },
    );
  }
  if (error instanceof NotificationsTransportError) {
    return new NotificationsDeliveryError(
      "The Notifications response was not received; retry only with the original event identity.",
      error.outcomeUnknown
        ? "notifications-transport-outcome-unknown"
        : "notifications-transport-unavailable",
      true,
      "retry_same_operation",
    );
  }
  if (error instanceof NotificationsContractError) {
    return new NotificationsDeliveryError(
      "Notifications returned data outside the pinned contract.",
      "notifications-contract-invalid",
      false,
      "terminal",
    );
  }
  if (error instanceof NotificationsProtocolError) {
    return new NotificationsDeliveryError(
      "Notifications returned an unclassified protocol response.",
      "notifications-protocol-unclassified",
      true,
      "retry_same_operation",
      { ...(error.status === undefined ? {} : { status: error.status }) },
    );
  }
  if (error instanceof NotificationsMappingError) {
    return new NotificationsDeliveryError(
      "Agent Relay cannot safely project this interaction into the pinned Notifications contract.",
      error.code,
      false,
      "terminal",
    );
  }
  return new NotificationsDeliveryError(
    "Notifications delivery failed with an unclassified response.",
    "notifications-unclassified",
    true,
    "retry_same_operation",
  );
}
