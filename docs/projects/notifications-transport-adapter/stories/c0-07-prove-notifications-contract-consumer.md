# Story specification: Prove Agent Relay against the Notifications contract

- **Status:** Complete against `1.0.0-rc.1`; C0-09 recorded `go`
- **Story code:** C0-07
- **Product:** Agent Relay
- **Project:** Shared Contracts and Autonomous Delivery Conventions
- **Wave:** Wave 0
- **Priority:** P0
- **Linear issue:** [FXO-1048](https://linear.app/flowxo/issue/FXO-1048)
- **Owning repository:** `agent-relay`
- **Intended owner:** Agent Relay transport boundary
- **Depends on:** C0-03 (complete); C0-05 (complete)
- **Implemented in:** `68b2fbf`; compatibility gate extended in `100c250`
- **Review:** [Agent Relay PR #2](https://github.com/flowxo/agent-relay/pull/2)
- **Last reviewed:** 2026-07-26

## User story

As the Agent Relay maintainer, I want an executable consumer proof against the
Notifications mock, so that AR2 can add the hosted transport without guessing
about delivery mapping, answer correlation, retry behavior, or local authority.

## Context

Agent Relay already has:

- a provider-neutral `NotificationTransport` delivery interface;
- direct Telegram delivery and reply routing;
- SQLite-backed event, pending-request, and first-writer-wins state;
- stable attention-event, request, machine, harness, session, and turn
  identities; and
- comprehensive local retry/resume tests.

C0 should prove the public seam while avoiding a premature production
configuration/polling implementation. AR2 owns daemon configuration, credential
storage, continuous hosted polling, diagnostics, and dogfood rollout.

## Desired behavior

### Version-pinned consumer

Agent Relay installs the exact C0-05 tarballs for:

- `@flowxo/notifications-contracts`; and
- `@flowxo/notifications`.

The pinned version and SHA-256 digest are recorded in the cross-repository lock
file introduced by C0-08. No sibling path, copied generated type, or mutable
branch is used in CI.

### Provider-neutral delivery mapping

Extend Agent Relay's delivery model with an optional provider-neutral
interaction:

```ts
interface DeliveryInteraction {
  type: "confirm" | "select" | "input";
  correlationId: string;
  prompt: string;
  expiresAt: string;
  options?: Array<{ value: string; label: string }>;
}

interface DeliveryMessage {
  eventId: string;
  title: string;
  text: string;
  interaction?: DeliveryInteraction;
}
```

Migrate existing `correlationId`/`choices` use into this shape without changing
direct Telegram behavior. Temporary deprecated aliases are allowed for one
internal migration commit but cannot remain the canonical contract at story
completion.

Map one Agent Relay delivery to Notifications:

| Agent Relay              | Notifications                                        |
| ------------------------ | ---------------------------------------------------- |
| `eventId`                | `Idempotency-Key` and message `correlation_id`       |
| title plus text          | One deterministic text body: title, blank line, text |
| interaction type/prompt  | Matching confirm/select/input interaction            |
| option value/label       | Matching opaque value and display label              |
| interaction correlation  | Interaction `correlation_id`                         |
| request expiry           | Interaction and message expiry                       |
| Notifications message ID | `DeliveryReceipt.messageId`                          |

No machine ID, local database path, shell command, session-resume invocation,
tool input, or raw permission payload is placed in notification content,
metadata, option values, or callback tokens.

The test transport implements `NotificationTransport.deliver`. A successful
Notifications `202` is a hosted-transport receipt, not proof the provider or
device accepted the message. Public diagnostic/status detail remains available
for AR2 but does not cause a second local attention event.

Notifications problems map to Agent Relay `TransportError`:

- explicit retryable API/availability failure: retryable;
- validation, auth, scope, unbound subscriber, or terminal rejection:
  non-retryable;
- connection loss around message creation: retryable only through the same Agent
  Relay event/idempotency key;
- message `outcome_unknown` after provider attempt: no new hosted send; surface
  diagnostic state; and
- unknown/unclassified response: retryable with bounded local policy and
  redacted diagnostics.

### Hosted-answer mapping

Add a pure adapter that accepts a validated Notifications machine event and
produces a local resolution input only after proving:

- correlation ID matches an open local pending request;
- machine identity is the locally configured machine stream;
- interaction type is compatible with the local request kind;
- answer value is one of the locally stored choices where applicable;
- event occurrence is not after local expiry; and
- expected machine/harness/session/turn identity still matches local state.

The adapter records resolution source as `notifications`, distinct from
`terminal` and direct `telegram`, but uses the existing atomic first-writer-wins
`RelayStore.resolveRequest` transition.

The consumer fixture acknowledges each hosted event only after it is:

- durably resolved locally;
- proven to be an already-resolved duplicate; or
- durably quarantined under the C0 contract with a stable safe reason.

Authentication, cross-machine identity, signature, and schema-integrity failures
are not acknowledged or quarantined to advance the cursor. They stop that stream
and surface a security/contract diagnostic.

A crash before acknowledgement repeats the event. Reprocessing produces the same
local resolution outcome and no duplicate resume command.

### C0 consumer proof

Add a deterministic contract test that:

1. starts the C0-05 mock;
2. ingests an Agent Relay request into SQLite;
3. delivers it through the contract transport;
4. injects a correlated mock human answer;
5. polls and validates the hosted event;
6. resolves the local request;
7. simulates a crash before acknowledgement;
8. polls the duplicate and proves local idempotency;
9. acknowledges the event;
10. proves the event no longer blocks cursor progress; and
11. runs the equivalent core behavior with direct Telegram to prove parity.

This is a test/contract consumer, not the AR2 production poller.

## Scope

### Included

- Exact Notifications contract/client artifact pin.
- Provider-neutral interaction extension and pure mapping functions.
- Contract-backed test transport.
- Hosted interaction-to-local-resolution adapter.
- Deterministic mock round trip, crash replay, and direct-Telegram parity tests.
- Stable error/diagnostic mapping documentation.

### Excluded

- Production Notifications credentials or configuration UI.
- Continuous daemon poller, backoff loop, health check, or installer changes.
- Hosted transport selection/fallback policy.
- Remote resume authority.
- Removal of direct Telegram.
- WebSockets.

## Implementation contract

### Ownership

Agent Relay owns:

- local event/request/session state;
- delivery mapping;
- local retry scheduling;
- validation against local identity;
- first-writer-wins resolution;
- resume decisions; and
- direct Telegram parity.

Notifications owns hosted message/interaction state and machine-event delivery.
Its answer event is evidence, not a local command.

### Interfaces affected

| Interface                           | Change                             | Compatibility requirement                                  |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `DeliveryMessage`                   | Add canonical typed interaction    | Existing noninteractive/direct Telegram behavior unchanged |
| `NotificationTransport` consumer    | Add contract-backed test transport | Uses same event ID on every retry                          |
| `RelayStore` resolution source      | Add `notifications` source         | Atomic terminal behavior unchanged                         |
| Notifications machine event adapter | Add pure validated mapping         | Cannot bypass local identity/expiry/options                |
| Agent Relay CI                      | Add pinned consumer contract test  | Runs without hosted account or public callback             |

### Data and lifecycle

The only allowed local schema change is adding the `notifications` resolution
source if SQLite validation requires it. This story does not add a production
cursor/credential table.

The mock consumer holds its committed cursor in the test harness. AR2 later
persists production cursor state. Existing pending-request/resume-command
lifecycle remains authoritative.

### Security and isolation

- Hosted event fields cannot select the local command or executable.
- The adapter checks local machine/harness/session/turn/request identity.
- Options are validated against local stored values, not trusted labels.
- Message rendering uses already-redacted Agent Relay content.
- Credentials/signatures are redacted from errors and snapshots.
- A hosted event for another machine/request is rejected, never acknowledged or
  quarantined to advance the cursor, and produces a durable security/contract
  diagnostic.

### Observability

Tests and mapping diagnostics use event ID, hosted message/event ID, local
correlation ID, machine/harness/session safe IDs, transport name, resolution
outcome, duplicate/expiry classification, and diagnostic code. They exclude
answers, prompts, credentials, project paths, and callback tokens from broad
logs.

## Acceptance criteria

1. **Given** each Agent Relay request kind, **when** mapped, **then** the
   Notifications request validates and preserves correlation, choices, and
   expiry without executable data leakage.
2. **Given** a repeated local delivery attempt, **when** the contract transport
   calls Notifications with the same event ID, **then** one hosted logical
   message exists.
3. **Given** a valid hosted answer, **when** mapped, **then** the matching local
   request resolves once through existing first-writer-wins state.
4. **Given** terminal or direct Telegram already won, **when** the hosted answer
   arrives, **then** it is a harmless duplicate and cannot create another resume
   command.
5. **Given** a crash after local resolution but before hosted acknowledgement,
   **when** the event repeats, **then** local state is unchanged and the event
   can then be acknowledged safely.
6. **Given** a mismatched machine/session/turn, stale answer, or unknown option,
   **when** mapped, **then** it cannot advance local state.
7. **Given** provider `outcome_unknown`, **when** diagnosed, **then** Agent
   Relay does not create a new hosted message automatically.
8. **Given** the core attention suite, **when** direct Telegram and the contract
   consumer tests run, **then** direct Telegram remains supported with
   equivalent local authority.

## Required tests

- **Unit:** Every delivery/request mapping, error classification, local answer
  validation, and resolution-source behavior.
- **Contract:** All mapped requests/events against pinned Notifications schemas.
- **Integration:** Full SQLite-to-mock-to-SQLite round trip and crash replay.
- **End to end:** Test fixture completes a correlated decision through the
  separate-process mock.
- **Security or isolation:** Cross-machine/session/turn, invalid option,
  executable-data scan, secret redaction, and first-writer-wins races.

## Delivery and rollout

The consumer proof landed after C0-05 published pinned draft artifacts. It
remains behind test-only construction and does not expose incomplete production
transport selection, credential storage, or continuous polling. AR2 promotes the
proven mapping into the daemon.

## Implementation guidance

- Reuse `packages/core/src/transport.ts`, `service.ts`, `store.ts`, and the
  existing `FakeTelegramTransport` tests.
- Put the contract client/mapping proof in the AR2-planned
  `packages/notifications-transport` boundary so it can be promoted without
  moving code; keep daemon wiring out of C0.
- Keep mapping functions pure and test them without HTTP.
- Route hosted resolution through `RelayStore.resolveRequest`; do not create a
  second state machine.
- Build the contract test around an isolated temporary SQLite database.
- Preserve the existing `pnpm check` command and add one focused contract script
  that it invokes.

## Autonomous decision allowance

The implementation agent may decide:

- mapping/helper file names;
- whether the test transport resides in core test support or a test-only
  package;
- internal error class wrapping; and
- fixture IDs/text.

The implementation agent must stop before:

- adding production daemon configuration or credential persistence;
- letting hosted events issue commands/resume directly;
- changing first-writer-wins behavior;
- removing or degrading direct Telegram;
- changing Notifications public contracts; or
- creating a second local request state machine.

## Completion evidence

- `contracts/contract-lock.json` pins exact `1.0.0-rc.1` artifacts:
  `@flowxo/notifications-contracts` at
  `02814c4ce1a963dbd8362eb270e42d9a42383f9257671a02f9f791bddfb00dc2`,
  `@flowxo/notifications` at
  `82d2136c35e0f9e5aa0ea3d67f1bae9c535f871c2bb13aa2e4cadcdbcb612c44`, and
  `@flowxo/notifications-contract-mock` at
  `9868dc62363b8119e001362c9c95be94dcadec370410f2a04bc86e9b49312e5e`.
- `pnpm contracts:notifications` verifies artifact safety and identity, mapping,
  schema compatibility, SQLite-to-separate-process-mock delivery, equivalent
  retry, crash-before-ack replay, acknowledgement, quarantine, cross-identity
  rejection, first-writer-wins behavior, and direct-Telegram parity.
- C0-08 adds canonical lock/policy digests, an additive-compatibility gate,
  fresh scripts-disabled installation, and deterministic generated evidence.
- The RC consumer commit `22a85f1` and exact PR #2 head `8315ed6` passed CI,
  packaged browser E2E, and secret scanning before merging to `main`.
- No production daemon transport selection, hosted credential persistence, or
  continuous poller is claimed by this story.

## References

- [C0 project specification](https://github.com/flowxo/flowxo-portfolio/blob/main/docs/projects/shared-contracts-and-autonomous-delivery-conventions/project-spec.md)
- [C0-03 interaction/machine contract story](https://github.com/flowxo/flowxo-notifications/blob/main/docs/projects/shared-contracts-and-autonomous-delivery-conventions/stories/c0-03-publish-interaction-and-machine-contracts.md)
- [C0-05 mock/client story](https://github.com/flowxo/flowxo-notifications/blob/main/docs/projects/shared-contracts-and-autonomous-delivery-conventions/stories/c0-05-deliver-notifications-mock-and-client.md)
- `agent-relay/packages/core/src/transport.ts`
- `agent-relay/packages/core/src/service.ts`
- `agent-relay/packages/core/src/store.ts`
- `agent-relay/docs/projects/notifications-transport-adapter/project-spec.md`
