# Agent Relay

Keep tabs on all your coding agents without keeping every terminal in view.

Agent Relay watches Codex, Claude Code, and Cursor sessions running on your
machine. When an agent finishes a turn, needs an answer, or a supervised process
exits unexpectedly, you get an alert in a dedicated Telegram topic. You can
respond from your phone, and Agent Relay routes the answer back to the right
session.

Each session gets its own topic, so five agents working at once still look like
five separate conversations. There is also a local web board for seeing every
session at a glance.

Agent Relay is local-first: the daemon and its SQLite database run on your
machine. Telegram and the optional WhooshBang service are adapters, not places
where Agent Relay keeps its source of truth.

> **Project status:** Agent Relay is an early alpha and is not published to npm
> yet. Install it from source. The currently tested setup is macOS on Apple
> silicon with Node.js 22 or newer and pnpm 11.

## What you get

- One private Telegram topic for each agent session.
- Clear alerts when an agent stops, asks a question, or has a proven crash.
- Buttons for choices and common actions such as **Continue**, **Details**,
  **Mute**, and **End**.
- Free-text answers routed to the exact request that opened them.
- A local session board at `http://127.0.0.1:4317/ui/`.
- Durable delivery and reply state in SQLite, including retries and visible dead
  letters.
- Native hooks for ordinary use, plus an opt-in supervisor when you need proven
  process exits or late CLI resume.
- Replaceable notification transports. Direct Telegram works without a hosted
  Agent Relay account, and a signed outbound webhook can feed your own tools.

## Get started

### 1. Build Agent Relay

You need Node.js 22 or newer, pnpm 11, and at least one supported coding
harness.

```sh
git clone https://github.com/flowxo/agent-relay.git
cd agent-relay

pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm build
```

The install starts with dependency lifecycle scripts disabled. The contract
preflight checks the vendored packages, then `pnpm rebuild` builds the reviewed
SQLite dependency.

Do not install the unrelated unscoped `agent-relay` package from npm. This
project's future package name is `@flowxo/agent-relay`, but it has not been
published.

### 2. Prove the local loop

Before adding Telegram credentials, run the complete ingest, database, and
delivery path against the built-in fake transport.

In one terminal:

```sh
node apps/relay/dist/cli.js daemon --transport fake --no-web
```

In another:

```sh
node apps/relay/dist/cli.js canary
```

The canary should finish in a durable `delivered` state. Stop the daemon with
`Ctrl-C`.

### 3. Install the harness hooks

Agent Relay can install user-level hooks for all three harnesses. Inspect the
dry run first:

```sh
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer preserves unrelated settings, makes private backups, and owns only
the entries it adds. It may update:

- `~/.codex/hooks.json`
- `~/.claude/settings.json`
- `~/.cursor/hooks.json`

It also creates the launcher at `~/.agent-relay/bin/agent-relay`.

Keep this source checkout in place while those hooks are installed; the launcher
points to the exact build you inspected.

Review newly installed hooks in each harness. In Codex, use `/hooks` and trust
the exact Agent Relay entry. Claude Code and Cursor have their own hook views.

For upgrade, rollback, and removal details, read the
[installation guide](docs/install-upgrade-uninstall.md).

## Connect Telegram

Direct Telegram is the easiest way to use Agent Relay away from your desk. It
uses long polling, so you do not need a public URL or webhook.

You will need:

- a dedicated bot created with
  [BotFather](https://core.telegram.org/bots/features#botfather);
- a private one-to-one chat with that bot;
- **Threaded Mode** enabled for the bot in BotFather; and
- the bot token, private chat ID, and operator user ID.

The [living onboarding guide](docs/onboarding.md) walks through BotFather,
finding the two IDs safely, and checking threaded mode. The shorter
[Telegram guide](docs/telegram.md) is the day-to-day reference.

Create a private, gitignored activation file:

```sh
umask 077
cp .env.example .env.activation
chmod 600 .env.activation
```

Set these values in `.env.activation`:

```dotenv
AGENT_RELAY_TRANSPORT=telegram
AGENT_RELAY_TELEGRAM_TOKEN=<bot token>
AGENT_RELAY_TELEGRAM_CHAT_ID=<private chat id>
AGENT_RELAY_TELEGRAM_OPERATOR_ID=<authorized user id>
AGENT_RELAY_TELEGRAM_UPDATE_MODE=poll
```

Load the file and start the daemon:

```sh
set +x
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay daemon
```

There is no background service installer yet, so leave this terminal running.
The daemon also starts the local web board on `127.0.0.1:4317`.

In a second terminal, load the same environment and run the real round-trip
canary:

```sh
set +x
set -a
. ./.env.activation
set +a

