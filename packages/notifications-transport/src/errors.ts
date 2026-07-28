import {
  NotificationsContractError,
  NotificationsProblemError,
  NotificationsProtocolError,
  NotificationsTransportError,
} from "@flowxo/notifications";
import { TransportError } from "@agent-relay/notification-contracts";

import { NotificationsMappingError } from "./mapping.js";

export type NotificationsFailureDisposition =
  "retry_same_operation" | "terminal" | "outcome_unknown";

export type NotificationsFailureCategory =
  | "retry"
  | "terminal-configuration"
  | "dead-letter-security"
  | "quarantine"
  | "operator-action";

export interface NotificationsFailurePolicy {
  category: NotificationsFailureCategory;
  retrySameOperation: boolean;
  permitNewIdentity: false;
}

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

const CONFIGURATION_FAILURE_CODES = new Set([
  "notifications-authentication-required",
  "notifications-connection-inactive",
  "notifications-credential-invalid",
  "notifications-environment-mismatch",
  "notifications-subscriber-unbound",
]);

const SECURITY_FAILURE_CODES = new Set([
  "notifications-authentication-identity-mismatch",
  "notifications-correlation-mismatch",
  "notifications-idempotency-conflict",
  "notifications-idempotency-identity-mismatch",
  "notifications-idempotency-key-required",
  "notifications-local-identity-mismatch",
  "notifications-presentation-identity-mismatch",
  "notifications-redirect-refused",
  "notifications-scope-forbidden",
  "notifications-stream-identity-failure",
]);

const QUARANTINE_FAILURE_CODES = new Set([
  "notifications-contract-integrity-failure",
  "notifications-contract-invalid",
  "notifications-protocol-malformed",
  "notifications-request-contract-invalid",
  "notifications-request-invalid",
  "notifications-schema-integrity-failure",
  "notifications-stream-order-invalid",
  "notifications-unsafe-opaque-value",
]);

const OPERATOR_ACTION_FAILURE_CODES = new Set([
  "notifications-cancellation-too-late",
  "notifications-provider-outcome-unknown",
  "notifications-provider-terminal",
  "notifications-resource-not-found",
  "notifications-resource-expired",
  "notifications-resolution-update-unsupported",
  "notifications-transport-outcome-unknown-terminal",
]);

export function notificationsFailurePolicy(
  error: Pick<
    NotificationsDeliveryError,
    "code" | "disposition" | "retryable" | "status"
  >,
): NotificationsFailurePolicy {
  if (CONFIGURATION_FAILURE_CODES.has(error.code) || error.status === 401) {
    return {
      category: "terminal-configuration",
      retrySameOperation: false,
      permitNewIdentity: false,
    };
  }
  if (
    SECURITY_FAILURE_CODES.has(error.code) ||
    error.status === 403 ||
    error.status === 409 ||
    (error.status !== undefined && error.status >= 300 && error.status < 400)
  ) {
    return {
      category: "dead-letter-security",
      retrySameOperation: false,
      permitNewIdentity: false,
    };
  }
  if (QUARANTINE_FAILURE_CODES.has(error.code)) {
    return {
      category: "quarantine",
      retrySameOperation: false,
      permitNewIdentity: false,
    };
  }
  if (
    OPERATOR_ACTION_FAILURE_CODES.has(error.code) ||
    error.disposition === "outcome_unknown" ||
    error.status === 404
  ) {
    return {
      category: "operator-action",
      retrySameOperation: false,
      permitNewIdentity: false,
    };
  }
  if (
    error.retryable ||
    error.status === 408 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return {
      category: "retry",
      retrySameOperation: true,
      permitNewIdentity: false,
    };
  }
  return {
    category: "operator-action",
    retrySameOperation: false,
    permitNewIdentity: false,
  };
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
    const status = error.status;
    if (status !== undefined && status >= 300 && status < 400) {
      return new NotificationsDeliveryError(
        "Notifications refused a credential-bearing redirect.",
        "notifications-redirect-refused",
        false,
        "terminal",
        { status },
      );
    }
    if (status === undefined || (status >= 200 && status < 300)) {
      return new NotificationsDeliveryError(
        "Notifications returned a malformed response outside the pinned contract.",
        "notifications-protocol-malformed",
        false,
        "terminal",
        { ...(status === undefined ? {} : { status }) },
      );
    }
    return new NotificationsDeliveryError(
      "Notifications returned an unclassified protocol response.",
      "notifications-protocol-unclassified",
      status >= 500 || status === 408 || status === 429,
      status >= 500 || status === 408 || status === 429
        ? "retry_same_operation"
        : "terminal",
      { status },
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
