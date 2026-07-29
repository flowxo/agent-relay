# Retired Notifications C0 consumer artifacts

This directory is immutable history. It holds the exact pre-rename
`@flowxo/notifications*` tarballs that Agent Relay's completed C0 consumer proof
reviewed. Those bytes, their digests, and [`artifacts.json`](artifacts.json) are
retained unchanged so the recorded C0 evidence stays verifiable.

Nothing here is installed, resolved, overridden, or checked by any active
runtime, package, lock, setup, or support path. The producer repository
`flowxo/flowxo-notifications` and the `@flowxo/notifications*` package
identities are retired. WhooshBang replaced them with a pre-alpha hard cut that
publishes no compatibility aliases and accepts no old contract, so these
artifacts cannot prove anything about the current candidate.

The active consumer boundary is
[`vendor/whooshbang-rc4`](../whooshbang-rc4/README.md), pinned by
[`contracts/contract-lock.json`](../../contracts/contract-lock.json).

The historical evidence these bytes back is recorded in
[the C0-07 story](../../docs/projects/notifications-transport-adapter/stories/c0-07-prove-notifications-contract-consumer.md).
That record describes the retired artifacts exactly as they were reviewed and is
not rewritten to claim compatibility with `1.0.0-rc.4`.
