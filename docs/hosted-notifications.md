# Optional hosted Notifications boundary

Flow XO Notifications is an optional, replaceable notification transport. It is
not required for local SQLite, hooks, fake delivery, direct Telegram, the web
companion, supervision, or continuation.

Open Source V1 remains a local Node.js application. It does not require a hosted
Agent Relay account, Cloudflare runtime, public callback, or Flow XO credential.

## Current implementation state

`packages/notifications-transport`,
`agent-relay notifications connect|status|disconnect`, and
`agent-relay transport` now implement the AR2.1–AR2.2 setup, explicit outbound
selection, and readiness boundary against exact pinned Notifications C0
artifacts. They prove:

- subscriber authorization without claiming success while it is pending;
- local 32-byte secret and credential-ID generation;
- digest-only machine-credential registration;
- narrow-credential poll and synthetic-message smoke tests;
- mode-`0600`, atomic, symlink-rejecting local storage;
- reconnect/rotation, idempotent hosted revocation, and explicit local erasure;
- HTTPS outside exact loopback mocks, no redirect following, and bounded bodies;
- provider-neutral delivery mapping and stable idempotency;
- bounded confirm/select/input interaction projection;
- retryable, terminal, and ambiguous outcome classification;
- authenticated signed-answer validation;
- exact local machine/session/request/option/expiry binding;
- SQLite-first resolution and provider acknowledgement;
- crash-before-ack replay without duplicate resume; and
- cross-machine stream, message, and administration denial.

The daemon can now select `fake`, direct `telegram`, or outbound `notifications`
explicitly. Credential presence never selects a transport, there is no dual send
or automatic failover, and switching retains SQLite and request state. There is
not yet a continuous hosted interaction poller, callback deployment, or
release-ready C0 promotion. Until C0-09 approves a release candidate, use the
executable C0 mock—not a production account—as the integration source of truth.

## Mock-backed setup command

Build first:

```sh
pnpm build
node apps/relay/dist/cli.js notifications --help
```

The broad project credential is accepted only through environment injection,
stdin, or an interactive hidden prompt. It is not accepted positionally,
returned in output, or written to either local file. For a noninteractive
secret-manager command:

```sh
credential_command | node apps/relay/dist/cli.js notifications connect \
  --credential-stdin \
  --base-url https://notifications.example.test \
  --subscriber-id subscriber_configured_in_notifications \
  --notifier-id default
```

The command emits the bounded authorization URL as a diagnostic immediately and
waits up to five minutes by default. Complete Telegram authorization at that
URL. A pending, expired, cancelled, failed, or revoked link exits without
creating or storing machine credential material and never reports `connected`.

After activation, Agent Relay:

1. binds one stable local machine ID to that subscriber/notifier;
2. generates a 32-byte secret and credential ID locally;
3. sends only the SHA-256 digest to Notifications;
4. polls the authenticated machine stream and sends a fixed synthetic canary;
5. verifies the returned project, environment, binding, subscriber, notifier,
   machine, and exact four narrow scopes; and
6. stores the new connection only after those checks pass.

HTTP is allowed only for exact loopback mock origins such as
`http://127.0.0.1:4319`. Every other origin requires HTTPS. Credential-bearing
requests use manual redirect handling and never forward authentication to a
redirect target. Success bodies are limited to 1 MiB and problem bodies to 64
KiB before JSON parsing.

Inspect safe local status:

```sh
node apps/relay/dist/cli.js notifications status
```

Status reports only the API origin, contract/environment, hashed machine and
canary references, credential presence, state, and pending-revocation count. It
does not print the credential or full machine, project, subscriber, notifier,
binding, message, or diagnostic identifiers.

## Select the outbound transport

Setup and selection are separate deliberate operations:

```sh
node apps/relay/dist/cli.js transport status
node apps/relay/dist/cli.js transport select notifications
node apps/relay/dist/cli.js daemon
```

The durable selection is a strict mode-`0600` `~/.agent-relay/transport.json`.
`AGENT_RELAY_TRANSPORT` overrides it for one process environment, and
`daemon --transport notifications` is the highest-precedence daemon-only
override. Exact accepted values are `fake`, `telegram`, and `notifications`;
unknown values fail closed.

The daemon refuses a selected hosted mode unless the retained narrow
configuration is active and its credential is present. It never reads or retains
the broad project bootstrap credential for runtime delivery. Selecting another
mode leaves the hosted connection and every local event/request intact.

