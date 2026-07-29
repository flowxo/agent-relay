import type { RelayService } from "@agent-relay/core";
import { sha256 } from "@agent-relay/protocol";
import {
  whooshbangFailurePolicy,
  WhooshBangContractTransport,
  type WhooshBangFailureCategory,
  type WhooshBangResolutionPresenter,
} from "@agent-relay/whooshbang-transport";

import type {
  AgentRelayTransport,
  ResolvedTransportSelection,
  TransportReadinessReport,
} from "./transport-config.js";

export type WhooshBangErrorClassification =
  | "authentication"
  | "authorization"
  | "configuration"
  | "contract"
  | "outcome-unknown"
  | "terminal"
  | "transient";

export interface DaemonTransportStatus {
  selectedTransport: AgentRelayTransport;
  transportReadiness?: TransportReadinessReport;
  transportRuntime: {
    webhook: {
      delivery: {
        lastError: {
          at: string;
          classification: "retryable" | "terminal";
          code: string;
        } | null;
        lastSuccessfulSendAt: string | null;
      };
      spool: {
        deadLetter: number;
        pending: number;
        retrying: number;
      };
    };
    whooshbang: {
      circuit: {
        blocked: boolean;
        errorCode?: string;
        suppressedDeliveries: number;
      };
      delivery: {
        lastError: {
          at: string;
          category: WhooshBangFailureCategory;
          classification: WhooshBangErrorClassification;
          code: string;
        } | null;
        lastSuccessfulSendAt: string | null;
      };
      polling: {
        committedCursorRef: string | null;
        lastError: {
          at: string;
          category: WhooshBangFailureCategory;
          classification: WhooshBangErrorClassification;
          code: string;
        } | null;
        lastSuccessfulPollAt: string | null;
        state: "active" | "error" | "not-started";
        unacknowledgedEventCount: number;
      };
      presentation: {
        capability:
          WhooshBangResolutionPresenter["capability"] | "not-selected";
        blocked: number;
        pending: number;
        retrying: number;
        updated: number;
        lastError: {
          at: string;
          category: WhooshBangFailureCategory;
          classification: WhooshBangErrorClassification;
          code: string;
        } | null;
      };
      spool: {
        deadLetter: number;
        pending: number;
        retrying: number;
      };
    };
    selection: ResolvedTransportSelection;
  };
}

export function classifyWebhookErrorCode(
  code: string,
): "retryable" | "terminal" {
  if (
    code === "webhook-timeout" ||
    code === "webhook-network-failure" ||
    code === "webhook-http-408" ||
    code === "webhook-http-425" ||
    code === "webhook-http-429"
  ) {
    return "retryable";
  }
  const status = /^webhook-http-(\d{3})$/.exec(code)?.[1];
  return status !== undefined && Number(status) >= 500
    ? "retryable"
    : "terminal";
}

const AUTHENTICATION_ERRORS = new Set([
  "whooshbang-authentication-required",
  "whooshbang-credential-invalid",
]);

const AUTHORIZATION_ERRORS = new Set([
  "whooshbang-environment-mismatch",
  "whooshbang-scope-forbidden",
  "whooshbang-authentication-identity-mismatch",
  "whooshbang-correlation-mismatch",
  "whooshbang-local-identity-mismatch",
  "whooshbang-stream-identity-failure",
]);

const CONFIGURATION_ERRORS = new Set([
  "whooshbang-connection-inactive",
  "whooshbang-resource-not-found",
  "whooshbang-subscriber-unbound",
]);

const CONTRACT_ERRORS = new Set([
  "whooshbang-contract-invalid",
  "whooshbang-idempotency-conflict",
  "whooshbang-idempotency-identity-mismatch",
  "whooshbang-idempotency-key-required",
  "whooshbang-request-contract-invalid",
  "whooshbang-request-invalid",
  "whooshbang-contract-integrity-failure",
  "whooshbang-schema-integrity-failure",
  "whooshbang-stream-order-invalid",
  "whooshbang-unsafe-opaque-value",
  "whooshbang-protocol-malformed",
  "whooshbang-presentation-identity-mismatch",
  "whooshbang-redirect-refused",
]);

const OUTCOME_UNKNOWN_ERRORS = new Set([
  "whooshbang-provider-outcome-unknown",
  "whooshbang-transport-outcome-unknown",
]);

const TERMINAL_ERRORS = new Set([
  "whooshbang-cancellation-too-late",
  "whooshbang-provider-terminal",
  "whooshbang-resource-expired",
  "whooshbang-request-not-found",
  "whooshbang-resolution-update-unsupported",
]);

export function classifyWhooshBangErrorCode(
  code: string,
): WhooshBangErrorClassification {
  if (AUTHENTICATION_ERRORS.has(code)) {
    return "authentication";
  }
  if (AUTHORIZATION_ERRORS.has(code)) {
    return "authorization";
  }
  if (CONFIGURATION_ERRORS.has(code)) {
    return "configuration";
  }
  if (CONTRACT_ERRORS.has(code)) {
    return "contract";
  }
  if (OUTCOME_UNKNOWN_ERRORS.has(code)) {
    return "outcome-unknown";
  }
  if (TERMINAL_ERRORS.has(code)) {
    return "terminal";
  }
  return "transient";
}

