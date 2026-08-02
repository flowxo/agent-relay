# WhooshBang RC.5 consumer artifacts

This directory is Agent Relay's active, consumer-owned fixture boundary for the
optional hosted transport. The lock pins the exact `1.0.0-rc.5` artifacts
produced by WhooshBang at `flowxo/whooshbang@d34e45a`:

- `@whooshbang/contracts`;
- `@whooshbang/sdk`; and
- `@whooshbang/contract-mock`.

Their package names, versions, contents, and SHA-256 digests are checked before
the consumer contract suite runs.

The fixture keeps Agent Relay CI independent from a sibling checkout or mutable
branch. It is not a shared runtime package or a copy of WhooshBang-owned schemas
or types. The canonical consumer inventory is
[`contracts/contract-lock.json`](../../contracts/contract-lock.json); the
`artifacts.json` provenance manifest is checked for exact parity with that lock,
including the producer repository and commit.

The superseded `1.0.0-rc.4` candidate is not vendored here. It remains an
immutable producer candidate that is reproducible from
`flowxo/whooshbang@c6f4eb3bee2391137c15364e7cb84e468728aab8`, and its three
exact digests are recorded in the FXO-1373 story specification and in this
repository's own history. Bytes that no active check verifies are an unauditable
binary rather than evidence.

WhooshBang made a pre-alpha hard cut with no compatibility aliases or dual
package identities, so nothing here accepts the retired pre-rename
`@flowxo/notifications*` artifacts. Those package identities no longer exist
upstream and cannot be rebuilt from the producer repository, so their bytes stay
untouched under [`vendor/notifications-c0`](../notifications-c0/README.md) as
immutable C0 history and are installed by no active path.
