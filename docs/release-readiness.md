# Release-readiness evaluation

This is the shortest complete review path for a developer who did not implement
Agent Relay. It answers what runs, what leaves the machine, what installation
changes, how to diagnose the result, and how to remove it before asking anyone
to trust or operate the public prerelease.

The supported V1 runtime is macOS on Apple silicon with Node.js 22 or newer; the
native arm64 release-exit target is exactly Node.js 22.23.1. Intel macOS,
Windows, Linux end-user operation, and stable publication remain unclaimed. The
complete frozen boundary is in [the V1 release record](v1-release-boundary.md).

## What runs locally

Agent Relay is one local CLI and daemon. Native harness hooks send bounded event
envelopes to its loopback API. SQLite is the durable authority for delivery,
questions, answers, session correlation, and resume ownership. The optional web
companion binds to loopback and requires its generated credential. Harness
continuation remains a local child-process action.

The fake transport exercises ingestion, SQLite, delivery, and diagnosis without
a remote account. Direct Telegram, outbound webhook, and WhooshBang are explicit
selectable transports behind the same local interface. Credential presence does
not silently select one, and the daemon never dual-sends or fails over to a
different transport automatically.

There is no default telemetry, Cloudflare runtime, hosted database, remote
execution authority, or server-side transcript store.

## What leaves the machine

With the fake transport, no notification payload leaves the machine. With direct
Telegram enabled, Agent Relay sends only the bounded rendered notification and
Telegram routing metadata described in [the Telegram guide](telegram.md). It
does not send raw hook payloads, full transcripts, environment variables,
credentials, local database contents, or source files.

The local web companion does not leave loopback. An explicitly selected
WhooshBang transport sends the configured subscriber, optional notifier, bounded
rendered title and text, opaque event correlation, and a supported interaction
with its expiry. An explicitly selected webhook sends the strict signed envelope
documented in [the webhook guide](outbound-webhooks.md). Neither transport
receives raw hooks, full transcripts, credentials, source files, or local
database contents.

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
The current SQLite schema is `11`; migrations are forward-only and a newer
schema fails closed as an unsafe downgrade.

## Verify the exact release

Ordinary feature work uses `pnpm check` and `pnpm check:pr`; it does not run the
following release matrix. Deliberately dispatch **Release candidate
qualification** on the exact candidate SHA. Its authoritative command is:

```sh
pnpm check:release
```

That single phase includes the complete quality, browser, package, hosted,
lifecycle, reproducibility, clean-home evidence, dependency-audit, security, and
pinned native Apple-silicon/Node release-exit suite and emits immutable reusable
evidence. After publication, validate the public registry artifact when
required:

```sh
pnpm release:validate:public
```

`pnpm release:exit` does not publish, tag, edit the real user home, or forward
credential environment variables. It:

1. requires a clean git tree and verifies the six-file bundle from the immutable
   release tag, while recording the current runner commit separately;
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
8. runs version, help, capabilities, install dry-run, install, unchanged
   reinstall, healthy doctor, and one clean fake delivery;
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
create signed GitHub provenance. The publication workflow consumes the
qualification artifact and must succeed before a release claims GitHub
build/SBOM attestations; it does not repeat qualification.

## Recorded release evidence

Native release-exit is **green**. On macOS Apple silicon it used official native
Node.js `22.23.1` and an isolated exact arm64 Codex CLI `0.145.0` harness. It
proved artifact identity, help, version, capabilities, dry-run, install,
idempotent reinstall, healthy doctor, one clean fake delivery, owned uninstall,
retained SQLite, and package removal with credentials omitted and hooks denied.
The public-registry mode independently downloaded and byte-matched the npm
tarball to SHA-256
`d3f5e6dbf33755d7630bd1884ed1ee8286055c0c129e23ddd139e1617875a0c7`, then
repeated the same native lifecycle. No live-provider traffic was run or
credited.

AR3 approved hosted dogfood and reliability exit evidence as
`go with named residuals`; required repository checks and browser E2E passed on
PR #40 and PR #41 reviewed heads and their merge commits. No Critical or High
Agent Relay boundary finding remains open.

