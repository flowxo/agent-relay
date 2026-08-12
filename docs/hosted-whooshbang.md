# Optional hosted WhooshBang boundary

WhooshBang is an optional, replaceable hosted notification transport for Agent
Relay. It is not required for local SQLite, hooks, fake delivery, direct
Telegram, the web companion, supervision, or continuation.

Open Source V1 remains a local Node.js application. It does not require a hosted
Agent Relay account, Cloudflare runtime, public callback, or WhooshBang
credential.

## Current implementation state

`packages/whooshbang-transport`,
`agent-relay whooshbang connect|status|disconnect`, `agent-relay transport`,
`agent-relay whooshbang-canary`, and `agent-relay doctor --live` implement the
packed hosted boundary against exact pinned WhooshBang artifacts. The hosted
connect path uses one developer OAuth consent, public-client registration,
authorization code with S256 PKCE, and the remote MCP
`whooshbang_create_machine_client` tool. The older broad-project-credential path
remains only as an explicit compatibility and administrative-revocation path.
Together the OAuth path, the explicit legacy compatibility path, and the pinned
consumer suite prove:

- legacy subscriber authorization without claiming success while it is pending;
- local 32-byte secret and credential-ID generation;
- digest-only machine-credential registration;
- narrow-credential poll and synthetic-message smoke tests;
- mode-`0600`, atomic, symlink-rejecting local storage;
- legacy reconnect/rotation, idempotent hosted revocation, and explicit local
  erasure;
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
- one common fake/direct-Telegram/WhooshBang behavior matrix; and
- a scripts-disabled clean-home proof from the packed release artifact.

The daemon can select `fake`, direct `telegram`, outbound `webhook`, or
`whooshbang` explicitly. Hosted mode runs outbound delivery plus the
authenticated machine-event poll/claim/resolve/ack loop.

Credential presence never selects a transport.

There is no dual send or automatic failover.

Switching retains SQLite and request state. The terminal-presentation worker is
implemented, but the exact pinned `@whooshbang/sdk@1.0.0-rc.13` client does not
expose a resolved-message update endpoint. Agent Relay records that optional
capability as unsupported instead of misusing message cancellation. C0-09
recorded `go` for the retired pre-rename `1.0.0-rc.1` candidate; that decision
does not carry to WhooshBang's breaking rename cut. FXO-1373 rebuilt the
repository-native consumer proof against the exact RC.4 artifacts, FXO-1436
advanced it to RC.5, the FXO-1209 re-vendor advanced it to contracts rc.10 / SDK
rc.11 / mock rc.13, and FXO-1531 advances it to `contracts@1.0.0-rc.12`,
`sdk@1.0.0-rc.13`, and `contract-mock@1.0.0-rc.15`. The executable mock remains
the deterministic credential-free regression source; an explicitly approved real
environment supplies the deployed-boundary evidence.

## OAuth/MCP hosted setup

Build first:

```sh
pnpm build
node apps/relay/dist/cli.js whooshbang --help
```

Keep the private project selector, subscriber, and notifier in the process
environment. The command arguments and output then contain no provider or
subscriber identity:

```sh
export AGENT_RELAY_WHOOSHBANG_BASE_URL='<WhooshBang-base-URL>'
export AGENT_RELAY_WHOOSHBANG_PROJECT_SELECTOR='<project-selector>'
export AGENT_RELAY_WHOOSHBANG_ENVIRONMENT=test
export AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID='<subscriber-id>'
export AGENT_RELAY_WHOOSHBANG_NOTIFIER_ID='<notifier-id>'
node apps/relay/dist/cli.js whooshbang connect
```

Agent Relay starts an ephemeral `127.0.0.1` callback before registering the
public OAuth client, opens the consent page without placing the URL, state, or
PKCE verifier in process arguments, and requests exactly
`projects:read machine-clients:write`. Sign in and approve once. The OAuth code,
verifier, and access token stay in memory and are discarded when the command
ends. Consent is the complete approval: there is no Telegram registration turn
or second important-action confirmation.

The environment name belongs to the selected WhooshBang deployment. For example,
an approved staging deployment may use its internal `live` environment to reach
that deployment's real provider binding; this does not select the production
deployment. Use only the deployment/environment pair that was explicitly
approved.

After approval, Agent Relay:

1. resolves the approved active project and environment through MCP;
2. generates a 32-byte machine secret and credential ID locally;
3. journals that material and its next local credential generation at mode
   `0600` before the remote side effect so a crash or lost response replays the
   same accepted create instead of orphaning a second identity;
