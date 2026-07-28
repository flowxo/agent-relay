# Agent Relay Notifications transport

This private package is the production-promotable boundary between Agent Relay
delivery semantics and the pinned FlowXO Notifications C0 API. C0-07 proves
mapping and local authority. AR2.1 adds the bounded project administration
client and mock-backed machine setup used by the CLI. AR2.2 wires explicit
outbound daemon selection and a terminal configuration circuit. AR2.3 adds the
bounded interaction source used by the durable local poll/claim/resolve/ack
loop. AR2.4 adds stable hosted failure policy plus the optional terminal
presentation interface. AR2.5 proves shared transport behavior, and AR2.6 proves
the installed public adapter from the packed release artifact.

## Machine bootstrap

`connectNotificationsMachine` normalizes a safe HTTPS or exact-loopback base
URL, creates and observes a single-use subscriber authorization link, verifies
the activated binding, creates one destination-bound machine client, generates
the 32-byte secret locally, registers only its SHA-256 digest, polls with the
narrow bearer, sends a fixed canary, and re-reads active machine metadata.

The administration client rejects redirects, credentials embedded in URLs,
non-contract media/status/body shapes, oversized bodies, and remote plain HTTP.
High-level bootstrap and disconnect errors use stable redacted messages. A
failure after credential registration attempts bounded credential/client
revocation and reports whether cleanup remained incomplete.

`disconnectNotificationsMachine` idempotently revokes the narrow credential and
machine client using a project credential supplied only for that operation.
Local storage and rotation orchestration remain in `apps/relay`; this package
has no filesystem, SQLite, Telegram, daemon, or shell-command authority.

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
- `observeInteractionCapabilities` publishes the exact draft.1 boundary:
  confirm, single-select, and free-text; one question; at most six options; no
  durable drafts, ordered/multi-select sets, or message updates.
- Explicit availability failures retry only with the unchanged event ID.
  Authentication, scope, validation, unbound subscriber, terminal provider, and
  idempotency-conflict failures are terminal. A provider `outcome_unknown`
  diagnostic forbids a new automatic hosted send.
- 401, 403, 404, 409, 429, 5xx, timeout, malformed/schema, and `outcome_unknown`
  conditions map to stable retry, terminal-configuration, dead-letter/security,
  quarantine, or operator-action categories. No category permits a new logical
  identity.
- Unknown 5xx protocol responses use the existing bounded local retry policy.
  Malformed successful responses, redirects, and contract/schema failures fail
  closed with stable redacted diagnostics.
- Authentication, scope, binding, and pinned-contract configuration failures
  open an in-process terminal circuit. Later deliveries remain visible in local
  SQLite but make no repeated credential-bearing network call until restart
  after corrective setup.

## Hosted answer authority

`validateHostedAnswer` is pure. Before it returns an input suitable for
`RelayStore.resolveRequest`, it proves authenticated schema/contract/stream
evidence, configured machine and binding identity, the pinned hosted message and
interaction, local correlation, local request kind, local
machine/harness/session/turn identity, option membership, occurrence, and
expiry. It cannot execute or select a resume command. C0 does not expose a
detached long-poll response signature, and this package does not claim one.

The daemon persists hosted delivery identity, immutable event digest, local
outcome, acknowledgement retry, message-update retry, and committed cursor in
SQLite. It commits local resolution or safe quarantine first, then acknowledges
Notifications with a deterministic idempotency key. A crash before
acknowledgement repeats the event; recovery drains that acknowledgement before a
new poll, and the already materialized resume command cannot be claimed twice.
Local duplicate/terminal reason codes remain durable, but `processed`
acknowledgements omit them because the pinned contract permits `reason_code`
only for `quarantined`.

## Resolution presentation

`NotificationsResolutionPresenter` is a bounded optional interface. The daemon
claims its SQLite message-update job only after the corresponding hosted event
is acknowledged. Retry uses `resolution_${sha256(hostedEventId)}` every time;
update failure cannot call `resolveRequest`, create a message, or claim
continuation.

The exact pinned `@flowxo/notifications@1.0.0-draft.1` client has no
resolved-message update method. `PinnedNotificationsResolutionPresenter`
therefore reports `unsupported`, and the daemon marks that job terminally with
`notifications-resolution-update-unsupported`. Tests inject a supported fake
presenter to prove answered, duplicate, expired, cancelled, and unsupported
projection plus retry/restart behavior without pretending cancellation is an
edit API.

Run the exact artifact and round-trip proof with:

```sh
pnpm contracts:notifications
pnpm package:hosted:check
```

The previous `pnpm notifications:contract:check` spelling remains an alias. The
first command proves the immutable consumer contract in isolation. The second
installs the product tarball into a clean home, exercises setup, selection,
confirm/select/input, crash-before-ack replay, explicit disconnect/erasure,
retained SQLite authority, direct-Telegram parity, owned uninstall, and
private-data exclusion. The contract mock remains verifier-only and is not
bundled into the product.
