import { NotificationsClient } from "@flowxo/notifications";
import { TransportError } from "@agent-relay/core/transport";

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

export class NotificationsContractTransport implements NotificationTransport {
  public readonly name = "notifications";
  private readonly client: NotificationsClient;
  private readonly target: NotificationsMessageTarget;
  private readonly deliveryIdentities = new Map<
    string,
    HostedDeliveryIdentity
  >();

  public constructor(options: NotificationsContractTransportOptions) {
    this.client = new NotificationsClient({
      baseUrl: options.baseUrl,
      credential: options.credential,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.target = {
      subscriberId: options.subscriberId,
      ...(options.notifierId === undefined
        ? {}
        : { notifierId: options.notifierId }),
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
      throw asNotificationsDeliveryError(error);
    }
  }
}
