# Harness contract evidence

Recorded on 2026-07-24 through 2026-07-29 on macOS arm64. The fixture corpora
under `packages/harnesses/fixtures` and
`packages/codex-app-server-driver/fixtures` contain only synthetic identifiers,
paths, and messages. Primary Codex, Claude Code, Cursor, and Telegram
documentation was rechecked through 2026-07-29 for the public guides; no support
claim was widened without new fixture and canary evidence. The generated
compatibility matrix is the authoritative support summary; this ledger provides
its linked provenance.

## Local observations

| Harness     | Exact live-verified version | Commands observed                                                                        |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | `codex-cli 0.145.0`         | `codex --version`, `codex --help`, `codex exec resume --help`, `codex app-server --help` |
| Claude Code | `2.1.219 (Claude Code)`     | `claude --version`, `claude --help`                                                      |
| Cursor      | `2026.07.23-e383d2b`        | `cursor-agent --version`, `cursor-agent --help`, `cursor-agent resume --help`            |

The local help output proves that all three CLIs expose a session-resume entry
point. It also proves that Codex App Server is installed and exposes a
structured transport. Cursor was initially observed as `3.12.30`; its login flow
auto-updated the launcher to the version recorded above before the live
stop/resume canary. These checks do not invoke a model or incur API cost.

A non-model maintenance check on 2026-07-29 observed Codex `codex-cli 0.146.0`
and Claude Code `2.1.220 (Claude Code)`. No model-backed continuation canary was
rerun for either update, so those installed versions are deliberately
`compatible-unverified`; `0.145.0` and `2.1.219` remain the exact verified
claims. This is the expected doctor warning path, not evidence for silently
advancing the support table.

## Installer observations

The official hook references were rechecked on 2026-07-29 before extending the
installer:

- Codex discovers user hooks at `~/.codex/hooks.json`, uses nested matcher
  groups and command handlers, and requires non-managed hooks to be reviewed and
  trusted. Agent Relay installs `SessionStart` for startup/resume/clear,
  `UserPromptSubmit`, `Stop`, and `PermissionRequest`.
- Claude Code stores user hooks inside `~/.claude/settings.json` under the same
  nested event/group/handler shape. Agent Relay installs `SessionStart` for
  startup/resume/clear/fork, `UserPromptSubmit`, `Stop`, `StopFailure`, and
  `PermissionRequest`.
- Cursor stores user hooks in `~/.cursor/hooks.json` with `version: 1` and flat
  command-handler arrays per event.

The lifecycle parsers retain only the session/source transition and a constant
prompt-submitted summary; tests prove a private sentinel in the native prompt is
never copied into the normalized event. Automatic compaction is excluded from
the installed SessionStart matchers. The installer fixtures preserve unrelated
entries in each shape. Cursor permission and lifecycle expansion remain excluded
because their evolving payloads still lack current sanitized evidence in this
repository.

## Supervisor observations

The Milestone 3 test process launches owned Node.js children and observes a
non-zero exit, self-delivered `SIGTERM`, and `ENOENT` startup failure through
Node's child-process contract. The supervisor preserves those statuses and
records only bounded exit metadata; it inherits stdio and does not capture
command output. These fixtures do not invoke a model.

Late-resume argv is derived from the initial invocation once. Codex defaults to
`read-only` and retains an explicit sandbox or dangerous bypass; Claude defaults
to `plan` and retains an explicit permission mode or dangerous bypass. Cursor
reuses the exact initial executable and retains only the allowlisted mode,
sandbox, workspace, additional directories, workspace trust, and `--force`.
Parsing stops at the initial option terminator, unrelated arguments are not
copied, and the answer follows a generated option terminator. Codex's documented
one-invocation hook-trust override is also retained so an approved headless
resume continues to emit hooks. Every answer remains a discrete argv value and
is never shell-interpreted.

## Telegram adapter observations

