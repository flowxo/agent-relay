# Troubleshooting and doctor

Start with local evidence. Do not solve a support problem by publishing a
database, raw log, credential, transcript, identity, or machine path.

## First pass

```sh
agent-relay doctor
agent-relay status
agent-relay canary
```

If using a source build, replace `agent-relay` with
`node apps/relay/dist/cli.js`.

`doctor` evaluates installation shape and compatibility. `status` reports
durable work and failures. The fake canary proves the local loop independently
of Telegram. `agent-relay capabilities` prints the safe generated record that
doctor consumes; its evidence IDs and classifications can be included in a
sanitized report.

| Evidence                               | Interpretation                                                         |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Doctor check `ok`                      | The exact local invariant passed                                       |
| Doctor `compatible-unverified` warning | Binary exists, but the exact version is not currently verified         |
| Doctor `unsupported` version failure   | Binary is absent or its required contract is recorded as incompatible  |
| Doctor failure for hook/manifest       | Install or upgrade reconciliation is incomplete                        |
| Event `queued` or `retry`              | Durable work remains and will be retried                               |
| Event `dead_letter`                    | Terminal or exhausted delivery requires diagnosis                      |
| Resume `claimed`                       | Ownership was committed; do not manually launch a duplicate            |
| Resume `failed`                        | Exact late-resume execution failed and is retained                     |
| Diagnostic count increasing            | A hook, transport, retention, browser, or supervisor path is reporting |

Logs are structured, redacted, private operational data. Inspect them locally:

```sh
tail -n 100 ~/.agent-relay/relay.ndjson
```

Redaction is defense in depth. Do not attach the output to a public issue.

## The daemon selects `fake-telegram`

This means the explicit selection resolved to `fake`; credential presence is
intentionally irrelevant. Inspect without printing credentials:

```sh
agent-relay transport status
```

If direct Telegram was intended, run `agent-relay transport select telegram` or
set `AGENT_RELAY_TRANSPORT=telegram`, verify token/chat readiness, and restart.
A durable selection change never deletes SQLite or request state.

A partial selected configuration fails clearly; it never silently routes real
work through another provider.

## Telegram preflight fails

Common stable provider codes:

| Code                               | Meaning and safe action                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `telegram-invalid-token`           | Replace the token from BotFather                                           |
| `telegram-topics-disabled`         | Enable Threaded Mode in BotFather and verify `getMe`                       |
| `telegram-private-chat-required`   | Use the intended one-to-one bot chat                                       |
| `telegram-invalid-chat`            | Open the intended bot chat, send `/start`, and verify discovery            |
| `telegram-bot-blocked`             | Unblock the bot and restart                                                |
| `telegram-topic-permission`        | Restore topic-management permission                                        |
| `telegram-topic-delete-permission` | Restore topic deletion permission and run `/cleanup` or `/prune` again     |
| `telegram-webhook-conflict`        | Poll mode found an active webhook; inspect before changing it              |
| `telegram-webhook-missing`         | Webhook mode has no configured Telegram HTTPS webhook                      |
| `telegram-polling-conflict`        | Another process is consuming `getUpdates`; stop the unintended consumer    |
| `telegram-topic-unavailable`       | A stored topic disappeared; allow the durable replacement path to complete |

Real Telegram fails closed and never falls back to an unthreaded conversation.
See the [Telegram guide](telegram.md) for setup and preflight behavior.

## `/cleanup` or `/prune` finds nothing, or deletion fails

Cleanup accepts only topics whose sessions have an explicit End tombstone or a
native `session.ended` event. Crashes, process exits, stopped turns, stale
heartbeats, and age are deliberately insufficient. Open requests, active
continuations, queued deliveries, and sessions that became active again also
exclude or skip a candidate.

Start the command from **New Chat** or an existing topic. The preview returns to
that same topic, expires after ten minutes, and is bound to the exact control
message. Telegram may leave an ordinary private bot command visually unread; the
returned control card and `telegram.reply-cleanup-previewed` log are the
acknowledgement. A permanent failure records `topic-cleanup.delete-failed`; a
permission failure uses `telegram-topic-delete-permission`. Correct the Bot API
access and run `/cleanup` again. Never manually remove the SQLite mapping to
force success: Agent Relay removes it only after Telegram confirms deletion or
reports the topic already absent.

