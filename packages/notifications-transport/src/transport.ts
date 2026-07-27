import { NotificationsClient } from "@flowxo/notifications";
import { TransportError } from "@agent-relay/core/transport";

import { normalizeNotificationsBaseUrl } from "./bootstrap.js";
import {
  asNotificationsDeliveryError,
  NotificationsDeliveryError,
} from "./errors.js";
import {
  mapDeliveryMessageToNotifications,
  type NotificationsMessageTarget,
} from "./mapping.js";

import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  NotificationTransport,
} from "@agent-relay/core/transport";
import type { NotificationsFetch } from "@flowxo/notifications";

const CONFIGURATION_TERMINAL_CODES = new Set([
  "notifications-authentication-required",
  "notifications-credential-invalid",
  "notifications-scope-forbidden",
  "notifications-environment-mismatch",
  "notifications-idempotency-conflict",
  "notifications-idempotency-key-required",
  "notifications-request-invalid",
  "notifications-subscriber-unbound",
  "notifications-resource-not-found",
  "notifications-contract-invalid",
]);

function noRedirectFetch(
  fetchImplementation: NotificationsFetch | undefined,
): NotificationsFetch {
  const runtimeFetch = fetchImplementation ?? globalThis.fetch;
  if (typeof runtimeFetch !== "function") {
    throw new TypeError("A Fetch-compatible implementation is required.");
  }
  const bound = runtimeFetch.bind(globalThis);
  return async (input, init) =>
    await bound(input, { ...init, redirect: "manual" });
}

export interface NotificationsContractTransportOptions extends NotificationsMessageTarget {
  baseUrl: string | URL;
  credential: string;
  fetch?: NotificationsFetch;
}

export interface HostedDeliveryIdentity {
  eventId: string;
  interactionId?: string;
  messageId: string;
}

export interface HostedDeliveryDiagnostic {
  diagnosticId: string;
  messageId: string;
  state:
    | "accepted"
    | "dispatch_pending"
    | "queued"
    | "sending"
    | "provider_accepted"
    | "retry_wait"
    | "terminal_failed"
    | "cancelled"
    | "expired";
}

export interface NotificationsTransportCircuitState {
  blocked: boolean;
  errorCode?: string;
  suppressedDeliveries: number;
}

export class NotificationsContractTransport implements NotificationTransport {
  public readonly name = "notifications";
  private readonly client: NotificationsClient;
  private readonly target: NotificationsMessageTarget;
  private blockedError: NotificationsDeliveryError | undefined;
  private suppressedDeliveries = 0;
  private readonly deliveryIdentities = new Map<
    string,
    HostedDeliveryIdentity
  >();

  public constructor(options: NotificationsContractTransportOptions) {
    const baseUrl = normalizeNotificationsBaseUrl(options.baseUrl);
    this.client = new NotificationsClient({
      baseUrl,
      credential: options.credential,
      fetch: noRedirectFetch(options.fetch),
    });
    this.target = {
      subscriberId: options.subscriberId,
      ...(options.notifierId === undefined
        ? {}
        : { notifierId: options.notifierId }),
    };
  }

  public circuitState(): NotificationsTransportCircuitState {
    return {
      blocked: this.blockedError !== undefined,
      suppressedDeliveries: this.suppressedDeliveries,
      ...(this.blockedError === undefined
        ? {}
        : { errorCode: this.blockedError.code }),
    };
  }

  public getHostedDeliveryIdentity(
    eventId: string,
  ): HostedDeliveryIdentity | undefined {
    return this.deliveryIdentities.get(eventId);
  }

  public async diagnoseMessage(
    messageId: string,
  ): Promise<HostedDeliveryDiagnostic> {
    try {
      const hosted = await this.client.getMessage(messageId);
      if (hosted.state === "outcome_unknown") {
        throw new NotificationsDeliveryError(
          "Notifications cannot prove the provider outcome; no new hosted send is permitted.",
          "notifications-provider-outcome-unknown",
          false,
          "outcome_unknown",
          {
            diagnosticId: hosted.diagnostic_id,
            hostedMessageId: hosted.id,
          },
        );
      }
      return {
        diagnosticId: hosted.diagnostic_id,
        messageId: hosted.id,
        state: hosted.state,
      };
    } catch (error) {
      throw asNotificationsDeliveryError(error);
    }
  }

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    if (
      context.idempotencyKey !== message.eventId ||
      context.idempotencyKey.length < 8
    ) {
      throw new TransportError(
        "Notifications delivery requires the stable event ID as its idempotency key.",
        "notifications-idempotency-identity-mismatch",
        false,
      );
    }
    if (this.blockedError !== undefined) {
      this.suppressedDeliveries += 1;
      throw this.blockedError;
    }
    try {
      const hosted = await this.client.createMessage(
        mapDeliveryMessageToNotifications(message, this.target),
        { idempotencyKey: message.eventId },
      );
      if (hosted.state === "outcome_unknown") {
        throw new NotificationsDeliveryError(
          "Notifications cannot prove the provider outcome; no new hosted send is permitted.",
          "notifications-provider-outcome-unknown",
          false,
          "outcome_unknown",
          {
            diagnosticId: hosted.diagnostic_id,
            hostedMessageId: hosted.id,
          },
        );
      }
      this.deliveryIdentities.set(message.eventId, {
        eventId: message.eventId,
        messageId: hosted.id,
        ...(hosted.interaction === undefined
          ? {}
          : { interactionId: hosted.interaction.id }),
      });
      return {
        transport: this.name,
        messageId: hosted.id,
      };
    } catch (error) {
      const classified = asNotificationsDeliveryError(error);
      if (CONFIGURATION_TERMINAL_CODES.has(classified.code)) {
        this.blockedError = classified;
      }
      throw classified;
    }
  }
}
