# Harness contract evidence

Recorded on 2026-07-24 and 2026-07-25 on macOS arm64. The fixture corpus under
`packages/harnesses/fixtures` contains only synthetic identifiers, paths, and
messages.

## Local observations

| Harness     | Installed version       | Commands observed                                                                        |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | `codex-cli 0.145.0`     | `codex --version`, `codex --help`, `codex exec resume --help`, `codex app-server --help` |
| Claude Code | `2.1.219 (Claude Code)` | `claude --version`, `claude --help`                                                      |
| Cursor      | `2026.07.23-e383d2b`    | `cursor-agent --version`, `cursor-agent --help`, `cursor-agent resume --help`            |

The local help output proves that all three CLIs expose a session-resume entry
point. It also proves that Codex App Server is installed and exposes a
structured transport. Cursor was initially observed as `3.12.30`; its login flow
auto-updated the launcher to the version recorded above before the live
stop/resume canary. These checks do not invoke a model or incur API cost.

## Installer observations

The official hook references were rechecked on 2026-07-24 before implementing
the installer:

- Codex discovers user hooks at `~/.codex/hooks.json`, uses nested matcher
  groups and command handlers, and requires non-managed hooks to be reviewed and
  trusted.
- Claude Code stores user hooks inside `~/.claude/settings.json` under the same
  nested event/group/handler shape.
- Cursor stores user hooks in `~/.cursor/hooks.json` with `version: 1` and flat
  command-handler arrays per event.

The installer fixtures preserve unrelated entries in each of those shapes.
Cursor permission hooks remain excluded from the default patch because their
evolving payload still lacks a sanitized live capture in this repository.

## Supervisor observations

The Milestone 3 test process launches owned Node.js children and observes a
non-zero exit, self-delivered `SIGTERM`, and `ENOENT` startup failure through
Node's child-process contract. The supervisor preserves those statuses and
records only bounded exit metadata; it inherits stdio and does not capture
command output. These fixtures do not invoke a model.

Late-resume argv is derived from the initial invocation once. Codex defaults to
`read-only` and retains an explicit sandbox or dangerous bypass; Claude defaults
to `plan` and retains an explicit permission mode or dangerous bypass; Cursor
retains workspace trust and `--force` only when the initial invocation had them.
Codex's documented one-invocation hook-trust override is also retained so an
approved headless resume continues to emit hooks. The answer is always a
discrete argv value and is never shell-interpreted.

## Telegram adapter observations

Telegram's official Bot API documentation was rechecked on 2026-07-25 against
Bot API 10.2. The current contract documents `createForumTopic` for forum
supergroups and private bot chats, a 1-128-character topic name, and
`message_thread_id` on `sendMessage`. Agent Relay's deterministic HTTP fixtures
cover the documented success and malformed-response shapes. A credentialed
private-topic creation has not yet been captured, so that boundary remains
contract-tested rather than live-proven.

Local reply intake defaults to `getUpdates` long polling because the daemon
binds to loopback. The implementation sends an offset one greater than the
highest handled update, limits intake to messages and callback queries, and
relies on the durable update claim when Telegram repeats an unconfirmed update.

The official contract states that `getUpdates` and webhooks are mutually
exclusive, `timeout` is expressed in seconds, `limit` is bounded from 1 through
100, and updates are retained for no longer than 24 hours. Webhook mode remains
available for an external HTTPS bridge and validates the documented
`X-Telegram-Bot-Api-Secret-Token` header. Tests use sanitized deterministic HTTP
responses and do not contain a bot token or private message.

The activation command is separately covered by a daemon-level fake transport
test. It sends a unique correlated question through HTTP and SQLite, injects an
authorized Telegram update that replies to the delivered message ID, and proves
durable Telegram resolution with no question or answer in command output. This
proves the local control loop.

The fake transport also creates deterministic topics. SQLite claims a session
topic before the transport call, persists provider/repository/branch, short
session identity, lifecycle, provisioning attempts, and the returned topic ID,
and reuses that mapping after reopen. Tests cover repeated events, competing
first deliveries, separate concurrent sessions, retryable and non-retryable
topic failures, path/secret sanitization, and restart reuse.