Telegram's official Bot API documentation was rechecked on 2026-07-29 against
Bot API 10.2. The current contract documents `createForumTopic` for forum
supergroups and private bot chats, a 1-128-character topic name, and
`editForumTopic` for both scopes, plus `message_thread_id`,
`disable_notification`, and explicit UTF-16 `entities` on `sendMessage`. Agent
Relay's deterministic HTTP fixtures cover the documented create, state-title
edit, literal rich-text, silent-delivery, and malformed-response shapes. A
credentialed 2026-07-25 activation also created and reused private topics for
several independent Codex sessions; no live identifier or message was retained.

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
session, latest-event, and control records. Schema 8 keeps the stable base name
separate from the applied and desired display title; state changes schedule
bounded leased edits, and file-backed fixtures prove retry and restart recovery.
Existing SQLite files backfill their current provider title before the first
state reconciliation.

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
unpinning. Agent Relay does not call the supergroup-only close method.
`deleteForumTopic` is isolated behind the existing exact-set, operator-confirmed
cleanup and purge controls. Fake restart fixtures recover interrupted topic
creation and title editing with explicit batch limits. Ended lanes suppress all
later events and cancel delayed requests; both a native `session.ended` event
and the End button are covered. Their Telegram topics remain visible until
confirmed cleanup, while their displayed title becomes `⚫` ended.

Real-Telegram daemon startup calls `getMe`, `getChat`, and `getWebhookInfo`
before opening the local service. Sanitized fixtures require
`has_topics_enabled=true`, a private chat, and update-mode/webhook agreement.
Threaded mode disabled, non-private scope, invalid token/chat, blocked bot,
topic-permission denial, missing or conflicting webhook state, concurrent
`getUpdates`, deleted/closed topics, and transient network/provider failures
have distinct stable codes. Fake transport bypasses credential checks and is
reported explicitly; real Telegram never falls back to an unthreaded
conversation.

Compact card fixtures enforce Telegram's 4,096-character message boundary and
64-byte callback-data boundary before the request. Card action payloads use a
fixed `relay-card:v1` namespace, a one-character action code, and an opaque
deterministic token that is registered against the full local event. Telegram
receives no parse mode. Explicit entities style only trusted structural ranges
over the final bounded UTF-16 text, so untrusted model text remains literal and
cannot create formatting or callback payloads.

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
diagnostics. Some Telegram clients attach reply metadata that does not identify
a request to ordinary topic text. A sanitized regression fixture proves that
this shape falls back only to exact-topic correlation when one eligible request
exists; known stale, cross-topic, ambiguous, and button-only targets remain
strict. The credentialed continuation below also live-proved this fallback.

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
- Phase 1 multi-session acceptance: concurrent supervised Codex stops created
  distinct private topics and compact cards. One direct topic-text answer and
  one Continue button were each durably correlated to their own session, resumed
  the exact Codex session in read-only mode, returned the expected sentinel, and
  recorded a succeeded exit-zero resume. Earlier intentionally bounded
  supervisors closed before two late actions arrived; those late actions remain
  resolution evidence but are not counted as resume evidence.
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
Unknown automatic Telegram reply metadata now falls back to exact-topic
correlation only when one eligible request exists. A transient daemon outage
while a supervisor is waiting produces one durable diagnostic, retries with
bounded backoff, and records recovery instead of abandoning the supervised
session. Cursor workspace trust is distinct from `--force`. A terminal interrupt
that a child normalizes to status 130 or 143 is expected only when it matches
the signal observed and forwarded by the owning supervisor; unrelated non-zero
exits remain crash evidence.

Credentialed acceptance must establish a harness's authentication readiness
before starting notification-producing supervision. When an exact harness offers
an authentication-status command, the acceptance preflight captures and discards
all output and uses only its success or failure; a failure stops before the
supervised child or a card-capable daemon step begins. The real command is used
only after its offline/network behavior is understood and the live window is
explicitly authorized.

`--max-resumes` bounds continuations inside one supervisor. It is not a ceiling
for initial launches, independent supervisor retries, events, or cards. A
bounded acceptance run therefore reserves the worst-case card count before each
supervised attempt and stops after any unexpected exit instead of starting a
second attempt under the same reservation. Independent non-zero authentication
exits correctly remain distinct owned-child `process.exited` evidence; they are
a setup-sequencing failure when supervision began before authentication was
ready, not a reason to suppress or coalesce real process exits.

## Codex app-server structured profile

The exact installed `codex-cli 0.145.0` app-server profile was verified on
2026-07-27 through the isolated `@agent-relay/codex-app-server-driver` package.
The adapter launches `codex app-server` directly over stdio JSON lines, performs
`initialize` / `initialized` with experimental API access, owns the resulting
child, and shuts down only that process.

The generated v2 schema bundle has a stable canonical SHA-256 of
`1bc09dedc506075562d4d49b702ecab6d947dd5a8c2a9014a5cde592a0938efb`. The
generator emits definitions in nondeterministic object-key order, so raw file
bytes are deliberately not the lock. The contract recursively sorts object keys
and compacts JSON before hashing; two independent generations produced the same
canonical digest and 326,909-byte canonical representation.

