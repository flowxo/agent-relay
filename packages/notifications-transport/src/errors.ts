import {
  WhooshBangContractError,
  WhooshBangProblemError,
  WhooshBangProtocolError,
  WhooshBangTransportError,
} from "@whooshbang/sdk";
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
  authentication_required: "WhooshBang authentication is required.",
  cancellation_too_late: "The WhooshBang operation can no longer be canceled.",
  credential_invalid: "The WhooshBang credential is invalid or revoked.",
  environment_mismatch:
    "The WhooshBang credential targets another environment.",
  idempotency_conflict:
    "WhooshBang rejected a conflicting idempotent operation.",
  idempotency_key_required: "WhooshBang requires an idempotency key.",
  project_slug_conflict: "WhooshBang rejected the requested project slug.",
  provider_outcome_unknown:
    "WhooshBang cannot prove the provider outcome; no new hosted send is permitted.",
  provider_retryable: "WhooshBang reported a retryable provider failure.",
  provider_terminal: "WhooshBang reported a terminal provider rejection.",
  rate_limited: "WhooshBang rate limited the request.",
  request_invalid: "WhooshBang rejected the request contract.",
  resource_expired: "The WhooshBang resource has expired.",
  resource_not_found: "The WhooshBang resource was not found.",
  scope_forbidden: "The WhooshBang credential lacks the required scope.",
  subscriber_unbound: "The WhooshBang subscriber is not bound.",
} as const;

export function asNotificationsDeliveryError(
  error: unknown,
): NotificationsDeliveryError {
  if (error instanceof NotificationsDeliveryError) {
    return error;
  }
  if (error instanceof WhooshBangProblemError) {
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
  if (error instanceof WhooshBangTransportError) {
    return new NotificationsDeliveryError(
      "The WhooshBang response was not received; retry only with the original event identity.",
      error.outcomeUnknown
        ? "notifications-transport-outcome-unknown"
        : "notifications-transport-unavailable",
      true,
      "retry_same_operation",
    );
  }
  if (error instanceof WhooshBangContractError) {
    return new NotificationsDeliveryError(
      "WhooshBang returned data outside the pinned contract.",
      "notifications-contract-invalid",
      false,
      "terminal",
    );
  }
  if (error instanceof WhooshBangProtocolError) {
    const status = error.status;
    if (status !== undefined && status >= 300 && status < 400) {
      return new NotificationsDeliveryError(
        "WhooshBang refused a credential-bearing redirect.",
        "notifications-redirect-refused",
        false,
        "terminal",
        { status },
      );
    }
    if (status === undefined || (status >= 200 && status < 300)) {
      return new NotificationsDeliveryError(
        "WhooshBang returned a malformed response outside the pinned contract.",
        "notifications-protocol-malformed",
        false,
        "terminal",
        { ...(status === undefined ? {} : { status }) },
      );
    }
    return new NotificationsDeliveryError(
      "WhooshBang returned an unclassified protocol response.",
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
      "Agent Relay cannot safely project this interaction into the pinned WhooshBang contract.",
      error.code,
      false,
      "terminal",
    );
  }
  return new NotificationsDeliveryError(
    "WhooshBang delivery failed with an unclassified response.",
    "notifications-unclassified",
    true,
    "retry_same_operation",
  );
}
