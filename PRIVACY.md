# Privacy

Agent Relay is a local-first application. Open Source V1 has no product
analytics, usage telemetry, remote crash-report service, hosted account, or
required Flow XO service. A supervised child exit can create an attention event
for the operator; that is local product behavior and is not telemetry.

This document describes the current source behavior. A future opt-in telemetry
feature would require a separate specification covering its payload, consent,
endpoint, retention, and disablement.

## Data stored locally

The default state directory is `~/.agent-relay`; set `AGENT_RELAY_STATE_DIR` to
use another exact path. Depending on the commands and features used, Agent Relay
stores:

- `relay.sqlite` and its SQLite WAL/SHM sidecars, including normalized events,
  delivery state, request state, bounded agent summaries or excerpts, operator
  answers, session metadata, diagnostics, resume claims, transport message/topic
  identifiers, topic-cleanup/prune modes, inactivity cutoffs, bounded candidate
  metadata, decisions, attempt state, native-hook ordering allocations, and two
  monotonic event insertion/deletion counters;
- `fallback-spool.ndjson` and its segment, pending, and processing siblings,
  containing bounded normalized hook records that could not reach the daemon yet
  or are being recovered;
- `relay.ndjson` and rotated siblings, containing structured redacted
  diagnostics;
- `web-credential.json`, containing independent local bearer and CSRF secrets
  when the local web companion is enabled;
- `transport.json`, containing the explicitly selected transport and update
  timestamp, but no transport credential;
- optional `webhook.json`, containing the explicitly configured outbound URL,
  shared HMAC secret, timeout, and configuration timestamp;
- optional `whooshbang.json`, containing the hosted API origin, subscriber and
  optional notifier routing, machine-client reference, contract version, and
  connection metadata;
- optional `whooshbang-credential.json`, containing the narrow machine bearer
  created for the current hosted connection;
- temporary `whooshbang-oauth-provisioning.json`, the crash-recovery journal for
  an OAuth/MCP provisioning attempt; it can contain a candidate narrow bearer
  until reconciliation commits or erases it;
- `install.json` and `bin/agent-relay`, which record and launch the owned
  user-level installation; and
- optional experimental `runner-bridge.json`, `runner-bridge.sqlite`, and its
  SQLite WAL/SHM sidecars, which retain bridge selection, runner authority,
  private product/native mappings, queued protocol frames, cursors, sanitized
  effect outcomes, normalized approval action digests, and adoption state; and
- the stable random local machine identifier used to separate sessions.

Agent Relay does not intentionally store a harness's raw hook payload or full
transcript. It can store the bounded last assistant message, question, choice
labels, failure summary, and operator answer needed to notify and continue a
session. Those values can still contain private source or conversation content.
Treat the state directory as sensitive.

Native-hook ordering allocations contain only opaque machine, harness, session,
and event identifiers, a SHA-256 canonical source fingerprint, a numeric
sequence, and allocation/update timestamps. The allocator does not add the raw
hook body, transcript, assistant message, task detail, credential, or
machine-specific path to SQLite.

For a Claude Code Stop that reports active background work, Agent Relay retains
only the in-flight and scheduled item counts. It discards task and cron IDs,
types, status strings, descriptions, commands, agent names, server/tool names,
workflow names, schedules, prompts, transcript paths, and the assistant message
from that paused observation. The resulting event is suppressed locally and is
not sent to a notification transport.

The experimental runner bridge is not a notification transport and does not send
through Telegram or WhooshBang. When explicitly composed later, it initiates its
own versioned outbound connection. Its status and doctor output exclude private
native session references, proof material, leases, frame payloads, source,
transcript, prompts, tool input/output, paths, environment, and credentials.
Approval command text, paths, patches, reasons, and raw native request bodies
stay inside the driver process; runner events contain only the normalized action
kind, SHA-256 target/parameter digests, generic summary, product IDs, expiry,
and capability digest.

The installer may create private timestamped backups next to changed harness
configuration files. The default files are:

- `~/.codex/hooks.json`;
- `~/.claude/settings.json`; and
- `~/.cursor/hooks.json`.

Backups can contain the user's pre-existing configuration and are not inside the
Agent Relay state directory.