The exact retained live-reviewed `@flowxo/agent-relay@0.1.0-alpha.1` tarball has
SHA-256 `654d6137233088905824f7960538b4d2e5911b9d100dcd1b825f79a15d84b198`. It
came from PR #39 and does **not** contain PR #40, PR #41, or PR #42. PR #40
source separately passed credential-free packed proof with ephemeral package
SHA-256 `8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543`; that
package was neither retained nor live-tested. PR #41's separate clean-commit
credential-free release-bundle proof has SHA-256
`3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106`, 277,069
bytes, 11 packed files, and six SPDX packages; it was not live-tested. The
current frozen PR #41 merge is `0adb7288483df331fbaaefb9b392ee2f4f3c7d84`. See
the [V1 release record](v1-release-boundary.md) for exact heads and merges. The
completed onboarding predecessor is PR #42, reviewed head
`52f04958bc6f3b838ff080eb8bc9111ac7e6f338`, merge
`c44ef5d38c3caa6ce2e6fa86c45976dfcb6f5f2a`.

FXO-1164 made the repository public, enabled the available GitHub security
controls, protected the prerelease environment, and created immutable tag
`v0.1.0-alpha.1` on exact commit `cda92d179e76c00eac848a3d496fa298115cce45`. The
protected tagged run passed the repository, browser, audit, bundle, upload, and
build/SBOM attestation jobs, but publication stopped because the Linux artifact
SHA-256 differed from the authorized macOS artifact SHA-256. Their extracted
bytes and uncompressed tar stream were identical; only gzip header offset 9 (the
tenth byte) differed. No npm package or GitHub release was created. The tag,
run, and attestations remain immutable failed-publication evidence.

## How to diagnose

Run these from the retained installed prefix:

```sh
agent-relay --version
agent-relay capabilities
agent-relay doctor
agent-relay status
```

`doctor` checks the V1 operating-system, architecture, and Node boundary;
SQLite; all three harness observations; safe evidence IDs; the capability
registry; installed hook version stamps; install manifest; exact launcher;
runtime entry and Node target; and owned hook counts. An exact recorded harness
version is `verified`; newer or different available versions are
`compatible-unverified` warnings unless explicitly known incompatible. A missing
unused harness warns, no usable harness fails, and a known-incompatible
installed harness fails.

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

Uninstall removes only the marked hook entries and official skill files,
launcher, and install manifest. It deliberately retains SQLite, the web
credential, diagnostics, and backups. Follow
[optional erasure](install-upgrade-uninstall.md#optional-erasure) only after
inspecting those retained files.

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

## Frozen limitations and publication boundary

Cursor IDE late resume is unsupported, Cursor permission automation remains
disabled, and native hooks cannot prove a process crash. Telegram delivery is at
least once across its acknowledgement ambiguity window. There is no automatic
dual-send, hosted dashboard, or team-policy surface.

Accepted Low residual: automation cannot prove that the invoking shell or GUI
session launched with every ambient hook disabled. Exact hook-denied isolation
and aggregate attribution mitigate this limitation, and contaminated windows
fail closed. No live-card authorization carries forward.

The immutable `v0.1.0-alpha.1` tag records the stopped cross-platform digest
attempt and must not move. FXO-1568 still approves MIT and the shipped notices
for the exact bundled WhooshBang contracts rc.12 and SDK rc.13 artifacts.
FXO-1574 advanced the corrected source to `0.1.0-alpha.2`, canonicalized the
gzip operating-system byte, and recorded a renewed go for one bounded FXO-1164
publication. FXO-1164 completed from exact source commit
`5649087a5789785737011fab49151287761fb276`; the tag, npm artifact, GitHub
prerelease, checksums, SBOM, and attestations are public and immutable. The npm
trusted publisher is configured and every later publication must use OIDC.

Native release-exit is green. The accepted Low ambient hook-isolation residual
remains explicit and uncredited. No production change, central workspace
release, live-provider traffic, credential retention, live card, registry
mutation, or broader publication is authorized.
