import type { RelayService } from "@agent-relay/core";
import { sha256 } from "@agent-relay/protocol";
import { NotificationsContractTransport } from "@agent-relay/notifications-transport";

import type {
  AgentRelayTransport,
  ResolvedTransportSelection,
  TransportReadinessReport,
} from "./transport-config.js";

export type NotificationsErrorClassification =
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
    notifications: {
      circuit: {
        blocked: boolean;
        errorCode?: string;
        suppressedDeliveries: number;
      };
      delivery: {
        lastError: {
          at: string;
          classification: NotificationsErrorClassification;
          code: string;
        } | null;
        lastSuccessfulSendAt: string | null;
      };
      polling: {
        committedCursorRef: string | null;
        lastError: {
          at: string;
          classification: NotificationsErrorClassification;
          code: string;
        } | null;
        lastSuccessfulPollAt: string | null;
        state: "active" | "error" | "not-started";
        unacknowledgedEventCount: number;
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

const AUTHENTICATION_ERRORS = new Set([
  "notifications-authentication-required",
  "notifications-credential-invalid",
]);

const AUTHORIZATION_ERRORS = new Set([
  "notifications-environment-mismatch",
  "notifications-scope-forbidden",
  "notifications-authentication-identity-mismatch",
  "notifications-correlation-mismatch",
  "notifications-local-identity-mismatch",
  "notifications-stream-identity-failure",
]);

const CONFIGURATION_ERRORS = new Set([
  "notifications-resource-not-found",
  "notifications-subscriber-unbound",
]);

const CONTRACT_ERRORS = new Set([
  "notifications-contract-invalid",
  "notifications-idempotency-conflict",
  "notifications-idempotency-identity-mismatch",
  "notifications-idempotency-key-required",
  "notifications-request-contract-invalid",
  "notifications-request-invalid",
  "notifications-contract-integrity-failure",
  "notifications-schema-integrity-failure",
  "notifications-stream-order-invalid",
  "notifications-unsafe-opaque-value",
]);

const OUTCOME_UNKNOWN_ERRORS = new Set([
  "notifications-provider-outcome-unknown",
  "notifications-transport-outcome-unknown",
]);

const TERMINAL_ERRORS = new Set([
  "notifications-cancellation-too-late",
  "notifications-provider-terminal",
  "notifications-resource-expired",
  "notifications-request-not-found",
]);

export function classifyNotificationsErrorCode(
  code: string,
): NotificationsErrorClassification {
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

export function buildDaemonTransportStatus(input: {
  readiness?: TransportReadinessReport;
  selection: ResolvedTransportSelection;
  service: RelayService;
  hostedStreamKey?: string;
}): DaemonTransportStatus {
  const storeStatus = input.service.store.status();
  const notificationsDelivery =
    input.service.store.transportDeliverySummary("notifications");
  const notificationsCircuit =
    input.service.transport instanceof NotificationsContractTransport
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
      notifications: {
        circuit: notificationsCircuit,
        delivery: {
          lastSuccessfulSendAt:
            notificationsDelivery.lastSuccessfulSendAt ?? null,
          lastError:
            notificationsDelivery.lastError === undefined
              ? null
              : {
                  ...notificationsDelivery.lastError,
                  classification: classifyNotificationsErrorCode(
                    notificationsDelivery.lastError.code,
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
                  classification: classifyNotificationsErrorCode(
                    hostedPoll.lastError.code,
                  ),
                },
          unacknowledgedEventCount: hostedPoll?.unacknowledgedEventCount ?? 0,
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