## Data sent to notification transports

Exactly one transport is selected; credentials never select one. The default is
the fake transport, which is local-only and makes no network request.

| Transport        | Default outbound fields                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake             | No network fields; the bounded delivery stays in process.                                                                                                                   |
| Direct Telegram  | Bot API routing, bounded title/text card, event/session presentation, supported interaction labels and opaque action tokens, and delivery mode.                             |
| Outbound webhook | Strict schema, stable delivery/idempotency ID, delivery mode, bounded message, sanitized source projection, optional local-web handoff, timestamp, and HMAC signature.      |
| WhooshBang       | Subscriber, optional notifier, bounded rendered title and text, opaque event correlation, a supported prompt/labels/opaque options with expiry, and request authentication. |

The fake transport is entirely local. Direct Telegram sends the configured bot a
bounded rendered attention card. Depending on the event, that card can include:

- a sanitized repository display name, branch, short session identifier,
  harness, surface, event type, and relative time;
- a bounded agent summary or assistant excerpt;
- a question, choice labels, and opaque action tokens; and
- resolution status and a bounded operator answer when a reply is processed.

Telegram necessarily receives the bot token at its API, the configured chat or
topic identifiers, message metadata, and the operator's Telegram reply.
Telegram's own storage and retention policies apply. Telegram retains
unconfirmed Bot API updates for no longer than 24 hours, and messages remain in
Telegram until removed there.

The optional WhooshBang adapter is replaceable and is not required for local or
direct-Telegram operation. When explicitly selected, it sends the configured
subscriber, optional notifier, bounded rendered title and text, opaque event
correlation ID, and, when supported, one prompt with choice labels and opaque
option values plus its expiry. It does not send a full repository, raw hook,
transcript, local path, command, environment, credential, or resume authority.
The narrow machine bearer and credential ID authenticate WhooshBang provider
requests; they are not message-payload fields. WhooshBang receives its own
request/network metadata and controls provider-side retention under the account
terms accepted by the operator.

The optional outbound webhook sends a strict `agent-relay-webhook.v1` JSON
envelope to the operator-configured endpoint. It contains the same bounded
rendered card, sanitized repository/branch and session projection, event type,
opaque delivery/request/action values, and, for an open request, a local web
handoff URL without credentials. It does not send the raw machine ID, harness
session ID, absolute project path, daemon/web credential, HMAC secret, answer,
resume command, or raw hook payload. The endpoint necessarily receives request
headers, timestamp, stable idempotency key, and HMAC signature. Storage,
retention, logging, and onward delivery at that custom endpoint are controlled
by its operator.

The local web companion binds to loopback by default. Its browser receives
sanitized session/timeline data, bounded event details, and request forms from
the local daemon. `agent-relay dashboard --web` reads the persistent bearer and
CSRF only from the private local credential file and sends them only as headers
to exact-loopback readiness/grant routes. It never puts them in URLs, shell or
browser-launch arguments, browser storage, logs, analytics, errors, or rendered
diagnostics.

The normal browser sees only a random 60-second single-use bootstrap grant in
its initial loopback URL. The page sends that grant in a same-origin exchange
body, immediately removes it from visible/history state, and receives a
host-only HttpOnly session cookie plus an ephemeral session CSRF held in page
memory. Grants, session records, and session CSRF values are bounded daemon
memory, not SQLite or credential-file additions. Browser sessions expire after
30 minutes idle, eight hours total, browser-session loss, or daemon restart.
Manual Advanced recovery can place the persistent bearer/CSRF in page memory
only when the operator explicitly pastes them.

Binding the server beyond loopback is not a supported security boundary. A
tunnel or public listener adds reachability without remote identity, TLS/proxy
policy, authorization, rate limits, or safe revocation; both remain unsupported.

## Credentials

Telegram tokens, chat IDs, operator IDs, webhook secrets, daemon tokens, and
WhooshBang credentials are configuration, not source data. Direct Telegram and
daemon values can be supplied by environment injection. The webhook configure
command accepts its secret from stdin or a private file and stores it in the
private configuration file; environment injection is process-only and does not
write `webhook.json`. WhooshBang OAuth/MCP onboarding is the default hosted
path: it creates and retains only a narrow machine bearer in
`whooshbang-credential.json`; its crash-recovery journal is erased after safe
reconciliation. The legacy project bootstrap credential is accepted only from
stdin, environment injection, or a hidden prompt and is not retained.

