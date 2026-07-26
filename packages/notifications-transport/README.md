# Agent Relay Notifications transport

This private package is the production-promotable, test-constructed boundary
between Agent Relay delivery semantics and the pinned FlowXO Notifications C0
API. C0-07 proves the mapping and local authority; it does not wire a production
poll loop, daemon configuration, credentials, cursor persistence, transport
selection, or fallback.

## Pinned consumer artifacts

Agent Relay consumes immutable tarballs from `vendor/notifications-c0`:

| Package                               | Version         | SHA-256                                                            |
| ------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `@flowxo/notifications-contracts`     | `1.0.0-draft.1` | `88fae08ed3e84954bd4f4b371a604fcd10c3e94bf6eb547fe98fc6ccebed9106` |
| `@flowxo/notifications`               | `1.0.0-draft.1` | `4ccf06d000fc36c7bcf4d74f5427c12950675fb5a661c1f9d146fc872545278c` |
| `@flowxo/notifications-contract-mock` | `1.0.0-draft.1` | `c803f181213b3a86ce5fb566719dfe7833be1a6ffc9d228be9ec1bf396289c63` |

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
