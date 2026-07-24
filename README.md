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

## Local loop

The daemon binds to loopback, uses SQLite as the source of truth, and selects
the fake Telegram transport unless all required Telegram settings are present.

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

## Real Telegram adapter

Copy the names from [`.env.example`](.env.example) into your secret manager or
shell environment. Do not commit values. The daemon activates the Bot API
adapter only when both `AGENT_RELAY_TELEGRAM_TOKEN` and
`AGENT_RELAY_TELEGRAM_CHAT_ID` exist. Reply routing additionally requires the
numeric `AGENT_RELAY_TELEGRAM_OPERATOR_ID`. An HTTP webhook bridge should also
set `AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET`; Agent Relay verifies it against
Telegram's `X-Telegram-Bot-Api-Secret-Token` header before processing updates.

The reply router accepts only the configured operator and chat, deduplicates
Telegram `update_id`, correlates text through Telegram's replied-to message ID,
and uses opaque callback tokens for fixed choices. Terminal and Telegram answers
share a single SQLite first-writer-wins transition.

## Current boundary

Native hooks do not prove a process crash. `process.exited` is a supported
protocol and delivery event only when a supervisor supplies the evidence.
Launching and owning harness child processes remains Milestone 3. Cursor IDE
late resume remains explicitly unsupported.