~/.agent-relay/bin/agent-relay telegram-canary --wait-ms 120000
```

Agent Relay creates a Telegram topic and asks for the exact reply
`relay-canary-ok`. When that succeeds, start Codex, Claude Code, or Cursor as
usual. Their installed hooks will send attention events to the daemon.

## Send alerts to your own tools

You do not need to write an Agent Relay adapter package to receive alerts in an
internal dashboard, desktop app, queue, or custom notifier. Select the built-in
outbound webhook and point it at any small HTTP receiver:

```sh
WEBHOOK_SECRET="$(openssl rand -hex 32)"
printf '%s' "$WEBHOOK_SECRET" |
  node apps/relay/dist/cli.js webhook configure \
    --url http://127.0.0.1:4319/agent-relay \
    --secret-stdin

node apps/relay/dist/cli.js transport select webhook
node apps/relay/dist/cli.js daemon
```

In another terminal, run `node apps/relay/dist/cli.js webhook-canary`. Every
delivery is strict JSON with a stable idempotency key and an HMAC-SHA256
signature over the exact request bytes. Loopback HTTP is allowed for local
development; non-loopback receivers require HTTPS.

This transport is outbound only. Questions include a credential-free link to the
exact request on the authenticated local web board. A public inbound response
API is intentionally deferred until its authentication, replay, proxy, and
authorization model has been designed.

The [outbound webhook guide](docs/outbound-webhooks.md) includes the full
payload, a working Node.js receiver, signature verification, acknowledgement
rules, retries, privacy boundaries, and environment-based setup.

## Use it day to day

### Follow sessions in Telegram

The first event from a session creates a topic named with the harness,
repository, optional branch, and a short session suffix. Later events from the
same session return to that topic, even after the daemon restarts.

Structured choices appear as buttons. For a free-text question, type in the
session topic when it has one compatible open request. If several requests are
open in that topic, reply to the specific request card so Agent Relay can tell
which one you mean.

Agent text cannot invent callback actions. Buttons carry opaque local tokens,
and every answer must match the configured chat, operator, topic, request, and
session before it is accepted. If Telegram and the web board race to answer the
same request, the first durable answer wins.

Useful session controls include:

- **Continue** — answer an eligible continuation request.
- **Details** — show a bounded, redacted excerpt.
- **Mute** — hide routine alerts without hiding questions or proven failures.
- **End** — close the Agent Relay lane after its open questions are resolved.

Ending a lane does not kill a process Agent Relay does not own, and it does not
automatically delete the Telegram topic.

### Clean up old topics

Send `/cleanup` to preview topics for sessions that Agent Relay can prove have
ended. Send `/purge`, `/purge 12h`, or `/purge 7d` to preview inactive topics
whose sessions were never explicitly ended. Both commands appear in the bot's
slash-command menu and require button confirmation before Telegram permanently
deletes anything. The older `/prune` spelling remains supported.

You can send either command from Telegram's **New Chat** surface or an existing
topic. Agent Relay posts the preview back where the command arrived. Telegram
does not expose ordinary private-bot read receipts, so the returned card is the
visible acknowledgement.

Cleanup is deliberately conservative. It will not remove a topic with an open
request, active continuation, pending delivery, or newly arrived work. See the
[Telegram cleanup and pruning rules](docs/telegram.md) before relying on it for
retention.

### Use the local web board

Open `http://127.0.0.1:4317/ui/` while the daemon is running. The board shows
running, waiting, crashed, stale, muted, and ended sessions, along with their
open requests and a bounded event timeline.

The daemon creates a private credential file at
`~/.agent-relay/web-credential.json`. Copy its bearer and CSRF values into the
connection form. The page keeps them in memory rather than browser storage.

To explore the UI with synthetic data and no Telegram account:

```sh
node apps/relay/dist/cli.js web-demo
```

The demo runs separately at `http://127.0.0.1:4318/ui/`. Read the
[web companion guide](docs/web-companion.md) for its security model and API.

### Supervise a CLI when exits matter

Installed hooks can prove that a harness emitted a stop or question event. They
cannot prove that its process crashed. If you need exit reporting or want Agent
Relay to resume a CLI after the original process exits, launch it through the
supervisor:

```sh
~/.agent-relay/bin/agent-relay run codex \
  --harness-version 0.145.0 -- exec "work on the task"

~/.agent-relay/bin/agent-relay run claude \
  --harness-version 2.1.219 -- --print "work on the task"

~/.agent-relay/bin/agent-relay run cursor \
  --harness-version 2026.07.23-e383d2b -- --trust "work on the task"
```

Arguments after `--` are passed directly to the harness without a shell. The
supervisor owns the child process, so it can report a non-zero exit or
unexpected signal without guessing. A correlated answer can then start the
harness's official resume command once the original child has exited.

Agent Relay never calls inactivity a crash and does not automatically restart a
silent process. Cursor IDE resume is also unsupported: an IDE stop hook cannot
safely be turned into a new Cursor CLI process.

## How it works

The main loop is intentionally small:

```text
Codex / Claude Code / Cursor
            │
            │ native hook or supervised child
            ▼
      local Agent Relay daemon  ◀──── correlated answer
            │
            ▼
      durable SQLite spool
            │
            ├──── Telegram session topics
            ├──── signed outbound webhook
            ├──── local web board
            └──── hosted WhooshBang (optional)
```

