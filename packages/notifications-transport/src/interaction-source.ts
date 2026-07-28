import { sha256 } from "@agent-relay/protocol";
import { NotificationsClient } from "@flowxo/notifications";

import { normalizeNotificationsBaseUrl } from "./bootstrap.js";
import {
  asNotificationsDeliveryError,
  NotificationsDeliveryError,
} from "./errors.js";

import type {
  InteractionEvent,
  MachineEventAckResponse,
  MachineEventPollResponse,
} from "@flowxo/notifications-contracts";
import type { NotificationsFetch } from "@flowxo/notifications";

export type HostedInteractionEvent = InteractionEvent;

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

export interface NotificationsInteractionSourceOptions {
  baseUrl: string | URL;
  credential: string;
  connectionGuard?: () => boolean | Promise<boolean>;
  fetch?: NotificationsFetch;
}

export interface PollHostedEventsOptions {
  after?: string;
  limit: number;
  waitSeconds: number;
  signal: AbortSignal;
}

export interface AcknowledgeHostedEventInput {
  eventId: string;
  cursor: string;
  disposition: "processed" | "quarantined";
  reasonCode?: string;
  signal: AbortSignal;
}

export interface NotificationsInteractionSource {
  poll(options: PollHostedEventsOptions): Promise<MachineEventPollResponse>;
  acknowledge(
    input: AcknowledgeHostedEventInput,
  ): Promise<MachineEventAckResponse>;
}

export class NotificationsMachineInteractionSource implements NotificationsInteractionSource {
  private readonly client: NotificationsClient;
  private readonly connectionGuard:
    (() => boolean | Promise<boolean>) | undefined;

  public constructor(options: NotificationsInteractionSourceOptions) {
    this.client = new NotificationsClient({
      baseUrl: normalizeNotificationsBaseUrl(options.baseUrl),
      credential: options.credential,
      fetch: noRedirectFetch(options.fetch),
    });
    this.connectionGuard = options.connectionGuard;
  }

  private async assertConnectionActive(): Promise<void> {
    if (this.connectionGuard !== undefined && !(await this.connectionGuard())) {
      throw new NotificationsDeliveryError(
        "The configured Notifications machine connection is inactive.",
        "notifications-connection-inactive",
        false,
        "terminal",
      );
    }
  }

  public async poll(
    options: PollHostedEventsOptions,
  ): Promise<MachineEventPollResponse> {
    try {
      await this.assertConnectionActive();
      return await this.client.pollMachineEvents({
        ...(options.after === undefined ? {} : { after: options.after }),
        limit: options.limit,
        wait: options.waitSeconds,
        signal: options.signal,
      });
    } catch (error) {
      throw asNotificationsDeliveryError(error);
    }
  }

  public async acknowledge(
    input: AcknowledgeHostedEventInput,
  ): Promise<MachineEventAckResponse> {
    try {
      await this.assertConnectionActive();
      return await this.client.acknowledgeMachineEvent(
        input.eventId,
        {
          cursor: input.cursor,
          disposition: input.disposition,
          reason_code: input.reasonCode ?? null,
        },
        {
          idempotencyKey: `ack_${sha256(input.eventId)}`,
          signal: input.signal,
        },
      );
    } catch (error) {
      throw asNotificationsDeliveryError(error);
    }
  }
}
