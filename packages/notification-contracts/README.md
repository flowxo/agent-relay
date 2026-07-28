# Notification contracts

This private workspace package owns the provider-neutral boundary between Agent
Relay's local authority and notification adapters. It defines bounded delivery,
receipt, topic creation/deletion, operator-control, interaction, capability,
action-token, and failure contracts.

It must not depend on core or a concrete provider. Core and provider adapters
depend on this package; `apps/relay` is the composition root that assembles
them. These internals are bundled into the single `@flowxo/agent-relay` CLI and
are not a separately supported public API.
