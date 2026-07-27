# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. It normalizes deterministic harness events,
durably spools them, routes them through replaceable notification transports,
and keeps continuation capabilities explicit.

It gives one operator a dependable way to notice when several coding agents
stop, fail, or need an answer; identify the exact session; respond through
buttons, text, or the local web board; and continue only where the harness has
an official continuation contract.

> **Release status:** an installable `0.1.0-alpha.1` package candidate is proven
> locally, but no npm package or stable support claim exists yet.

## What it can prove

| Signal or action    | Evidence and boundary                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| Stop or question    | Native runtime-validated hook payload from the exact harness session                  |
| Inline continuation | The original hook remains open for a bounded reply and returns native harness JSON    |
| Late CLI resume     | An Agent Relay-owned supervisor exits, claims one answer, and invokes official resume |
| Process crash       | Reported only from the exit status of a child process Agent Relay owns                |
| Silent hang         | Never inferred from inactivity; no automatic hang restart is claimed                  |
| Cursor IDE resume   | Unsupported; an IDE Stop hook cannot safely become a new Cursor CLI process           |

Native hooks do not prove that a process crashed. Installing hooks alone gives
stop/question notifications and bounded inline replies. Use
`agent-relay run <harness>` when proven exit reporting or late CLI resume is
required.

The current end-user validation target is macOS on Apple silicon with
Node.js 22. Exact harness versions and surfaces are evidence-based, not guessed
from a version range; see [compatibility and evidence](docs/compatibility.md)
and the [generated capability matrix](docs/capability-matrix.md). Windows, Linux
runtime operation, Intel macOS, automatic service installation, and Cursor IDE
late resume are not current support claims.

### Evidence-backed harness support

This concise table and the detailed matrix are generated from the same
runtime-validated registry that powers `agent-relay capabilities` and `doctor`.
Exact versions are snapshots, not ranges.

<!-- BEGIN GENERATED HARNESS SUPPORT -->

| Harness / surface | Exact verified version  | Classification          | Important boundary                                                                            |
| ----------------- | ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| Codex CLI         | `codex-cli 0.145.0`     | `verified`              | Stop and read-only late resume are live-proven; crash proof requires supervision.             |
| Codex App Server  | —                       | `compatible-unverified` | The official structured contract is understood but is not the installed V1 user path.         |
| Claude Code CLI   | `2.1.219 (Claude Code)` | `verified`              | Stop and plan-mode late resume are live-proven; StopFailure remains fixture-proven.           |
| Claude Agent SDK  | —                       | `compatible-unverified` | The streaming SDK contract is understood but is not the installed V1 user path.               |
| Cursor CLI        | `2026.07.23-e383d2b`    | `verified`              | Interactive Stop and trusted late resume are live-proven; --print did not emit initial Stop.  |
| Cursor IDE        | —                       | `compatible-unverified` | Stop hooks are contract-backed; an IDE session cannot be safely resumed as a new CLI process. |

<!-- END GENERATED HARNESS SUPPORT -->

## Try the complete local loop first

No Telegram account or hosted service is needed for the first proof:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
pnpm build
```

In one terminal, start the local daemon with Telegram credentials removed:

```sh
env -u AGENT_RELAY_TELEGRAM_TOKEN \
  -u AGENT_RELAY_TELEGRAM_CHAT_ID \
  node apps/relay/dist/cli.js daemon --no-web
```

In a second terminal:

```sh
env -u AGENT_RELAY_TELEGRAM_TOKEN \
  -u AGENT_RELAY_TELEGRAM_CHAT_ID \
  node apps/relay/dist/cli.js canary
