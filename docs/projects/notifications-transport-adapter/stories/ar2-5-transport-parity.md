# AR2.5: Run common behavior across every transport

- **Status:** Complete
- **Linear issue:** [FXO-1154](https://linear.app/flowxo/issue/FXO-1154)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Transport parity and packaged handoff
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-rc.1`
- **Last reviewed:** 2026-07-26

## Outcome

Fake, direct Telegram, and Notifications now run one transport-neutral behavior
matrix. The hosted adapter cannot silently weaken the local decision or resume
authority, and direct Telegram remains an executable first-class path.

The shared suite uses:

- `FakeNotificationTransport`;
- the real `TelegramBotTransport` and `TelegramReplyRouter` against a bounded
  synthetic Bot API; and
- the real `NotificationsContractTransport`, pinned executable contract mock,
  machine event source, and durable interaction poller.

## Common matrix

Each provider runs the same scenarios for:

1. bounded delivery and duplicate ingestion;
2. retry with the unchanged event/idempotency identity and one successful
   logical message;
3. confirm, single-select, and free-text/continuation answers;
4. strict local machine/harness/session/turn identity;
5. expiry without continuation;
6. duplicate answers;
7. terminal-first and phone-first races;
8. answer-after-restart; and
9. one durable resume claim across a second restart.

Local request state, selected answer, and resume ownership are equivalent.
`resolvedBy` remains intentionally provider-specific: `telegram` for fake/direct
Telegram and `notifications` for hosted answers.

## Explicit capability difference

Every transport now returns a runtime-validated provider observation.

| Capability                       | Fake | Direct Telegram | Notifications rc.1 |
| -------------------------------- | ---- | --------------- | ------------------ |
| confirm/select/input             | yes  | yes             | yes                |
| message updates                  | yes  | yes             | no                 |
| durable multi-question drafts    | yes  | yes             | no                 |
| ordered or multi-select sets     | yes  | yes             | no                 |
| maximum hosted question count    | 10   | 10              | 1                  |
| maximum hosted select option set | 20   | 20              | 6                  |

The hosted record is proven by the exact pinned contract and fixture. It does
not claim resolved-message updates merely because the adapter contains a future
presenter interface.

## Contract issue found by parity

The local store retains `already_resolved`, `locally_expired`, and
`locally_cancelled` reasons for diagnosis. The rc.1 acknowledgement schema
allows `reason_code` only when disposition is `quarantined`.

The shared exact-mock sequence proved that forwarding a local reason with
`processed` blocked the cursor and every later event. The poller now projects
only quarantine reasons to the provider while keeping every local reason
durable. The matrix exercises an expired answer followed by later valid answers,
so this regression cannot silently return.

## Provider-specific regression evidence

The common matrix is additive. Existing provider suites still prove:

- direct Telegram topic isolation, opaque buttons, structured drafts,
  plain-topic/replied-message correlation, card resolution, preflight, polling,
  and live fake canary;
- Notifications cross-machine/session/turn rejection, unknown options,
  malformed/schema failures, stale events, executable-data rejection, stable
  hosted idempotency, ack/update retry, cursor barriers, and disconnect
  recovery; and
- local first-writer-wins resolution plus single-owner resume independent of
  transport presentation.

Focused verification:

```sh
pnpm exec vitest run \
  apps/relay/src/transport-parity.test.ts \
  apps/relay/src/notifications-poller.test.ts \
  apps/relay/src/canary.test.ts \
  packages/core/src/service.test.ts \
  packages/telegram-transport/src/reply-router.test.ts \
  packages/telegram-transport/src/transport.test.ts \
  packages/telegram-transport/src/multi-select.test.ts \
  packages/telegram-transport/src/question-set.test.ts \
  packages/telegram-transport/src/question-set-text.test.ts \
  packages/telegram-transport/src/card-actions.test.ts \
  packages/core/src/resume.test.ts \
  packages/notifications-transport/src/transport.test.ts \
  packages/notifications-transport/src/mapping.test.ts \
  packages/notifications-transport/src/hosted-answer.test.ts \
  packages/notifications-transport/src/interaction-source.test.ts \
  packages/notifications-transport/src/presentation-source.test.ts \
  --no-file-parallelism
pnpm check
pnpm test:e2e
pnpm audit --prod
```

On 2026-07-26:

- the focused 16-file matrix passed 146 tests;
- the complete repository gate passed 51 Vitest files/408 tests, 17
  contract-lock and supply-chain tests, and the isolated six-test Notifications
  consumer;
- the package proof verified a 190,951-byte packed/1,221,519-byte unpacked
  artifact and the complete packed lifecycle;
- all three Chromium scenarios passed; and
- `pnpm audit --prod` found no known vulnerability.

The compact cumulative ledger remains in
[`docs/progress.md`](../../../progress.md).

## Deferred

- FXO-1155 proves the installed packed artifact end to end and completes the
  AR3-ready operational handoff.
- Production dogfood remains owned by AR3 and awaits the approved real service.
- A real hosted resolution update remains a future exact Notifications
  capability.

## References

- [`project-spec.md`](../project-spec.md)
- [`ar2-4-presentation-and-diagnosis.md`](ar2-4-presentation-and-diagnosis.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`packages/notifications-transport/README.md`](../../../../packages/notifications-transport/README.md)