`agent-relay status` reports selected mode/source, safe readiness, last hosted
send, local pending/retry/dead-letter counts, and the last hosted error as a
code plus classification. Until FXO-1152 lands, hosted poll status is truthfully
`not-started` with null last-poll/cursor values and zero claimed unacknowledged
events; these fields are not evidence that inbound answers work. Raw sessions,
prompts, answers, transcripts, credentials, and full provider identifiers are
excluded from status and doctor.

## Credential and disconnect lifecycle

The local files are:

- `~/.agent-relay/notifications.json`: private non-secret connection metadata;
- `~/.agent-relay/notifications-credential.json`: only the current narrow
  bearer, its credential ID, creation time, and safe rotation lineage.

Both are regular mode-`0600` JSON files under a private directory. Writes use a
same-directory temporary file, file sync, and atomic rename. Existing symlinks,
non-regular files, exposed permissions, oversized JSON, malformed schemas, and
credential/configuration mismatches fail closed.

`disconnect` is local by default and retains both files so a temporary provider
outage or deliberate disablement is reversible:

```sh
node apps/relay/dist/cli.js notifications disconnect
```

Hosted revocation requires the broad project credential again:

```sh
credential_command | node apps/relay/dist/cli.js notifications disconnect \
  --revoke --credential-stdin
```

Add `--erase-credential` to remove the local narrow secret after disconnect. Add
both `--erase-credential --erase-configuration` to remove the complete hosted
setup record. Configuration erasure is refused while a hosted credential may
still be active unless `--revoke` is also supplied.

Running `notifications connect` again generates and smoke-tests a replacement
before switching local configuration. The former credential/client is revoked
after the new connection commits. A failed old-client revocation remains as
bounded `pendingRevocations` diagnosis and is retried on a later credentialed
connect/disconnect; it is never silently discarded. Revoke the retained
connection before changing the API origin, project, or environment so those
pending records never lose their revocation authority.

## Data contract

The hosted provider may receive only the bounded `DeliveryMessage` projection:

- deterministic event/correlation identity;
- rendered title and secret-redacted text;
- prompt, safe option labels, and opaque values for supported interactions; and
- expiry and acknowledgement metadata required by the contract.

It must not receive a raw hook payload, full transcript, repository contents,
tool input, executable command, process arguments, absolute path, machine
identity, or local credential. The provider cannot select or execute a resume.

Provider answers are untrusted until signature/schema/stream evidence,
configured scope, hosted message/interaction, local request identity, option
membership, occurrence, and expiry all match. The local first-writer-wins
transition remains authoritative.

## Failure boundary

Retries preserve the same event ID. Authentication, scope, validation,
subscriber, known terminal provider, and idempotency-conflict failures do not
retry as new messages. An ambiguous provider outcome forbids a fresh automatic
send and remains visible for diagnosis.

After an authentication, scope, binding, or pinned-contract configuration
failure, the in-process adapter opens a terminal circuit. Later local events are
still durably dead-lettered and counted, but no additional credential-bearing
provider request is made until the operator fixes/reconnects and restarts.
Status exposes only the safe error code/classification and the number of
suppressed hosted deliveries. Transient failures retain the existing bounded
SQLite retry policy and stable event identity.

A provider acknowledgement happens after the local result commits. A crash
before acknowledgement can repeat the hosted answer, but the reopened SQLite
state proves it is a duplicate and the resume command remains single-owner.

## Deployment boundary

A future hosted adapter may call a Cloudflare-hosted Notifications service. That
does not move Agent Relay protocol, SQLite, hooks, installer, daemon, or
supervisor into Cloudflare. Direct Telegram and fake/local operation remain
independent transport choices.

Before production selection, remaining AR2 work must document and test:

- polling lifecycle, durable cursors, and local acknowledgement state;
- provider retention and privacy terms;
- retry/quarantine/reconciliation behavior;
- deliberate switching without double delivery;
- fake executable contract testing; and
- direct-Telegram parity for local authority and continuation.

No hosted service may silently become required for installation, doctor, local
canary, or uninstall.

See the [transport contributor guide](extending-transports.md), the pinned
[consumer package README](../packages/notifications-transport/README.md), and
the
[AR2 specification](projects/notifications-transport-adapter/project-spec.md).
