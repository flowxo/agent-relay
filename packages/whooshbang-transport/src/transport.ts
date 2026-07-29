import { WhooshBangClient } from "@whooshbang/sdk";
import { TransportError } from "@agent-relay/notification-contracts";
import {
  InteractionProviderObservationV1Schema,
  MAX_INTERACTION_TEXT_LENGTH,
  type InteractionProviderObservationV1,
} from "@agent-relay/protocol";

import { normalizeWhooshBangBaseUrl } from "./bootstrap.js";
import {
  asWhooshBangDeliveryError,
  WhooshBangDeliveryError,
} from "./errors.js";
import {
  mapDeliveryMessageToWhooshBang,
  type WhooshBangMessageTarget,
} from "./mapping.js";
import { whooshbangMachineStreamKey } from "./machine-stream.js";

import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractionCapabilityTransport,
  NotificationTransport,
} from "@agent-relay/notification-contracts";
import type { WhooshBangFetch } from "@whooshbang/sdk";

const CONFIGURATION_TERMINAL_CODES = new Set([
  "whooshbang-authentication-required",
  "whooshbang-connection-inactive",
  "whooshbang-credential-invalid",
  "whooshbang-scope-forbidden",
  "whooshbang-environment-mismatch",
  "whooshbang-idempotency-conflict",
  "whooshbang-idempotency-key-required",
  "whooshbang-request-invalid",
  "whooshbang-subscriber-unbound",
  "whooshbang-resource-not-found",
  "whooshbang-contract-invalid",
  "whooshbang-protocol-malformed",
  "whooshbang-redirect-refused",
]);

function noRedirectFetch(
  fetchImplementation: WhooshBangFetch | undefined,
): WhooshBangFetch {
  const runtimeFetch = fetchImplementation ?? globalThis.fetch;
  if (typeof runtimeFetch !== "function") {
    throw new TypeError("A Fetch-compatible implementation is required.");
  }
  const bound = runtimeFetch.bind(globalThis);
  return async (input, init) =>
    await bound(input, { ...init, redirect: "manual" });
}

export interface WhooshBangContractTransportOptions extends WhooshBangMessageTarget {
  baseUrl: string | URL;
  credential: string;
  machineClientId: string;
  connectionGuard?: () => boolean | Promise<boolean>;
  fetch?: WhooshBangFetch;
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

export interface WhooshBangTransportCircuitState {
  blocked: boolean;
  errorCode?: string;
  suppressedDeliveries: number;
}

export class WhooshBangContractTransport
  implements NotificationTransport, InteractionCapabilityTransport
{
  public readonly name = "whooshbang";
  private readonly client: WhooshBangClient;
  private readonly target: WhooshBangMessageTarget;
  private readonly streamKey: string;
  private readonly connectionGuard:
    (() => boolean | Promise<boolean>) | undefined;
  private blockedError: WhooshBangDeliveryError | undefined;
  private suppressedDeliveries = 0;
  private readonly deliveryIdentities = new Map<
    string,
    HostedDeliveryIdentity
  >();

  public constructor(options: WhooshBangContractTransportOptions) {
    const baseUrl = normalizeWhooshBangBaseUrl(options.baseUrl);
    this.streamKey = whooshbangMachineStreamKey(
      baseUrl,
      options.machineClientId,
    );
    this.client = new WhooshBangClient({
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

  public circuitState(): WhooshBangTransportCircuitState {
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
        providerId: "transport_flowxo_whooshbang",
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
      observedVersion: "@whooshbang/sdk@1.0.0-rc.4",
      fixture: "interaction-machine-semantic-scenarios@1.0.0-rc.4",
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
        throw new WhooshBangDeliveryError(
          "WhooshBang cannot prove the provider outcome; no new hosted send is permitted.",
          "whooshbang-provider-outcome-unknown",
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
      throw asWhooshBangDeliveryError(error);
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
        "WhooshBang delivery requires the stable event ID as its idempotency key.",
        "whooshbang-idempotency-identity-mismatch",
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
        throw new WhooshBangDeliveryError(
          "The configured WhooshBang machine connection is inactive.",
          "whooshbang-connection-inactive",
          false,
          "terminal",
        );
      }
      const hosted = await this.client.createMessage(
        mapDeliveryMessageToWhooshBang(message, this.target),
        { idempotencyKey: message.eventId },
      );
      if (hosted.state === "outcome_unknown") {
        throw new WhooshBangDeliveryError(
          "WhooshBang cannot prove the provider outcome; no new hosted send is permitted.",
          "whooshbang-provider-outcome-unknown",
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
      const classified = asWhooshBangDeliveryError(error);
      if (CONFIGURATION_TERMINAL_CODES.has(classified.code)) {
        this.blockedError = classified;
      }
      throw classified;
    }
  }
}