Keep source credentials in a secret manager or mode-`0600`, gitignored local
file. Agent Relay excludes token-, secret-, credential-, and
authorization-shaped fields from structured logs. `whooshbang disconnect`
removes local connection use;
`--revoke --erase-credential --erase-configuration` with newly supplied project
authority revokes the narrow provider credential and erases its local
credential, configuration, and reconciled journal. Provider messages or account
records must be erased through the provider separately.

Redaction is defense in depth, not permission to publish logs or databases.
Never attach `.env` files, SQLite files, raw logs, transcripts, or config
backups to an issue or pull request.

## Retention

The daemon runs bounded local retention maintenance. Current defaults are:

| Local record class                    | Default |
| ------------------------------------- | ------- |
| Delivered events and Telegram updates | 30 days |
| Resolved requests and answers         | 30 days |
| Dead-letter deliveries                | 90 days |
| Diagnostics                           | 90 days |
| Terminal sessions                     | 90 days |

Open requests, active resume ownership, and records needed to preserve
referential integrity can outlive the nominal window. The fallback spool
persists until replay succeeds or the user deliberately removes it. Rotating
logs default to five files of at most 4 MiB each. Retention values and log
limits are configurable through the documented daemon flags and `AGENT_RELAY_*`
environment variables.

SQLite also retains two content-free lifetime scalars: the number of event rows
inserted and deleted. They let a bounded canary detect when retention would
otherwise hide overlapping event traffic. Individual event retention does not
reset these counters; they remain local, contain no identifiers or content, and
are removed only when the configured state directory is erased.

Local retention does not delete messages already accepted by Telegram or another
provider. The direct-Telegram `/cleanup` command is an explicit exception: after
an exact-set preview and operator confirmation, it calls Telegram's destructive
topic deletion API, which removes the selected topics and all messages in them.
`/prune` uses the same confirmation and deletion path for an inactive set. Its
durable state contains the cutoff and bounded topic/session display metadata,
not transcript text. Pruning does not erase or mark the local session ended, and
later activity can create a new provider topic.

Development tooling follows the same minimization rule. Exploratory dogfood
records contain only the source commit, branch, dirty flag, build digest,
deployment time, and service-restart result. They do not contain coding-session
prompts, answers, transcripts, provider identifiers, credentials, browser
sessions, or local diagnostic contents. Formal candidate dogfood evidence is a
short, secret-free list of tested flow names, environment class, limitations,
tester, timestamp, result, and exact candidate SHA. CI artifacts use synthetic
credentials and isolated homes; real dogfood content must never be uploaded.

## Uninstall and erasure

Run `agent-relay uninstall` before removing the package. It removes only owned
hook entries, the launcher, and the install manifest. It deliberately preserves
SQLite, logs, credentials, fallback records, answers, and config backups so an
uninstall cannot silently destroy user data.

To erase local Agent Relay data:

1. stop the daemon and all supervised Agent Relay processes;
2. run `agent-relay uninstall` and inspect the result;
3. remove the exact configured `AGENT_RELAY_STATE_DIR` (by default
   `~/.agent-relay`) only after confirming it is the intended directory;
4. inspect and, if desired, remove exact `*.agent-relay-backup-*` files adjacent
   to the three harness configs; and
5. remove any local secret file or secret-manager entry created for Agent Relay.

To erase only experimental runner bridge state while retaining standalone
attention data, stop the daemon, run `agent-relay runner-bridge disable`, then
run `agent-relay runner-bridge erase --confirm`. This scoped command refuses
while enabled and does not remove `relay.sqlite`.

Delete corresponding Telegram messages/topics or provider data through that
provider separately. Package-manager removal alone neither uninstalls hooks nor
erases retained data.

For safe diagnostic-sharing guidance, see [SUPPORT.md](SUPPORT.md). Report a
suspected privacy or security vulnerability through [SECURITY.md](SECURITY.md).