4. sends only the credential ID and SHA-256 digest to WhooshBang;
5. validates project, environment, binding, subscriber, notifier, machine, and
   the exact four narrow runtime scopes;
6. proves an authenticated narrow poll; and
7. atomically promotes the narrow bearer into the active mode-`0600` store and
   removes the pending journal.

Only one WhooshBang lifecycle operation—OAuth connect, legacy connect, or
disconnect—may run in a state directory at a time. A retry after a crash or
uncertain response must use the same OAuth target; legacy bootstrap remains
blocked, and disconnect preserves the recovery journal until exact replay or
verified cleanup is possible. When connection persistence completed before a
crash but journal deletion did not, the next OAuth command verifies the active
target, exact credential, and generation, removes the duplicate journal, and
then reports the already-active connection without reopening consent or making a
remote request. A different requested target still requires the retained
connection to be revoked first. OAuth discovery, registration, token exchange,
MCP calls, cleanup, and the post-answer diagnostic all have local deadlines.

Setup itself sends no notification. Select WhooshBang, start the daemon, and run
the one answerable hosted canary only when that traffic is explicitly approved:

```sh
node apps/relay/dist/cli.js transport select whooshbang
node apps/relay/dist/cli.js daemon
node apps/relay/dist/cli.js whooshbang-canary \
  --wait-ms 120000 \
  --request-ttl-ms 300000
node apps/relay/dist/cli.js doctor --live
```

`doctor --live` is the WhooshBang-specific running-daemon evidence check; use
plain `doctor` for fake, direct Telegram, and webhook installation/readiness
diagnosis.

The canary succeeds only when the reply arrives through WhooshBang, matches the
fixed synthetic challenge, resolves exactly once locally, and the daemon proves
a committed hosted cursor with zero unacknowledged events. The client wait and
durable request TTL are separate, the TTL must outlive the wait by at least one
minute, and the aggregate pre/post status must attribute exactly one newly
delivered event to the canary. A ceiling-bound run must use a normal terminal or
exact hook-denied agent boundary; `canary-attribution-conflict` invalidates the
proof. Its output contains only hashed message/diagnostic references, safe
timestamps, cursor reference, capability state, and bounded aggregate
attribution counts.

## Explicit legacy mock and administration path

Passing `--legacy-project-credential` (with hidden prompt or environment
injection), or the explicit `--credential-stdin`, selects the older broad
project-credential bootstrap. Merely having a stale broad credential in the
environment never changes the default OAuth path. The legacy path exists for the
exact contract mock, migration, and explicit machine-client revocation. The
broad credential is never accepted positionally, returned in output, or written
to disk.

HTTP is allowed only for exact loopback mock origins such as
`http://127.0.0.1:4319`. Every other origin requires HTTPS. Credential-bearing
requests use manual redirect handling and never forward authentication to a
redirect target. Success bodies are limited to 1 MiB and problem bodies to 64
KiB before JSON parsing.

Inspect safe local status:

```sh
node apps/relay/dist/cli.js whooshbang status
```

Status reports only the API origin, contract/environment, a hashed machine
reference, the hashed canary reference after that journey passes, credential
presence, state, and pending-revocation count. It does not print the credential
or full machine, project, subscriber, notifier, binding, message, or diagnostic
identifiers.

## Select the transport

Setup and selection are separate deliberate operations:

```sh
node apps/relay/dist/cli.js transport status
node apps/relay/dist/cli.js transport select whooshbang
node apps/relay/dist/cli.js daemon
```

The durable selection is a strict mode-`0600` `~/.agent-relay/transport.json`.
`AGENT_RELAY_TRANSPORT` overrides it for one process environment, and
`daemon --transport whooshbang` is the highest-precedence daemon-only override.
Exact accepted values are `fake`, `telegram`, `webhook`, and `whooshbang`;
unknown values fail closed.

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
safe claim and retry state in SQLite before acknowledging WhooshBang.

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

The executable pinned presenter returns `unsupported` without HTTP because the
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

- `~/.agent-relay/whooshbang.json`: private non-secret connection metadata;
- `~/.agent-relay/whooshbang-credential.json`: only the current narrow bearer,
  its credential ID, creation time, and safe rotation lineage;
- `~/.agent-relay/whooshbang-oauth-provisioning.json`: a temporary mode-`0600`
  recovery journal containing the locally retained candidate bearer and exact
  target/generation until connection promotion or verified cleanup completes.

All are regular mode-`0600` JSON files under a private directory. Writes use a
same-directory temporary file, file sync, and atomic rename. Existing symlinks,
non-regular files, exposed permissions, oversized JSON, malformed schemas, and
credential/configuration mismatches fail closed.

