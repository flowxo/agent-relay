# Agent Relay 0.1.0-alpha.3 release candidate

> **Candidate status:** publication is blocked. The alpha.2 authorization was
> consumed and does not carry to alpha.3. These notes authorize no registry,
> tag, release, production, live-provider, or vendor-directory action. The
> published alpha.2 artifacts and stopped alpha.1 evidence remain immutable.

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. It keeps SQLite authoritative on the
developer's machine and supports direct Telegram without a hosted account. A
signed outbound webhook and WhooshBang are optional, explicitly selected
transports.

## Start here

Follow the public journey in the repository README:

1. evaluate the support, privacy, and known-limit boundary;
2. inspect `integrations install --dry-run`, install the owned vendor bundles,
   complete native activation and trust, and run `doctor`;
3. prove one local delivery with the fake transport;
4. choose exactly one transport;
5. use a supported harness;
6. reconcile upgrades before restarting the daemon; and
7. uninstall native snapshots and owned bundles before package removal, with
   optional local erasure as a separate destructive step.

The credential-free `web-demo` shows four concurrent bounded synthetic sessions
using a separate SQLite database and fake transport. It contains no external
credential, live-provider data, private transcript, source code, username,
hostname, repository identity, or machine-specific path.

## User-visible capabilities

- Durable local delivery, retry, dead-letter, request, answer, and continuation
  authority in SQLite.
- Per-session Telegram topics, bounded cards, structured interactions, exact
  reply correlation, and supervised CLI continuation on supported surfaces.
- A loopback-only authenticated web board for concurrent session triage.
- One durable eight-state session-activity record shared by Telegram and the web
  board, with confidence, bounded reasons, server-clock timing, and mute kept
  independent.
- Explicit fake, direct Telegram, signed outbound webhook, or WhooshBang
  transport selection, with no automatic dual-send or failover.
- Recoverable vendor-plugin installation, upgrade, drift repair, disable,
  rollback, ownership-aware uninstall, and optional post-uninstall erasure.

## Support evidence

The supported V1 runtime is macOS on Apple silicon with Node.js 22 or newer. The
native release-exit target is exact arm64 Node.js 22.23.1. The frozen harness
snapshots are Codex CLI `codex-cli 0.145.0`, Claude Code CLI
`2.1.219 (Claude Code)`, and Cursor CLI `2026.07.23-e383d2b`. Run
`agent-relay doctor` and `agent-relay capabilities`; a different installed
harness version is `compatible-unverified`, not silently supported.

The source candidate is evaluated with credential-free package, hosted,
lifecycle, contract, and browser proof. Publication remains blocked regardless
of local verification status.

## Configuration, installer, schema, and privacy changes

- The release candidate identity is `@flowxo/agent-relay@0.1.0-alpha.3`.
- Release packing canonicalizes the gzip operating-system byte to `255` before
  comparing final compressed bytes. Noncanonical bundles fail verification.
- Development-only `brace-expansion`, `fast-uri`, and `postcss` are pinned to
  patched versions after the public dependency scan and audit refresh; none
  enters the shipped runtime graph.
- The hosted transport identifier is `whooshbang`; stale `notifications`
  selection fails closed and requires an explicit reconnect and reselection.
- Existing WhooshBang connections must reconnect after the exact contract pin
  changes to contracts rc.12 / SDK rc.13 / mock rc.15.
- Install manifests record the package version and launcher target. Re-running
  install reconciles only owned entries and preserves unrelated harness config.
- SQLite migrates forward automatically through schema 10. An older binary
  refuses a newer schema; do not edit `user_version` to force a downgrade.
- Agent Relay has no product analytics, usage telemetry, or remote crash-report
  service. Transport-specific bounded fields, local retention, and provider-side
  erasure responsibilities are documented in `PRIVACY.md`.
- Cursor permission automation is disabled and the installer does not add a
  Cursor permission hook.

## Upgrade and rollback

Stop Agent Relay processes, install the exact newer artifact with dependency
scripts disabled, explicitly rebuild the reviewed SQLite dependency, run
`doctor`, inspect and apply `integrations upgrade --dry-run` /
`integrations upgrade`, require a following `integrations install` to be
unchanged, then run the fake canary before reselecting a real transport.

SQLite migrations are forward-only. Roll back only when the older binary
explicitly supports the database schema or after restoring a reviewed private
backup. A normal bad prerelease is deprecated rather than deleted or
unpublished; its tag and semantic version are never moved or reused. A fixed
artifact receives a new version. Suspected compromise stops promotion and uses
the private vulnerability-reporting path.

## Known limitations and publication gates

- Cursor IDE late resume is unsupported; Cursor permission automation remains
  disabled.
- Native hooks cannot prove process crashes; supervised ownership is required.
- Telegram delivery is at least once across its acknowledgement ambiguity
  window.
- Windows, Linux, and Intel macOS end-user runtimes are not claimed.
- There is no automatic dual-send, transport failover, hosted dashboard, or
  team-policy surface.
- The accepted Low residual remains: automation cannot prove that every ambient
  hook was disabled in the invoking shell or GUI. Exact hook-denied isolation
  and aggregate attribution mitigate it; contaminated windows fail closed.
- FXO-1568 approves MIT and `Copyright (c) 2026 Flow XO, LLC` for the exact
  bundled WhooshBang contracts rc.12 and SDK rc.13 artifacts. Different
  versions, source commits, or archive digests require a new review.
- Alpha.3 publication is blocked. FXO-1574 approved one bounded FXO-1164
  publication for alpha.2; that execution is complete and consumed. No approval
  carries to this candidate.

## Exact artifact and provenance boundary

`pnpm release:bundle` creates the npm tarball, SPDX SBOM, package-content
snapshot, these release notes, source manifest, and `SHA256SUMS` from one clean
commit. The manifest records whether the intended tag actually points at that
commit. A local build is unsigned evidence; only the separately authorized
tagged GitHub workflow can create signed build and SBOM attestations.

`pnpm release:evidence` can verify an exact clean bundle and record a sanitized
clean-home fake-canary result. It never forwards provider credentials or
contacts a live provider. That evidence does not authorize publication.

The alpha.1 failed-publication tag and the published alpha.2 package, tag,
release, checksums, SBOM, and attestations remain immutable. Alpha.3 uses a new
semantic version precisely because an immutable published version cannot be
moved, replaced, or reused. Any future alpha.3 publication needs a separate
owner decision, exact final commit, regenerated digests, protected workflow, and
OIDC verification.
