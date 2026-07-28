# Agent Relay onboarding

> **Status:** Living operational guide
>
> **Last verified:** 2026-07-28
>
> **Scope:** macOS-first local development and direct Telegram activation

This is the canonical path from a clean checkout to one proven
agent-to-Telegram-to-agent interaction. Update it whenever installation,
configuration, supported harness behavior, Telegram requirements, or the
activation canary changes.

For the shorter public entry points, see the
[installation lifecycle](./install-upgrade-uninstall.md),
[Telegram guide](./telegram.md), [web companion guide](./web-companion.md), and
[troubleshooting guide](./troubleshooting.md).

Do not add real tokens, account identifiers, private messages, session IDs,
usernames, hostnames, or machine-specific paths to this document.

## Current verified baseline

| Component   | Verified version or state |
| ----------- | ------------------------- |
| Node.js     | 22 or newer               |
| pnpm        | 11                        |
| Codex CLI   | `codex-cli 0.145.0`       |
| Claude Code | `2.1.219 (Claude Code)`   |
| Cursor CLI  | `2026.07.23-e383d2b`      |
| Telegram    | Bot API 10.2              |

The exact harness observations and evidence boundaries live in
[`harness-evidence.md`](./harness-evidence.md). Run `doctor` rather than
assuming this table is still current.

## 1. Prepare the repository

Requirements:

- macOS for the currently verified installation path;
- Node.js 22 or newer;
- pnpm 11;
- at least one supported harness installed; and
- a dedicated Telegram bot and private chat for the direct transport.

From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
pnpm build
```

The scripts-disabled install prevents dependency lifecycle code from running
before the exact vendored Notifications artifacts are inspected. The contract
preflight validates those archives and pins, then `pnpm rebuild` runs the
approved native build needed by SQLite. No Telegram credentials are needed for
these checks. Tests use sanitized fixtures and a fake transport.

## 2. Create and configure the Telegram bot

Create or select a dedicated bot through [`@BotFather`](https://t.me/BotFather).
Treat its token like a password.

### Enable private-chat topics

Open the bot's settings in BotFather and enable **Threaded Mode**. Telegram does
not expose a documented Bot API method for enabling this flag with the bot
token. The token can verify the flag and manage topics after it is enabled.

Telegram documents private bot topics in its
[`Forum topics`](https://core.telegram.org/api/forum) guide. Telegram also warns
that threaded mode is subject to additional terms concerning Telegram Star
purchases; review the BotFather notice before enabling it.

Whether the operator may manually create topics is a separate BotFather setting.
Agent Relay creates and owns session topics itself, so user-created topics are
not required.

Verify threaded mode without printing the token or bot identity:

```sh
set -a
. ./.env.activation
set +a

