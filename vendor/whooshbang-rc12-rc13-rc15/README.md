# WhooshBang RC.12/RC.13/RC.15 consumer artifacts

This directory is Agent Relay's active, consumer-owned fixture boundary for the
optional hosted transport. The three artifacts no longer share a release
candidate number, so the directory is named for the exact set it holds. The lock
pins all three from one immutable WhooshBang source commit,
`flowxo/whooshbang@50de931`:

- `@whooshbang/contracts` at `1.0.0-rc.12`;
- `@whooshbang/sdk` at `1.0.0-rc.13`; and
- `@whooshbang/contract-mock` at `1.0.0-rc.15`.

Their package names, versions, contents, and SHA-256 digests are checked before
the consumer contract suite runs. `artifacts.json` records the version and full
producer commit per artifact rather than one set-wide contract version, because
a single number no longer identifies the set.

The mock's scenario corpus is versioned separately from the mock package. It
declares `contract-mock-scenarios.v1` at `1.0.0-rc.12`, matching the contract
candidate the scenarios were generated against. WhooshBang's own lock records
the same pairing. Both identities are pinned here and asserted exactly.

The fixture keeps Agent Relay CI independent from a sibling checkout or mutable
branch. It is not a shared runtime package or a copy of WhooshBang-owned schemas
or types. The canonical consumer inventory is
[`contracts/contract-lock.json`](../../contracts/contract-lock.json); the
`artifacts.json` provenance manifest is checked for exact parity with that lock,
including the producer repository and per-artifact commit.

WhooshBang made a pre-alpha hard cut with no compatibility aliases or dual
package identities, so nothing here accepts the retired pre-rename
`@flowxo/notifications*` artifacts. Those bytes remain untouched under
[`vendor/notifications-c0`](../notifications-c0/README.md) as immutable C0
history and are installed by no active path.

The superseded contracts rc.10 / SDK rc.11 / mock rc.13 set this directory
replaces is removed rather than kept beside it, as the contract update procedure
requires. It stays reproducible from producer commit
`08d4203fc2f52c4ab80fcfbc6416951351fba8ae`, and its digests stay recorded in the
FXO-1209 story specification that pinned it.
