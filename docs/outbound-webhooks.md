# Send Agent Relay alerts to your own tools

The outbound webhook is the shortest path from Agent Relay to something you
already use: an internal dashboard, a desktop notifier, a queue, a home-grown
mobile app, or a small service that fans alerts into another system.

It is a notification transport, not a remote-control API. Agent Relay sends one
signed, runtime-validated JSON document for each deliverable alert. Your
receiver acknowledges it over HTTP. Requests remain authoritative in the local
SQLite database, and the payload can include a link back to the authenticated
local web board for answering them.

No Telegram bot, hosted Agent Relay account, or public URL is required. An HTTP
receiver on `127.0.0.1` works for local development.

## Configure it

Build and prove Agent Relay with the fake canary first. Then give the webhook a
shared secret of at least 32 UTF-8 bytes. The CLI accepts that secret only on
stdin, not as an argument:

```sh
WEBHOOK_SECRET="$(openssl rand -hex 32)"
printf '%s' "$WEBHOOK_SECRET" |
  node apps/relay/dist/cli.js webhook configure \
    --url http://127.0.0.1:4319/agent-relay \
    --secret-stdin

node apps/relay/dist/cli.js webhook status
node apps/relay/dist/cli.js transport select webhook
```

Keep `WEBHOOK_SECRET` in your receiver's secret manager or private environment;
the shell variable above is only a compact local-development example. The
configuration command writes `~/.agent-relay/webhook.json` with mode `0600`.
Status, doctor, and logs report only the endpoint origin, credential presence,
timeout, and stable failure codes. They do not report the secret, URL path, or
query.

Restart the daemon after selecting the transport:

```sh
node apps/relay/dist/cli.js daemon
```

In another terminal, prove a real delivery to your receiver:

```sh
node apps/relay/dist/cli.js webhook-canary
node apps/relay/dist/cli.js status
```

Configuration never selects a transport. Likewise, setting webhook environment
variables does not override a durable `fake`, `telegram`, or `whooshbang`
selection unless `AGENT_RELAY_TRANSPORT=webhook` is also explicit.

You can inject configuration instead of writing the file:

```dotenv
AGENT_RELAY_TRANSPORT=webhook
AGENT_RELAY_WEBHOOK_URL='<HTTPS-receiver-URL>'
AGENT_RELAY_WEBHOOK_SECRET='<shared-secret-of-at-least-32-bytes>'
AGENT_RELAY_WEBHOOK_TIMEOUT_MS=5000
```

The URL must use HTTPS unless its host is loopback. URL credentials and
fragments are rejected. Redirects are never followed. The timeout can be
configured from 100 to 30000 milliseconds and defaults to 5000.

## Receive and verify a delivery

Verify the signature over the raw request bytes before parsing JSON. The signed
value is:

```text
<X-Agent-Relay-Timestamp>.<exact HTTP request body>
```

The signature header is a lowercase hex HMAC-SHA256 prefixed with `v1=`. A
minimal Node.js receiver looks like this:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.AGENT_RELAY_RECEIVER_SECRET;
if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
  throw new Error("AGENT_RELAY_RECEIVER_SECRET must contain at least 32 bytes");
}

