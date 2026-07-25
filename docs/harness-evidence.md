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

Telegram's official Bot API documentation was rechecked on 2026-07-24. Local
reply intake defaults to `getUpdates` long polling because the daemon binds to
loopback. The implementation sends an offset one greater than the highest
handled update, limits intake to messages and callback queries, and relies on
the durable update claim when Telegram repeats an unconfirmed update.

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
- [Telegram Bot API](https://core.telegram.org/bots/api) documents `getUpdates`,
  offsets, long-poll timeouts, update limits, allowed update filters, webhook
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
