# AR2.3: Poll, claim, resolve, and acknowledge hosted interactions durably

- **Status:** Complete
- **Linear issue:** [FXO-1152](https://linear.app/flowxo/issue/FXO-1152)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Durable hosted interaction loop
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-draft.1`
- **Last reviewed:** 2026-07-26

## Outcome

When `notifications` is the selected transport, the local daemon continuously
polls the authenticated machine stream. It resolves confirm, select, and input
answers through the existing SQLite first-writer-wins transition, commits a safe
hosted-event outcome and acknowledgement job in the same local transaction, and
only then acknowledges the provider event.

The provider supplies answer facts, not execution authority. Hosted fields never
choose a process, argv, resume owner, session, or permitted option.

## Durable model

SQLite schema version `2` adds five bounded records:

| Record                          | Durable purpose                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `hosted_delivery_mappings`      | Local event to hosted message/interaction/type identity                         |
| `hosted_poll_state`             | Hashed stream key, committed cursor, last successful poll, safe last error      |
| `hosted_event_claims`           | One immutable event/cursor/payload digest and safe local outcome                |
| `hosted_event_acknowledgements` | Pending/acknowledging/retry/acknowledged/blocked provider acknowledgement state |
| `hosted_message_updates`        | Pending/retry state reserved for FXO-1153 presentation reflection               |

The stream key is a full SHA-256 digest of API origin plus machine-client ID.
Raw responses and answer payloads are not copied into the hosted claim. The
existing pending request remains the answer authority. Runtime status exposes
only a shortened hash of the committed cursor.

Interactive delivery now returns hosted interaction identity through
`DeliveryReceipt`; `RelayService` commits that identity with the normal
delivered event transition. Restart therefore does not depend on the adapter's
former in-memory delivery map.

## Poll and acknowledgement order

For each selected hosted stream, the daemon:

1. recovers interrupted acknowledgement/message-update leases;
2. drains the oldest unacknowledged local claim before polling;
3. polls after the last locally committed cursor with a bounded wait and request
   timeout;
4. relies on the pinned client for authenticated response/schema validation,
   then verifies the server cursor equals local authority and rejects duplicate
   event/cursor identities in a batch;
5. validates binding, hosted message/interaction/correlation, local
   machine/harness/session/turn/request/type, option membership, occurrence, and
   expiry;
6. atomically resolves the request and records the immutable event digest,
   outcome, acknowledgement job, and message-update job;
7. acknowledges with a deterministic event-derived idempotency key; and
8. advances the local cursor only after the acknowledgement response matches the
   durable event, cursor, disposition, reason, and contiguous committed cursor.

Only the first returned event is claimed before the next acknowledgement. This
keeps cursor advancement contiguous even when the provider returns a batch.
Opaque cursor ordering itself is a pinned provider contract; Agent Relay can
verify uniqueness and committed-cursor continuity but does not infer ordering
from cursor text.

C0 authenticates the long-poll endpoint and runtime-validates its response. It
does not expose a detached response signature, and Agent Relay does not claim
one.

## Failure and restart behavior

- A retryable poll failure records a safe code and applies bounded exponential
  backoff.
- A stuck poll is aborted by a separate local timeout. Daemon shutdown abort is
  not logged as failure.
- A retryable acknowledgement failure remains ahead of all later work with a
  durable next-attempt time.
- A crash after local commit but before provider acknowledgement replays only
  the same acknowledgement; the decision cannot run twice.
- A crash after the provider accepted an acknowledgement but before local cursor
  commit replays the same idempotent acknowledgement before another poll.
- Authentication, contract, cursor, binding, cross-session, or immutable-event
  failures stop without acknowledgement or cursor advance.
- Invalid option/kind/answer and post-expiry poison are durably quarantined
  before a quarantine acknowledgement.
- Already answered, terminal-first, expired, and cancelled requests produce
  explicit harmless acknowledgement outcomes without replacing local state.

## Acceptance evidence

| Acceptance area                          | Evidence                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Schema-v2 migration                      | Version-one migration test plus future-schema refusal and packaged lifecycle check             |
| Delivery identity survives restart       | Hosted mapping is committed in `markDelivered`; SQLite reopen test reads and uses it           |
| Atomic local authority                   | Store test resolves, claims, and enqueues acknowledgement/message update in one transaction    |
| Immutable replay                         | Changed payload digest under the same event identity fails closed                              |
| Crash-before/after-ack recovery          | Durable retry/restart test drains acknowledgement before polling and resolves only once        |
| Confirm/select/input                     | Cursor-ordered three-session poller test                                                       |
| Poison, stale, duplicate, terminal races | Poller, hosted validator, and pinned C0 consumer tests                                         |
| Wrong binding/session/turn/machine       | Binding and identity stop tests; cross-machine C0 stream test                                  |
| Timeout/backoff/shutdown                 | Bounded timeout, transient retry, and abort-without-noise poller tests                         |
| Pinned executable boundary               | Source poll/ack test and running-daemon hosted select round trip against the exact packed mock |
| Safe diagnosis                           | Hashed cursor status, safe error classification, and secret/provider-ID exclusion assertions   |

Focused verification:

```sh
pnpm exec vitest run \
  packages/core/src/hosted-interactions.test.ts \
  packages/core/src/store-schema.test.ts \
  packages/notifications-transport/src/interaction-source.test.ts \
  packages/notifications-transport/src/hosted-answer.test.ts \
  packages/notifications-transport/src/transport.test.ts \
  packages/notifications-transport/test/contract-consumer.contract.test.ts \
  apps/relay/src/notifications-poller.test.ts \
  apps/relay/src/transport-status.test.ts \
  apps/relay/src/daemon.test.ts \
  --no-file-parallelism
pnpm check
pnpm test:e2e
pnpm audit --prod
```

On 2026-07-26 the focused matrix passed 9 files/73 tests. The complete
repository gate passed 49 Vitest files/374 tests, 17 contract-lock and
supply-chain tests, the six-test isolated Notifications consumer,
distribution/package verification, and the packed schema-1-to-schema-2
lifecycle. All three Chromium scenarios passed, and the production dependency
audit found no known vulnerability.

## Proven versus deferred

### Proven locally

- Selected hosted delivery and answer intake complete one daemon-controlled loop
  against the executable C0 mock.
- SQLite commits local authority before provider acknowledgement and recovers
  every relevant crash window without duplicate resolution.
- Poison and integrity failures cannot silently skip the stream.
- Direct Telegram does not enter the hosted poller and remains independently
  selected.

### Deferred

- FXO-1153 consumes `hosted_message_updates` to reflect terminal presentation
  and extend hosted failure diagnosis.
- FXO-1154 runs the shared behavior matrix across fake, Telegram, and hosted
  transports.
- FXO-1155 proves the packaged end-to-end hosted path and release handoff.
- Production dogfood remains gated by C0-09 and AR3.

## References

- [`project-spec.md`](../project-spec.md)
- [`ar2-2-explicit-transport-selection.md`](ar2-2-explicit-transport-selection.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`packages/notifications-transport/README.md`](../../../../packages/notifications-transport/README.md)