A journal without a committed connection may be the sole replay material for a
remote create whose response was lost. Local disconnect therefore reports
`oauth_recovery_pending` and preserves it; it never falls through to legacy
provisioning. A journal proven to duplicate the committed connection generation
is removed during restart reconciliation or disconnect.

If a crash lands the new credential file before its configuration commit marker,
restart accepts that credential-only state only when its ID, readable bearer,
and generation exactly match the private OAuth journal. This also covers a
generation-two candidate that replaced the credential file beside a fully
revoked, no-pending generation-one configuration. The duplicate candidate file
is removed under the configuration lock, the journal's recorded generation
remains authoritative, and exact-target OAuth replay continues. Status and full
local erase continue to report and preserve that recovery until it is replayed
or cleanup is verified. Any nonmatching orphan or non-revoked prior
configuration fails closed.

`disconnect` is local by default and retains both files so a temporary provider
outage or deliberate disablement is reversible:

```sh
node apps/relay/dist/cli.js whooshbang disconnect
```

Hosted revocation requires the broad project credential again:

```sh
credential_command | node apps/relay/dist/cli.js whooshbang disconnect \
  --revoke --credential-stdin
```

Add `--erase-credential` to remove the local narrow secret after disconnect. Add
both `--erase-credential --erase-configuration` to remove the complete hosted
setup record. Configuration erasure is refused while a hosted credential may
still be active unless `--revoke` is also supplied.

The default OAuth path refuses to replace a retained connection: explicitly
revoke it before connecting again. In the legacy project-credential path,
running `whooshbang connect --legacy-project-credential` generates and
smoke-tests a replacement before switching local configuration. The former
credential/client is revoked after the new connection commits. A failed
old-client revocation remains as bounded `pendingRevocations` diagnosis and is
retried on a later credentialed connect/disconnect; it is never silently
discarded. Revoke the retained connection before changing the API origin,
project, or environment so those pending records never lose their revocation
authority.

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
state proves it is a duplicate and the resume command remains single-owner. The
exact consumer suite also proves that an event acknowledged beyond a cursor gap
is omitted from subsequent polls, and that replaying its acknowledgement reports
`existing` with the current committed cursor rather than returning the stale
body from the first acknowledgement. Local duplicate/expired/cancelled reason
codes remain in SQLite. The pinned machine contract accepts `reason_code` only
with a `quarantined` acknowledgement, so a normal `processed` acknowledgement
deliberately omits those local-only reasons.

## Transport parity

Fake, direct Telegram, and WhooshBang run the same local behavior matrix for
bounded delivery, duplicate ingestion, retry identity, confirm/select/input,
identity rejection, expiry, duplicate answers, both terminal/phone race orders,
restart, and single-owner resume. The direct Telegram leg uses the real
`TelegramBotTransport` and reply router against a synthetic Bot API; the hosted
leg uses the exact pinned contract mock and durable poller.

Presentation differences are declared rather than normalized away. Fake and
direct Telegram advertise `message-updates`; the pinned WhooshBang observation
advertises only proven confirm, single-select, and free-text behavior with one
question and at most six options. It does not advertise durable drafts,
ordered/multi-select sets, or message updates. The daemon also reports the exact
resolved-presentation capability as unsupported.

## Deployment boundary

The explicitly selected hosted adapter calls the configured WhooshBang service.
That does not move Agent Relay protocol, SQLite, hooks, installer, daemon, or
supervisor into Cloudflare. Direct Telegram, outbound webhook, and fake/local
operation remain independent transport choices. Exactly one transport is
selected; there is no dual send or automatic failover.

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
selects WhooshBang, and resolves confirm, select, and input requests.

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

AR3 completed hosted dogfood and reliability exit with
`go with named residuals`. The retained live-reviewed package came from PR #39
and does not contain PR #40 or PR #41. PR #40 source separately passed
credential-free packed proof; its ephemeral package was neither retained nor
live-tested. PR #41's distinct credential-free release bundle was also not
live-tested, and native release-exit was still non-green at that earlier AR3
evidence point. The exact heads, merges, and SHA-256 values are frozen in the
[V1 release record](v1-release-boundary.md). No live authorization carries
forward, and this evidence does not authorize another provider observation.

No hosted service may silently become required for installation, doctor, local
canary, or uninstall.

See the [transport contributor guide](extending-transports.md), the pinned
[consumer package README](../packages/whooshbang-transport/README.md), and the
[adapter specification](projects/notifications-transport-adapter/project-spec.md).