The readable session suffix now carries a six-character digest of the full
machine/harness/session identity, and the 128-character name bound preserves
that suffix. Fixtures prove that two sessions ending in the same eight
characters still receive distinguishable names. `topicRecords` expose `running`,
`waiting`, `muted`, `crashed`, `ended`, and `stale` lane states from durable
session, latest-event, and control records without renaming the topic on every
event. Existing SQLite files add and backfill the latest-event field on open.

The Telegram HTTP fixtures classify a
`400 Bad Request: message thread not found` response only when `sendMessage`
included a persisted `message_thread_id`. The daemon then clears that stale
mapping, records a `topic.reconciliation-required` diagnostic, retries the
owning event through the durable spool, and lazily creates a replacement topic.
The fake transport proves this path without ever falling back to the unthreaded
conversation. A live topic deletion has not been induced, so the exact error
description remains fixture-proven rather than credentialed-account-proven.

A second fixture classifies a scoped `400` response proving that a message
thread is closed and runs the same replacement path. Bot API 10.2 documents
`closeForumTopic` and `reopenForumTopic` for forum supergroups, while its
private-chat topic support explicitly covers creation, editing, deletion, and
unpinning. Agent Relay does not call the supergroup-only close method for the
current private-chat transport. Fake restart fixtures recover interrupted topic
creation with an explicit batch limit. Ended lanes suppress all later events and
cancel delayed requests; both a native `session.ended` event and the End button
are covered.

Real-Telegram daemon startup calls `getMe`, `getChat`, and `getWebhookInfo`
before opening the local service. Sanitized fixtures require
`has_topics_enabled=true`, a private chat, and update-mode/webhook agreement.
Threaded mode disabled, non-private scope, invalid token/chat, blocked bot,
topic-permission denial, missing or conflicting webhook state, concurrent
`getUpdates`, deleted/closed topics, and transient network/provider failures
have distinct stable codes. Fake transport bypasses credential checks and is
reported explicitly; real Telegram never falls back to General.

Compact card fixtures enforce Telegram's 4,096-character message boundary and
64-byte callback-data boundary before the request. Card action payloads use a
fixed `relay-card:v1` namespace, a one-character action code, and an opaque
deterministic token that is registered against the full local event. Telegram
receives no parse mode, so untrusted model text remains normalized plain text
and cannot create formatting or callback payloads.

Card callback fixtures include Telegram's originating message and
`message_thread_id`. The router validates the versioned payload, configured
operator and chat, persisted delivery message, session, and topic before
claiming an action. SQLite commits first-writer-wins execution before callback
acknowledgement. Tests cover every action, repeated updates and taps, malformed
and unknown tokens, unauthorized senders, cross-message/topic attempts, blocked
End with a pending question, and an ambiguous Details delivery failure.

Durable coalescing fixtures prove that exact-equivalent `turn.started`,
`turn.activity`, and request-free `turn.stopped` events inside the configurable
window edit one anchor card with a count and latest timestamp. The fingerprint
is a digest; no transcript is added to coalescing metadata or diagnostics.
Question, crash, stale, process, and session events bypass the path. A failed
edit is diagnosed and retried as a separate visible card, and mute/end
suppression emits one durable diagnostic per event. Consumed Details actions
close their group to later coalescing so a stale button is not revived. A
file-backed close/reopen fixture reuses the same anchor after daemon restart.
Concurrent claims use an expected group count; one loser is diagnosed and
retried as a separate visible card rather than overwriting the displayed count.

Details fixtures exercise two-page delivery of the maximum bounded single event,
the latest ten events of a coalesced group, and an eight-page upper bound. Every
rendered page stays below Telegram's 4,096-character limit; omitted history
remains in SQLite with the true group count.

Plain topic-text fixtures bind `message_thread_id` to the durable session-topic
registry before inspecting requests. Direct text resolves only when that topic
contains exactly one open, unexpired `input` or `continuation` request. Zero and
multiple candidates leave every request unchanged and produce bounded guidance;
button-only requests reject ordinary chatter. Explicit replies additionally bind
the replied-to delivery to the same session topic. Concurrent messages,
duplicates, stale replies, unauthorized senders, cross-topic attempts, and
guidance-delivery failures are covered without retaining rejected text in
diagnostics. This behavior is fake-transport proven; a live direct-topic-text
activation is not yet claimed.