function signaturesMatch(actual, expected) {
  const left = Buffer.from(actual ?? "", "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const timestamp = request.headers["x-agent-relay-timestamp"];
    const actual = request.headers["x-agent-relay-signature"];
    const expected = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`, "utf8")
      .update(body)
      .digest("hex")}`;

    const timestampMs = Number(timestamp) * 1000;
    const fresh =
      Number.isFinite(timestampMs) &&
      Math.abs(Date.now() - timestampMs) <= 5 * 60_000;
    if (!fresh || !signaturesMatch(actual, expected)) {
      response.writeHead(401).end();
      return;
    }

    const delivery = JSON.parse(body.toString("utf8"));
    const idempotencyKey = request.headers["idempotency-key"];
    if (
      delivery.schema !== "agent-relay-webhook.v1" ||
      delivery.deliveryId !== idempotencyKey
    ) {
      response.writeHead(400).end();
      return;
    }

    // Commit delivery.deliveryId before doing non-idempotent downstream work.
    // "silent" is a visible history update; "notify" should attract attention.
    console.log(
      delivery.deliveryMode,
      delivery.message.title,
      delivery.message.text,
    );

    response.writeHead(202, { "content-type": "application/json" }).end(
      JSON.stringify({
        schema: "agent-relay-webhook-ack.v1",
        deliveryId: delivery.deliveryId,
        messageId: `local-${delivery.deliveryId}`,
      }),
    );
  });
}).listen(4319, "127.0.0.1");
```

Production receivers should also cap the request body, require
`Content-Type: application/json`, reject stale timestamps, and store the
`Idempotency-Key` before starting non-idempotent work. The same delivery ID is
reused for retries. Bounded presentation fields such as the human-readable age
label may be refreshed, so do not use the body digest as the delivery identity.
The timestamp and signature can also change on a later attempt; signature
verification and delivery deduplication are separate checks.

## Payload contract

Every request has these headers:

| Header                    | Meaning                               |
| ------------------------- | ------------------------------------- |
| `Content-Type`            | `application/json`                    |
| `Idempotency-Key`         | Stable Agent Relay delivery/event ID  |
| `X-Agent-Relay-Schema`    | `agent-relay-webhook.v1`              |
| `X-Agent-Relay-Timestamp` | Unix time in whole seconds            |
| `X-Agent-Relay-Signature` | `v1=` plus the exact-body HMAC-SHA256 |

The strict v1 envelope is:

```json
{
  "schema": "agent-relay-webhook.v1",
  "deliveryId": "event_fixture_webhook_12345678",
  "deliveryMode": "silent",
  "message": {
    "eventId": "event_fixture_webhook_12345678",
    "title": "Codex · agent-relay",
    "text": "Summary: Synthetic fixture notification\n\nSession ended · now\n\nsession.ended · codex/cli · main · session level-basin-41"
  },
  "source": {
    "occurredAt": "2026-07-28T14:00:00.000Z",
    "eventType": "session.ended",
    "harness": "codex",
    "surface": "cli",
    "repository": "agent-relay",
    "branch": "main",
    "sessionKey": "ca21fd46c699bc5492244186",
    "shortSessionId": "level-basin-41"
  }
}
```

`message` can also contain the provider-neutral `interaction`, `multiSelect`,
`questionSet`, and `actions` structures. Their values are opaque presentation
handles, not commands and not an inbound API.

`deliveryMode` is `notify` for an event that requires operator attention and
`silent` for routine lifecycle history such as a session opening, a prompt being
submitted, or structured background work continuing. A custom receiver should
keep silent events visible without producing a device alert. The field is
advisory at the HTTP boundary; the receiver owns its downstream notification
behavior.

When an open request can be answered in the local web companion, the envelope
also includes:

```json
{
  "handoff": {
    "mode": "local-web",
    "requestId": "request_fixture_webhook_12345678",
    "expiresAt": "2026-07-28T14:10:00.000Z",
    "url": "http://127.0.0.1:4317/ui/?request=request_fixture_webhook_12345678"
  }
}
```

The handoff URL carries no bearer or CSRF credential. Opening it still requires
the private local web credential, and the page focuses the exact request after
authentication. A receiver on another machine should present this as a "Respond
on Agent Relay host" link rather than assuming its own loopback points to the
developer's daemon. If the daemon was deliberately started with `--no-web`,
Agent Relay still sends a bounded question alert but omits structured response
controls and the handoff; the request remains visibly open in SQLite instead of
becoming a silent delivery failure.

The checked-in
[synthetic v1 fixture](../packages/webhook-transport/fixtures/webhook/delivery-v1.json)
is validated by the repository fixture gate.

## Acknowledgements and retries

Any `2xx` response with an empty body acknowledges the delivery. A receiver can
instead return the strict acknowledgement shown above. Its `deliveryId` must
match, and the optional `messageId` becomes Agent Relay's provider receipt.
Success bodies are limited to 16 KiB; malformed, oversized, or mismatched
acknowledgements fail visibly.

Agent Relay retries network failures, timeouts, HTTP `408`, `425`, `429`, and
`5xx` responses with the same delivery identity. It honors a valid `Retry-After`
header up to one hour. Redirects and other `4xx` responses are terminal.
Exhausted or terminal failures become visible SQLite dead letters and safe
status codes; response bodies are neither logged nor retained as error messages.

Run these when diagnosing a receiver:

```sh
agent-relay webhook status
agent-relay transport status
agent-relay status
agent-relay doctor
```

To remove only the file-backed webhook credential:

```sh
agent-relay webhook disconnect
```

Environment injection can remain active after that command, and transport
selection is deliberately unchanged. Restart after changing either.

## Outbound now; inbound later

V1 does not accept webhook answers. Do not expose the existing loopback daemon
routes through a reverse proxy and call them a public integration API: those
routes were designed for local hooks, the local browser, and exact built-in
adapters.

A post-release design story will evaluate a small authenticated inbound response
API on the daemon, including request/option contracts, configurable auth, replay
protection, reverse-proxy deployment, first-writer behavior, rate limits, and
whether loopback remains the safe default. Until that threat model is complete,
custom tools should use the outbound payload plus the local web handoff.
