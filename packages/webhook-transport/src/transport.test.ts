import { readFile } from "node:fs/promises";

import type {
  TransportError,
  DeliveryContext,
  DeliveryMessage,
} from "@agent-relay/notification-contracts";
import { describe, expect, it, vi } from "vitest";

import { WebhookDeliveryEnvelopeV1Schema } from "./schema.js";
import {
  WEBHOOK_MAXIMUM_ACK_BYTES,
  WebhookNotificationTransport,
  parseWebhookEndpoint,
  webhookSignature,
} from "./transport.js";

const secret = "synthetic-shared-secret-material-0001";
const now = new Date("2026-07-28T14:00:00.000Z");

const message: DeliveryMessage = {
  eventId: "event_webhook_delivery_12345678",
  title: "Codex · agent-relay",
  text: "Input required · now\nmain · session 12345678-a1b2c3",
  interaction: {
    type: "select",
    correlationId: "request_webhook_delivery_12345678",
    prompt: "Choose a synthetic result",
    expiresAt: "2026-07-28T14:10:00.000Z",
    options: [
      { value: "option_token_first_12345678", label: "First" },
      { value: "option_token_second_12345678", label: "Second" },
    ],
  },
};

const context: DeliveryContext = {
  idempotencyKey: "event_webhook_delivery_12345678",
  deliveryMode: "notify",
  source: {
    occurredAt: "2026-07-28T14:00:00.000Z",
    eventType: "input.required",
    harness: "codex",
    surface: "cli",
    repository: "agent-relay",
    branch: "codex/webhook",
    sessionKey: "a".repeat(24),
    shortSessionId: "12345678-a1b2c3",
  },
  handoff: {
    mode: "local-web",
    requestId: "request_webhook_delivery_12345678",
    expiresAt: "2026-07-28T14:10:00.000Z",
    url: "http://127.0.0.1:4317/ui/?request=request_webhook_delivery_12345678",
  },
};

function transport(fetchImplementation: typeof fetch) {
  return new WebhookNotificationTransport({
    endpoint: "https://receiver.example.test/agent-relay",
    secret,
    fetch: fetchImplementation,
    now: () => now,
  });
}

