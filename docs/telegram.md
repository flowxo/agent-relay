# Direct Telegram setup and operation

> **Transport:** optional direct Telegram Bot API
>
> **Default reply mode:** long polling from the loopback daemon

Direct Telegram requires no hosted Agent Relay account or public web server. The
bot sends one private topic per logical harness session so concurrent sessions
remain distinguishable.

## Prerequisites

- the fake canary in [the install guide](install-upgrade-uninstall.md) passes;
- a dedicated Telegram bot;
- a one-to-one chat with that bot;
- the intended operator's Telegram user ID; and
- private-chat **Threaded Mode** enabled through BotFather.

Telegram does not currently document a Bot API method for enabling Threaded Mode
with the bot token. The token can verify `has_topics_enabled` and create topics
after BotFather enables it. Creating a topic does not enable the account-level
feature.

The living [onboarding guide](onboarding.md) contains the safe `getUpdates`
discovery flow and BotFather details. Never copy the resulting numeric IDs or
token into a fixture, issue, screenshot, or committed file.

## Store configuration privately

Copy the variable names into a secret manager or a mode-`0600`, gitignored local
file:

```dotenv
AGENT_RELAY_TRANSPORT=telegram
AGENT_RELAY_TELEGRAM_TOKEN=<bot token>
AGENT_RELAY_TELEGRAM_CHAT_ID=<private chat id>
AGENT_RELAY_TELEGRAM_OPERATOR_ID=<authorized operator id>
AGENT_RELAY_TELEGRAM_UPDATE_MODE=poll
```

The development-only `.env.activation` filename is already ignored. Verify its
permissions and ignore status without printing the values:

```sh
test "$(stat -f '%Lp' .env.activation)" = 600
git check-ignore -q .env.activation
```

Long polling requires no public callback. Webhook mode is available only when an
external HTTPS bridge already exists and additionally requires
`AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET`. Polling and webhooks are mutually
exclusive; inspect `getWebhookInfo` before removing or changing a webhook.

Transport selection is explicit and credential-independent. Instead of the
environment override above, persist the choice with:

```sh
~/.agent-relay/bin/agent-relay transport select telegram
~/.agent-relay/bin/agent-relay transport status
```

Restart the daemon after a durable selection change. Direct Telegram never
automatically receives a second copy when another transport is selected.

## Start and preflight

Load the private environment with shell tracing disabled, then start the
installed daemon:

```sh
set +x
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay daemon
```

Before listening, the daemon calls Telegram `getMe`, `getChat`, and
`getWebhookInfo`. It fails closed unless:

- the token is valid;
- the chat is private;
- private topics are enabled; and
- poll/webhook configuration agrees with Telegram.

Real Telegram never falls back to General or silently switches to the fake
transport. Expected structured evidence includes `telegram.preflight-succeeded`,
`telegram.poll-started` in poll mode, and `daemon.started` with transport
`telegram`.

## Run the bounded activation canary

In another terminal with the same environment:

```sh
~/.agent-relay/bin/agent-relay telegram-canary --wait-ms 120000
```

Open the new canary topic and send the exact synthetic challenge printed by the
card:

```text
relay-canary-ok
```

Success requires topic creation/reuse, delivery, authorized operator/chat/topic
routing, exact request correlation, durable first-writer-wins resolution, and
`resolvedBy: telegram`. Command output omits the private question and answer.

## Session topics and cards

The first event for a machine + harness + session lazily creates a bounded topic
name containing:

- harness;
- sanitized repository display name;
- optional branch; and
- a readable short session suffix plus collision digest.

The absolute working path, transcript, bot identity, and full session ID are not
used in the topic name. SQLite retains the provider topic mapping across
restarts.

Cards are plain text and bounded below Telegram's message limit. They show
session identity, event kind/age, and a bounded summary or question. Model text
cannot create a button: callback data is a versioned opaque local token.

Available controls depend on durable event state:

- **Continue** resolves one eligible continuation;
- **Details** posts bounded, secret-redacted pages once;
- **Mute** suppresses routine cards but not questions or proven failures; and
- **End** closes only the Agent Relay lane after open questions are resolved.

End does not claim to terminate an unowned harness process, and it does not
delete the Telegram topic or its message history.

### Delete proven-dead topics

Send `/cleanup` from the configured operator account in General or any session
topic. Agent Relay posts a bounded preview in General; nothing is deleted until
the operator taps **Delete topics**. The confirmation expires after ten minutes,
and a newer preview supersedes an older one.

A topic qualifies only when the local store proves all of the following:

- the session received an explicit **End** action or native `session.ended`
  event;
- the session is not active;
- no unexpired request is open;
- no continuation is claimed or running;
- no event for that session is queued, retrying, or being delivered; and
- the topic mapping is ready in the current transport scope.

A crash, stale heartbeat, process exit, stopped turn, or age alone never
qualifies. Agent Relay snapshots at most twenty candidates in one preview and
rechecks every candidate immediately before deletion. A changed session is
skipped and retains its mapping.

Telegram's `deleteForumTopic` permanently removes the topic and every message in
it. Agent Relay treats an already-absent topic as successful, retries bounded
transient failures from SQLite, and removes the local mapping only after
Telegram confirms deletion or absence. Permanent failures and control-message
edit failures remain visible in diagnostics. `/v1/status` exposes safe aggregate
counts under `topicCleanups`. Re-run `/cleanup` for additional eligible topics.

Confirmations, selections, permissions, and ordered question sets use buttons.
Free text can be typed directly in a session topic only when exactly one
compatible request is open there. With zero candidates, Agent Relay posts
guidance; with multiple candidates, it asks for Telegram's Reply gesture on the
specific request card. It never searches another topic or treats arbitrary topic
chatter as a button answer.

## Reliability and privacy

The configured chat, operator, topic, original message, request, and session
must all match before an answer is claimed. Telegram `update_id` values and
callback actions are durable and idempotent. A stale, duplicate, unauthorized,
cross-topic, expired, or already-resolved answer is diagnosed without echoing
its text into logs.

Telegram retains unconfirmed Bot API updates for no longer than 24 hours. Local
request retention cannot recover an upstream update after that boundary.
Messages already accepted by Telegram remain subject to Telegram's own storage
and deletion behavior.

Telegram has no caller-supplied idempotency key for `sendMessage` or topic
creation. SQLite prevents normal duplicates, but a process crash after Telegram
accepts a request and before the receipt commits leaves a narrow at-least-once
duplicate window.

If Telegram proves a stored topic is unavailable, Agent Relay invalidates only
that mapping, records `topic.reconciliation-required`, retries the owning event,
and creates a replacement. It never sends that event into General.

Confirmed topic cleanup is a separate durable worker. Its exact preview,
operator decision, per-topic attempts, and terminal result survive restart.

See [troubleshooting](troubleshooting.md) for provider codes and
[PRIVACY.md](../PRIVACY.md) for outbound fields and erasure.

## Primary references

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram forum topics](https://core.telegram.org/api/forum)
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq)