function failureCategoryForCode(code: string): WhooshBangFailureCategory {
  const classification = classifyWhooshBangErrorCode(code);
  return whooshbangFailurePolicy({
    code,
    disposition:
      code === "whooshbang-provider-outcome-unknown"
        ? "outcome_unknown"
        : classification === "transient"
          ? "retry_same_operation"
          : "terminal",
    retryable:
      classification === "transient" ||
      code === "whooshbang-transport-outcome-unknown",
  }).category;
}

export function buildDaemonTransportStatus(input: {
  readiness?: TransportReadinessReport;
  selection: ResolvedTransportSelection;
  service: RelayService;
  hostedStreamKey?: string;
  hostedPresentationCapability?: WhooshBangResolutionPresenter["capability"];
}): DaemonTransportStatus {
  const storeStatus = input.service.store.status();
  const whooshbangDelivery =
    input.service.store.transportDeliverySummary("whooshbang");
  const webhookDelivery =
    input.service.store.transportDeliverySummary("webhook");
  const whooshbangCircuit =
    input.service.transport instanceof WhooshBangContractTransport
      ? input.service.transport.circuitState()
      : { blocked: false, suppressedDeliveries: 0 };
  const hostedPoll =
    input.hostedStreamKey === undefined
      ? undefined
      : input.service.store.hostedPollStatus(input.hostedStreamKey);

  return {
    selectedTransport: input.selection.selected,
    ...(input.readiness === undefined
      ? {}
      : { transportReadiness: input.readiness }),
    transportRuntime: {
      selection: input.selection,
      webhook: {
        delivery: {
          lastSuccessfulSendAt: webhookDelivery.lastSuccessfulSendAt ?? null,
          lastError:
            webhookDelivery.lastError === undefined
              ? null
              : {
                  ...webhookDelivery.lastError,
                  classification: classifyWebhookErrorCode(
                    webhookDelivery.lastError.code,
                  ),
                },
        },
        spool: {
          pending: storeStatus.events.queued + storeStatus.events.delivering,
          retrying: storeStatus.events.retry,
          deadLetter: storeStatus.events.dead_letter,
        },
      },
      whooshbang: {
        circuit: whooshbangCircuit,
        delivery: {
          lastSuccessfulSendAt: whooshbangDelivery.lastSuccessfulSendAt ?? null,
          lastError:
            whooshbangDelivery.lastError === undefined
              ? null
              : {
                  ...whooshbangDelivery.lastError,
                  category: failureCategoryForCode(
                    whooshbangDelivery.lastError.code,
                  ),
                  classification: classifyWhooshBangErrorCode(
                    whooshbangDelivery.lastError.code,
                  ),
                },
        },
        polling: {
          state:
            hostedPoll?.lastError !== undefined
              ? "error"
              : hostedPoll?.lastSuccessfulPollAt !== undefined
                ? "active"
                : "not-started",
          lastSuccessfulPollAt: hostedPoll?.lastSuccessfulPollAt ?? null,
          committedCursorRef:
            hostedPoll?.committedCursor === undefined
              ? null
              : `cursor_${sha256(hostedPoll.committedCursor).slice(0, 12)}`,
          lastError:
            hostedPoll?.lastError === undefined
              ? null
              : {
                  ...hostedPoll.lastError,
                  category: failureCategoryForCode(hostedPoll.lastError.code),
                  classification: classifyWhooshBangErrorCode(
                    hostedPoll.lastError.code,
                  ),
                },
          unacknowledgedEventCount: hostedPoll?.unacknowledgedEventCount ?? 0,
        },
        presentation: {
          capability:
            input.hostedPresentationCapability ??
            (input.hostedStreamKey === undefined
              ? "not-selected"
              : "unsupported"),
          pending:
            (hostedPoll?.messageUpdates.pending ?? 0) +
            (hostedPoll?.messageUpdates.updating ?? 0),
          retrying: hostedPoll?.messageUpdates.retry ?? 0,
          updated: hostedPoll?.messageUpdates.updated ?? 0,
          blocked: hostedPoll?.messageUpdates.blocked ?? 0,
          lastError:
            hostedPoll?.messageUpdates.lastError === undefined
              ? null
              : {
                  ...hostedPoll.messageUpdates.lastError,
                  category: failureCategoryForCode(
                    hostedPoll.messageUpdates.lastError.code,
                  ),
                  classification: classifyWhooshBangErrorCode(
                    hostedPoll.messageUpdates.lastError.code,
                  ),
                },
        },
        spool: {
          pending: storeStatus.events.queued + storeStatus.events.delivering,
          retrying: storeStatus.events.retry,
          deadLetter: storeStatus.events.dead_letter,
        },
      },
    },
  };
}
