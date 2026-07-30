import { createHmac } from "node:crypto";

import {
  TransportError,
  type DeliveryContext,
  type DeliveryMessage,
  type DeliveryReceipt,
  type NotificationTransport,
} from "@agent-relay/notification-contracts";
import { sha256 } from "@agent-relay/protocol";

import {
  WebhookDeliveryAckV1Schema,
  WebhookDeliveryEnvelopeV1Schema,
} from "./schema.js";

export const WEBHOOK_MINIMUM_SECRET_BYTES = 32;
export const WEBHOOK_MAXIMUM_SECRET_BYTES = 512;
export const WEBHOOK_MINIMUM_TIMEOUT_MS = 100;
export const WEBHOOK_MAXIMUM_TIMEOUT_MS = 30_000;
export const WEBHOOK_DEFAULT_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAXIMUM_REQUEST_BYTES = 128 * 1_024;
export const WEBHOOK_MAXIMUM_ACK_BYTES = 16 * 1_024;
export const WEBHOOK_MAXIMUM_RETRY_AFTER_MS = 60 * 60_000;

export interface WebhookTransportOptions {
  endpoint: string;
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function parseWebhookEndpoint(value: string): URL {
  if (value.length === 0 || value.length > 2_048) {
    throw new Error("Webhook URL must contain between 1 and 2048 characters");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("Webhook URL must not contain credentials");
  }
  if (endpoint.hash.length > 0) {
    throw new Error("Webhook URL must not contain a fragment");
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))
  ) {
    throw new Error(
      "Webhook URL must use HTTPS, except for loopback development receivers",
    );
  }
  return endpoint;
}

export function webhookEndpointOrigin(value: string): string {
  return parseWebhookEndpoint(value).origin;
}

export function parseWebhookSecret(secret: string): string {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (
    bytes < WEBHOOK_MINIMUM_SECRET_BYTES ||
    bytes > WEBHOOK_MAXIMUM_SECRET_BYTES
  ) {
    throw new Error(
      `Webhook secret must contain between ${String(
        WEBHOOK_MINIMUM_SECRET_BYTES,
      )} and ${String(WEBHOOK_MAXIMUM_SECRET_BYTES)} UTF-8 bytes`,
    );
  }
  return secret;
}

export function parseWebhookTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? WEBHOOK_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < WEBHOOK_MINIMUM_TIMEOUT_MS ||
    value > WEBHOOK_MAXIMUM_TIMEOUT_MS
  ) {
    throw new Error(
      `Webhook timeout must be an integer between ${String(
        WEBHOOK_MINIMUM_TIMEOUT_MS,
      )} and ${String(WEBHOOK_MAXIMUM_TIMEOUT_MS)} milliseconds`,
    );
  }
  return value;
}

export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex")}`;
}

function retryAfterMilliseconds(
  header: string | null,
  now: Date,
): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  let milliseconds: number;
  if (/^\d+$/.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
  } else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    milliseconds = Math.max(0, timestamp - now.getTime());
  }
  if (!Number.isFinite(milliseconds)) {
    return WEBHOOK_MAXIMUM_RETRY_AFTER_MS;
  }
  return Math.min(
    WEBHOOK_MAXIMUM_RETRY_AFTER_MS,
    Math.max(0, Math.ceil(milliseconds)),
  );
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TransportError(
      "Webhook acknowledgement exceeds its size limit",
      "webhook-ack-too-large",
      false,
      response.status,
    );
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      size += item.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TransportError(
          "Webhook acknowledgement exceeds its size limit",
          "webhook-ack-too-large",
          false,
          response.status,
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new TransportError(
      "Webhook acknowledgement is not valid UTF-8",
      "webhook-ack-invalid",
      false,
      response.status,
    );
  }
}

export class WebhookNotificationTransport implements NotificationTransport {
  public readonly name = "webhook";
  public readonly supportedDeliveryModes = ["notify", "silent"] as const;
  private readonly endpoint: URL;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  private readonly now: () => Date;

  public constructor(options: WebhookTransportOptions) {
    this.endpoint = parseWebhookEndpoint(options.endpoint);
    this.secret = parseWebhookSecret(options.secret);
    this.timeoutMs = parseWebhookTimeout(options.timeoutMs);
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const parsed = WebhookDeliveryEnvelopeV1Schema.safeParse({
      schema: "agent-relay-webhook.v1",
      deliveryId: context.idempotencyKey,
      ...(context.deliveryMode === undefined
        ? {}
        : { deliveryMode: context.deliveryMode }),
      message,
      ...(context.source === undefined ? {} : { source: context.source }),
      ...(context.handoff === undefined ? {} : { handoff: context.handoff }),
    });
    if (!parsed.success) {
      throw new TransportError(
        "Webhook delivery payload failed local contract validation",
        "webhook-payload-invalid",
        false,
      );
    }
    const body = JSON.stringify(parsed.data);
    if (Buffer.byteLength(body, "utf8") > WEBHOOK_MAXIMUM_REQUEST_BYTES) {
      throw new TransportError(
        "Webhook delivery payload exceeds its size limit",
        "webhook-payload-too-large",
        false,
      );
    }
    const now = this.now();
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.request(this.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": context.idempotencyKey,
          "x-agent-relay-schema": "agent-relay-webhook.v1",
          "x-agent-relay-timestamp": timestamp,
          "x-agent-relay-signature": webhookSignature(
            this.secret,
            timestamp,
            body,
          ),
        },
        body,
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new TransportError(
          "Webhook endpoint returned a redirect; redirects are refused",
          "webhook-redirect-refused",
          false,
          response.status,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new TransportError(
          `Webhook endpoint returned HTTP ${String(response.status)}`,
          `webhook-http-${String(response.status)}`,
          retryable,
          response.status,
          retryable
            ? retryAfterMilliseconds(response.headers.get("retry-after"), now)
            : undefined,
        );
      }

      const acknowledgement = (
        await readBoundedResponse(response, WEBHOOK_MAXIMUM_ACK_BYTES)
      ).trim();
      if (acknowledgement.length === 0) {
        return {
          transport: this.name,
          messageId: `webhook_${sha256(context.idempotencyKey).slice(0, 24)}`,
        };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(acknowledgement) as unknown;
      } catch {
        throw new TransportError(
          "Webhook acknowledgement is not valid JSON",
          "webhook-ack-invalid",
          false,
          response.status,
        );
      }
      const parsedAck = WebhookDeliveryAckV1Schema.safeParse(raw);
      if (
        !parsedAck.success ||
        parsedAck.data.deliveryId !== context.idempotencyKey
      ) {
        throw new TransportError(
          "Webhook acknowledgement does not match the delivery",
          "webhook-ack-invalid",
          false,
          response.status,
        );
      }
      return {
        transport: this.name,
        messageId:
          parsedAck.data.messageId ??
          `webhook_${sha256(context.idempotencyKey).slice(0, 24)}`,
      };
    } catch (error) {
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError(
        controller.signal.aborted
          ? "Webhook delivery timed out before an acknowledgement"
          : "Webhook delivery failed before an acknowledgement",
        controller.signal.aborted
          ? "webhook-timeout"
          : "webhook-network-failure",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
