# Agent Relay — Implementation Brief

This is the operational companion to
[`agent-attention-control-plane-design.md`](./agent-attention-control-plane-design.md).
Read that document first: it contains the Pushary reverse engineering, official
harness capabilities, architecture, protocol sketch, risks, and original LOE.

## Mission

Build a reliable, local-first attention and control layer for concurrent coding
agents.

When Codex, Claude Code, or Cursor reaches a point where a person may need to
look at it, exits unexpectedly, or explicitly needs input, Agent Relay should
create one normalized event. That event can be delivered through Telegram. Where
the harness supports continuation, a reply from Telegram should be correlated to
the correct session and allow the agent to continue safely.

This is an experimental internal tool. Optimize first for determinism,
observability, and ease of diagnosis—not multi-tenant polish.

## Default product decisions

Proceed with these defaults unless repository evidence proves one is
impractical:

- macOS-first, with portable Node.js/TypeScript code where practical.
- One operator, one Telegram bot, one machine initially.
- Multiple simultaneous sessions across Codex, Claude Code, and Cursor.
- A local relay daemon is the source of truth for machine/session state.
- SQLite-backed local durable spool for events, commands, and delivery attempts.
- At-least-once delivery with stable event IDs and idempotent consumers.
- A versioned, harness-neutral event and command contract.
- Telegram is an adapter, not part of the core protocol.
- No transcript upload by default. Send concise summaries and small, explicitly
  bounded excerpts only when needed.
- Secrets remain outside source control and logs.
- Cursor IDE late resumption is out of scope until an official mechanism is
  proven. Cursor CLI resumption and stop-hook inline continuation are in scope.
- Prefer native hooks. Use MCP for explicit semantic questions. Use a launcher
  or supervisor for process exit/crash detection.

## Suggested repository shape

Treat this as a starting point, not a constraint:

```text
apps/
  daemon/              local HTTP/IPC service, state, spool, delivery
  telegram-gateway/    webhook/update handling and Telegram adapter
packages/
  protocol/            versioned event/command schemas and IDs
  core/                session state machine and correlation logic
  hooks/               Codex, Claude Code, and Cursor adapters
  testing/             harness fixtures, fake Telegram, scenario helpers
docs/
```

A single-process implementation is acceptable initially if package boundaries
keep the core protocol and state machine independent from Telegram and the
harness adapters.

## Execution order

### Milestone 0 — contract and capability spike

Goal: remove uncertainty before committing to the full implementation.

- Establish the TypeScript workspace, linting, tests, and CI.
- Encode the normalized event/command schemas with runtime validation.
- Build fixture-driven parsers for captured/synthetic hook payloads.
- Prove native stop continuation output for Codex, Claude Code, and Cursor.
- Prove the supported CLI resume path for Codex, Claude Code, and Cursor CLI.
- Record exact tested harness versions and observed payloads.
- Turn unsupported behavior into explicit capability flags, not silent fallback.

Exit criteria:

- Automated contract tests cover all three harnesses.
- A capability matrix generated from code or fixtures agrees with the design
  memo.
- Unknown or malformed payloads produce actionable diagnostics.

### Milestone 1 — deterministic local notification loop

Goal: every supported attention event becomes an observable, deduplicated
delivery attempt.

- Implement the daemon and SQLite spool.
- Add session registration, heartbeat/activity, event ingestion, idempotency,
  retry, and delivery status.
- Add Codex, Claude Code, and Cursor hook entry points.
- Implement a fake/in-memory notification transport first.
- Add a Telegram Bot API adapter after the fake transport is proven.
- Provide readable structured logs and a local status/doctor command.

Exit criteria:

- Normal stop, explicit question, permission request, abnormal process exit, and
  transport failure scenarios are covered by automated tests where supported.
- Replaying the same event does not create duplicate user-visible messages.
- Losing connectivity queues events and retrying does not lose or duplicate
  them.
- Hook failures are visible and do not silently disappear.

### Milestone 2 — correlated replies and inline continuation

Goal: a Telegram reply reaches exactly the correct waiting session.

- Render Telegram messages with stable session identity and short context.
- Support inline buttons for fixed choices and a reply flow for free text.
- Correlate replies to event, session, machine, and pending turn.
- Enforce one terminal outcome for the terminal/Telegram response race.
- Emit the harness-specific continuation response while the stop hook is open.
- Expire stale questions clearly and reject late or duplicate answers safely.

Exit criteria:

- Multiple simultaneous sessions can ask questions without cross-talk.
- Terminal-first and Telegram-first races both have deterministic tests.
- Duplicate Telegram updates are harmless.
- A stale reply can never resume the wrong turn.

### Milestone 3 — supervision and late CLI resume

Goal: cover crashes and allow supported CLI sessions to continue after the
original hook process is gone.

- Add launcher/supervisor support and reliable exit classification.
- Distinguish active, waiting, stopped, exited, and suspected-stalled states.
- Avoid claiming a hang from inactivity alone.
- Implement Codex and Claude Code late resume, then Cursor CLI if its observed
  contract is reliable.
- Audit every command and state transition.

Exit criteria:

- Killed/crashed child processes generate a durable attention event.
- Supported CLI sessions resume from a Telegram response in an end-to-end test.
- Unsupported Cursor IDE late resume is reported honestly.

### Milestone 4 — installer and hardening

Goal: make the tool safe to install and diagnose without hand-editing configs.

- Add idempotent install, uninstall, and doctor flows.
- Back up and minimally patch harness configuration.
- Detect version/capability drift.
- Add secret redaction, payload limits, retention controls, and log rotation.
- Exercise clean install, upgrade, partial failure, and recovery.

## Reliability rules

- Never silently discard an event.
- A hook should have a strict time budget and fail with a useful local record.
- Event identity must be stable across retries.
- Telegram `update_id` and callback handling must be idempotent.
- Every pending question must end answered, expired, cancelled, or failed.
- Session identity must include a stable machine identity and harness session
  ID.
- Treat stop, question, permission, process exit, and suspected stall as
  different event classes.
- Redact known secret shapes and avoid command output/transcripts by default.
- Do not let notification transport failure block the agent indefinitely.

## Autonomous working agreement

The coding session should make routine engineering decisions independently:

- Inspect the repo and current official documentation as needed.
- Choose conventional dependencies and install them.
- Create and revise architecture, tests, fixtures, and documentation.
- Run formatters, static checks, unit tests, and local integration tests.
- Diagnose failures and keep iterating rather than stopping at the first error.
- Maintain `docs/progress.md` with completed work, current evidence, remaining
  risks, and the next milestone.
- Make small, coherent commits when a milestone or useful slice is green.

Only interrupt the user for:

- Credentials or external account setup that cannot be mocked locally.
- A product choice that materially changes scope or architecture.
- An irreversible/destructive action, meaningful cost, or production deployment.
- A genuinely blocked harness contract after local inspection, official-doc
  research, and a fixture-based fallback have all been exhausted.

When external credentials are unavailable, continue with fakes and document the
single command or setup step needed to activate the real adapter later.

## Definition of done for each milestone

A milestone is not complete merely because code exists. It should include:

- Focused tests for success, duplicate, timeout, malformed-input, and retry
  paths.
- A short manual verification recipe.
- Updated architecture/capability documentation.
- No committed credentials, machine-specific paths, or captured private
  transcripts.
- A concise progress record stating what is proven versus assumed.

## Immediate starting point

Begin with Milestone 0 and continue into Milestone 1 without waiting for review
if the contract tests are green. Keep Telegram behind a transport interface so
the entire local loop can be completed before a bot token is available.
