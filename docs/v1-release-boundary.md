# Agent Relay V1 release boundary

The machine-readable source of truth is
[`packaging/v1-release-boundary.json`](../packaging/v1-release-boundary.json).
This summary freezes the support, privacy, compatibility, and provenance
boundary for the corrected `@flowxo/agent-relay@0.1.0-alpha.2` candidate.
FXO-1574 requires renewed exact-candidate approval before FXO-1164 publication
may resume; this source record does not claim that alpha.2 publication has
occurred.

## Package and source

- Package version: `0.1.0-alpha.2`.
- Intended tag: `v0.1.0-alpha.2`. It does not exist and is not authorized until
  renewed approval names the exact corrected candidate; generated manifests
  record observed build-time tag state.
- The source candidate entering this freeze is PR #40, reviewed head
  `9a5e6a68609e3764ba5198c350528254bd37da62`, merged as
  `eb5ae1316949f5053c6ae64fdf6d624243e2b2ee`.
- The current frozen source after FXO-1161 is PR #41, reviewed head
  `875e5631ad45bbeb86c377e73dabe4d616b46413`, merged as
  `0adb7288483df331fbaaefb9b392ee2f4f3c7d84`. These are two distinct points in
  the release history, not interchangeable provenance labels.
- The completed onboarding/artifact predecessor is PR #42, reviewed head
  `52f04958bc6f3b838ff080eb8bc9111ac7e6f338`, merged as
  `c44ef5d38c3caa6ce2e6fa86c45976dfcb6f5f2a`. FXO-1568 starts from that commit;
  its final post-merge candidate and new digests are recorded externally before
  FXO-1164 execution rather than self-referenced from this source file.
- The frozen package manager is `pnpm@11.17.0`; `pnpm-lock.yaml` has SHA-256
  `46b51f60a932e73533b43c7d605c350b36f01dcdd4e196ef61f14309bf2c6b38`.
- The final clean reviewed release commit and tarball are bound later by the
  generated package-content snapshot, release notes, release manifest,
  `SHA256SUMS`, SPDX SBOM, sanitized clean-home evidence, and any separately
  authorized CI provenance. This document deliberately does not try to
  self-record a future tarball digest.

## Same-version evidence distinction

The exact retained live-reviewed package is `@flowxo/agent-relay@0.1.0-alpha.1`,
SHA-256 `654d6137233088905824f7960538b4d2e5911b9d100dcd1b825f79a15d84b198`. It
came from PR #39 reviewed head `4ba4b1fbd832c34f465cd40f199e5c1dac7ed890`,
merged as `85d2d0a1f8649bf4359031227d1b9b844208cc15`. It does **not** contain PR
#40, PR #41, or PR #42.

PR #40 source separately passed credential-free packed proof with ephemeral
package SHA-256
`8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543`. That package
was not retained and was not live-tested. No live rerun is needed to erase this
distinction.

PR #41's clean-commit credential-free release-bundle proof has SHA-256
`3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106`, size 277,069
bytes, 11 packed files, and six SPDX packages. It contains PR #40 and PR #41,
but it was not live-tested. It is a separate proof from both the retained PR #39
tarball and PR #40's ephemeral package.

## Preserved alpha.1 publication attempt

Immutable tag `v0.1.0-alpha.1` points to exact source commit
`cda92d179e76c00eac848a3d496fa298115cce45`. Its protected tagged workflow passed
repository, browser, audit, bundle, upload, and build/SBOM attestation jobs. The
Linux archive SHA-256 is
`4e6dca3e14767444c4125c72a7d0f124b7818d45f585784a59f01d24a47b1e89`, while the
authorized macOS archive SHA-256 is
`eaead1f9011b8968a76dadb5e37ed3bcd020f6f477484b24db1e259e88ebeaa2`. They have
identical extracted files and uncompressed tar SHA-256
`504c991da1a6a9cf43db8658eb9b83917fbd054738a4a4a9c281fd1cd4a3b211`; only gzip
header offset 9 (the tenth byte) differs (`0x03` versus `0x13`). No npm package
or GitHub release was created. The alpha.1 tag, run, and attestations are
retained and must never be deleted, moved, or reused.

