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

> **Alpha release status:**
> [`@flowxo/agent-relay@0.1.0-alpha.2`](https://www.npmjs.com/package/@flowxo/agent-relay/v/0.1.0-alpha.2)
> and its
> [GitHub prerelease](https://github.com/flowxo/agent-relay/releases/tag/v0.1.0-alpha.2)
> are public from immutable tag `v0.1.0-alpha.2` and source commit
> `5649087a5789785737011fab49151287761fb276`. The supported setup is macOS on
> Apple silicon with Node.js 22 or newer; source development uses pnpm 11.

The [V1 release boundary](docs/v1-release-boundary.md) records exact
package/source provenance, lockfile, support, transport/privacy fields, and
known limitations. The repository and security-reporting path are public. The
failed alpha.1 tag and attestations remain immutable evidence. Alpha.2 was not
live-provider tested; publication did not authorize production change,
credential retention, live-provider work, or any later release.

## What you get

- One private Telegram topic for each agent session.
- One [durable shared activity model](docs/session-activity.md) in topic titles,
  Telegram status, and the web board: Working, Needs input, Background work,
  Idle, Done, Failed, Unknown, or Ended. Muting remains independent.
- Clear alerts when an agent stops, asks a question, or has a proven crash.
- Quiet lifecycle updates when a session starts or the operator sends more work,
  so an unattended topic does not look falsely paused.
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

Exactly one transport is selected; fake is the local-only default and there is
no automatic dual-send or failover. Open Source V1 has no hosted dashboard or
team-policy surface.

## Get started

Follow this order so every state-changing step has a credential-free check in
front of it.

### 1. Evaluate or install

You need Node.js 22 or newer, pnpm 11, and at least one supported coding
harness.

Before installing anything, read the
[release-readiness evaluation](docs/release-readiness.md),
[support policy](SUPPORT.md), [privacy policy](PRIVACY.md), and
[known limitations](docs/v1-release-boundary.md#known-limitations-and-accepted-residual).
Install the exact public alpha into a directory you will retain while hooks are
installed. Dependency lifecycle scripts stay disabled until the reviewed native
SQLite dependency is rebuilt explicitly:

```sh
mkdir agent-relay-alpha && cd agent-relay-alpha
npm init -y
npm install --save-exact --ignore-scripts @flowxo/agent-relay@0.1.0-alpha.2
npm rebuild better-sqlite3
./node_modules/.bin/agent-relay --help
./node_modules/.bin/agent-relay --version
./node_modules/.bin/agent-relay capabilities
```

Do not install the unrelated unscoped `agent-relay` package. For a visual
evaluation with no external account, credential, or live provider, build and
start the sanitized concurrent-session demo from source instead:

```sh
git clone https://github.com/flowxo/agent-relay.git
cd agent-relay

pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm build
node apps/relay/dist/cli.js web-demo
```

The install starts with dependency lifecycle scripts disabled. The contract
preflight checks the vendored packages, then `pnpm rebuild` builds the reviewed
SQLite dependency. `web-demo` uses a separate local database and fake transport;
its sessions, topics, project labels, and messages are synthetic. It does not
read your Relay state or include credentials, transcripts, source, usernames,
hostnames, raw paths, private identifiers, or live-provider data.

### 2. Inspect, install, and diagnose

Inspect the complete user-level change before applying it, then diagnose the
result:

```sh
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer preserves unrelated settings, makes private backups, and owns only
the entries it adds. It may update `~/.codex/hooks.json`,
`~/.claude/settings.json`, and `~/.cursor/hooks.json`, and creates the launcher
at `~/.agent-relay/bin/agent-relay`. Keep this source checkout in place while
those hooks are installed; the launcher points to the exact build you inspected.

### 3. Prove the local loop

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

### 4. Choose one transport

Exactly one transport is active. Credentials never select one, and Agent Relay
does not automatically dual-send or fail over.

| Choice       | Account boundary                                                 | Setup                                                |
| ------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `fake`       | No network or account                                            | Already proven above                                 |
| `telegram`   | Your own bot; no hosted Agent Relay account or public server     | [Direct Telegram onboarding](docs/onboarding.md)     |
| `webhook`    | Your own HTTPS receiver                                          | [Signed outbound webhook](docs/outbound-webhooks.md) |
| `whooshbang` | Optional hosted WhooshBang account and narrow machine credential | [WhooshBang onboarding](docs/hosted-whooshbang.md)   |

Select deliberately, then restart the daemon:

```sh
node apps/relay/dist/cli.js transport select telegram
# or: transport select webhook | whooshbang | fake
node apps/relay/dist/cli.js daemon
```

Direct Telegram and WhooshBang are independent choices. You never need a
WhooshBang or other hosted Agent Relay account to use direct Telegram.

### 5. Use a supported harness

Review newly installed hooks in each harness. In Codex, use `/hooks` and trust
the exact Agent Relay entry. Claude Code and Cursor have their own hook views.
Then start Codex, Claude Code, or Cursor normally. Use the optional
[`agent-relay run`](#supervise-a-cli-when-exits-matter) supervisor only when you
need proven process exits or supported late CLI resume.

### 6. Reconcile an upgrade

Stop Relay processes, install the newer reviewed source or artifact, run
`doctor`, inspect `install --dry-run`, apply `install` twice, and require the
second result to be unchanged. Then run `doctor` and the fake canary before
reselecting a live transport. SQLite migrations are forward-only; read the
[upgrade and rollback procedure](docs/install-upgrade-uninstall.md#reconcile-an-upgrade)
and
[candidate rollback boundary](docs/install-upgrade-uninstall.md#roll-back-a-candidate)
before crossing a schema boundary.

### 7. Uninstall owned integration

Remove owned hooks and the launcher before removing the package or source:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

Uninstall preserves unrelated hooks, local state, transport configuration,
private backups, and provider-side records.

### 8. Optionally erase retained data

Erasure is a separate destructive choice. After uninstalling and stopping every
Relay process, inspect and remove only the exact configured state directory,
then handle provider data separately. Follow the bounded
[optional-erasure procedure](docs/install-upgrade-uninstall.md#optional-erasure).

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

~/.agent-relay/bin/agent-relay telegram-canary \
  --wait-ms 120000 \
  --request-ttl-ms 300000
```

Agent Relay creates a Telegram topic and asks for the exact reply
`relay-canary-ok`. The client wait and durable request lifetime are separate;
the request TTL must outlive the wait by at least one minute. A successful
one-card proof also requires the daemon's aggregate event counts to advance by
exactly one delivered event. Run a ceiling-bound live canary from a normal
terminal or an exact hook-denied agent boundary, never from an agent session
that can emit ambient Relay events. When that succeeds, start Codex, Claude
Code, or Cursor as usual. Their installed hooks will send attention events to
the daemon.

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
development; non-loopback receivers require HTTPS. The envelope marks each
delivery as `notify` or `silent`, allowing a receiver to mirror Agent Relay's
attention policy.

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
repository, optional branch, and a short session suffix. A leading emoji follows
the current state without changing that stable identity. Later events from the
same session return to the topic, even after the daemon restarts.

Events that need attention—stops, questions, permission decisions, proven
failures, and stale-process warnings—use ordinary Telegram notifications.
Session starts, submitted prompts, and structured background-work updates are
sent silently. They keep the topic's visible history current without pinging
your phone.

Stop cards show a compact excerpt: up to two lines from the start, an omission
marker, and up to two lines from the end. The waiting state appears after that
excerpt, where the agent actually stopped. The event kind and compact session
identity sit in a quiet footer instead of taking over the top of every card.
Headings and labels use Telegram formatting, while agent text remains literal
and cannot inject markup. Tap **Details** for the bounded long-form text.

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

### Check current status

Send `/status` inside a coding-session topic to see its current SQLite-backed
state, last event, last-seen age, and open-request count. Send it from
Telegram's **New Chat** surface or any non-coding topic to get a compact
monospace table of all open session topics. The command is installed in the
bot's slash-command menu.

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
the canonical eight session-activity states, last activity, and independent mute
status, along with open requests and a bounded event timeline. The authenticated
API also exposes confidence and bounded reason/source fields.

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
  --harness-version "$(codex --version)" -- exec "work on the task"

~/.agent-relay/bin/agent-relay run claude \
  --harness-version "$(claude --version)" -- --print "work on the task"

CURSOR_AGENT_EXACT="/absolute/path/to/approved/cursor-agent"
~/.agent-relay/bin/agent-relay run cursor \
  --harness-version "$("$CURSOR_AGENT_EXACT" --version)" \
  --executable "$CURSOR_AGENT_EXACT" \
  --cwd "$PWD" \
  -- --mode plan --sandbox enabled --trust --workspace "$PWD" -- \
  "work on the task"
```

Arguments after `--` are passed directly to the harness without a shell. The
supervisor owns the child process, so it can report a non-zero exit or
unexpected signal without guessing. A correlated answer can then start the
harness's official resume command once the original child has exited.

Cursor late resume reuses the exact initial executable and reconstructs only the
allowlisted mode, sandbox, workspace, additional directories, trust, and force
context. Keep the second `--` before the prompt; prompt text and unrelated
credential, endpoint, model, plugin, and MCP arguments are never copied into the
resume invocation. Use an immutable versioned executable or a fail-closed
version-checking wrapper; a mutable `command -v` launcher is not exact-artifact
proof.

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
| Codex CLI         | `codex-cli 0.145.0`     | `verified`              | Stop and read-only late resume are live-proven; privacy-safe session and prompt lifecycle cards are fixture-proven.              |
| Codex App Server  | `codex-cli 0.145.0`     | `verified`              | The owned stdio driver, durable correlation, and local adoption recovery are exact-version proven behind the default-off bridge. |
| Claude Code CLI   | `2.1.219 (Claude Code)` | `verified`              | Stop and plan-mode late resume are live-proven; quiet lifecycle, structured background work, and StopFailure are fixture-proven. |
| Claude Agent SDK  | —                       | `compatible-unverified` | The streaming SDK contract is understood but is not the installed V1 user path.                                                  |
| Cursor CLI        | `2026.07.23-e383d2b`    | `verified`              | Interactive Stop and trusted late resume are live-proven; --print did not emit initial Stop.                                     |
| Cursor IDE        | —                       | `compatible-unverified` | Stop hooks are contract-backed; an IDE session cannot be safely resumed as a new CLI process.                                    |

Supported runtime: macOS on Apple silicon with native arm64 Node or x64 Node
through Rosetta, Node.js 22 or newer; native release-exit is green on exact
Node.js 22.23.1 with Codex CLI 0.145.0. Not claimed: Windows, Linux end-user
runtime, Intel macOS, Cursor IDE late resume, native-hook crash proof, Cursor
permission automation.
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
- [Non-implementer public release walkthrough](docs/public-release-walkthrough.md)
- [Frozen V1 support, privacy, and provenance boundary](docs/v1-release-boundary.md)
- [Curated prerelease notes](packaging/release-notes.md)
- [Safe fixtures and evidence](docs/fixtures.md)
- [Hosted WhooshBang boundary](docs/hosted-whooshbang.md)
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
