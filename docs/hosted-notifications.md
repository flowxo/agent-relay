# Optional hosted Notifications boundary

Flow XO Notifications is an optional, replaceable notification transport. It is
not required for local SQLite, hooks, fake delivery, direct Telegram, the web
companion, supervision, or continuation.

Open Source V1 remains a local Node.js application. It does not require a hosted
Agent Relay account, Cloudflare runtime, public callback, or Flow XO credential.

## Current implementation state

`packages/notifications-transport`,
`agent-relay notifications connect|status|disconnect`, and
`agent-relay transport` now implement the complete AR2.1–AR2.6 mock-backed
setup, explicit selection, and durable interaction boundary against exact pinned
Notifications C0 artifacts. They prove:

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
- separate durable terminal-presentation retry with one deterministic operation
  identity;
- stable retry/configuration/security/quarantine/operator-action failure
  categories and rate-limited safe logs;
- runtime disconnect/revocation guards that stop new send/poll/ack calls while
  retaining local state; and
- cross-machine stream, message, and administration denial;
- one common fake/direct-Telegram/Notifications behavior matrix; and
- a scripts-disabled clean-home proof from the packed release artifact.

The daemon can select `fake`, direct `telegram`, outbound `webhook`, or
`notifications` explicitly. Hosted mode runs outbound delivery plus the
authenticated machine-event poll/claim/resolve/ack loop.

Credential presence never selects a transport.

There is no dual send or automatic failover.

Switching retains SQLite and request state. The terminal-presentation worker is
implemented, but the exact pinned rc.1 client does not expose a resolved-message
update endpoint. Agent Relay records that optional capability as unsupported
instead of misusing message cancellation. C0-09 approved the exact `1.0.0-rc.1`
candidate. Continue using the executable C0 mock—not a production account—as the
integration source of truth until the Notifications owner supplies and
authorizes an AR3 service environment.

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
override. Exact accepted values are `fake`, `telegram`, `webhook`, and
`notifications`; unknown values fail closed.

The daemon refuses a selected hosted mode unless the retained narrow
configuration is active and its credential is present. It never reads or retains
the broad project bootstrap credential for runtime delivery. Selecting another
mode leaves the hosted connection and every local event/request intact.

`agent-relay status` reports selected mode/source, safe readiness, last hosted
send, local pending/retry/dead-letter counts, last successful poll, a hashed
committed-cursor reference, unacknowledged local event count, and the last
hosted error as a code plus classification/category. Presentation status adds
only capability and pending/retry/updated/blocked counts. `not-started` means
the selected daemon has not completed a poll; `active` means at least one
response was validated; `error` retains a safe failure code. Raw sessions,
prompts, answers, transcripts, credentials, full cursor values, and full
provider identifiers are excluded from status and doctor.

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

## Terminal presentation and diagnosis

Every durably handled hosted answer creates an independent message-update job.
After provider acknowledgement, the daemon projects `answered`, `duplicate`,
`expired`, `cancelled`, or `unsupported` plus the local resolution-source
category into a bounded presenter. A retry always reuses
`resolution_${sha256(hostedEventId)}`. It never sends a new message, re-runs the
decision, or touches continuation authority.

The executable rc.1 presenter returns `unsupported` without HTTP because the
pinned client has no resolution-update method. The job becomes durably blocked
with a safe capability code while polling and local authority continue. A future
exact contract may implement the same interface; supported-fake tests already
prove successful updates, transient retry, response-loss retry with the same
identity, terminal ambiguity, and restart recovery.

Hosted failures map to stable local categories:

| Condition                            | Category and automatic behavior                    |
| ------------------------------------ | -------------------------------------------------- |
| 401 / inactive or revoked connection | terminal configuration; explicit reconnect/restart |
| 403 / identity or scope mismatch     | dead-letter/security; no processing                |
| 404 removed resource                 | operator action; inspect the retained mapping      |
| 409 idempotency conflict / redirect  | dead-letter/security; never mint another identity  |
| 429 / 5xx / timeout                  | bounded retry of the same operation                |
| schema or malformed success body     | quarantine/fail closed                             |
| explicit `outcome_unknown`           | operator action; no new hosted message or identity |

