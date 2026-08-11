# Agent Relay V1 release boundary

The machine-readable source of truth is
[`packaging/v1-release-boundary.json`](../packaging/v1-release-boundary.json).
This summary freezes the support, privacy, compatibility, and provenance
boundary for `@flowxo/agent-relay@0.1.0-alpha.1`; it does not authorize or claim
a publication.

## Package and source

- Package version: `0.1.0-alpha.1`.
- Intended tag: `v0.1.0-alpha.1`. It has not been created. Tagging and
  publication require separate owner authorization.
- The source candidate entering this freeze is PR #40, reviewed head
  `9a5e6a68609e3764ba5198c350528254bd37da62`, merged as
  `eb5ae1316949f5053c6ae64fdf6d624243e2b2ee`.
- The frozen package manager is `pnpm@11.17.0`; `pnpm-lock.yaml` has SHA-256
  `46b51f60a932e73533b43c7d605c350b36f01dcdd4e196ef61f14309bf2c6b38`.
- The final clean reviewed release commit and tarball are bound later by the
  generated release manifest, `SHA256SUMS`, SPDX SBOM, and CI provenance. This
  document deliberately does not try to self-record a future tarball digest.

## Same-version evidence distinction

The exact retained live-reviewed package is `@flowxo/agent-relay@0.1.0-alpha.1`,
SHA-256 `654d6137233088905824f7960538b4d2e5911b9d100dcd1b825f79a15d84b198`. It
came from PR #39 reviewed head `4ba4b1fbd832c34f465cd40f199e5c1dac7ed890`,
merged as `85d2d0a1f8649bf4359031227d1b9b844208cc15`. It does **not** contain PR
#40.

PR #40 source separately passed credential-free packed proof with ephemeral
package SHA-256
`8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543`. That package
was not retained and was not live-tested. No live rerun is needed to erase this
distinction.

## Support and compatibility

V1 supports macOS on Apple silicon with native arm64 Node or x64 Node through
Rosetta and Node.js `>=22`. Native arm64 release-exit validation is pinned to
Node.js `22.23.1`. Windows, Linux, and Intel macOS are not end-user support
claims. The exact harness snapshots remain Codex CLI `codex-cli 0.145.0`, Claude
Code CLI `2.1.219 (Claude Code)`, and Cursor CLI `2026.07.23-e383d2b`; the
generated [capability matrix](capability-matrix.md) freezes the individual
surfaces and capabilities.

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

No tag, package, release, registry action, repository promotion, production
change, or live-provider operation is authorized by this freeze. The bundled
WhooshBang contracts and SDK currently declare no distributable license
metadata. An owner-approved license and notice decision is therefore a hard
publication gate; Agent Relay does not infer one.
