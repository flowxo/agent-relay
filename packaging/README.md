# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. This package contains the supported
`agent-relay` command-line application; it does not expose a public JavaScript
library API.

> This is the unpublished `0.1.0-alpha.1` candidate. The package remains marked
> `private` while the checked-in owner publication approval is false. The Flow
> XO npm scope, public repository, protected environment, trusted publisher, and
> first prerelease still require explicit approval.

The intended `v0.1.0-alpha.1` tag has not been created. Tagging and publication
are separate owner-authorized actions. Public distribution is also blocked until
the bundled WhooshBang contracts and SDK receive an owner-approved distributable
license and notice decision.

## Supported target

- macOS on Apple silicon
- Node.js 22 or newer

Native release-exit evidence uses exact Node.js 22.23.1. Windows, Linux, and
Intel macOS end-user runtimes are not claimed.

Start with the credential-free local proof:

```sh
agent-relay --help
agent-relay --version
agent-relay capabilities
agent-relay daemon
```

In another terminal:

```sh
agent-relay canary
agent-relay status
```

The daemon should report the `fake-telegram` transport and the canary should
report one durable delivery with no retry or dead letter. No hosted service or
Telegram credential is required. The capability record is safe to inspect and
contains classifications, exact verified versions, and evidence IDs without
transcripts or machine paths.

## Choose one transport explicitly

Agent Relay supports four exclusive transport choices: `fake`, direct
`telegram`, signed outbound `webhook`, and hosted `whooshbang`. Credentials
affect readiness but never select a transport. There is no dual send or
automatic failover.

```sh
agent-relay transport status
agent-relay transport select fake
agent-relay transport select telegram
agent-relay transport select webhook
agent-relay transport select whooshbang
```

Restart the daemon after changing the durable selection. Switching transports
retains the local SQLite spool, pending requests, answers, and continuation
authority. To fall back during a provider incident, explicitly select `fake` or
`telegram`; Agent Relay will not send an event to a second provider
automatically.

## Known limitations

Cursor IDE late resume is unsupported, Cursor permission automation is disabled,
and native hooks cannot prove process crashes without supervised ownership.
Telegram delivery is at least once across its documented acknowledgement
ambiguity window. Open Source V1 has no hosted dashboard or team-policy surface.

Accepted Low residual: automation cannot prove that the invoking shell or GUI
session launched with every ambient hook disabled. Exact hook-denied isolation
and aggregate attribution mitigate it; contaminated windows fail closed.

For a custom receiver, configure the shared secret through stdin, select the
webhook, restart, and run its canary:

```sh
printf '%s' "$AGENT_RELAY_RECEIVER_SECRET" |
  agent-relay webhook configure \
    --url https://alerts.example.test/agent-relay \
    --secret-stdin
agent-relay transport select webhook
agent-relay daemon
agent-relay webhook-canary
```

The receiver gets one strict `agent-relay-webhook.v1` JSON envelope with a
stable idempotency key, safe routing metadata, and an exact-byte HMAC-SHA256
signature. It does not get a remote-control API. See the repository's outbound
webhook guide for verification, acknowledgement, retry, and privacy details.

Direct Telegram remains independent of the hosted service. It uses the
operator's own bot and the setup documented in the repository. Browser OAuth/MCP
is the default WhooshBang onboarding path and retains only the resulting narrow
machine bearer in a separate private mode-`0600` file. Legacy operator
automation may instead supply the broad project bootstrap credential only from
stdin, environment injection, or a hidden prompt:

```sh
credential_command | agent-relay whooshbang connect \
  --credential-stdin \
  --base-url https://whooshbang.example.test \
  --subscriber-id configured_subscriber \
  --notifier-id default
agent-relay whooshbang status
agent-relay transport select whooshbang
```

The provider receives only a bounded attention card and, when applicable, one
confirm, single-select, or free-text question with safe option labels and opaque
values. Raw hooks, full transcripts, repository contents, tool input, executable
commands, process arguments, absolute paths, machine credentials, and resume
authority do not cross the transport boundary.

Use `agent-relay status`, `agent-relay doctor`, and
`agent-relay whooshbang status` for safe diagnosis. They expose stable codes,
counts, capability state, and hashed references—not credentials, full provider
identifiers, prompts, answers, transcripts, or raw session identities.

Disconnect is local and reversible by default. For complete removal, first
revoke the hosted machine credential with a newly supplied project credential,
then explicitly erase its local narrow credential and configuration:

```sh
credential_command | agent-relay whooshbang disconnect \
  --revoke \
  --erase-credential \
  --erase-configuration \
  --credential-stdin
```

This operation and package uninstall retain SQLite state. After an interrupted
daemon, restart with the same selected transport to recover durable delivery,
poll, and acknowledgement work. After a disconnect or rotation, reconnect and
restart explicitly. The exact mock-based packed proof remains credential-free.
AR3 separately approved bounded hosted dogfood and reliability exit as
`go with named residuals`. The retained live-reviewed alpha.1 tarball came from
PR #39 and does not contain PR #40; PR #40 source passed a separate ephemeral
packed proof that was not retained or live-tested. The repository's V1 release
record freezes the exact commits and SHA-256 values. No live authorization
carries forward.

Before changing user-level harness configuration, inspect the exact plan:

```sh
agent-relay install --dry-run
agent-relay install
agent-relay doctor
```

Uninstall owned hooks and the launcher before removing the package:

```sh
agent-relay uninstall --dry-run
agent-relay uninstall
```

Uninstall preserves local state, logs, credentials, backups, and unrelated
harness settings by default.

Full documentation, support boundaries, security reporting, privacy behavior,
and source are maintained at
[github.com/flowxo/agent-relay](https://github.com/flowxo/agent-relay). Do not
install the unrelated unscoped `agent-relay` package from npm.