describe("signed outbound webhook transport", () => {
  it("keeps the checked-in synthetic delivery fixture on the exact v1 schema", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/webhook/delivery-v1.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    expect(WebhookDeliveryEnvelopeV1Schema.parse(fixture)).toEqual(fixture);
  });

  it("sends deterministic runtime-validated JSON with exact-byte authentication", async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const request = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init: init ?? {} });
        return new Response(null, { status: 204 });
      },
    ) as typeof fetch;

    await expect(transport(request).deliver(message, context)).resolves.toEqual(
      {
        transport: "webhook",
        messageId: "webhook_ef339062b8d620b9b6c84f8c",
      },
    );
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    const body = String(sent.init.body);
    const headers = new Headers(sent.init.headers);
    expect(sent.input).toBe("https://receiver.example.test/agent-relay");
    expect(sent.init).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(JSON.parse(body)).toEqual({
      schema: "agent-relay-webhook.v1",
      deliveryId: context.idempotencyKey,
      deliveryMode: "notify",
      message,
      source: context.source,
      handoff: context.handoff,
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe(context.idempotencyKey);
    expect(headers.get("x-agent-relay-schema")).toBe("agent-relay-webhook.v1");
    expect(headers.get("x-agent-relay-timestamp")).toBe("1785247200");
    expect(headers.get("x-agent-relay-signature")).toBe(
      webhookSignature(secret, "1785247200", body),
    );
    expect(body).not.toContain(secret);
    expect(transport(request).supportedDeliveryModes).toEqual([
      "notify",
      "silent",
    ]);
  });

  it("accepts a matching acknowledgement and rejects malformed or mismatched acknowledgements", async () => {
    const matching = transport(
      (async () =>
        new Response(
          JSON.stringify({
            schema: "agent-relay-webhook-ack.v1",
            deliveryId: context.idempotencyKey,
            messageId: "receiver_message_12345678",
          }),
          { status: 202 },
        )) as typeof fetch,
    );
    await expect(matching.deliver(message, context)).resolves.toEqual({
      transport: "webhook",
      messageId: "receiver_message_12345678",
    });

    for (const body of [
      "{",
      JSON.stringify({
        schema: "agent-relay-webhook-ack.v1",
        deliveryId: "different_delivery_12345678",
      }),
      JSON.stringify({
        schema: "unknown",
        deliveryId: context.idempotencyKey,
      }),
    ]) {
      const invalid = transport(
        (async () => new Response(body, { status: 200 })) as typeof fetch,
      );
      await expect(invalid.deliver(message, context)).rejects.toMatchObject({
        code: "webhook-ack-invalid",
        retryable: false,
      });
    }
  });

  it("bounds acknowledgement bodies without retaining receiver content", async () => {
    const privateBody = `private-${"x".repeat(WEBHOOK_MAXIMUM_ACK_BYTES)}`;
    const request = (async () =>
      new Response(privateBody, {
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(privateBody, "utf8")),
        },
      })) as typeof fetch;
    let failure: unknown;
    try {
      await transport(request).deliver(message, context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "webhook-ack-too-large",
      retryable: false,
    });
    expect((failure as Error).message).not.toContain(privateBody.slice(0, 20));
  });

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
  ])("maps HTTP %i to retryable=%s", async (status, retryable) => {
    const request = (async () =>
      new Response("private receiver failure", { status })) as typeof fetch;
    await expect(
      transport(request).deliver(message, context),
    ).rejects.toMatchObject({
      code: `webhook-http-${String(status)}`,
      retryable,
      status,
      message: `Webhook endpoint returned HTTP ${String(status)}`,
    });
  });

  it("honors and caps Retry-After while refusing redirects", async () => {
    const retrying = transport(
      (async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "7200" },
        })) as typeof fetch,
    );
    await expect(retrying.deliver(message, context)).rejects.toMatchObject({
      code: "webhook-http-429",
      retryAfterMs: 3_600_000,
    });

    const redirect = transport(
      (async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://other.example.test/" },
        })) as typeof fetch,
    );
    await expect(redirect.deliver(message, context)).rejects.toMatchObject({
      code: "webhook-redirect-refused",
      retryable: false,
      status: 307,
    });
  });

  it("makes header and acknowledgement-body timeouts visible and retryable", async () => {
    const timeoutRequest = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const timeoutTransport = new WebhookNotificationTransport({
      endpoint: "https://receiver.example.test/",
      secret,
      timeoutMs: 100,
      fetch: timeoutRequest,
    });
    await expect(
      timeoutTransport.deliver(message, context),
    ).rejects.toMatchObject({
      code: "webhook-timeout",
      retryable: true,
    });

    const stalledAcknowledgement = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const stalledAcknowledgementTransport = new WebhookNotificationTransport({
      endpoint: "https://receiver.example.test/",
      secret,
      timeoutMs: 100,
      fetch: stalledAcknowledgement,
    });
    await expect(
      stalledAcknowledgementTransport.deliver(message, context),
    ).rejects.toMatchObject({
      code: "webhook-timeout",
      retryable: true,
    });
  });

  it("makes pre-acknowledgement network failures visible and retryable", async () => {
    const network = transport((async () => {
      throw new Error("private DNS diagnostic");
    }) as typeof fetch);
    await expect(network.deliver(message, context)).rejects.toMatchObject({
      code: "webhook-network-failure",
      retryable: true,
      message: "Webhook delivery failed before an acknowledgement",
    });
  });

  it("keeps retries and concurrent session deliveries isolated by stable delivery ID", async () => {
    const bodies: string[] = [];
    const request = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const shared = transport(request);
    const secondContext: DeliveryContext = {
      ...context,
      idempotencyKey: "event_webhook_delivery_87654321",
      source: {
        ...context.source!,
        sessionKey: "b".repeat(24),
        shortSessionId: "87654321-d4e5f6",
      },
    };

    await Promise.all([
      shared.deliver(message, context),
      shared.deliver(
        { ...message, eventId: "event_webhook_delivery_87654321" },
        secondContext,
      ),
    ]);
    await shared.deliver(message, context);

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe(bodies[2]);
    expect(JSON.parse(bodies[0]!).deliveryId).toBe(context.idempotencyKey);
    expect(JSON.parse(bodies[1]!).deliveryId).toBe(
      secondContext.idempotencyKey,
    );
    expect(JSON.parse(bodies[0]!).source.sessionKey).not.toBe(
      JSON.parse(bodies[1]!).source.sessionKey,
    );
  });

  it("allows loopback HTTP development receivers but requires HTTPS elsewhere", () => {
    expect(parseWebhookEndpoint("http://127.0.0.1:4319/hook").origin).toBe(
      "http://127.0.0.1:4319",
    );
    expect(parseWebhookEndpoint("http://[::1]:4319/hook").origin).toBe(
      "http://[::1]:4319",
    );
    expect(() =>
      parseWebhookEndpoint("http://receiver.example.test/hook"),
    ).toThrow("must use HTTPS");
    expect(() =>
      parseWebhookEndpoint("https://user:password@example.test/hook"),
    ).toThrow("must not contain credentials");
    expect(() =>
      parseWebhookEndpoint("https://example.test/hook#private"),
    ).toThrow("must not contain a fragment");
  });

  it("rejects an invalid local payload before making a request", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      transport(request as typeof fetch).deliver(
        { ...message, title: "" },
        context,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<TransportError>>({
        code: "webhook-payload-invalid",
        retryable: false,
      }),
    );
    expect(request).not.toHaveBeenCalled();
  });
});
