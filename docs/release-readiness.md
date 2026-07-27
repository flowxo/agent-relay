# Release-readiness evaluation

This is the shortest complete review path for a developer who did not implement
Agent Relay. It answers what runs, what leaves the machine, what installation
changes, how to diagnose the result, and how to remove it before asking anyone
to trust or publish the prerelease.

The current target is macOS on Apple silicon with native arm64 Node.js 22.23.1.
Intel macOS, Windows, Linux end-user operation, and stable publication remain
unclaimed.

## What runs locally

Agent Relay is one local CLI and daemon. Native harness hooks send bounded event
envelopes to its loopback API. SQLite is the durable authority for delivery,
questions, answers, session correlation, and resume ownership. The optional web
companion binds to loopback and requires its generated credential. Harness
continuation remains a local child-process action.

The fake transport exercises ingestion, SQLite, delivery, and diagnosis without
a Telegram or hosted account. Direct Telegram and future Notifications support
are explicit transports behind the same local interface; credential presence
does not silently select one.

There is no default telemetry, Cloudflare runtime, hosted database, remote
execution authority, or server-side transcript store.

## What leaves the machine

With the fake transport, no notification payload leaves the machine. With direct
Telegram enabled, Agent Relay sends only the bounded rendered notification and
Telegram routing metadata described in [the Telegram guide](telegram.md). It
does not send raw hook payloads, full transcripts, environment variables,
credentials, local database contents, or source files.

The local web companion does not leave loopback. A future explicitly selected
Notifications transport may send its documented bounded contract fields, but it
is not selected by the V1 daemon.

Package installation contacts the configured npm registry for the two exact
direct runtime dependencies and their frozen transitive closure. The release
exit command additionally downloads the exact official Node archive named in
`packaging/release-exit.json`. It checks that archive against the pinned SHA-256
from Node's versioned checksum manifest before execution.

## What installation changes

`agent-relay install --dry-run` reports changes without writing. Installation
creates a private owned launcher and manifest under `~/.agent-relay`, then adds
marked entries to:

- `~/.codex/hooks.json`;
- `~/.claude/settings.json`; and
- `~/.cursor/hooks.json`.

Existing settings and hooks are preserved, and changed configuration files
receive private backups. SQLite state, the local web credential, retained logs,
and those backups are data, not package-manager files.

The package itself can live in any retained local prefix. The launcher records
the exact package entry and Node executable, so moving or removing that prefix
without running Agent Relay's uninstall first makes doctor report a mismatch.

## Verify the exact candidate

From a clean checkout with the frozen dependencies already installed:

```sh
pnpm check
pnpm test:e2e
pnpm audit --prod
pnpm release:bundle
pnpm release:bundle:verify
pnpm release:exit
```

`pnpm release:exit` does not publish, tag, edit the real user home, or forward
credential environment variables. It:

1. requires a clean git tree and a four-file bundle bound to `HEAD`;
2. verifies the artifact, checksums, exact commit, SPDX file inventory, and
   runtime dependency records;
3. downloads or reuses the exact hash-verified Node.js 22.23.1 native arm64
   archive;
4. creates a quoted temporary home and npm prefix;
5. installs the tarball with lifecycle scripts disabled and explicitly rebuilds
   only `better-sqlite3` under native arm64 Node;
6. proves the package is copied, not a globally linked workspace package;
7. exposes the three locally installed harness executables through temporary
   aliases and requires doctor to tie each observation to its recorded evidence
   ID, with at least one exact verified version;
8. runs install dry-run, install, unchanged reinstall, healthy doctor, and one
   clean fake delivery;
9. runs uninstall dry-run and owned uninstall, retaining SQLite while removing
   every owned hook and launcher; and
10. removes the package from the isolated prefix.

The path-free result is written with mode `0600` to:

```text
.artifacts/release-exit/agent-relay-release-exit.json
```

That ignored record contains safe versions, hashes, evidence IDs, counts, and
boolean lifecycle outcomes. It rejects private paths, credentials, question,
answer, summary, and transcript fields. The runtime archive cache is also under
ignored `.artifacts/` and is hash-checked on every use.

This local proof can validate checksums and native execution, but it cannot
create signed GitHub provenance. The separate tagged workflow must succeed
before a release claims GitHub build/SBOM attestations.

## Recorded local evidence

The matrix completed on 2026-07-26 on macOS 26.5.2 with the official Node.js
22.23.1 `darwin/arm64` runtime and its bundled npm 10.9.8. The exact private
alpha artifact contained 11 files; its SPDX record contained the application
plus three runtime packages.

Doctor observed exact verified Codex `0.145.0` and Cursor `2026.07.23-e383d2b`
records. Installed Claude Code `2.1.220` correctly remained
`compatible-unverified` against the last live-proven `2.1.219` record rather
than silently widening support.

The clean-home install, native SQLite load/query, unchanged reinstall, healthy
doctor, one delivered fake event with zero retries/dead letters, owned
uninstall, retained SQLite, package removal, zero remaining owned hooks, and
mode-`0600` path-free evidence record all passed. Publication and signed
provenance were not attempted.

## How to diagnose

Run these from the retained installed prefix:

```sh
agent-relay --version
agent-relay capabilities
agent-relay doctor
agent-relay status
```

`doctor` checks SQLite, all three harness observations, safe evidence IDs, the
capability registry, install manifest, exact launcher, runtime entry and Node
target, and owned hook counts. An exact recorded harness version is `verified`;
newer or different available versions are `compatible-unverified` warnings
unless explicitly known incompatible. Missing or known-incompatible harnesses
fail.

Use diagnostic IDs and the redacted capability/doctor records when asking for
support. Do not attach the SQLite database, relay logs, hook configuration,
activation file, Telegram messages, transcripts, credentials, identities, or
machine paths.

## How to remove

Run Agent Relay's ownership-aware removal before removing the package:

```sh
agent-relay uninstall --dry-run
agent-relay uninstall
```

Then remove `@flowxo/agent-relay` with the package manager that owns its
retained prefix. Package-manager removal alone cannot safely edit harness
configuration.

Uninstall removes only the marked hook entries, launcher, and install manifest.
It deliberately retains SQLite, the web credential, diagnostics, and backups.
Follow [optional erasure](install-upgrade-uninstall.md#optional-erasure) only
after inspecting those retained files.

## Non-implementer walkthrough

An evaluator should be able to answer these without reading source:

| Question                                     | Answer location                                           |
| -------------------------------------------- | --------------------------------------------------------- |
| What process and durable state run locally?  | [What runs locally](#what-runs-locally)                   |
| What data can cross the network?             | [What leaves the machine](#what-leaves-the-machine)       |
| Which files and settings change?             | [What installation changes](#what-installation-changes)   |
| How is the exact artifact proven?            | [Verify the exact candidate](#verify-the-exact-candidate) |
| How are drift and failures diagnosed?        | [How to diagnose](#how-to-diagnose)                       |
| How are hooks removed without erasing state? | [How to remove](#how-to-remove)                           |

The walkthrough is incomplete if any answer depends on a private credential,
unrecorded maintainer memory, a repository path, or a hosted Flow XO account.

## AR2 handoff

AR2 adds the optional FlowXO Notifications adapter through the existing
`NotificationTransport` boundary. It does not need a new event protocol, answer
authority, continuation mechanism, SQLite authority model, installer, or package
topology. The pinned C0 transport contract and executable mock already pass
independently in this repository; AR2 still owns production-shaped selection,
narrow credentials, polling, diagnosis, and packing its adapter into a later
candidate.

The current artifact proves the safe local baseline and does not claim that the
AR2 adapter is already a selectable production transport.
