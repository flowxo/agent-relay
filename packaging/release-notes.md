# Agent Relay 0.1.0-alpha.2 release candidate

> **Candidate status:** FXO-1574 requires renewed exact-candidate approval
> before FXO-1164 publication can resume. Consult the generated manifest's
> build-time `tagStatus`; these notes do not claim that the alpha.2 tag, npm
> package, or GitHub prerelease exists. The repository is public, while the
> immutable alpha.1 tag and attestations remain stopped-publication evidence.

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. It keeps SQLite authoritative on the
developer's machine and supports direct Telegram without a hosted account. A
signed outbound webhook and WhooshBang are optional, explicitly selected
transports.

## Start here

Follow the public journey in the repository README:

1. evaluate the support, privacy, and known-limit boundary;
2. inspect `install --dry-run`, install the owned hooks, and run `doctor`;
3. prove one local delivery with the fake transport;
4. choose exactly one transport;
5. use a supported harness;
6. reconcile upgrades before restarting the daemon; and
7. uninstall owned hooks before package removal, with optional local erasure as
   a separate destructive step.

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
- Explicit fake, direct Telegram, signed outbound webhook, or WhooshBang
  transport selection, with no automatic dual-send or failover.
- Transactional hook installation, reconciliation, diagnosis, ownership-aware
  uninstall, and optional post-uninstall erasure.

## Support evidence

The supported V1 runtime is macOS on Apple silicon with Node.js 22 or newer. The
native release-exit target is exact arm64 Node.js 22.23.1. The frozen harness
snapshots are Codex CLI `codex-cli 0.145.0`, Claude Code CLI
`2.1.219 (Claude Code)`, and Cursor CLI `2026.07.23-e383d2b`. Run
`agent-relay doctor` and `agent-relay capabilities`; a different installed
harness version is `compatible-unverified`, not silently supported.

The current clean source candidate has credential-free package, hosted,
lifecycle, contract, and browser proof. Native release-exit is **not green**:
the exact arm64 Node target was reached, then the command failed closed because
the machine had no installed harness at an exact frozen verified snapshot. This
limitation must not be converted into a support claim or erased with live
traffic.

## Configuration, installer, schema, and privacy changes

- The release candidate identity is `@flowxo/agent-relay@0.1.0-alpha.2`.
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
- SQLite migrates forward automatically through schema 9. An older binary
  refuses a newer schema; do not edit `user_version` to force a downgrade.
- Agent Relay has no product analytics, usage telemetry, or remote crash-report
  service. Transport-specific bounded fields, local retention, and provider-side
  erasure responsibilities are documented in `PRIVACY.md`.
- Cursor permission automation is disabled and the installer does not add a
  Cursor permission hook.

## Upgrade and rollback

Stop Agent Relay processes, install the exact newer artifact with dependency
scripts disabled, explicitly rebuild the reviewed SQLite dependency, run
`doctor`, inspect and apply `install --dry-run` / `install`, require a second
install to be unchanged, then run the fake canary before reselecting a real
transport.

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
- Alpha.2 publication is blocked pending renewed exact-candidate approval. If
  approved, the first npm publish remains an interactive 2FA bootstrap because
  the package must already exist before trusted-publisher setup. The exact OIDC
  publisher is installed immediately afterward; no token is retained and every
  later publish uses OIDC.

## Exact artifact and provenance boundary

`pnpm release:bundle` creates the npm tarball, SPDX SBOM, package-content
snapshot, these release notes, source manifest, and `SHA256SUMS` from one clean
commit. The manifest records whether the intended tag actually points at that
commit. A local build is unsigned evidence; only the separately authorized
tagged GitHub workflow can create signed build and SBOM attestations.

The immutable alpha.1 source commit `cda92d179e76c00eac848a3d496fa298115cce45`
produced equal-size Linux and macOS archives whose extracted files and
uncompressed tar stream were identical. Only gzip header offset 9 (the tenth
byte) differed (`0x03` versus `0x13`), changing the artifact digest and its
downstream SBOM/checksum/attestation bindings. The alpha.1 tag, tagged run, and
attestations are retained; the version and tag are never deleted, moved, or
reused.

`pnpm release:evidence` then verifies that exact bundle and records a sanitized
clean-home packed-package fake-canary result. It never forwards provider
credentials to the installed runtime or contacts a live provider, and it does
not substitute for the currently non-green native release-exit gate.

The retained live-reviewed package remains the earlier PR #39 alpha.1 tarball,
SHA-256 `654d6137233088905824f7960538b4d2e5911b9d100dcd1b825f79a15d84b198`. It
contains none of PR #40, PR #41, or PR #42. The source candidate entering the
freeze was PR #40 merge `eb5ae1316949f5053c6ae64fdf6d624243e2b2ee`; its
ephemeral package proof had SHA-256
`8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543` and was
neither retained nor live-tested. The current frozen source after FXO-1161 is PR
#41 reviewed head `875e5631ad45bbeb86c377e73dabe4d616b46413`, merge
`0adb7288483df331fbaaefb9b392ee2f4f3c7d84`. Its separate credential-free
release-bundle proof had SHA-256
`3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106`, 277,069
bytes, 11 packed files, and six SPDX packages; it was not live-tested. No
live-card authorization carries forward. The completed onboarding predecessor is
PR #42, reviewed head `52f04958bc6f3b838ff080eb8bc9111ac7e6f338`, merge
`c44ef5d38c3caa6ce2e6fa86c45976dfcb6f5f2a`. FXO-1574 records the corrected
alpha.2 source and regenerated digests before requesting renewed approval and
resuming FXO-1164.