Sanitized fixtures and deterministic fake-app-server tests cover:

- exact version mismatch and schema drift;
- initialize ordering and malformed, oversized, unknown, duplicate, timed-out,
  and error responses;
- thread start/resume and turn start/follow-up;
- active-turn steering and exact turn interruption;
- command-execution and file-change approval responses;
- thread, turn, item, terminal failure, approval, and native-error observations;
  and
- intentional shutdown, unexpected exit, pending-request rejection, and bounded
  termination escalation.

The model-backed canary used an ephemeral thread in a generated temporary
read-only project with approvals disabled. It initialized, started one thread
and one turn, observed user and agent message item lifecycles, observed a
completed turn, stopped its owned process, and removed the temporary project and
generated schemas. The committed evidence contains only booleans, enums, the
public version, and schema digest. No prompt, response, transcript, native
identifier, credential, account value, or machine path was retained. The same
bounded canary passed again on 2026-07-28 after merging the current WhooshBang
RC.1 and release-readiness baseline into the Phase 3 integration candidate.

The verified structured-driver capabilities are deterministic interrupt,
follow-up turn, approval decision, resume, active steer, terminal failure, and
owned-process exit observation. Project/artifact operations and session pause
remain absent from the driver capability list. The driver profile does not infer
durable adoption or product/native correlation from app-server method
availability; those semantics are proven separately by the runner-bridge
adoption, ownership, and restart-reconciliation suites.

## Official contract sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) documents `SessionStart`,
  `UserPromptSubmit`, `Stop`, `decision: "block"` continuation, hook trust, and
  permission decisions.
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
  documents `codex exec resume`.
- [Codex App Server](https://developers.openai.com/codex/app-server) documents
  `thread/resume`, `turn/start`, and `turn/steer`.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) documents
  `SessionStart`, `UserPromptSubmit`, `Stop`, its `background_tasks` and
  `session_crons` pause evidence, `StopFailure`, `Notification`, and permission
  wire contracts.
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
  documents programmatic hooks, permissions, streaming input, and session
  resume.
- [Cursor hooks](https://cursor.com/docs/hooks) and the official
  [agent best-practices example](https://cursor.com/blog/agent-best-practices)
  document the `stop` payload and `followup_message`.
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using) documents session
  resume.
- [Telegram Bot API](https://core.telegram.org/bots/api) documents
  `createForumTopic`, private-chat `message_thread_id`, `getUpdates`, offsets,
  long-poll timeouts, update limits, allowed update filters,
  `disable_notification`, webhook exclusivity, and webhook secret headers.
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq) documents the 24-hour
  pending-update retention boundary.

## Evidence boundary

The checked-in hook payloads are sanitized official examples adapted into
synthetic fixtures, not private local transcripts. Adapter and continuation
tests prove our parser and emitted JSON match the documented contracts. The live
evidence above is limited to the exact installed versions, CLI surfaces,
installed user hooks, and private-chat transport tested. Cursor permission
automation remains fixture-backed and disabled by default. Native hooks still do
not prove process crashes; the delivered crash whooshbang were produced only
because Agent Relay owned and observed the child processes.

The Claude background-work fixture is official-contract-derived, not a retained
private Stop payload. It proves the parser keeps only in-flight and scheduled
counts and discards task identity, description, command, agent type, schedule,
prompt, transcript path, working path, and the assistant message. The exact
installed `2.1.220` build naturally produced background work followed by a
truly-idle Stop under the previous suppression policy. Silent Telegram
projection is deterministic HTTP-fixture evidence until another natural
background-work event exercises the updated installed daemon.

The Codex and Claude lifecycle fixtures are official-contract-derived and
synthetic. They prove SessionStart and UserPromptSubmit parsing, prompt-content
non-retention, stable constant summaries, malformed-input diagnosis, and
transport mode selection. They do not promote the currently installed harness
versions or claim equivalent Cursor lifecycle hooks.

Native-hook ordering is implementation evidence, not an additional harness
payload claim. Deterministic file-backed SQLite tests assign distinct hooks
monotonic per-session sequences across simultaneous connections and process
restart, reuse the same allocation on retry, advance past retained legacy
hash-derived sequences, and prove a delayed fallback replay cannot rewind the
session lane. The allocator stores only opaque normalized identifiers, a SHA-256
source fingerprint, sequence, and timestamps; no private payload fixture was
captured for this behavior.
