import { NotificationsClient } from "@flowxo/notifications";
import { TransportError } from "@agent-relay/core/transport";
import {
  InteractionProviderObservationV1Schema,
  MAX_INTERACTION_TEXT_LENGTH,
  type InteractionProviderObservationV1,
} from "@agent-relay/protocol";

import { normalizeNotificationsBaseUrl } from "./bootstrap.js";
import {
  asNotificationsDeliveryError,
  NotificationsDeliveryError,
} from "./errors.js";
import {
  mapDeliveryMessageToNotifications,
  type NotificationsMessageTarget,
} from "./mapping.js";
import { notificationsMachineStreamKey } from "./machine-stream.js";

import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractionCapabilityTransport,
  NotificationTransport,
} from "@agent-relay/core/transport";
import type { NotificationsFetch } from "@flowxo/notifications";

const CONFIGURATION_TERMINAL_CODES = new Set([
  "notifications-authentication-required",
  "notifications-connection-inactive",
  "notifications-credential-invalid",
  "notifications-scope-forbidden",
  "notifications-environment-mismatch",
  "notifications-idempotency-conflict",
  "notifications-idempotency-key-required",
  "notifications-request-invalid",
  "notifications-subscriber-unbound",
  "notifications-resource-not-found",
  "notifications-contract-invalid",
  "notifications-protocol-malformed",
  "notifications-redirect-refused",
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
  machineClientId: string;
  connectionGuard?: () => boolean | Promise<boolean>;
  fetch?: NotificationsFetch;
}

export interface HostedDeliveryIdentity {
  eventId: string;
  interactionId?: string;
  messageId: string;
  streamKey: string;
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

export class NotificationsContractTransport
  implements NotificationTransport, InteractionCapabilityTransport
{
  public readonly name = "notifications";
  private readonly client: NotificationsClient;
  private readonly target: NotificationsMessageTarget;
  private readonly streamKey: string;
  private readonly connectionGuard:
    (() => boolean | Promise<boolean>) | undefined;
  private blockedError: NotificationsDeliveryError | undefined;
  private suppressedDeliveries = 0;
  private readonly deliveryIdentities = new Map<
    string,
    HostedDeliveryIdentity
  >();

  public constructor(options: NotificationsContractTransportOptions) {
    const baseUrl = normalizeNotificationsBaseUrl(options.baseUrl);
    this.streamKey = notificationsMachineStreamKey(
      baseUrl,
      options.machineClientId,
    );
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
    this.connectionGuard = options.connectionGuard;
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

  public observeInteractionCapabilities(
    observedAt: string,
  ): InteractionProviderObservationV1 {
    return InteractionProviderObservationV1Schema.parse({
      schema: "agent-interaction-provider-observation.v1",
      capabilities: {
        schema: "agent-interaction-capabilities.v1",
        providerId: "transport_flowxo_notifications",
        providerKind: "transport",
        observedAt,
        features: ["confirm", "single-select", "free-text"],
        presentationModes: ["buttons", "direct-text"],
        limits: {
          maxQuestions: 1,
          maxOptionsPerQuestion: 6,
          maxTextLength: MAX_INTERACTION_TEXT_LENGTH,
          maxPayloadBytes: 8_192,
        },
      },
      status: "proven",
      evidence: "official-docs",
      observedVersion: "@flowxo/notifications@1.0.0-draft.1",
      fixture: "interaction-machine-semantic-scenarios@1.0.0-draft.1",
      note: "The pinned hosted contract proves confirm, single-select, and input. It does not expose durable drafts, ordered or multi-select sets, or resolved-message updates.",
    });
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
      if (
        this.connectionGuard !== undefined &&
        !(await this.connectionGuard())
      ) {
        throw new NotificationsDeliveryError(
          "The configured Notifications machine connection is inactive.",
          "notifications-connection-inactive",
          false,
          "terminal",
        );
      }
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
        streamKey: this.streamKey,
        ...(hosted.interaction === undefined
          ? {}
          : { interactionId: hosted.interaction.id }),
      });
      return {
        transport: this.name,
        messageId: hosted.id,
        ...(hosted.interaction === undefined
          ? {}
          : {
              hostedInteraction: {
                id: hosted.interaction.id,
                type: hosted.interaction.type,
                streamKey: this.streamKey,
              },
            }),
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