The first repeated network/auth/config failure is logged with a safe code.
Equivalent failures inside the bounded interval remain durable in SQLite but are
aggregated in logs; a later emitted record includes the suppressed count. Empty
polls and shutdown cancellation are not failures.

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

The daemon also rechecks the private connection commit marker before every
hosted send, poll, and acknowledgement. A local disconnect, revocation, erased
configuration, or rotation stops new calls in the running process. Local events,
decisions, hosted mappings, and safe errors remain in SQLite. Explicit
reconnect/rotation followed by daemon restart builds a fresh client and resumes
from durable state.

A provider acknowledgement happens after the local result commits. A crash
before acknowledgement can repeat the hosted answer, but the reopened SQLite
state proves it is a duplicate and the resume command remains single-owner.
Local duplicate/expired/cancelled reason codes remain in SQLite. The pinned
machine contract accepts `reason_code` only with a `quarantined`
acknowledgement, so a normal `processed` acknowledgement deliberately omits
those local-only reasons.

## Transport parity

Fake, direct Telegram, and Notifications run the same local behavior matrix for
bounded delivery, duplicate ingestion, retry identity, confirm/select/input,
identity rejection, expiry, duplicate answers, both terminal/phone race orders,
restart, and single-owner resume. The direct Telegram leg uses the real
`TelegramBotTransport` and reply router against a synthetic Bot API; the hosted
leg uses the exact pinned contract mock and durable poller.

Presentation differences are declared rather than normalized away. Fake and
direct Telegram advertise `message-updates`; the pinned Notifications
observation advertises only proven confirm, single-select, and free-text
behavior with one question and at most six options. It does not advertise
durable drafts, ordered/multi-select sets, or message updates. The daemon also
reports the exact resolved-presentation capability as unsupported.

## Deployment boundary

A future hosted adapter may call a Cloudflare-hosted Notifications service. That
does not move Agent Relay protocol, SQLite, hooks, installer, daemon, or
supervisor into Cloudflare. Direct Telegram and fake/local operation remain
independent transport choices.

## Packed artifact proof

From a preflighted checkout on the supported macOS runtime:

```sh
pnpm package:hosted:check
```

This command creates the exact release tarball, installs it with lifecycle
scripts disabled into a clean home and prefix, explicitly rebuilds the approved
SQLite native dependency, and rejects workspace or sibling runtime resolution.
The installed public CLI then connects to the exact pinned executable mock,
stores a narrow mode-`0600` credential separately from non-secret configuration,
selects Notifications, and resolves confirm, select, and input requests.

The proof kills the daemon after local commit but before one provider
acknowledgement. Restart must replay that immutable acknowledgement, advance the
provider cursor exactly once, and leave one local answer/resume outcome. It then
proves safe presentation diagnosis, explicit hosted revoke/erasure, retained
SQLite authority under a fake transport, the real direct-Telegram adapter
against a synthetic Bot API, owned uninstall with retained state, and
package-manager removal.

The mock is a verifier-only dependency and is never bundled into the product.
The command imports the exact versions, archive digests, and source commits from
`contracts/contract-lock.json`; copied owner types, mutable references,
workspace links, and sibling runtime dependencies fail existing gates. Its
privacy sentinels prove that credentials, provider IDs, prompts, answers, hidden
transcript text, machine paths, and executable values do not appear in the
packed CLI or captured diagnostics. Unsupported operating systems explicitly
skip only the native installed-runtime portion.

This is the AR2 release handoff, not production-service dogfood. AR3 still owns:

- provider retention/privacy-term confirmation for the production service;
- real hosted subscriber authorization and digest verification;
- live service delivery, polling, reply, disconnect, and recovery evidence; and
- operational acceptance of deliberate switching.

No hosted service may silently become required for installation, doctor, local
canary, or uninstall.

See the [transport contributor guide](extending-transports.md), the pinned
[consumer package README](../packages/notifications-transport/README.md), and
the
[AR2 specification](projects/notifications-transport-adapter/project-spec.md).
