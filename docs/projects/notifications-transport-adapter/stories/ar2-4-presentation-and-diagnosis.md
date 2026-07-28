# AR2.4: Reflect local resolution and classify hosted failures

- **Status:** Complete
- **Linear issue:** [FXO-1153](https://linear.app/flowxo/issue/FXO-1153)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Presentation and diagnosis
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-rc.1`
- **Last reviewed:** 2026-07-26

## Outcome

Hosted presentation is now a separate durable concern after local authority and
provider acknowledgement. A supported presenter can mark the originating
interaction answered, duplicate, expired, cancelled, or unsupported. Failure
cannot resolve a request again, create another message, or claim continuation.

The exact pinned rc.1 client has no resolved-message update method. The
production adapter therefore records the optional capability as unsupported
without making HTTP or pretending that message cancellation is an edit.

## Durable presentation worker

`hosted_message_updates` was introduced in AR2.3. AR2.4 now:

1. claims only work whose hosted event acknowledgement is durable;
2. derives `resolution_${sha256(hostedEventId)}` as the immutable operation ID;
3. projects only message/interaction identity, terminal category, safe reason,
   and resolution-source category;
4. marks success, bounded retry, or terminal block separately from the request;
5. recovers an interrupted `updating` lease on restart; and
6. reports capability, pending/retry/updated/blocked counts, and a safe last
   code through status.

The supported fake presenter proves the complete worker contract. The pinned
presenter returns `notifications-resolution-update-unsupported`, which is a
durable terminal capability result and does not stop polling.

## Failure policy

Every hosted failure maps to one of:

- `retry` — repeat only the same logical operation;
- `terminal-configuration` — reconnect or restart after correction;
- `dead-letter-security` — identity, scope, redirect, or idempotency integrity;
- `quarantine` — malformed/schema/contract data; or
- `operator-action` — removed resource, terminal provider outcome, or explicit
  ambiguity.

No policy permits a new identity. Explicit provider `outcome_unknown` blocks
automatic presentation retry. Transport response loss may retry only the same
deterministic update operation and never creates a new hosted message.

Errors retain only timestamp, stable code, category, counts, and hashed event
reference. Repeated hosted failures are rate-limited in process while every
affected event/update remains durable. Empty polls and shutdown aborts remain
non-errors.

## Disconnect and recovery

The daemon rechecks the private active connection marker before every hosted
send, poll, and acknowledgement. Disconnect, revocation, erased configuration,
or rotation stops new credential-bearing calls. SQLite events, decisions,
delivery mappings, claims, and safe error state remain. Explicit reconnect or
rotation followed by daemon restart creates a fresh client and resumes from the
durable spool/cursor.

## Acceptance evidence

| Acceptance area                         | Evidence                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Answered/duplicate/expired/cancelled    | Store projection and supported-presenter tests                              |
| Separate retry after local commit       | Store and poller tests keep the request answered across update retry        |
| Same identity after response loss       | Poller test observes the same SHA-256 operation ID across attempts          |
| Explicit `outcome_unknown`              | One blocked update, one hosted message, no second identity                  |
| HTTP/error category matrix              | Error-policy tests cover 401/403/404/409/429/5xx/schema/malformed/ambiguity |
| Redacted, rate-limited diagnosis        | Poller/service log tests plus status secret-exclusion assertions            |
| Disconnect/revoke preservation/recovery | Running-daemon disconnect/restart test                                      |
| Exact draft capability                  | Pinned presenter unit and running-daemon status test                        |

Focused verification:

```sh
pnpm exec vitest run \
  packages/core/src/hosted-interactions.test.ts \
  packages/core/src/service.test.ts \
  packages/notifications-transport/src/errors.test.ts \
  packages/notifications-transport/src/interaction-source.test.ts \
  packages/notifications-transport/src/presentation-source.test.ts \
  packages/notifications-transport/src/transport.test.ts \
  apps/relay/src/notifications-poller.test.ts \
  apps/relay/src/transport-status.test.ts \
  apps/relay/src/doctor.test.ts \
  apps/relay/src/daemon.test.ts \
  --no-file-parallelism
pnpm check
pnpm test:e2e
pnpm audit --prod
```

On 2026-07-26 the focused matrix passed 10 files/93 tests. The complete
repository gate passed 50 Vitest files/395 tests, 17 contract-lock and
supply-chain tests, the six-test isolated Notifications consumer, the
190,583-byte packed/1,220,612-byte unpacked distribution proof, and the packed
schema-1-to-schema-2 lifecycle. All three Chromium scenarios passed, and the
production dependency audit found no known vulnerability.

## Deferred

- FXO-1154 runs shared fake, direct-Telegram, and Notifications behavior parity.
- FXO-1155 proves the packaged mock-backed end-to-end path and release handoff.
- A real resolved-message update remains a Notifications contract capability,
  not an Agent Relay-local API invention.
- Production dogfood remains owned by AR3 and awaits the approved real service.

## References

- [`project-spec.md`](../project-spec.md)
- [`ar2-3-durable-hosted-interaction-poller.md`](ar2-3-durable-hosted-interaction-poller.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`packages/notifications-transport/README.md`](../../../../packages/notifications-transport/README.md)
