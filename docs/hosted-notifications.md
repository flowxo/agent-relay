# Optional hosted Notifications boundary

Flow XO Notifications is an optional, replaceable notification transport. It is
not required for local SQLite, hooks, fake delivery, direct Telegram, the web
companion, supervision, or continuation.

Open Source V1 remains a local Node.js application. It does not require a hosted
Agent Relay account, Cloudflare runtime, public callback, or Flow XO credential.

## Current implementation state

`packages/notifications-transport`,
`agent-relay notifications connect|status|disconnect`, and
`agent-relay transport` now implement the AR2.1–AR2.3 setup, explicit selection,
and durable interaction boundary against exact pinned Notifications C0
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
- authenticated, runtime-validated poll-response contracts without claiming a
  detached payload signature;
- exact local machine/session/request/option/expiry binding;
- durable cursor/event/acknowledgement/message-update state;
- continuous bounded long polling selected only in hosted mode;
- SQLite-first resolution followed by idempotent provider acknowledgement;
- crash-before-ack replay without duplicate resume; and
- cross-machine stream, message, and administration denial.

The daemon can now select `fake`, direct `telegram`, or `notifications`
explicitly. Hosted mode runs outbound delivery plus the authenticated
machine-event poll/claim/resolve/ack loop.

Credential presence never selects a transport.

There is no dual send or automatic failover.

Switching retains SQLite and request state. Hosted message presentation
reflection and release-ready C0 promotion are still pending. Until C0-09
approves a release candidate, use the executable C0 mock—not a production
account—as the integration source of truth.

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

## Select the transport

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
send, local pending/retry/dead-letter counts, last successful poll, a hashed
committed-cursor reference, unacknowledged local event count, and the last
hosted error as a code plus classification. `not-started` means the selected
daemon has not completed a poll; `active` means at least one response was
validated; `error` retains a safe failure code. Raw sessions, prompts, answers,
transcripts, credentials, full cursor values, and full provider identifiers are
excluded from status and doctor.

## Hosted answer loop

The selected hosted daemon drains any durable acknowledgement retry before it
polls after the locally committed cursor. For one event at a time it validates
the pinned response contract, binding, message/interaction/correlation, local
machine/harness/session/turn/request, answer kind, option membership,
occurrence, and expiry. It then commits the local first-writer-wins result plus
safe claim and retry state in SQLite before acknowledging Notifications.

Confirm, select, and bounded input answers use the same local resolution path as
direct Telegram and the web companion. A crash before acknowledgement repeats
the immutable event and cannot create another decision. A response-loss crash
after provider acceptance repeats the same deterministic acknowledgement before
polling again. Invalid answer data is explicitly quarantined; identity,
authentication, contract, and cursor-integrity failures stop without advancing
past the event.

The C0 endpoint authenticates the narrow credential and the pinned client
validates the response schema. The C0 poll response does not carry a detached
signature, so Agent Relay records contract-backed authentication/schema evidence
rather than claiming cryptographic payload signing.

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

Provider answers are untrusted until authenticated schema/contract/stream
evidence, configured binding, hosted message/interaction, local request
identity, option membership, occurrence, and expiry all match. The local
first-writer-wins transition remains authoritative.

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

- provider retention and privacy terms;
- hosted terminal-message reflection and update retry behavior;
- deliberate switching without double delivery;
- common fake/direct-Telegram/hosted parity; and
- the packaged hosted lifecycle.

No hosted service may silently become required for installation, doctor, local
canary, or uninstall.

See the [transport contributor guide](extending-transports.md), the pinned
[consumer package README](../packages/notifications-transport/README.md), and
the
[AR2 specification](projects/notifications-transport-adapter/project-spec.md).
