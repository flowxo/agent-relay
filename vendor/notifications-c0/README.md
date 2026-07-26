# Notifications C0 consumer artifacts

This directory is Agent Relay's immutable, consumer-owned fixture boundary for
the Notifications C0 contract proof. The tarballs are the exact `1.0.0-draft.1`
artifacts produced by FlowXO Notifications. Their package names, versions,
contents, and SHA-256 digests are checked before the consumer contract suite
runs.

The fixture keeps Agent Relay CI independent from a sibling checkout or mutable
branch. It is not a shared runtime package, a copy of Notifications-owned
schemas or types, or the cross-repository compatibility lock introduced by
C0-08.
