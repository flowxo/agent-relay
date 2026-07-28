# Agent Relay Notifications transport

This private package is the production-promotable, test-constructed boundary
between Agent Relay delivery semantics and the pinned FlowXO Notifications C0
API. C0-07 proves the mapping and local authority; it does not wire a production
poll loop, daemon configuration, credentials, cursor persistence, transport
selection, or fallback.

## Pinned consumer artifacts

Agent Relay consumes immutable tarballs from `vendor/notifications-c0`:

| Package                               | Version      | SHA-256                                                            |
| ------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `@flowxo/notifications-contracts`     | `1.0.0-rc.1` | `02814c4ce1a963dbd8362eb270e42d9a42383f9257671a02f9f791bddfb00dc2` |
| `@flowxo/notifications`               | `1.0.0-rc.1` | `82d2136c35e0f9e5aa0ea3d67f1bae9c535f871c2bb13aa2e4cadcdbcb612c44` |
| `@flowxo/notifications-contract-mock` | `1.0.0-rc.1` | `9868dc62363b8119e001362c9c95be94dcadec370410f2a04bc86e9b49312e5e` |

The C0-08 source of truth is
[`contracts/contract-lock.json`](../../contracts/contract-lock.json). The
focused check verifies its hashes, canonical schema and policy digests, fixture
identities, archive paths, package identities, exact owner dependency versions,
install-script and secret-path absence, scripts-disabled fresh pnpm install, and
the production package import boundary. No owner schema or generated type is
copied into Agent Relay.

## Mapping and failure policy

- The stable Agent Relay event ID is both `Idempotency-Key` and hosted message
  correlation.
- Hosted text is deterministic: title, one blank line, then already-redacted
  text.
- Canonical `DeliveryInteraction` projects confirm to `confirm`, a bounded
  single choice to `select`, and free text/continuation to `input`.
- Opaque local option tokens cross as values and are mapped back to locally
  stored option IDs. Commands, paths, machine IDs, tool inputs, provider
  identities, and raw permission payloads are never added.
- Multi-select, ordered sets, and select requests wider than the pinned hosted
  capability fail before HTTP. Their negotiated local fallback is retained; they
  are never flattened.
- Explicit availability failures retry only with the unchanged event ID.
  Authentication, scope, validation, unbound subscriber, terminal provider, and
  idempotency-conflict failures are terminal. A provider `outcome_unknown`
  diagnostic forbids a new automatic hosted send.
- Unknown protocol responses use the existing bounded local retry policy and
  stable redacted diagnostics. Contract/schema failures fail closed.

## Hosted answer authority

`validateHostedAnswer` is pure. Before it returns an input suitable for
`RelayStore.resolveRequest`, it proves validated schema/signature/stream
evidence, authenticated and configured machine identity, the pinned hosted
message and interaction, local correlation, local request kind, local
machine/harness/session/turn identity, option membership, occurrence, and
expiry. It cannot execute or select a resume command.

The C0 harness commits the local resolution or safe quarantine first, then
acknowledges Notifications. A crash before acknowledgement repeats the event;
the reopened SQLite request proves a duplicate, and the already materialized
resume command cannot be claimed twice.

Run the exact artifact and round-trip proof with:

```sh
pnpm contracts:notifications
```

The previous `pnpm notifications:contract:check` spelling remains an alias.
