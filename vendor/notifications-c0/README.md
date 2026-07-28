# Notifications C0 consumer artifacts

This directory is Agent Relay's immutable, consumer-owned fixture boundary for
the Notifications C0 contract proof. The current lock pins the exact
`1.0.0-rc.1` artifacts produced by FlowXO Notifications. Their package names,
versions, contents, and SHA-256 digests are checked before the consumer contract
suite runs. The `1.0.0-draft.1` tarballs remain only as the historical
compatibility baseline and are no longer installed by the gate.

The fixture keeps Agent Relay CI independent from a sibling checkout or mutable
branch. It is not a shared runtime package or a copy of Notifications-owned
schemas or types. C0-08's canonical consumer inventory is
[`contracts/contract-lock.json`](../../contracts/contract-lock.json); the legacy
`artifacts.json` provenance manifest is checked for exact parity with that lock.
