import { sha256 } from "@agent-relay/protocol";
import { WhooshBangClient } from "@whooshbang/sdk";

import { normalizeWhooshBangBaseUrl } from "./bootstrap.js";
import {
  asWhooshBangDeliveryError,
  WhooshBangDeliveryError,
} from "./errors.js";

import type {
  InteractionEvent,
  MachineEventAckResponse,
  MachineEventPollResponse,
} from "@whooshbang/contracts";
import type { WhooshBangFetch } from "@whooshbang/sdk";

export type HostedInteractionEvent = InteractionEvent;

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

export interface WhooshBangInteractionSourceOptions {
  baseUrl: string | URL;
  credential: string;
  connectionGuard?: () => boolean | Promise<boolean>;
  fetch?: WhooshBangFetch;
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

export interface WhooshBangInteractionSource {
  poll(options: PollHostedEventsOptions): Promise<MachineEventPollResponse>;
  acknowledge(
    input: AcknowledgeHostedEventInput,
  ): Promise<MachineEventAckResponse>;
}

export class WhooshBangMachineInteractionSource implements WhooshBangInteractionSource {
  private readonly client: WhooshBangClient;
  private readonly connectionGuard:
    (() => boolean | Promise<boolean>) | undefined;

  public constructor(options: WhooshBangInteractionSourceOptions) {
    this.client = new WhooshBangClient({
      baseUrl: normalizeWhooshBangBaseUrl(options.baseUrl),
      credential: options.credential,
      fetch: noRedirectFetch(options.fetch),
    });
    this.connectionGuard = options.connectionGuard;
  }

  private async assertConnectionActive(): Promise<void> {
    if (this.connectionGuard !== undefined && !(await this.connectionGuard())) {
      throw new WhooshBangDeliveryError(
        "The configured WhooshBang machine connection is inactive.",
        "whooshbang-connection-inactive",
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
      throw asWhooshBangDeliveryError(error);
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
      throw asWhooshBangDeliveryError(error);
    }
  }
}
