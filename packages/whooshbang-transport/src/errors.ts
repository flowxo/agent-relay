import {
  WhooshBangContractError,
  WhooshBangProblemError,
  WhooshBangProtocolError,
  WhooshBangTransportError,
} from "@whooshbang/sdk";
import { TransportError } from "@agent-relay/notification-contracts";

import { WhooshBangMappingError } from "./mapping.js";

export type WhooshBangFailureDisposition =
  "retry_same_operation" | "terminal" | "outcome_unknown";

export type WhooshBangFailureCategory =
  | "retry"
  | "terminal-configuration"
  | "dead-letter-security"
  | "quarantine"
  | "operator-action";

export interface WhooshBangFailurePolicy {
  category: WhooshBangFailureCategory;
  retrySameOperation: boolean;
  permitNewIdentity: false;
}

export class WhooshBangDeliveryError extends TransportError {
  public override readonly name = "WhooshBangDeliveryError";
  public readonly diagnosticId?: string;
  public readonly hostedMessageId?: string;
  public readonly retryAt?: string;

  public constructor(
    message: string,
    code: string,
    retryable: boolean,
    public readonly disposition: WhooshBangFailureDisposition,
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
  "whooshbang-authentication-required",
  "whooshbang-connection-inactive",
  "whooshbang-credential-invalid",
  "whooshbang-environment-mismatch",
  "whooshbang-subscriber-unbound",
]);

const SECURITY_FAILURE_CODES = new Set([
  "whooshbang-authentication-identity-mismatch",
  "whooshbang-correlation-mismatch",
  "whooshbang-idempotency-conflict",
  "whooshbang-idempotency-identity-mismatch",
  "whooshbang-idempotency-key-required",
  "whooshbang-local-identity-mismatch",
  "whooshbang-presentation-identity-mismatch",
  "whooshbang-redirect-refused",
  "whooshbang-scope-forbidden",
  "whooshbang-stream-identity-failure",
]);

const QUARANTINE_FAILURE_CODES = new Set([
  "whooshbang-contract-integrity-failure",
  "whooshbang-contract-invalid",
  "whooshbang-protocol-malformed",
  "whooshbang-request-contract-invalid",
  "whooshbang-request-invalid",
  "whooshbang-schema-integrity-failure",
  "whooshbang-stream-order-invalid",
  "whooshbang-unsafe-opaque-value",
]);

const OPERATOR_ACTION_FAILURE_CODES = new Set([
  "whooshbang-cancellation-too-late",
  "whooshbang-provider-outcome-unknown",
  "whooshbang-provider-terminal",
  "whooshbang-resource-not-found",
  "whooshbang-resource-expired",
  "whooshbang-resolution-update-unsupported",
  "whooshbang-transport-outcome-unknown-terminal",
]);

export function whooshbangFailurePolicy(
  error: Pick<
    WhooshBangDeliveryError,
    "code" | "disposition" | "retryable" | "status"
  >,
): WhooshBangFailurePolicy {
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

export function asWhooshBangDeliveryError(
  error: unknown,
): WhooshBangDeliveryError {
  if (error instanceof WhooshBangDeliveryError) {
    return error;
  }
  if (error instanceof WhooshBangProblemError) {
    const outcomeUnknown = error.problem.code === "provider_outcome_unknown";
    const retryable = !outcomeUnknown && error.retryable;
    return new WhooshBangDeliveryError(
      SAFE_PROBLEM_MESSAGES[error.problem.code],
      `whooshbang-${error.problem.code.replaceAll("_", "-")}`,
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
    return new WhooshBangDeliveryError(
      "The WhooshBang response was not received; retry only with the original event identity.",
      error.outcomeUnknown
        ? "whooshbang-transport-outcome-unknown"
        : "whooshbang-transport-unavailable",
      true,
      "retry_same_operation",
    );
  }
  if (error instanceof WhooshBangContractError) {
    return new WhooshBangDeliveryError(
      "WhooshBang returned data outside the pinned contract.",
      "whooshbang-contract-invalid",
      false,
      "terminal",
    );
  }
  if (error instanceof WhooshBangProtocolError) {
    const status = error.status;
    if (status !== undefined && status >= 300 && status < 400) {
      return new WhooshBangDeliveryError(
        "WhooshBang refused a credential-bearing redirect.",
        "whooshbang-redirect-refused",
        false,
        "terminal",
        { status },
      );
    }
    if (status === undefined || (status >= 200 && status < 300)) {
      return new WhooshBangDeliveryError(
        "WhooshBang returned a malformed response outside the pinned contract.",
        "whooshbang-protocol-malformed",
        false,
        "terminal",
        { ...(status === undefined ? {} : { status }) },
      );
    }
    return new WhooshBangDeliveryError(
      "WhooshBang returned an unclassified protocol response.",
      "whooshbang-protocol-unclassified",
      status >= 500 || status === 408 || status === 429,
      status >= 500 || status === 408 || status === 429
        ? "retry_same_operation"
        : "terminal",
      { status },
    );
  }
  if (error instanceof WhooshBangMappingError) {
    return new WhooshBangDeliveryError(
      "Agent Relay cannot safely project this interaction into the pinned WhooshBang contract.",
      error.code,
      false,
      "terminal",
    );
  }
  return new WhooshBangDeliveryError(
    "WhooshBang delivery failed with an unclassified response.",
    "whooshbang-unclassified",
    true,
    "retry_same_operation",
  );
}
