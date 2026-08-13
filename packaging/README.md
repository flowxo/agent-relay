# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. This package contains the supported
`agent-relay` command-line application; it does not expose a public JavaScript
library API.

> This is the unpublished `0.1.0-alpha.2` correction candidate. FXO-1574
> approved one bounded future FXO-1164 publication with the exact bundled
> WhooshBang MIT licenses/notices and named non-blocking residuals. The staged
> artifact is registry-eligible; the workspace root remains private to prevent
> accidental publication.

The immutable `v0.1.0-alpha.1` tag exposed a one-byte cross-platform gzip-header
digest mismatch before npm or GitHub release publication. It and its
attestations remain preserved failed-publication evidence. Consult the release
manifest for the alpha.2 build-time tag state. No alpha.2 tag or publication is
claimed by this source text. FXO-1164 may create and publish only the exact
post-merge candidate and regenerated digests recorded in FXO-1574.

## Supported target

- macOS on Apple silicon
- Node.js 22 or newer

The native release-exit target is exact Node.js 22.23.1. That gate is **not
green**: it reached the arm64 Node target and then failed closed because no
installed harness matched an exact frozen verified snapshot. Windows, Linux, and
Intel macOS end-user runtimes are not claimed.

## Safe onboarding order

1. Evaluate the repository's release-readiness, support, privacy, and known
   limitations; run the sanitized `web-demo` if useful.
2. Inspect `agent-relay install --dry-run`, apply `agent-relay install`, and run
   `agent-relay doctor`.
3. Start the fake transport and require one durable fake canary delivery.
4. Explicitly choose fake, direct Telegram, signed webhook, or WhooshBang.
   Direct Telegram uses your own bot and needs no hosted Agent Relay account or
   public server; WhooshBang remains optional.
5. Start a supported harness normally or use `agent-relay run` when supervised
   exit evidence is required.
6. Reconcile upgrades with dry-run, owned install, an unchanged second install,
   doctor, and fake canary. SQLite migrations are forward-only; use an older
   binary only with an explicitly supported schema or a reviewed backup.
7. Run owned uninstall before package removal. Erase the exact retained state
   directory only as a separate, optional destructive action.

Start with the credential-free local proof:

```sh
agent-relay --help
agent-relay --version
agent-relay capabilities
agent-relay daemon --transport fake --no-web
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
PR #39 and does not contain PR #40 or PR #41; PR #40 source passed a separate
ephemeral packed proof that was not retained or live-tested. PR #41's distinct
credential-free release bundle has SHA-256
`3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106`, 277,069
bytes, 11 packed files, and six SPDX packages; it was not live-tested. The
current frozen source after FXO-1161 is PR #41 merge
`0adb7288483df331fbaaefb9b392ee2f4f3c7d84`. The repository's V1 release record
freezes the exact commits and SHA-256 values. No live authorization carries
forward.

Before changing user-level harness configuration, inspect the exact plan:

```sh
agent-relay install --dry-run
agent-relay install
agent-relay doctor
```

Install also renders the reviewed `agent-relay` skill at the standard user skill
location for Codex, Claude Code, and Cursor. It teaches agents to use only the
exact `agent-relay-mcp.v1` surface for bounded product or workflow questions and
to preserve every native permission and authorization path. Doctor reports skill
presence, compatibility, and deterministic drift without dumping its contents.
Other skills, instruction files, MCP servers, hooks, and settings are preserved.

Uninstall owned hooks, official skills, and the launcher before removing the
package:

```sh
agent-relay uninstall --dry-run
agent-relay uninstall
```

Uninstall preserves local state, logs, credentials, backups, unrelated skills
and instructions, MCP servers, and harness settings by default.

Full documentation, support boundaries, security reporting, privacy behavior,
and source are maintained at
[github.com/flowxo/agent-relay](https://github.com/flowxo/agent-relay). Do not
install the unrelated unscoped `agent-relay` package from npm.