```

The canary must report a durable fake-Telegram delivery. Stop the daemon with
`Ctrl-C`. Next, follow the
[installation/upgrade/uninstall guide](docs/install-upgrade-uninstall.md).
Configure [direct Telegram](docs/telegram.md) only when private credentials are
available.

## Inspect the standalone package

The one-package distribution candidate is `@flowxo/agent-relay`. The npm scope
is still an owner-controlled publication gate; do not try to install it from the
registry yet, and do not install the unrelated unscoped `agent-relay` package.

Build and prove the exact local artifact:

```sh
pnpm package:check
pnpm package:lifecycle:check
```

That command packs the staged release directory, compares all 11 files to a
reviewed allowlist, enforces compressed and unpacked size budgets, rejects
workspace/source/private-path leakage, installs with lifecycle scripts disabled
in an isolated prefix, explicitly rebuilds the approved SQLite native
dependency, and proves CLI help, the fake canary, static web assets, and the
authenticated local web API. It publishes nothing and removes its temporary
artifact.

The lifecycle check then generates the sanitized prior `0.1.0-alpha.0` fixture
and proves dry run, install, doctor, retained answer/state, forward migration,
stale-manifest diagnosis, upgrade, idempotent reconciliation, unsafe-downgrade
refusal, owned uninstall, unrelated-config preservation, and package removal. It
also publishes nothing.

See [package identity and artifact boundary](docs/packaging.md) for the exact
contents, metadata, source-map decision, and a command that retains a local
tarball for inspection.

## What runs and what changes

The Node.js daemon binds to loopback, uses local SQLite as the source of truth,
and writes bounded redacted diagnostics. The installer creates one owned
launcher and minimally merges owned hook entries into:

- `~/.codex/hooks.json`;
- `~/.claude/settings.json`; and
- `~/.cursor/hooks.json`.

Existing entries are preserved and changed files receive private backups.
Uninstall removes only owned hooks, launcher, and manifest; retained state is
preserved until the operator explicitly erases it.

The fake transport stays local. Direct Telegram sends bounded attention cards
that can include an agent summary or question. The optional local web companion
talks only to the loopback daemon. Flow XO Notifications is an optional,
replaceable transport: local operation requires no hosted account, Cloudflare
runtime, public callback, or Flow XO credential. See the
[architecture and threat boundaries](docs/architecture.md),
[privacy policy](PRIVACY.md), and
[hosted Notifications boundary](docs/hosted-notifications.md).

## Documentation

- [Architecture and threat boundaries](docs/architecture.md)
- [Install, upgrade, uninstall, and erasure](docs/install-upgrade-uninstall.md)
- [Direct Telegram setup and operation](docs/telegram.md)
- [Local web companion](docs/web-companion.md)
- [Troubleshooting and doctor](docs/troubleshooting.md)
- [Compatibility and evidence policy](docs/compatibility.md)
- [Package identity and artifact boundary](docs/packaging.md)
- [Write a notification transport](docs/extending-transports.md)
- [Write or update a harness adapter](docs/extending-harnesses.md)
- [Optional hosted Notifications boundary](docs/hosted-notifications.md)
- [Living clean-checkout onboarding](docs/onboarding.md)

Implementation history and deeper evidence remain available in the
[implementation brief](docs/implementation-brief.md),
[progress ledger](docs/progress.md),
[harness evidence](docs/harness-evidence.md),
[Open Source V1 charter](docs/product/open-source-v1-charter.md), and
[AR1 project specification](docs/projects/open-source-release-readiness/project-spec.md).

## Trust and governance

Agent Relay is local-first and sends no product analytics or remote crash
reports. Notification providers receive bounded attention cards, which can
include an agent summary or question; local state and uninstall behavior are
documented in [PRIVACY.md](PRIVACY.md).

Before reporting or operating the software, read:

- [SECURITY.md](SECURITY.md) for private vulnerability reporting;
- [SUPPORT.md](SUPPORT.md) for the verified support boundary and safe
  diagnostics;
- [PRIVACY.md](PRIVACY.md) for local files, outbound data, retention, and
  erasure;
- [MAINTAINERS.md](MAINTAINERS.md) for review and release authority;
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations; and
- the [MIT license](LICENSE).

Never post a token, private transcript, SQLite database, raw log, username,
hostname, account identifier, or real working path in an issue or pull request.

## Development

Requirements: Node.js 22 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
pnpm build
pnpm contracts:notifications
```

