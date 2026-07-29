# Extending notification transports

A transport delivers a bounded presentation. It does not own requests, decide
answers, select sessions, execute commands, or resume a harness.

Start with the repository [contribution workflow](../CONTRIBUTING.md) and
[safe fixture guide](fixtures.md). A transport change uses the dedicated issue
and pull-request paths so authentication, callback correlation, default outbound
data, retention, and provider support claims receive the right review.

Start in `packages/notification-contracts/src/transport.ts`. The required
interface is:

```ts
interface NotificationTransport {
  readonly name: string;
  deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt>;
}
```

`DeliveryMessage` contains already-rendered title/text plus optional typed
interaction, multi-select, question-set, and action controls. `DeliveryContext`
contains a stable idempotency key and optional durable topic ID.

## Optional capabilities

Implement only what the provider can prove:

- `TopicNotificationTransport` creates and returns one durable topic ID;
- `TopicDeletionTransport` deletes one provider topic with an idempotent
  `deleted` or `already-missing` receipt;
- `InteractiveNotificationTransport` acknowledges callbacks and edits original
  or resolved messages;
- `OperatorControlTransport` sends and edits provider-neutral operator controls
  in an optional explicitly selected provider topic or unthreaded context; and
- `InteractionCapabilityTransport` reports observed provider limits for
  deterministic negotiation.

Do not advertise an optional interface and silently no-op its methods.
Unsupported interaction shapes must negotiate to another local surface or fail
visibly before delivery.

## Required invariants

### Local authority

SQLite creates, expires, and resolves requests. A provider callback becomes a
typed candidate answer and then passes through the same expected
machine/harness/session/turn/request transition as Telegram, terminal, and web.
The transport never writes a resume command directly.

### Stable identity and retries

Use `context.idempotencyKey` unchanged for every retry. Return a stable provider
message ID. Topic creation uses its separate stable idempotency key and persists
the returned topic before later messages use it. Topic deletion must be
idempotent from the caller's perspective: an already-absent provider topic is a
successful outcome, and the local topic mapping is retained until that receipt
commits.

Classify failures with `TransportError`:

- retryable network, timeout, rate-limit, provider-availability, and unknown
  failures keep the event durable;
- authentication, scope, validation, and known terminal failures dead-letter;
  and
- an ambiguous accepted/not-recorded outcome must be visible and must not
  trigger a fresh identity automatically.

Never catch and discard a transport failure.

### Bounded outbound data

Do not add raw hook payloads, transcripts, source code, tool input, process
arguments, absolute paths, machine IDs, or credentials. Reuse the canonical
rendered message and redaction helpers. Provider-specific mapping must be
documented in [PRIVACY.md](../PRIVACY.md).

Opaque action values are data, not executable commands. Provider text must never
be shell-interpreted.

### Correlated inbound data

Validate provider schemas and authentication before local lookup. Bind an answer
to the configured account/scope, provider message, interaction/request,
operator/subscriber where applicable, and locally retained identity. Enforce
expiry, option membership, and first-writer-wins state locally.

Duplicate provider deliveries must replay or acknowledge the stored local
outcome without repeating a resume. Unknown or cross-session answers are
quarantined or rejected with a bounded diagnostic.

## Implementation path

1. Add a sibling provider package that depends on
   `@agent-relay/notification-contracts`; do not put provider API code in core.
2. Add provider capability observation and negotiation only for proven shapes.
3. Map canonical delivery data without widening the privacy contract.
4. Map provider failures into retryable/terminal/ambiguous classes.
5. Add authenticated inbound validation as a pure step before local mutation.
6. Wire selection only in the `apps/relay` composition root; keep the fake
   transport available.
7. Document credentials, endpoint, disablement, retention, and uninstall.

The dependency direction is deliberate:

```text
notification-contracts <- core
notification-contracts <- provider adapter
core + provider adapters <- apps/relay
```

Core must not import a concrete provider package. An inbound adapter may depend
inward on core's application/store ports to submit a validated candidate answer;
that does not transfer request authority to the provider.

The in-memory fake transport in
`packages/core/src/notifications/adapters/fake.ts` is the reference test double.
The adapter in `packages/telegram-transport` demonstrates topics, buttons,
edits, polling/webhook correlation, and provider error classification without
placing Telegram Bot API code in core.

The Notifications adapter in `packages/notifications-transport` demonstrates a
provider-neutral contract mapping, explicit daemon selection, safe readiness
diagnosis, authenticated contract validation against pinned artifacts, and a
durable poll/claim/resolve/ack loop. Its optional resolution presenter is
separate from local authority and reuses one deterministic operation identity;
the pinned rc.1 implementation reports unsupported because that exact client has
no resolved-message update method. Its failure policy distinguishes retry,
configuration, security, quarantine, and operator action without permitting a
new identity. It does not claim a detached response signature that the C0 poll
contract does not provide. See the [hosted boundary](hosted-notifications.md).

## Minimum tests

- success and exact receipt persistence;
- duplicate event and callback delivery;
- retry, rate limit, timeout, and terminal error;
- ambiguous provider outcome;
- malformed and oversized provider payload;
- stale, expired, unauthorized, and cross-session answer;
- concurrent sessions with similar readable identity;
- provider answer racing terminal/web/Telegram answer;
- process restart between send, commit, answer, and acknowledgement;
- topic reuse and unavailable-topic reconciliation when supported;
- privacy/redaction and outbound size limits; and
- fake-canary parity without provider credentials.

Run `pnpm check`, `pnpm test:e2e` for changed operator surfaces, and the
provider's isolated contract suite. Update the architecture, privacy, support,
compatibility, progress, and changelog surfaces in the same change.

For a normal transport change, begin with:

```sh
pnpm fixtures:check
pnpm exec vitest run packages/core packages/notification-contracts
pnpm exec vitest run packages/telegram-transport
pnpm check
```

Then run `pnpm test:e2e` for changed operator flows and the provider-specific
contract command. All repository checks must stay credential-free; use the fake
transport or an executable mock for normal CI and reserve a bounded live canary
for a separately recorded compatibility claim.