Harness adapters validate native payloads and turn them into one shared,
runtime-validated event protocol. The daemon writes an event before trying to
deliver it. Delivery attempts, retries, requests, answers, callbacks, and
continuation claims all use the same SQLite source of truth.

If the daemon is temporarily unavailable, a hook returns the harness's safe
no-op response and writes a bounded, redacted record to a fallback spool. The
daemon replays it later. Malformed input and exhausted deliveries become
diagnostics or dead letters instead of disappearing silently.

Only the selected transport receives an event. The fake transport remains local,
direct Telegram receives bounded cards, the outbound webhook sends signed
runtime-validated JSON, and the optional hosted WhooshBang adapter receives the
same provider-neutral contract. Agent Relay does not require a hosted account,
public callback, or Cloudflare runtime for local, webhook, or Telegram
operation.

For the deeper design, read
[architecture and threat boundaries](docs/architecture.md). To add another
provider, start with
[extending notification transports](docs/extending-transports.md). To support
another agent surface, see
[extending harness adapters](docs/extending-harnesses.md).

## Compatibility

Agent Relay fails closed when a harness capability is unknown. Exact versions
below are evidence snapshots, not promises that an untested version behaves the
same way. Run `agent-relay doctor` and `agent-relay capabilities` on your
machine.

<!-- BEGIN GENERATED HARNESS SUPPORT -->

| Harness / surface | Exact verified version  | Classification          | Important boundary                                                                                                               |
| ----------------- | ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI         | `codex-cli 0.145.0`     | `verified`              | Stop and read-only late resume are live-proven; crash proof requires supervision.                                                |
| Codex App Server  | `codex-cli 0.145.0`     | `verified`              | The owned stdio driver, durable correlation, and local adoption recovery are exact-version proven behind the default-off bridge. |
| Claude Code CLI   | `2.1.219 (Claude Code)` | `verified`              | Stop and plan-mode late resume are live-proven; structured background-work suppression and StopFailure remain fixture-proven.    |
| Claude Agent SDK  | —                       | `compatible-unverified` | The streaming SDK contract is understood but is not the installed V1 user path.                                                  |
| Cursor CLI        | `2026.07.23-e383d2b`    | `verified`              | Interactive Stop and trusted late resume are live-proven; --print did not emit initial Stop.                                     |
| Cursor IDE        | —                       | `compatible-unverified` | Stop hooks are contract-backed; an IDE session cannot be safely resumed as a new CLI process.                                    |

<!-- END GENERATED HARNESS SUPPORT -->

The current runtime validation target is macOS on Apple silicon with Node.js 22.
Windows, Linux runtime operation, Intel macOS, automatic service installation,
and Cursor IDE late resume are not current support claims. The
[compatibility policy](docs/compatibility.md) explains the classifications, and
the [generated capability matrix](docs/capability-matrix.md) links every claim
to its evidence.

## Privacy and removal

Agent Relay sends no product analytics or remote crash reports. Local state,
outbound fields, retention, and erasure are documented in
[PRIVACY.md](PRIVACY.md).

To remove the installed hooks and launcher while preserving local data:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

Uninstall removes only Agent Relay-owned hook entries, its launcher, and its
manifest. Read the [installation guide](docs/install-upgrade-uninstall.md)
before erasing the retained state directory or provider data.

Never post tokens, transcripts, databases, raw logs, account identifiers, or
machine-specific paths in an issue. Private vulnerability reporting is
documented in [SECURITY.md](SECURITY.md); [SUPPORT.md](SUPPORT.md) explains how
to share safe diagnostics.

## Development

The full local quality gate is:

```sh
pnpm check
```

It runs formatting, governance, documentation, fixture and secret checks,
linting, type checking, tests, compatibility generation checks, contract tests,
and isolated package proofs. No real bot token, transcript, or hosted account is
needed.

Compatibility summaries in this README and `SUPPORT.md` are generated from the
runtime registry. After changing harness evidence, run:

```sh
pnpm capabilities:generate
pnpm capabilities:check
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then use the focused references
for the part you are changing:

- [Package contents and artifact boundary](docs/packaging.md)
- [Prerelease builds and publication](docs/releasing.md)
- [Release-readiness evidence](docs/release-readiness.md)
- [Safe fixtures and evidence](docs/fixtures.md)
- [Hosted WhooshBang boundary](docs/hosted-notifications.md)
- [Experimental runner bridge](docs/runner-bridge.md)
- [Troubleshooting and doctor](docs/troubleshooting.md)

Project history and implementation evidence live in the
[implementation brief](docs/implementation-brief.md),
[progress ledger](docs/progress.md), and
[harness evidence](docs/harness-evidence.md).

## Project policies

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Maintainers and release authority](MAINTAINERS.md)
- [Security policy](SECURITY.md)
- [Privacy](PRIVACY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [MIT license](LICENSE)