`/prune` is the separate path for inactive topics that are not proven dead. It
defaults to 24 hours and accepts a duration from one hour through thirty days,
for example `/prune 6h` or `/prune 7d`. Active sessions, unexpired open
requests, claimed/running continuations, pending deliveries, and activity newer
than the selected cutoff are excluded. Pruning does not End a session. A later
event recreates its topic, although the old Telegram topic and messages remain
permanently deleted.

## A Telegram reply is ignored

Confirm locally that:

- the sender is the configured operator;
- the chat and topic match the delivered request;
- polling and webhooks are not both active;
- the request remains open and unexpired;
- direct topic text has exactly one compatible request, or Telegram's Reply
  action identifies the exact card; and
- the daemon recorded a handled or diagnosed update.

Zero compatible text requests produce `reply not used`; multiple requests
produce `choose a request`. Buttons remain required for permission, confirm,
select, and multi-select decisions. Agent Relay does not guess across topics.

Telegram keeps unconfirmed updates for no longer than 24 hours. A locally open
request cannot restore an upstream update that Telegram already discarded.

## A newly installed hook does not fire

Run `doctor`, inspect the exact owned handler, and use the harness's hook view.

- Codex: open `/hooks` and trust the exact new or changed user hook. The
  one-invocation trust bypass is only for automation that already reviewed the
  hook source.
- Claude Code: confirm the owned entry is under `hooks` in user `settings.json`,
  then use its hook/debug view.
- Cursor: confirm `hooks.json` has `version: 1`, restart the harness after
  changing it, and use the trusted-workspace hook view.

If the daemon was unavailable, inspect durable fallback status. A valid hook
returns safe native no-op JSON and spools a bounded normalized record; it should
not block the harness or silently discard the failure.

## Historical fallback events become dead letters

For Telegram or Notifications, the installed daemon defaults
`AGENT_RELAY_STARTUP_BACKLOG_MAX_AGE_MS` to one hour. After interrupted-delivery
recovery and fallback replay—but before automatic drain—older queued work is
marked `dead_letter` with `delivery-stale-backlog`. One bounded
`delivery.stale-backlog-quarantined` diagnostic records the count without event
text.

This is deliberate flood protection, not silent loss. Still-open unexpired
requests and `process.exited` events carrying proven `owned-child` evidence are
exempt. Normal dead-letter retention remains authoritative. Set the value to `0`
only for an intentional full historical replay; inspect `status` first, because
external transports do not provide a caller-controlled idempotency key for every
provider operation.

## Claude reports waiting while background work still runs

Claude Code can emit its main `Stop` hook while background tasks or scheduled
wakeups remain. On Claude Code 2.1.145 or newer, Agent Relay reads the official
`background_tasks` and `session_crons` arrays. A non-empty collection keeps the
lane active and produces a local `notification.suppressed` diagnostic with
reason `background-work`; it must not create a Telegram/Notifications card or a
continuation request.

Agent Relay uses only the collection counts. It does not inspect the assistant
message, terminal status text, task descriptions, commands, prompts, or
transcript. Missing fields retain ordinary Stop behavior because absence is not
proof of background work. If a current Claude payload contains non-empty arrays
but a waiting card still arrives, run `doctor`, confirm the installed hook
launcher points to the current package, rebuild/reinstall, and inspect the
bounded daemon diagnostic before retrying.

## Native hook ordering is degraded

`hook-sequence-allocation-failed` means a valid native hook could not open or
write the local SQLite ordering allocator. Agent Relay still sends or spools the
event with retry-stable reduced-fidelity ordering, so the attention signal is
not silently discarded, but a later event may leave the displayed session lane
stale. `hook-sequence-store-close-failed` means the allocation committed and was
retained, but SQLite cleanup failed.

Stop supervised processes and the daemon before upgrading. Confirm the exact
state directory is writable and private, run `doctor`, reconcile the installed
launcher, then restart one daemon. Do not delete the sequence tables or edit
`user_version`; retained mappings are what make fallback replay and duplicate
hooks safe across restarts.

