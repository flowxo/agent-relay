# WhooshBang RC.4 consumer artifacts

This directory is Agent Relay's active, consumer-owned fixture boundary for the
optional hosted transport. The lock pins the exact `1.0.0-rc.4` artifacts
produced by WhooshBang at `flowxo/whooshbang@c6f4eb3`:

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

WhooshBang made a pre-alpha hard cut with no compatibility aliases or dual
package identities, so nothing here accepts the retired pre-rename
`@flowxo/notifications*` artifacts. Those bytes remain untouched under
[`vendor/notifications-c0`](../notifications-c0/README.md) as immutable C0
history and are installed by no active path.