## Support and compatibility

V1 supports macOS on Apple silicon with native arm64 Node or x64 Node through
Rosetta and Node.js `>=22`. Native arm64 release-exit validation is pinned to
Node.js `22.23.1`. Windows, Linux, and Intel macOS are not end-user support
claims. The exact harness snapshots remain Codex CLI `codex-cli 0.145.0`, Claude
Code CLI `2.1.219 (Claude Code)`, and Cursor CLI `2026.07.23-e383d2b`; the
generated [capability matrix](capability-matrix.md) freezes the individual
surfaces and capabilities.

Native release-exit is **not green**. The exact arm64 Node.js `22.23.1` target
was reached, then the proof failed closed because the machine had no installed
harness at an exact frozen verified snapshot. The result is not credited as a
completed lifecycle matrix and no live traffic should be run merely to change
that evidence state.

The installer manifest is `agent-relay-install.v1` version `1`. The current
SQLite schema is `9`; migrations are forward-only and a newer schema fails
closed as an unsafe downgrade. Doctor checks the runtime target, current harness
observations, installed hook version stamps, package/launcher state, SQLite, and
selected transport readiness. At least one supported harness is required; an
uninstalled unused harness is a warning.

The fake transport is local-only and remains the default. Exactly one of fake,
direct Telegram, outbound webhook, or WhooshBang is selected. There is no
automatic dual-send or failover. WhooshBang contracts rc.12 and SDK rc.13 are
bundled; contract mock rc.15 is proof-only. Their source and archive checksums
are pinned in the contract lock.

## Privacy snapshot

Agent Relay has no product analytics, usage telemetry, or remote crash-report
service. The machine-readable record inventories the durable selection,
Telegram, webhook, WhooshBang, installer, database, log, fallback, and temporary
provisioning files. Default local retention is 30 days for delivered work,
requests, and Telegram updates and 90 days for dead letters, diagnostics, and
sessions.

The fake transport has no network fields. Telegram, webhook, and WhooshBang each
receive only their documented bounded routing, presentation, correlation, and
interaction fields. The narrow WhooshBang machine bearer and credential ID
authenticate provider requests but are not message-payload fields. Webhook
environment injection is process-only; configure-by-stdin or private file writes
the mode-`0600` configuration. Local erasure does not erase provider-held
messages or account records, which require separate provider-side action.

## Known limitations and accepted residual

- Cursor IDE late resume is unsupported, and Cursor permission automation is
  disabled.
- Native hooks cannot prove process crashes; crash evidence requires Agent Relay
  to own the supervised child.
- Telegram delivery is at least once across its documented acknowledgement
  ambiguity window.
- Agent Relay provides no automatic dual-send or transport failover.
- Windows, Linux, and Intel macOS are not claimed end-user runtimes.
- V1 has no hosted dashboard or team-policy surface.
- Accepted Low residual: automation cannot prove that the invoking shell or GUI
  session launched with every ambient hook disabled. Exact hook-denied isolation
  and aggregate attribution mitigate it; contaminated observation windows fail
  closed.

No Critical or High Agent Relay boundary finding remains open. No live-card
authorization carries forward.

## Publication boundary

FXO-1568's MIT and `Copyright (c) 2026 Flow XO, LLC` decision remains valid for
the exact bundled WhooshBang contracts rc.12 and SDK rc.13 artifacts. Its
alpha.1 source/version/archive authorization does not carry to alpha.2.
`packaging/release.json` therefore keeps publication false and registry action
blocked. FXO-1574 must record the exact corrected commit and regenerated
artifact, SBOM, checksum, notes, manifest, clean-home, and signed-attestation
digests, then obtain renewed owner approval before FXO-1164 resumes.

If approved, the first npm publish uses the reviewed interactive 2FA bootstrap
and immediately configures the exact `flowxo/agent-relay` / `prerelease.yml` /
`npm-prerelease` publisher. No token is retained; every later publish uses OIDC.

The authorization excludes production deployment or mutation, the central
workspace release, live-provider traffic, credential disclosure or retention,
live-card authorization, and any publication beyond that exact Agent Relay
alpha. Substantive candidate or scope drift requires renewed approval.
