# Agent Relay onboarding

> **Status:** Living operational guide
>
> **Last verified:** 2026-07-25
>
> **Scope:** macOS-first local development and direct Telegram activation

This is the canonical path from a clean checkout to one proven
agent-to-Telegram-to-agent interaction. Update it whenever installation,
configuration, supported harness behavior, Telegram requirements, or the
activation canary changes.

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
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

No Telegram credentials are needed for these checks. Tests use sanitized
fixtures and a fake transport.

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
The first attention event for a logical harness session lazily creates one
topic. Later events for that machine, harness, and session reuse the durable
mapping after daemon restarts. Topic names contain only the harness, sanitized
repository and optional branch, and the final eight characters of the session
identifier. They never contain transcript text, tokens, or an absolute working
path.

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
AGENT_RELAY_TELEGRAM_TOKEN=<bot token>
AGENT_RELAY_TELEGRAM_CHAT_ID=<private chat id>
AGENT_RELAY_TELEGRAM_OPERATOR_ID=<authorized user id>
AGENT_RELAY_TELEGRAM_UPDATE_MODE=poll
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

`doctor` must report a healthy launcher, SQLite spool, capability matrix,
expected hook counts, and installed harness versions. Version drift is a warning
to recapture evidence before claiming compatibility.

## 5. Start the daemon

Managed background startup is not implemented yet. Start one daemon in a
terminal and leave it running:

```sh
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay daemon
```

Expected startup evidence includes:

- `telegram.poll-started`;
- `daemon.started`;
- loopback host and port `127.0.0.1:4317`; and
- transport `telegram`, not `fake-telegram`.

Starting after an offline period may replay previously spooled events. Stable
event IDs keep replay idempotent, but events that were never delivered before
the restart may produce historical notifications.

The first event for a session records a `topic.created` log before
`delivery.succeeded`. Inspect `status` to see `topics` counts and
`topicRecords`. Topic creation failures are represented both on the topic record
and as durable `topic.create-failed` diagnostics. Retryable failures keep the
owning event in the normal delivery spool.

Notifications are rendered as compact plain-text cards with stable session
identity, event age, a bounded one-line summary, and fixed callback data that
cannot be supplied by model text. Full long content remains in the local durable
event record and receives a Details action. Question-choice buttons and card
actions are active:

- Continue appears only for an open continuation that the harness reports as
  supported, and resolves it once through the existing resume queue.
- Details posts the bounded full local event once.
- Mute suppresses routine cards for that session while questions, stale
  warnings, and proven failures remain visible.
- End closes the relay lane after pending questions are resolved. It does not
  claim to terminate an already-running harness process.

Every action is committed before Telegram is acknowledged. Repeated taps return
the stored result without repeating the action. Session controls are inspectable
as `sessionControlRecords` in `status`.

## 6. Prove the Telegram interaction loop

In another terminal:

```sh
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay telegram-canary --wait-ms 120000
```

Use Telegram's Reply action on the fresh canary message and respond with
exactly:

```text
relay-canary-ok
```

Success requires:

- lazy creation or reuse of the exact session topic;
- Bot API delivery;
- authorized chat and operator routing;
- correlation to the exact Telegram message;
- exact challenge validation;
- durable first-writer-wins resolution; and
- a terminal result showing `resolvedBy: telegram`.

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

Both `AGENT_RELAY_TELEGRAM_TOKEN` and `AGENT_RELAY_TELEGRAM_CHAT_ID` must be
present in the daemon environment. Restart after correcting the activation file.

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

### Telegram replies are ignored

Confirm:

- the sender matches `AGENT_RELAY_TELEGRAM_OPERATOR_ID`;
- the chat matches `AGENT_RELAY_TELEGRAM_CHAT_ID`;
- polling and webhook modes are not both configured;
- the message targets an open, unexpired request; and
- the daemon logs show a handled or diagnosed Telegram update.

### A batch of old notifications appears after startup

The fallback spool replays events captured while the daemon was unavailable.
Inspect `status` to confirm there are no queued, retrying, or dead-letter
records after delivery completes.

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