The checked-in compatibility matrix and the README/SUPPORT summaries are
generated from the runtime registry. Run `pnpm capabilities:generate` after an
evidence change; `pnpm capabilities:check` fails on any drift. Sanitized harness
fixtures and their provenance live under `packages/harnesses/fixtures`.

No bot token, transcript, credential, hostname, username, or raw working path is
required for the contract test suite.

The stable Notifications C0 consumer command verifies the exact immutable
contract/client/mock lock and a fresh scripts-disabled install, runs the
SQLite-to-mock crash-replay proof, and starts the packed mock as a guarded
separate loopback process. It requires no hosted account, public callback, or
sibling checkout. Its lock, safe install order, compatibility policy, generated
evidence, and update procedure are documented in
[`contracts/README.md`](contracts/README.md).

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

Codex requires new or changed command hooks to be reviewed in `/hooks`. For
vetted one-off non-interactive automation, Codex also documents
`--dangerously-bypass-hook-trust`; Agent Relay preserves that flag during late
resume when it was present on the initial invocation. Claude's `/hooks` browser
and Cursor's trusted-workspace hook view provide corresponding runtime
verification. `doctor` checks the files, exact-path launcher, installed harness
binaries, verified-version classifications, evidence IDs, SQLite schema, and
capability records. Version drift is a `compatible-unverified` warning; a
missing, known-incompatible, or misconfigured binary or hook is a failure.

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

pnpm relay hook cursor --surface ide --harness-version 2026.07.23-e383d2b \
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
pnpm relay run cursor --harness-version 2026.07.23-e383d2b \
  -- --trust "work on the task"
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
Resume execution authority is derived once from the initial argv. Codex fails
closed to `read-only` unless the initial invocation explicitly selected another
sandbox or dangerous bypass; Claude fails closed to `plan`; Cursor carries
workspace trust and `--force` only when they were originally present.

By default the supervisor remains available for an open continuation until its
24-hour expiry. Use `--resume-wait-ms` to shorten that bound, or
`AGENT_RELAY_LATE_RESUME_TTL_MS` to shorten the hook-created request expiry. If
the daemon is unavailable when a crash occurs, the normalized crash event is
written to the privacy-safe fallback spool.

Supervisors accept at most 100 late resumes by default. Use `--max-resumes 1`
for a bounded activation canary or another explicit limit for automation. The
last permitted resumed child runs with late-resume hook creation disabled, so
its final Stop event cannot open an orphan continuation request.

On the tested Cursor build, the interactive CLI emits the configured Stop hook
but `--print` exits without one. Start the supervised initial Cursor turn
interactively as above, then exit the idle CLI after its Stop notification. The
late-resume leg uses Cursor's official non-interactive `--resume=<session>`
contract. `--trust` is preserved without being widened to `--force`.

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
retained in git. Model-backed private-chat canaries have proved installed Stop
hooks and exact late resume for Codex `0.145.0`, Claude Code `2.1.219`, and
Cursor CLI `2026.07.23-e383d2b`. An invalid Claude invocation also proved
owned-child crash delivery. Cursor's live run additionally proved workspace
trust preservation and expected operator-signal classification. Native hooks
still do not prove crashes, Cursor IDE late resume remains explicitly
unsupported, Cursor `--print` did not emit Stop on the tested build, and an
interactive child must exit before its session can be resumed through a new CLI
process.

The pinned Notifications `1.0.0-draft.1` consumer and compatibility gate are
also green against the executable mock. They prove the provider-neutral mapping,
retry, replay, acknowledgement, isolation, and local-authority boundary; they do
not yet add production Notifications selection, hosted credential persistence,
or continuous polling. Cross-repository promotion to `1.0.0-rc.1` remains gated
by [C0-09](https://linear.app/flowxo/issue/FXO-1050).