## Stop arrives but late resume does not

Late resume requires a process launched by `agent-relay run`. A native hook in
an independently started harness can provide inline continuation but has no
owning supervisor to launch a later process.

Check:

- the surface supports late resume in the
  [generated capability matrix](capability-matrix.md);
- the original supervised child exited;
- the request was answered before expiry;
- the supervisor remained open within `--resume-wait-ms`;
- `--max-resumes` was not exhausted;
- the resume state is not already `claimed`, `running`, or terminal; and
- the original execution mode is still supported.

Do not manually retry a `claimed` command. At-most-once ownership deliberately
prefers a visible interrupted claim over duplicate agent execution.

Cursor IDE late resume is unsupported. On the verified Cursor CLI build, the
initial Stop was interactive; `--print` was proven only for the late-resume leg.

## Crash or hang behavior is surprising

Native Stop/Failure hooks can prove a harness lifecycle event, not an operating
system process exit. A `process.exited` notification is valid only with
`owned-child` evidence from `agent-relay run`.

Agent Relay never labels inactivity as a crash or hang. There is no automatic
hang restart. A future stall signal needs a harness-specific health probe and a
separate safety review.

## The local web board will not connect

Confirm the daemon binds to `127.0.0.1`, the web companion is enabled, and
`web-credential.json` beside the active database is a regular mode-`0600` file.
Paste both current values into the board after every reload.

The UI refuses incompatible API/asset versions. Rebuild the exact source and
restart the daemon rather than bypassing the version check. A stale form after a
Telegram answer is expected to become read-only.

If web operation is unnecessary, use `daemon --no-web`. Do not expose the
listener beyond loopback as a troubleshooting shortcut.

## Installation or uninstall differs from the dry run

Stop and inspect before repeating the command. Installer writes are atomic and
rollback is tested, but a malformed config or ownership mismatch should be
understood before any manual edit.

Never delete an entire harness configuration file. Agent Relay owns only marked
handlers. Follow the
[install/upgrade/uninstall guide](install-upgrade-uninstall.md).

`package-version`, `runtime-entry`, `runtime-node`, or `launcher-target`
failures mean the package manager changed the running CLI but the owned
installation has not been reconciled, or the launcher was modified. Confirm the
new package is intentional, run `agent-relay install --dry-run`, then
`agent-relay install` and doctor again.

If `sqlite-spool` says `refusing unsafe downgrade`, the database was opened by a
newer schema than this package supports. Stop the older package and use the
newer release or restore an appropriate backup. Do not edit SQLite
`user_version` to bypass the refusal.

## Experimental runner adoption requires recovery

Runner status may report a claimed or blocked-recovery adoption. That means
standalone interaction has already been disabled for the exact local session,
but the product binding was not yet proven complete. Do not delete either SQLite
file, restart the session through a standalone surface, or manually change
ownership rows. Restart the same bridge composition so it can inspect the
durable receipt and complete the original adoption ID.

An `outcome_unknown` approval or command is deliberately not retryable. Inspect
the native session locally and start a new product operation if appropriate;
never re-send the old native approval response.

## Runner contract candidate differs or apply is interrupted

Run the candidate command without `--apply` first. A `changed: true` result is a
review requirement, not an automatic upgrade. Confirm the exact producer commit,
two artifact digests, 33 fixtures, and `internal-until-gate-5` commitment before
using a dedicated update branch.

Apply refuses dirty lock/vendor targets. If replacement is interrupted, the
updater restores and re-verifies the prior complete set before returning a
failure. Do not copy one archive or edit the lock manually. If recovery itself
cannot be proven, stop and retain the checkout for inspection; do not run
package lifecycle scripts or the daemon against a mixed set.

A cross-repository canary failure reports only the failed stage. Re-run that
fixed command directly with synthetic data and use safe doctor/contract fields;
do not attach its raw stderr, local paths, Codex output, SQLite files,
credentials, or environment.

## Preparing a public report

Reproduce with the fake transport and synthetic data if possible. Include only
the safe fields listed in [SUPPORT.md](../SUPPORT.md). If the problem might
expose private content, execution authority, authentication, or session
isolation, use [private security reporting](../SECURITY.md), not a public issue.
