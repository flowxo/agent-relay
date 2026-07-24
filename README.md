# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. It normalizes deterministic harness events,
durably spools them, routes them through replaceable notification transports,
and keeps continuation capabilities explicit.

The implementation follows
[`docs/implementation-brief.md`](docs/implementation-brief.md). Current
evidence, risks, and the next action are tracked in
[`docs/progress.md`](docs/progress.md).

## Development

Requirements: Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm check
pnpm build
```

The checked-in capability matrix is generated from code and verified by
`pnpm capabilities:check`. Sanitized harness fixtures and their provenance live
under `packages/harnesses/fixtures`.

No bot token, transcript, credential, hostname, username, or raw working path is
required for the contract test suite.

## Safe installation

Build once, inspect the exact changes, then install user-level hooks:

```sh
pnpm build
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer creates one exact-path launcher under `~/.agent-relay/bin` and
minimally patches `~/.codex/hooks.json`, `~/.claude/settings.json`, and
`~/.cursor/hooks.json`. Existing hooks and unrelated settings are preserved.
Every changed existing config receives a private timestamped backup. All target
files are preflighted before mutation, writes are atomic, and a partial failure
rolls back earlier writes.

Codex installs `Stop` and `PermissionRequest`; Claude installs `Stop`,
`StopFailure`, and `PermissionRequest`. Cursor installs only `stop` until its
permission fixture has a sanitized live capture. Cursor defaults to IDE
capabilities; pass `--cursor-surface cli` for a CLI-only installation. A
supervised Cursor child always overrides that surface to CLI.

Codex requires new or changed command hooks to be reviewed in `/hooks`. Claude's
`/hooks` browser and Cursor's trusted-workspace hook view provide corresponding
runtime verification. `doctor` checks the files, exact-path launcher, installed
harness binaries, tested versions, SQLite schema, and capability records.
Version drift is a warning; a missing binary or hook is a failure.

Safe uninstall removes only entries carrying Agent Relay's ownership marker and
its launcher/manifest. It preserves user hooks, unrelated settings, SQLite,
fallback records, logs, credentials, and config backups:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

## Local loop

The daemon binds to loopback, uses SQLite as the source of truth, and selects
the fake Telegram transport unless both the Telegram token and chat ID are
present.

```sh
# Terminal 1
pnpm relay daemon

# Terminal 2
pnpm relay canary
pnpm relay status
pnpm relay doctor
```

The canary queues and drains one bounded synthetic stop event. Repeating an
event with the same event ID is idempotent. When the transport is offline or
times out, the event remains in `retry`; non-retryable or exhausted delivery
attempts are visible in `dead_letter`.

Hook entry points read one native JSON payload from stdin and write only native
continuation JSON to stdout:

```sh
pnpm relay hook codex --harness-version 0.145.0 \
  < packages/harnesses/fixtures/codex/stop.json

pnpm relay hook cursor --surface ide --harness-version 3.12.30 \
  < packages/harnesses/fixtures/cursor/stop.json
```

If the daemon is unavailable, the hook returns safe no-op JSON, writes a concise
diagnostic to stderr, and appends the normalized event or diagnostic (never the
raw malformed payload) to the fallback spool. A remote-mode stop hook can remain
open for a bounded inline reply:

```sh
pnpm relay hook claude --harness-version 2.1.219 --wait-ms 30000 \
  < packages/harnesses/fixtures/claude/stop.json
```

Codex and Claude answers emit `decision: "block"` plus `reason`; Cursor emits
`followup_message`. Stop recursion fields prevent a second waiting loop.

Fallback records are redacted, capped, and rotated into lossless segments. The
daemon atomically claims and replays those segments at startup and every five
seconds; event and diagnostic IDs make crash retries harmless. Failed lines stay
in a pending segment while successful lines are removed. Replay can also be run
and inspected explicitly:

```sh
pnpm relay replay-fallback
```

The command exits non-zero while any segment remains pending. Invalid or
oversized lines become durable bounded diagnostics rather than being silently
discarded; raw invalid input is never sent to Telegram.

## Retention and logs

The daemon expires stale open requests, then applies bounded batches to terminal
requests, delivered events, dead letters, diagnostics, Telegram update IDs, and
provably inactive sessions. Open work and claimed/running resume commands are
never pruned. Defaults retain delivered history for 30 days and dead letters and
diagnostics for 90 days:

```sh
pnpm relay maintain --retention-days 30 \
  --dead-letter-retention-days 90 \
  --diagnostic-retention-days 90
```

Maintenance runs at daemon startup and hourly. The daemon writes redacted JSON
lines to stderr and `~/.agent-relay/relay.ndjson`; the file defaults to 4 MiB
with five total segments. Configure these bounds through the
`AGENT_RELAY_*_RETENTION_DAYS`, `AGENT_RELAY_LOG_PATH`,
`AGENT_RELAY_LOG_MAX_BYTES`, and `AGENT_RELAY_LOG_FILES` variables shown in
[`.env.example`](.env.example). File-write failures are also emitted to stderr.