curl --silent --show-error --fail \
  "https://api.telegram.org/bot${AGENT_RELAY_TELEGRAM_TOKEN}/getMe" |
  jq '{
    has_topics_enabled: (.result.has_topics_enabled // false),
    allows_users_to_create_topics:
      (.result.allows_users_to_create_topics // null)
  }'
```

`has_topics_enabled` must be `true` before session-topic routing is activated.
The daemon repeats this check at every real-Telegram startup. It also verifies
that the configured chat is private and that `getWebhookInfo` agrees with
`AGENT_RELAY_TELEGRAM_UPDATE_MODE`. Startup records
`telegram.preflight-succeeded` without logging bot, chat, or operator IDs.

There is no unthreaded real-Telegram compatibility mode. If topics are disabled
or the chat is not private, startup fails clearly rather than delivering
different sessions into General. Transport selection is independent of
credentials: an unset selection defaults to `fake`, while a selected Telegram
transport fails readiness/startup if its required configuration is absent.

The first attention event for a logical harness session lazily creates one
topic. Later events for that machine, harness, and session reuse the durable
mapping after daemon restarts. Topic names contain only the harness, sanitized
repository and optional branch, plus the final eight readable session characters
and a six-character digest of the full machine/harness/session identity. The
digest prevents two sessions with the same readable suffix from becoming
indistinguishable. Name bounding preserves that identity suffix. Names never
contain transcript text, tokens, or an absolute working path.

### Discover the private chat and operator IDs

Send a message to the bot from the intended private Telegram account. With no
webhook configured, inspect the most recent update locally:

```sh
set -a
. ./.env.activation
set +a

curl --silent --show-error --fail \
  "https://api.telegram.org/bot${AGENT_RELAY_TELEGRAM_TOKEN}/getUpdates" |
  jq '.result[-1].message |
    {chat_id: .chat.id, operator_id: .from.id}'
```

In a one-to-one chat the values are commonly identical, but configure the two
fields independently. Do not paste either value into documentation, fixtures,
issues, or pull requests.

If `getUpdates` reports that a webhook is active, inspect `getWebhookInfo`
before changing anything. Telegram does not permit polling and webhook delivery
at the same time.

## 3. Create the private activation environment

The development activation file is gitignored. Create it with private
permissions:

```sh
umask 077
cp .env.example .env.activation
chmod 600 .env.activation
```

Set at least:

```dotenv
AGENT_RELAY_TRANSPORT=telegram
AGENT_RELAY_TELEGRAM_TOKEN=<bot token>
AGENT_RELAY_TELEGRAM_CHAT_ID=<private chat id>
AGENT_RELAY_TELEGRAM_OPERATOR_ID=<authorized user id>
AGENT_RELAY_TELEGRAM_UPDATE_MODE=poll
# Optional; defaults to 60000. Use 0 to disable.
AGENT_RELAY_COALESCE_WINDOW_MS=60000
# Optional safety bound for real transports; defaults to one hour. Use 0 only
# when every queued fallback event should be delivered regardless of age.
AGENT_RELAY_STARTUP_BACKLOG_MAX_AGE_MS=3600000
# Optional local companion; defaults to 1. Set to 0 to disable.
AGENT_RELAY_WEB_ENABLED=1
```

Long polling is the simplest loopback-daemon setup and requires no public
webhook. Use a high-entropy `AGENT_RELAY_DAEMON_TOKEN` if another local process
boundary requires daemon authentication.

Validate privacy without printing values:

```sh
test "$(stat -f '%Lp' .env.activation)" = 600
git check-ignore -q .env.activation
```

## 4. Install the user-level hooks

Build first, inspect the intended changes, then install:

```sh
pnpm build
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer:

- writes an exact-path launcher under `~/.agent-relay/bin`;
- minimally patches the Codex, Claude Code, and Cursor user hook files;
- creates private timestamped backups before changing existing configuration;
- preserves unrelated hooks and settings; and
- records an ownership manifest for safe upgrades and uninstall.

Review or trust newly installed hooks through each harness's supported UI. Codex
exposes `/hooks`; Claude Code and Cursor expose their corresponding hook
configuration views.

`doctor` must report a healthy launcher, SQLite spool, runtime-validated
compatibility registry, expected hook counts, and installed harness versions.
Version drift is a `compatible-unverified` warning to recapture evidence before
claiming compatibility; a known-incompatible version fails.

Before startup, inspect the safe selection/readiness projection:

```sh
~/.agent-relay/bin/agent-relay transport status
```

The environment override above selects Telegram for that process. To retain the
same choice without an environment override, run
`agent-relay transport select telegram`; the private
`~/.agent-relay/transport.json` takes effect on the next daemon start. A
daemon-only `--transport telegram` override takes precedence without rewriting
that file.

## 5. Start the daemon

Managed background startup is not implemented yet. Start one daemon in a
terminal and leave it running:

```sh
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay daemon
```

For repository development, the equivalent source command is:

```sh
pnpm relay -- daemon
```

The built and installed command serves the same packaged assets and versioned
API; `pnpm check` verifies that compatibility from compiled output.

Expected startup evidence includes:

- `telegram.poll-started`;
- `daemon.started`;
- loopback host and port `127.0.0.1:4317`; and
- transport `telegram`, not `fake-telegram`.

Before a real transport begins automatic drain, the installed daemon marks
queued/retrying events older than `AGENT_RELAY_STARTUP_BACKLOG_MAX_AGE_MS` as
visible dead letters. Still-open, unexpired requests and proven `owned-child`
process exits are exempt. A quarantine emits
`delivery.stale-backlog-quarantined` with a bounded count and no event content.
The same guard runs after later fallback replay. Set the value to `0` only when
intentionally replaying every historical event; a large spool can otherwise
create a burst of obsolete provider messages.

Startup also creates a private local-web credential beside the SQLite database,
normally `~/.agent-relay/web-credential.json`. It must remain a regular
mode-`0600` file. This credential is independent from Telegram and
`AGENT_RELAY_DAEMON_TOKEN`; the daemon never prints its bearer or CSRF values.
The local browser API is documented in [`local-web-api.md`](./local-web-api.md).
Its authenticated read models and resumable stream can also be exercised with
`curl` without a real bot token.

Open `http://127.0.0.1:4317/ui/` for the compact session board. Copy the `token`
and `csrfToken` fields from the private web credential into the connection form.
The board keeps both in page memory, shows stable session identities, filters
real running/waiting/crashed/stale/muted/ended lane states, and maintains a
global expiry-ordered attention queue. Reloading deliberately requires the
credential again. A disconnected, degraded, or stale board keeps those states
visually distinct instead of presenting cached data as live.

Select any session row to open its bounded evidence timeline. Event, delivery,
request, operator-action, and continuation entries share their retained event
and correlation IDs. Default details remain transcript-free. The separate
**Reveal private assistant excerpt** action is the only UI path that requests
bounded assistant content, and recognized secrets remain redacted. **Export
diagnostics** downloads at most 500 retained records after applying current
secret and machine-path redaction again.

Open attention cards contain the locally supported response form: free text,
single choice, bounded multi-select, or an ordered mixed question set. Form
drafts survive live board re-renders only in page memory and are discarded when
the request becomes terminal. **Continue**, **Details**, **Mute**, and **End**
use the same retained request/card commands as Telegram. Disabled buttons mean
the exact harness/event state does not support that action. End changes only the
relay lane; it does not terminate the harness process.

When Telegram and the browser answer at nearly the same time, the first SQLite
transition wins. The other surface changes to the terminal state without showing
or resubmitting the winning private answer. A browser winner also asks the
daemon to remove the Telegram controls; any transport edit failure is durably
diagnosed rather than hidden.

### Try the board without Telegram credentials

Use the separate synthetic demo to see four concurrent lanes and actionable
forms without a bot token, account ID, private transcript, or hosted service:

```sh
pnpm build
node apps/relay/dist/cli.js web-demo
```

Open `http://127.0.0.1:4318/ui/` and use
`~/.agent-relay/web-demo/web-credential.json`; `web.demo-started` names the
credential file without logging either value. The demo always selects the fake
transport even if Telegram variables exist in the calling shell. Stop it with
`Ctrl-C`.

### Disable the companion

Either set `AGENT_RELAY_WEB_ENABLED=0` or start the normal daemon with
`--no-web`. No `web-credential.json` is then created; `/`, `/ui/*`, and
`/v1/web/*` return a diagnosed 404; and the hook, status, durable spool,
Telegram, and supervisor paths remain active. The listener remains necessary for
those local daemon APIs.

Keep the default loopback host. Binding to another interface expands the trust
boundary and is not part of the supported local-only deployment. The console
uses no CDN, telemetry, browser storage, or hosted backend; see
[`local-web-api.md`](./local-web-api.md) for the complete security and privacy
defaults.

Starting after an offline period may replay previously spooled events. Stable
event IDs keep replay idempotent, but events that were never delivered before
the restart may produce historical notifications.

The first event for a session records a `topic.created` log before
`delivery.succeeded`. Inspect `status` to see `topics` counts and
`topicRecords`. Topic creation failures are represented both on the topic record
and as durable `topic.create-failed` diagnostics. Retryable failures keep the
owning event in the normal delivery spool.

Each topic record also reports a durable `laneState`: `running`, `waiting`,
`muted`, `crashed`, `ended`, or `stale`. The stable topic name is not rewritten
on every event. Compact event cards and session-control edits show state in
Telegram, while `status` exposes the reconciled current value. Crash and stale
evidence remain visible even when routine notifications were muted.

Notifications are rendered as compact plain-text cards with stable session
identity, event age, a bounded one-line summary, and fixed callback data that
cannot be supplied by model text. Full long content remains in the local durable
event record and receives a Details action. Question-choice buttons and card
actions are active:

Claude Code `Stop` events with a non-empty structured `background_tasks` or
`session_crons` collection are not operator attention. Agent Relay retains only
the two bounded counts, keeps the lane running, and records a durable
`background-work` suppression. It does not inspect assistant prose, task
descriptions, commands, scheduled prompts, or transcripts. A later Stop with
both collections empty produces the ordinary waiting card. Missing fields retain
the older deterministic Stop behavior.

Exact-equivalent `turn.started`, `turn.activity`, and request-free
`turn.stopped` events reuse one visible card during a rolling 60-second window.
The edited card shows the durable event count and latest event timestamp. Set
`AGENT_RELAY_COALESCE_WINDOW_MS` or `--coalesce-window-ms` to a value from `1`
to `3600000`; set it to `0` to disable coalescing. The fingerprint covers event
type and bounded content but is stored only as a digest.

Questions, permission requests, crashes, stale warnings, process exits, session
events, and any notification whose card edit failed always remain separate.
After a coalescing edit failure, the event retries as its own visible card.
Every coalescing, edit-failure, mute, and ended-lane suppression decision is
recorded as a privacy-safe durable diagnostic.

Details are delivered in Telegram-safe 3,500-character pages, with at most eight
pages per action. Coalesced Details show the latest ten durable events and the
true total count; older evidence remains available in the local SQLite store.
After Details is consumed, a later equivalent event starts a new card so the
operator is never shown an already-used Details button.

- Continue appears only for an open continuation that the harness reports as
  supported, and resolves it once through the existing resume queue.
- Details posts bounded Telegram-safe pages once.
- Mute suppresses routine cards for that session while questions, stale
  warnings, and proven failures remain visible.
- End closes the relay lane after pending questions are resolved. It does not
  claim to terminate an already-running harness process. Once ended, delayed
  events are durably suppressed and delayed requests are canceled instead of
  silently reopening the lane.

End intentionally leaves the Telegram topic intact. To remove ended-session
topics, send `/cleanup` in General or any topic. Agent Relay posts the exact
proven-dead candidate set in General and requires a ten-minute **Delete topics**
confirmation. Crashes, process exits, stale sessions, stopped turns, and age do
not qualify without an explicit End or native `session.ended` event. Every
candidate is revalidated before Telegram permanently deletes the topic and all
of its messages. Cleanup is limited to twenty topics per confirmation; re-run
the command for another batch.

Every action is committed before Telegram is acknowledged. Repeated taps return
the stored result without repeating the action. `status` exposes aggregate
control/session counts and safe transport diagnosis; detailed session state is
available through the authenticated local web companion rather than raw
identities in CLI output.

Free-text and continuation requests can be answered without Telegram's Reply
gesture when correlation is unambiguous. Type directly in the session topic when
exactly one open, unexpired `input` or `continuation` request exists there.
Agent Relay never searches another topic. If no eligible request exists, it
posts guidance without consuming the text as an answer. If more than one is
eligible, it asks you to reply to the specific request card rather than
guessing. Button-only confirmations, selections, and permissions cannot be
answered by ordinary topic chatter. Some Telegram clients attach automatic reply
metadata to ordinary topic text. When that metadata does not identify a retained
request, Agent Relay still applies the exact-topic, exactly-one-open request
rule. A known stale or cross-topic request remains rejected.

### Optional hosted Notifications setup proof

The optional hosted adapter now has a mock-backed setup and explicit full daemon
lifecycle, documented in the
[hosted Notifications guide](./hosted-notifications.md). It can authorize a
subscriber, generate and store a narrow credential, send a synthetic canary,
rotate, revoke, erase, and deliver normal attention events when `notifications`
is selected. Selected hosted mode also long-polls confirm/select/input answers,
commits them to the exact local request before provider acknowledgement, and
recovers cursor/acknowledgement work after restart. Terminal presentation is a
separate durable worker; the pinned rc.1 contract reports that optional
capability as unsupported because it has no resolution-update endpoint. Safe
status still exposes its queue/block counts and failure category. Local
disconnect or revocation stops new hosted calls, retains SQLite authority, and
requires explicit reconnect/rotation plus daemon restart.

Maintainers can prove the complete installed boundary without a real hosted
account or bot token:

```sh
pnpm package:hosted:check
```

The check installs the exact tarball into a clean home, configures the pinned
loopback mock through the public CLI, resolves confirm/select/input, proves
crash-before-ack replay, revocation/erasure with retained SQLite authority, and
an unchanged direct-Telegram canary against a synthetic Bot API. It rejects
workspace/sibling runtime dependencies and scans packed output and logs for
private fixture values.

Do not place a broad Notifications project credential in git or pass it as a
positional argument. Supply it only through the command's stdin, environment
injection, or hidden prompt. The local setup files are retained by uninstall;
use `notifications disconnect --revoke` before explicit credential/configuration
erasure. C0-09 approved the exact `1.0.0-rc.1` candidate, but it did not create
or authorize a real service environment. Perform this setup only against the
executable loopback mock until the Notifications owner supplies the approved AR3
environment and bounded-canary authorization.

## 6. Prove the Telegram interaction loop

In another terminal:

```sh
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay telegram-canary --wait-ms 120000
```

Open the fresh canary session topic and send exactly:

```text
relay-canary-ok
```

Success requires:

- lazy creation or reuse of the exact session topic;
- Bot API delivery;
- authorized chat and operator routing;
- direct topic-text correlation to exactly one eligible request;
- exact challenge validation;
- durable first-writer-wins resolution; and
- a terminal result showing `resolvedBy: telegram`.

Telegram's Reply action remains available when a topic contains multiple
eligible text requests. The replied-to card must belong to the same persisted
session topic and must represent a compatible free-text or continuation request.

The canary output deliberately excludes the private question and answer.

## 7. Run a supervised agent interaction

Installed hooks alone provide lifecycle notifications. Use `agent-relay run`
when crash evidence or late CLI resume is required.

### Codex

```sh
~/.agent-relay/bin/agent-relay run codex \
  --harness-version "$(codex --version)" \
  --max-resumes 10 \
  -- exec "Describe the repository and ask what to work on next."
```

### Claude Code

```sh
~/.agent-relay/bin/agent-relay run claude \
  --harness-version "$(claude --version)" \
  --max-resumes 10 \
  -- --print "Describe the repository and ask what to work on next."
```

### Cursor CLI

```sh
~/.agent-relay/bin/agent-relay run cursor \
  --harness-version "$(cursor-agent --version)" \
  --max-resumes 10 \
  -- --trust "Describe the repository and ask what to work on next."
```

The tested Cursor build emits its initial Stop hook interactively, not through
`--print`. Exit the idle initial Cursor process after its Stop notification so
the supervisor can launch the exact late-resume invocation.

For all three harnesses:

1. wait for the fresh Stop notification;
2. answer the correlated Telegram request;
3. keep the supervisor terminal open;
4. confirm the exact session is resumed; and
5. confirm `resume.succeeded` with exit code zero.

The supervisor derives continuation authority from the original invocation. It
must not widen sandbox, trust, or permission settings during resume.

## 8. Inspect status and diagnosis

With the activation environment loaded:

```sh
~/.agent-relay/bin/agent-relay status
~/.agent-relay/bin/agent-relay doctor
tail -f ~/.agent-relay/relay.ndjson
```

Useful status fields include queued/retrying/dead-letter events, session states,
resume command states, and diagnostic counts. Logs are redacted and rotated, but
should still be treated as private operational data.

## Troubleshooting

### The daemon reports `fake-telegram`

This means `fake` was selected, not that Telegram credentials were missing. Run
`agent-relay transport status`, then select `telegram` durably or set
`AGENT_RELAY_TRANSPORT=telegram`. Confirm token/chat readiness without printing
values and restart. Credentials alone never switch the transport.

### Threaded mode still reports false

Enable Threaded Mode through BotFather, then call `getMe` again. Topic creation
through the bot token does not replace this initial account-level setting.

### A session topic is not created

Confirm `has_topics_enabled` is still true, restart the daemon after rebuilding,
then inspect:

```sh
~/.agent-relay/bin/agent-relay status
tail -n 100 ~/.agent-relay/relay.ndjson
```

The status output distinguishes `pending`, `creating`, `ready`, `retry`, and
`failed` topic records. A retryable Bot API or network failure remains attached
to the queued event. A rejected topic request is dead-lettered rather than
silently delivering into the General conversation.

If an existing topic was deleted, Agent Relay records
`topic.reconciliation-required`, invalidates only that session's stale mapping,
and retries the event before creating a replacement topic. It never silently
falls back to the General conversation.

The same deterministic replacement path handles a provider response proving that
a stored topic is closed or otherwise unavailable. Telegram Bot API 10.2
documents private-chat topic creation, editing, and deletion, but its
`closeForumTopic` method is documented for forum supergroups rather than private
bot topics. Its `deleteForumTopic` method does support private chats, but
deletion also removes every message in the topic. End remains a durable local
relay-lane state and leaves the topic intact; the separate `/cleanup` command
previews and requires confirmation before calling the destructive method.
Unavailable-topic responses trigger reconciliation. Interrupted topic creations
are recovered in bounded retry batches at daemon startup.

### Telegram startup or delivery reports a provider code

Agent Relay classifies provider responses before retry policy is applied:

| Error code                         | Meaning and recovery                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `telegram-invalid-token`           | Replace `AGENT_RELAY_TELEGRAM_TOKEN` with the current BotFather token.                                             |
| `telegram-topics-disabled`         | Enable Threaded Mode in BotFather, verify `getMe`, and restart.                                                    |
| `telegram-private-chat-required`   | Use the intended one-to-one chat ID; unthreaded/group fallback is disabled.                                        |
| `telegram-invalid-chat`            | Verify the chat ID, open the bot chat, send `/start`, and restart.                                                 |
| `telegram-bot-blocked`             | Unblock the bot, send `/start`, and retry.                                                                         |
| `telegram-topic-permission`        | Restore topic-management permission or correct the target chat.                                                    |
| `telegram-topic-delete-permission` | Restore permission to delete the bot-owned topic, then run `/cleanup` again.                                       |
| `telegram-topic-unavailable`       | The stored topic was deleted/closed; Agent Relay invalidates it and creates a replacement.                         |
| `telegram-webhook-conflict`        | Poll mode found an active webhook; inspect `getWebhookInfo`, then remove the stale webhook or select webhook mode. |
| `telegram-webhook-missing`         | Webhook mode has no configured HTTPS URL; set the webhook before restarting.                                       |
| `telegram-polling-conflict`        | Another process is calling `getUpdates`; stop the other consumer and restart this daemon.                          |

Startup failures are emitted as structured `cli.failed` output with the stable
provider code in `errorCode`. Runtime topic failures remain on the durable topic
record and in diagnostics. Network failures, timeouts, rate limits, and provider
5xx responses retain normal bounded retry behavior.

For poll mode, this read-only check must show an empty URL:

```sh
curl --silent --show-error --fail \
  "https://api.telegram.org/bot${AGENT_RELAY_TELEGRAM_TOKEN}/getWebhookInfo" |
  jq '{url: .result.url, pending_update_count: .result.pending_update_count}'
```

Do not delete a webhook until you have confirmed it is stale. Webhook mode
requires both a configured Telegram HTTPS URL and
`AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET`.

### Telegram replies are ignored

Confirm:

- the sender matches `AGENT_RELAY_TELEGRAM_OPERATOR_ID`;
- the chat matches `AGENT_RELAY_TELEGRAM_CHAT_ID`;
- polling and webhook modes are not both configured;
- the message is inside the persisted session topic;
- exactly one open, unexpired free-text or continuation request exists there, or
  Telegram's Reply action identifies one compatible request card; and
- the daemon logs show a handled or diagnosed Telegram update.

For zero eligible requests, Agent Relay posts `reply not used` guidance. For
multiple eligible requests it posts `choose a request` guidance. Decisions and
guidance-delivery failures are retained as bounded diagnostics without copying
the rejected message text.

### Historical fallback work is quarantined at startup

The fallback spool still replays every valid record into local SQLite, but a
real transport does not automatically send obsolete routine/failure cards.
Events older than the one-hour default become `dead_letter` with
`delivery-stale-backlog`; open unexpired requests and proven supervised crashes
remain deliverable. Inspect `status` and the bounded
`delivery.stale-backlog-quarantined` diagnostic locally.

If the age guard was explicitly disabled and a historical burst begins, stop the
daemon, preserve a private database backup, and diagnose the queued work before
restarting. Do not erase SQLite or publish its contents.

### The daemon port is already in use

Check for an existing daemon before starting another:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

Single-instance service management is not implemented yet.

### Codex does not execute a newly installed hook

Review the hook through Codex `/hooks`. Do not bypass hook trust globally. The
one-invocation bypass is reserved for vetted non-interactive automation.

### Cursor does not emit an initial Stop under `--print`

Use the tested interactive initial Cursor flow. Headless `--print` remains the
late-resume leg only.

## Safe uninstall

Inspect first:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

Uninstall removes only Agent Relay-owned hook entries, launcher, and manifest.
It intentionally preserves SQLite state, logs, credentials, backups, and
unrelated user configuration.

## Keeping this guide alive

Update this document in the same change whenever any of these change:

- Node.js or package-manager requirements;
- supported or tested harness versions;
- Telegram Bot API prerequisites or BotFather-only settings;
- environment variables or credential storage;
- install, upgrade, doctor, or uninstall behavior;
- daemon lifecycle or service management;
- canary commands or expected outcomes;
- topic, button, question, or reply semantics;
- privacy defaults and transmitted content; or
- a known limitation becomes supported.

Before a public release, verify this guide from a clean temporary home and a
fresh Telegram bot. The release evidence should include:

1. clean dependency installation and full checks;
2. dry-run and real hook installation;
3. healthy `doctor`;
4. Telegram topic capability verification;
5. real Telegram activation canary;
6. one supported live stop/resume path per harness;
7. ownership-safe uninstall; and
8. confirmation that no private value entered git or command output.