A credentialed private-chat activation was run on 2026-07-24. The Bot API
accepted the synthetic canary notification, loopback long polling received the
operator's replied-to-message update, and SQLite recorded the exact challenge as
an authorized Telegram answer. A reply to an earlier expired request was also
correlated and rejected as stale. The token, numeric account identifiers,
private message content, and machine paths are deliberately omitted. The
sanitized update shape is already represented by the deterministic reply-router
and daemon canary fixtures.

## Live harness activation

Short model-backed canaries were run through the installed hooks and the real
private-chat Telegram transport on 2026-07-24 and 2026-07-25. Identifiers,
prompts, replies, transcripts, credentials, and working paths were not retained
as fixtures.

- Codex `0.145.0`: a first `codex exec` attempt skipped the untrusted user hook,
  matching the official trust contract. A retry with the documented
  `--dangerously-bypass-hook-trust` one-invocation override emitted Stop,
  delivered it to Telegram, rejected stale replies, correlated a fresh reply,
  and resumed the exact session successfully. The first resume exposed a
  read-only-to-full-access sandbox widening. After late-resume policy was made
  fail-closed, the exact-session canary was repeated and the resumed CLI
  reported `read-only`.
- Claude Code `2.1.219`: an invalid initial argv combination exited non-zero and
  produced a real owned-child crash notification. The corrected `--print`
  invocation emitted Stop, delivered it to Telegram, correlated the reply to the
  exact session, and resumed successfully under `--permission-mode plan`.
- Cursor `2026.07.23-e383d2b`: after authentication, an interactive initial turn
  emitted the installed user-level Stop hook and delivered it to Telegram. The
  operator reply was correlated to the exact conversation, and
  `cursor-agent --resume=<session>` returned the requested sentinel and exited
  zero. The initial workspace-trust flag was retained without adding `--force`.
  On this build, `--print` required workspace trust and exited cleanly without
  emitting Stop, so the proven initial Stop path is interactive.

The live loops also exposed operational issues now covered by tests. Background
delivery can race an activation command's explicit drain, and expected empty
resume polls can amplify logs. Activation now waits for the durable delivery
receipt, while expected `waiting` polls are silent. A `--max-resumes` bound
prevents the last permitted resumed child from opening an orphan continuation
request. Supervised version metadata overrides the install-time hook version.
Cursor workspace trust is distinct from `--force`. A terminal interrupt that a
child normalizes to status 130 or 143 is expected only when it matches the
signal observed and forwarded by the owning supervisor; unrelated non-zero exits
remain crash evidence.

## Official contract sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) documents `Stop` input,
  `decision: "block"` continuation, hook trust, and permission decisions.
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
  documents `codex exec resume`.
- [Codex App Server](https://developers.openai.com/codex/app-server) documents
  `thread/resume`, `turn/start`, and `turn/steer`.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) documents `Stop`,
  `StopFailure`, `Notification`, and permission wire contracts.
- [Cursor hooks](https://cursor.com/docs/hooks) and the official
  [agent best-practices example](https://cursor.com/blog/agent-best-practices)
  document the `stop` payload and `followup_message`.
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using) documents session
  resume.
- [Telegram Bot API](https://core.telegram.org/bots/api) documents
  `createForumTopic`, private-chat `message_thread_id`, `getUpdates`, offsets,
  long-poll timeouts, update limits, allowed update filters, webhook
  exclusivity, and webhook secret headers.
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq) documents the 24-hour
  pending-update retention boundary.

## Evidence boundary

The checked-in hook payloads are sanitized official examples adapted into
synthetic fixtures, not private local transcripts. Adapter and continuation
tests prove our parser and emitted JSON match the documented contracts. The live
evidence above is limited to the exact installed versions, CLI surfaces,
installed user hooks, and private-chat transport tested. Cursor permission
automation remains fixture-backed and disabled by default. Native hooks still do
not prove process crashes; the delivered crash notifications were produced only
because Agent Relay owned and observed the child processes.