## Supervised CLI processes

Milestone 3 adds an opt-in launcher for CLI processes whose exit status must be
proven:

```sh
# Arguments after -- are passed directly as argv; no shell is involved.
pnpm relay run codex --harness-version 0.145.0 -- exec "work on the task"
pnpm relay run claude --harness-version 2.1.219 -- --print "work on the task"
pnpm relay run cursor --harness-version 3.12.30 -- --print "work on the task"
```

The launcher inherits the terminal, owns the child PID, forwards `SIGINT` and
`SIGTERM`, preserves the conventional terminal exit status, and records a
`process.exited` event only for a non-zero exit, unrequested signal, startup
failure, or unknown exit. Every crash event must carry validated `owned-child`
evidence; native hooks cannot manufacture it. Command output and arguments are
not copied into the event or logs.

The launcher injects a unique bridge identity into its child. A supervised CLI
stop hook opens a durable continuation request without keeping the hook process
alive. Once the owned child has exited cleanly, a correlated Telegram answer is
atomically claimed and resumed with the official Codex, Claude Code, or Cursor
CLI argv. Resume claims and their running/succeeded/failed transitions are
stored in SQLite, so concurrent supervisors cannot resume the same answer twice.

By default the supervisor remains available for an open continuation until its
24-hour expiry. Use `--resume-wait-ms` to shorten that bound, or
`AGENT_RELAY_LATE_RESUME_TTL_MS` to shorten the hook-created request expiry. If
the daemon is unavailable when a crash occurs, the normalized crash event is
written to the privacy-safe fallback spool.

The supervisor does not infer a hang from inactivity. `suspected_stalled` is a
distinct state reserved for an explicit failed harness health probe; no
automatic restart exists. Active CLI steering is also not claimed: late resume
starts only after the owned process exits.

## Real Telegram adapter

Copy the names from [`.env.example`](.env.example) into your secret manager or
shell environment. Do not commit values. The daemon activates the Bot API
adapter only when both `AGENT_RELAY_TELEGRAM_TOKEN` and
`AGENT_RELAY_TELEGRAM_CHAT_ID` exist. Reply routing additionally requires the
numeric `AGENT_RELAY_TELEGRAM_OPERATOR_ID`.

The default `AGENT_RELAY_TELEGRAM_UPDATE_MODE=poll` uses Bot API long polling,
so a daemon bound to loopback can receive replies without a public HTTP
deployment. The next poll confirms only update IDs that the reply router has
handled. A crash before confirmation can replay an update, and the durable
SQLite claim makes that replay harmless. Poll and routing errors are logged with
bounded exponential retry.

Set `AGENT_RELAY_TELEGRAM_UPDATE_MODE=webhook` only when an external HTTPS
bridge is available. Webhook mode requires
`AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET`; the `/v1/telegram/updates` route verifies
Telegram's `X-Telegram-Bot-Api-Secret-Token` independently from the daemon
bearer token. Telegram does not permit `getUpdates` while a webhook is
configured, so remove the bot's webhook before switching back to poll mode.

The reply router accepts only the configured operator and chat, deduplicates
Telegram `update_id`, correlates text through Telegram's replied-to message ID,
and uses opaque callback tokens for fixed choices. Terminal and Telegram answers
share a single SQLite first-writer-wins transition. Telegram retains pending Bot
API updates for no longer than 24 hours; Agent Relay's longer-lived request
state does not extend that upstream delivery window.

### Telegram activation canary

Use a dedicated bot and private chat. Keep the three values in a secret manager
or a local, mode-`0600`, gitignored environment file; never paste them into an
issue, PR, fixture, or log. Start the daemon with all three variables present:

```sh
# Terminal 1
set -a
. ./.env.activation
set +a
pnpm relay daemon
```

Then run the bounded round trip from another terminal:

```sh
# Terminal 2 (source the same file if daemon authentication is configured)
set -a
. ./.env.activation
set +a
pnpm relay telegram-canary --wait-ms 120000
```

The command refuses the fake transport. It sends a unique correlated question
and waits up to two minutes for a direct Telegram reply containing exactly
`relay-canary-ok`. Success requires real Bot API delivery, authorized
chat/operator routing, replied-to-message correlation, and durable resolution by
Telegram. The result omits the question and answer text and exits non-zero for a
delivery failure, timeout, terminal answer, or mismatched reply.

## Current boundary

Supervisor tests use real local child exit codes/signals. A daemon-level
activation test covers a complete fake Telegram delivery and HTTP reply,
including authorized routing and durable resolution. A credentialed private-chat
canary on 2026-07-24 additionally proved real Bot API delivery, long-poll reply
intake, replied-to-message correlation, exact answer validation, stale-answer
rejection, and durable Telegram resolution. No credential or private message was
retained in git. A model-backed late-resume canary has not been run because it
would consume harness quota. Native hooks still do not prove crashes, Cursor IDE
late resume remains explicitly unsupported, and an interactive child must exit
before its session can be resumed through a new CLI process.
