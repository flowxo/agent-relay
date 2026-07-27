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

- `relay.sqlite`, including normalized events, delivery state, request state,
  bounded agent summaries or excerpts, operator answers, session metadata,
  diagnostics, resume claims, and transport message/topic identifiers;
- `fallback-spool.ndjson`, containing bounded normalized hook records that could
  not reach the daemon yet;
- `relay.ndjson` and rotated siblings, containing structured redacted
  diagnostics;
- `web-credential.json`, containing independent local bearer and CSRF secrets
  when the local web companion is enabled;
- `install.json` and `bin/agent-relay`, which record and launch the owned
  user-level installation; and
- optional experimental `runner-bridge.json` and `runner-bridge.sqlite`, which
  retain bridge selection, runner authority, private product/native mappings,
  queued protocol frames, cursors, and sanitized effect outcomes; and
- the stable random local machine identifier used to separate sessions.

Agent Relay does not intentionally store a harness's raw hook payload or full
transcript. It can store the bounded last assistant message, question, choice
labels, failure summary, and operator answer needed to notify and continue a
session. Those values can still contain private source or conversation content.
Treat the state directory as sensitive.

The experimental runner bridge is not a notification transport and does not send
through Telegram or Notifications. When explicitly composed later, it initiates
its own versioned outbound connection. Its status and doctor output exclude
private native session references, proof material, leases, frame payloads,
source, transcript, prompts, tool input/output, paths, environment, and
credentials.

The installer may create private timestamped backups next to changed harness
configuration files. The default files are:

- `~/.codex/hooks.json`;
- `~/.claude/settings.json`; and
- `~/.cursor/hooks.json`.

Backups can contain the user's pre-existing configuration and are not inside the
Agent Relay state directory.

## Data sent to notification transports

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

The optional Notifications adapter is replaceable and is not required for local
or direct-Telegram operation. When configured, it receives the bounded transport
contract described above, not a full repository or transcript. Provider-specific
credentials, endpoints, retention, and account terms must be documented before
that adapter is promoted for production use.

The local web companion binds to loopback by default. Its browser receives
sanitized session/timeline data, bounded event details, and request forms from
the local daemon. The bearer and CSRF secrets stay in the local credential file
unless the user copies them elsewhere. Binding the server beyond loopback is not
a supported security boundary.

## Credentials

Telegram tokens, chat IDs, operator IDs, webhook secrets, daemon tokens, and
future provider credentials are configuration, not source data. Keep them in a
secret manager or a mode-`0600`, gitignored local environment file. Agent Relay
reads these values from the environment and excludes token-, secret-,
credential-, and authorization-shaped fields from structured logs.

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

Local retention does not delete messages already accepted by Telegram or another
provider.

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
