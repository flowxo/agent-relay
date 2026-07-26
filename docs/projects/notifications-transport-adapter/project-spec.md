# Project specification: FlowXO Notifications Transport Adapter

- **Status:** Planned; executable C0 consumer baseline complete; C0-09 gates
  production promotion
- **Product:** Agent Relay
- **Initiative:**
  [Agent Relay — Open Source V1](https://linear.app/flowxo/initiative/agent-relay-open-source-v1-664f633c9408)
- **Wave:** `wave:1-independent-alpha`
- **Priority:** High
- **Linear project:**
  [AR2 — FlowXO Notifications Transport Adapter](https://linear.app/flowxo/project/ar2-flowxo-notifications-transport-adapter-89e35890c6d7)
- **Owning repository:** `agent-relay`
- **Last reviewed:** 2026-07-26

## 1. Why this project exists

Direct Telegram proves Agent Relay's end-to-end behavior but asks every user to
create and operate a bot, configure credentials and operator IDs, and choose a
reply-ingress mode.

FlowXO Notifications should become the simplest hosted transport:

- the user authorizes Telegram through a managed subscription;
- Notifications owns the provider bot/webhook/delivery;
- Agent Relay sends a small provider-neutral request;
- a local daemon receives answers without exposing a public local webhook; and
- local SQLite remains authoritative for whether and how a coding session
  continues.

This project proves that Agent Relay can use the hosted service through public
contracts without rewriting its local control plane or weakening its open-source
independence.

The executable boundary is no longer an assumption. C0-07 is complete in
`68b2fbf`; C0-08 adds the immutable lock, compatibility policy, safe install,
and repository-native gate in `100c250`; and the exact Agent Relay
`1.0.0-draft.1` candidate through `76240c4` is green in
[PR #2](https://github.com/flowxo/agent-relay/pull/2). That evidence covers
provider-neutral mapping and mock-backed consumer behavior. It does not add
production daemon selection, credential persistence, or continuous hosted
polling. The centrally owned
[C0-09 security review](https://linear.app/flowxo/issue/FXO-1050) still gates
promotion to `1.0.0-rc.1` and production dogfood; mock-backed AR2 work may
proceed independently.

## 2. Outcome

At project completion:

1. Agent Relay can configure a Notifications machine client without storing a
   broad project API key permanently;
2. `NotificationTransport` sends bounded attention events through the
   Notifications C0 mock;
3. confirm/select/input answers arrive through cursor-based long polling;
4. each hosted answer resolves the exact local pending request at most once;
5. terminal and phone replies racing still use the existing local
   first-writer-wins transition;
6. local durable polling resumes after restart or network loss;
7. message resolution is reflected through Notifications when the contract
   supports it;
8. hosted errors are classified into retry, dead letter, authentication, and
   operator-action states;
9. direct Telegram remains fully functional; and
10. the two transports pass the same core attention/decision behavior suite.

Production service dogfood belongs to AR3/N3. AR2 completes against executable
contracts and mocks.

## 3. Users and jobs

- **Agent Relay user:** receive phone attention without operating a Telegram
  bot.
- **Agent Relay operator:** choose direct Telegram or hosted Notifications
  explicitly and switch without losing local work.
- **Maintainer:** support one bounded hosted adapter rather than importing the
  full Notifications product model.
- **Notifications team:** change its provider implementation without changing
  Agent Relay's local protocol.
- **Security reviewer:** prove that a hosted interaction cannot execute an
  arbitrary command or target another machine/session.

## 4. Scope

### 4.1 Included

- Notifications transport configuration and credential storage.
- Narrow machine-client creation/bootstrap flow.
- Explicit transport selection.
- Mapping `DeliveryMessage` to Notifications messages/interactions.
- Stable local event ID as the hosted idempotency identity.
- Hosted message ID storage.
- Cursor-based machine-event polling.
- Durable local event claim before server acknowledgement.
- Confirm/select/input mapping to the existing local resolution paths.
- Expiry, stale, duplicate, unauthorized, malformed, and wrong-machine handling.
- Hosted delivery-status diagnosis.
- Resolved-message update when supported.
- Redacted status/doctor checks.
- Contract-mock and consumer-driven tests.
- Direct Telegram parity tests.
- Documentation for hosted versus direct setup.
- Clean uninstall/state-retention behavior for hosted credentials.

### 4.2 Explicitly excluded

- Notifications provider implementation.
- Telegram/Slack/WhatsApp handling inside Agent Relay's hosted adapter.
- FlowXO agent conversations.
- General customer webhooks.
- A public local webhook.
- WebSocket machine-event transport.
- Hosted transcript, terminal, file, or source synchronization.
- Remote shell or arbitrary command execution.
- Hosted machine/session dashboard.
- Automatic send fan-out to both hosted and direct Telegram.
- Automatic failover that may produce duplicate visible messages.
- Moving pending requests, answer ownership, resume commands, or process
  authority out of local SQLite.
- Publishing stable Open Source V1.

## 5. Product behavior

### 5.1 Explicit transport selection

Agent Relay supports:

- `fake` for local/test operation;
- `telegram` for direct Bot API delivery; and
- `notifications` for the hosted service.

Selection is explicit in durable local configuration or a command-line override.
The presence of credentials does not silently change the selected transport.

If hosted delivery is unavailable:

- the local event remains retrying or dead-lettered under existing policy;
- the user sees an actionable diagnostic;
- the user may switch future/retry behavior deliberately; and
- Agent Relay does not automatically also send through direct Telegram.

An automatic fallback policy is deferred because two transports may reach the
same person and create duplicate decisions.

### 5.2 Setup flow

The V1 flow uses a broad project credential only for bootstrap:

1. The user creates or chooses a Notifications project/notifier.
2. The user runs `agent-relay notifications connect`.
3. The CLI reads a Notifications project API credential from stdin, environment
   injection, or an interactive hidden prompt—never a required positional
   argument.
4. Agent Relay creates a narrowly scoped machine client for its stable local
   machine ID.
5. Agent Relay generates a 32-byte runtime secret and random credential ID
   locally, registers only its SHA-256 digest, and smoke-tests the new narrow
   credential.
6. Notifications returns safe setup metadata:
   - machine-client ID;
   - Telegram subscriber authorization URL/status identity;
   - notifier/environment identity; and
   - capability/contract version.
7. Agent Relay stores only its locally generated narrow machine credential in a
   mode-`0600` credential file and discards the broad bootstrap credential.
8. The CLI prints/opens the subscriber link without claiming success yet.
9. After the user completes messenger authorization, the CLI verifies the
   binding and sends a synthetic canary.
10. `doctor` reports hosted transport readiness without showing secrets or
    provider IDs.

The machine credential is restricted to:

- send to the one configured notifier/subscriber binding;
- read and acknowledge only that machine client's interaction stream;
- inspect only its own hosted messages/diagnostics; and
- update only messages created by that client where supported.

It cannot administer the Notifications account, create unrelated subscribers,
read another machine, or attach a FlowXO agent.

The alternative dashboard flow generates the secret in the user's browser,
registers only its digest, and provides a one-time downloadable/importable
narrow credential. This avoids entering a broad project API key on the local
machine. Permanently storing a general project API key is not an acceptable V1
default.

### 5.3 Delivery

For each claimed local event, Agent Relay sends:

- stable local `eventId` as `Idempotency-Key`;
- bounded title and text;
- opaque local correlation ID where a reply exists;
- confirm/select/input interaction definition;
- opaque option values/labels;
- expiry;
- safe display context such as harness, surface, and shortened session label;
  and
- no arbitrary command, transcript, source, environment value, username,
  hostname, or raw path.

Notifications returns:

- stable hosted message ID;
- accepted state;
- status/diagnostic URL or ID;
- contract version; and
- effective capability/degradation information.

Agent Relay commits the hosted message ID through the existing delivery receipt
path. A retry with the same local event ID returns the same hosted message.

### 5.4 Interaction polling

The daemon maintains one durable polling stream per configured machine client:

1. Read the last durably acknowledged cursor from SQLite.
2. Request events after that cursor with a bounded long-poll wait.
3. Validate response schema, credential-bound client identity, contract version,
   event order, occurrence, and expiry.
4. Process events in stable order.
5. For each event, begin a SQLite transaction.
6. Claim hosted event ID idempotently.
7. Correlate hosted message and opaque correlation/option token to a local open
   request.
8. Invoke the existing local first-writer-wins resolution transition.
9. Persist the hosted-event outcome and safe diagnostic.
10. Commit locally.
11. Acknowledge the hosted event to Notifications.
12. Advance local committed cursor only across durably handled events.

If the server acknowledgement fails, the event may repeat; the local claim
returns the original result and acknowledgement is retried.

A malformed or wrong-machine event is recorded safely and must not let the
cursor skip unhandled earlier work. Terminal poison-event policy requires an
explicit bounded quarantine record and acknowledgement rule in the C0 contract.

### 5.5 Local authority

Notifications `interaction.received` means the hosted service authenticated and
correlated a response. Agent Relay still decides:

- whether the request exists;
- whether it is open;
- whether it is expired;
- whether a terminal answer already won;
- whether machine/harness/session/turn identity matches;
- whether the answer maps to an allowed option or bounded free text;
- whether the harness supports continuation;
- what argv may execute; and
- whether a resume command has already been claimed.

No hosted field is treated as executable data.

### 5.6 Resolution reflection

After local resolution:

- if the phone answer won, acknowledge it as recorded and update the hosted
  message to a terminal “handled” state;
- if the terminal answer already won, classify the phone response as duplicate
  and update/acknowledge without changing local state;
- if expired/cancelled, show that state;
- if unsupported, retain the answer locally for inspection but do not invent a
  continuation; and
- if the hosted update call fails, local resolution remains authoritative and a
  bounded retry updates presentation later.

Updating the messenger presentation is never part of the atomic continuation
claim.

### 5.7 Status and diagnosis

`agent-relay status` and `doctor` show:

- selected transport;
- Notifications API origin;
- contract version;
- machine-client ID in safe shortened form;
- credential present/permissions valid;
- subscriber binding active;
- last successful send;
- pending/retrying/dead-letter counts;
- last successful poll;
- committed cursor;
- unacknowledged local hosted event count;
- last classified hosted error; and
- direct Telegram availability when configured.

They never show API keys, full provider identity, question/answer, or private
message content.

### 5.8 Disconnect and revocation

- Network loss stops hosted calls but not hook intake or local persistence.
- Laptop sleep/restart resumes delivery and polling from SQLite.
- A revoked credential is terminal for hosted calls and produces one
  rate-limited actionable diagnostic.
- Reconnect uses an explicit setup/rotation flow.
- Removing the hosted configuration does not delete local events or requests.
- Uninstall keeps credentials/state by default, consistent with current
  uninstall policy, and documents optional erasure.

## 6. Architecture and interfaces

### 6.1 Existing boundary

The existing `NotificationTransport` remains the outbound core:

```ts
interface NotificationTransport {
  readonly name: string;
  deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt>;
}
```

The Notifications adapter implements it without importing app-local daemon or
SQLite classes.

### 6.2 New bounded interfaces

Do not make `NotificationTransport` mirror the entire hosted API.

Recommended separate roles:

```ts
interface NotificationInteractionSource {
  poll(input: {
    after?: string;
    waitSeconds: number;
    signal?: AbortSignal;
  }): Promise<PolledInteractionBatch>;

  acknowledge(input: {
    eventId: string;
    cursor: string;
    disposition: "processed" | "quarantined";
    reasonCode?: string;
    idempotencyKey: string;
  }): Promise<void>;
}

interface HostedMessageUpdater {
  markResolved(input: {
    messageId: string;
    outcome: "answered" | "duplicate" | "expired" | "cancelled" | "unsupported";
    resolvedBy?: "terminal" | "notifications";
  }): Promise<void>;
}
```

Exact names may change, but outbound delivery, inbound event source, and
presentation update stay separable.

Direct Telegram continues using its native poller/reply router; hosted
Notifications produces provider-neutral interaction events and must not enter
`TelegramReplyRouter`.

### 6.3 Packages

Recommended additions:

```text
packages/
  notifications-transport/
    src/
      client.ts
      transport.ts
      interaction-source.ts
      schemas.ts
      errors.ts
      fixtures/
```

The package:

- depends on Agent Relay transport/domain types and the pinned Notifications
  contract package or generated types;
- uses ordinary `fetch`;
- has no Cloudflare runtime import;
- has no SQLite dependency;
- has no Telegram types;
- validates all network boundaries; and
- can be tested against the C0 mock independently of the daemon.

Daemon/app code owns configuration, credential file, polling loop, SQLite
claims, and resolution invocation.

### 6.4 Contract ownership

| Contract                                     | Owner                |
| -------------------------------------------- | -------------------- |
| Notifications message API                    | FlowXO Notifications |
| Notifications machine event poll/ack         | FlowXO Notifications |
| Notifications machine bootstrap credential   | FlowXO Notifications |
| Agent Relay `DeliveryMessage` mapping        | Agent Relay          |
| Agent Relay local hosted-event record/cursor | Agent Relay          |
| Agent Relay local resolution/continuation    | Agent Relay          |

Pinned schemas/fixtures come from the owner. Agent Relay does not hand-copy
Notifications types as its only compatibility mechanism.

## 7. Data and lifecycle

### 7.1 Local configuration

Non-secret configuration:

- selected transport;
- Notifications base URL;
- environment/notifier display identity;
- machine-client ID;
- expected contract major version; and
- connection status metadata.

Secret configuration:

- machine credential;
- optional credential version/creation time; and
- rotation metadata that is not itself secret.

Secret file is mode `0600`, written atomically, excluded from logs/backups by
default, and never stored in SQLite event payloads.

### 7.2 SQLite additions

| Record                       | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| hosted delivery mapping      | local event ID to hosted message ID, transport, and status identity |
| machine poll state           | machine-client ID, committed cursor, last success/error             |
| hosted event claim           | hosted event ID unique, cursor/order, local outcome, timestamps     |
| hosted acknowledgement state | pending/acknowledged/retry metadata                                 |
| hosted message update state  | pending/succeeded/terminal update attempt                           |

Existing pending requests, events, delivery attempts, decisions, resume
commands, and Telegram update claims stay canonical and are not duplicated.

### 7.3 Hosted event lifecycle

```text
received
  -> locally_claimed
  -> locally_resolved
  -> ack_pending
  -> acknowledged
```

Alternate local terminal outcomes:

- duplicate;
- expired;
- cancelled;
- uncorrelated;
- identity_mismatch;
- unsupported;
- malformed_quarantined.

Every outcome is durable before server acknowledgement.

### 7.4 Retention

- Open/unacknowledged hosted events are never pruned.
- Acknowledged event claims follow existing request/delivery retention.
- Machine cursor persists for the life of the configured client.
- Revoked credential may be erased while keeping non-secret diagnostic state.
- Hosted message IDs are retained only as long as delivery/request diagnosis
  needs them.
- No hosted response body is retained raw after validation/normalization.

## 8. Error model

Map hosted failures to stable Agent Relay categories:

| Hosted condition                       | Local behavior                                                |
| -------------------------------------- | ------------------------------------------------------------- |
| 401 invalid/revoked machine credential | terminal configuration error; stop aggressive retry           |
| 403 wrong machine/scope                | security diagnostic; no processing                            |
| 404 message/client removed             | terminal for resource, actionable reconnect                   |
| 409 idempotency mismatch               | dead letter/security diagnostic                               |
| 429 rate limit                         | retry at server-provided safe time                            |
| 5xx/temporary unavailable              | bounded retry                                                 |
| network timeout before response        | retry using same idempotency key for send; repeat poll safely |
| schema/contract major mismatch         | fail closed and require upgrade                               |
| malformed event                        | quarantine under C0 poison-event rule                         |
| expired interaction                    | local expired outcome; acknowledge                            |

Hosted error bodies and diagnostics are redacted before local persistence.

## 9. Security and privacy

- Bootstrap API credential is read through a secret-safe input path and not
  written permanently.
- Stored machine credential is least-privilege and mode `0600`.
- Machine credential secret is generated locally; Notifications receives and
  stores only its SHA-256 digest.
- HTTPS is required except explicit loopback contract-mock tests.
- Custom API origins require an explicit unsafe-development flag when not
  loopback/HTTPS.
- Redirect following is bounded and cannot send credentials to a different
  origin.
- Response bodies have size limits before parsing.
- Contract major/version is validated.
- Machine/client identity in an event must match configuration.
- Hosted interaction tokens are opaque data passed to existing local token
  resolution; they are not commands.
- Local correlation includes machine, harness, surface, session, turn/request,
  and expiry.
- Logs exclude credential, question, answer, message content, subscriber
  identity, and provider identity.
- Config/doctor output redacts credential and full IDs.
- Untrusted server text is never shell-interpreted.
- Message/update presentation calls cannot widen execution authority.

## 10. Reliability

- Send uses local event ID idempotency.
- Queue/service duplicates return the same hosted message.
- Local delivery attempt state remains the retry source of truth.
- Poll response repeats are harmless.
- SQLite commit precedes hosted acknowledgement.
- Cursor cannot advance past unhandled work.
- Poll cancellation on daemon shutdown does not create an error/dead letter.
- Laptop sleep and process restart recover.
- Resolution reflection retries separately from local decision.
- Direct Telegram has an independent canary and remains available.
- Contract-mock outage cannot corrupt local state.

## 11. Test strategy

### 11.1 Mapping/unit

- bounded title/text mapping;
- choices to confirm/select;
- free-text request to input;
- expiry;
- idempotency header;
- no command/session leakage;
- error classification;
- response-size and schema validation;
- redirect/origin security; and
- redaction.

### 11.2 C0 consumer contract

- first send and receipt;
- duplicate equivalent send;
- idempotency conflict;
- retryable/terminal send errors;
- interaction poll with zero/events;
- repeat unacknowledged event;
- ack idempotency;
- wrong machine credential;
- stale/expired/duplicate event;
- cursor ordering;
- contract version mismatch;
- resolved-message update; and
- credential revocation.

### 11.3 SQLite/daemon integration

- durable hosted delivery mapping;
- restart between poll and local claim;
- restart after local commit before ack;
- terminal answer wins before phone answer;
- phone answer wins before terminal answer;
- two machines cannot consume each other's events;
- two concurrent sessions remain isolated;
- free-text/choice exact resolution;
- unsupported late resume retains answer;
- ack/update retry does not repeat continuation;
- credential rotation; and
- removal of hosted config preserves local work.

### 11.4 Transport parity

The fake, direct Telegram, and Notifications transports run common behavior for:

- one event creates one delivery receipt;
- retry uses same local idempotency;
- confirm/select options stay opaque;
- input remains bounded;
- duplicate answer resolves once;
- stale/expired answer does not continue;
- terminal/phone race resolves once; and
- resolved presentation failure does not reverse local resolution.

Provider-specific setup and rendering remain provider tests, not parity
requirements.

### 11.5 End to end against mock

1. Create synthetic machine client.
2. Configure hosted transport.
3. Ingest an input-required event.
4. Deliver through mock Notifications.
5. Mock a subscriber answer.
6. Poll and durably resolve locally.
7. Acknowledge hosted event.
8. Claim and execute exactly one fake resume.
9. Restart daemon and prove no duplicate.

No cloud credentials or model invocation are required.

## 12. Observability and operator behavior

Structured safe events:

- hosted transport configured/disconnected;
- send accepted/retry/dead-letter;
- polling connected/disconnected/backoff;
- hosted event received/duplicate/resolved/quarantined;
- ack pending/succeeded/terminal;
- resolved-message update pending/succeeded/terminal;
- credential invalid/version mismatch; and
- contract version.

Metrics remain local status/counts in Open Source V1. No hosted telemetry is
sent beyond the product API operations the user configured.

Expected empty long polls are not logged. Repeated auth/config errors are
rate-limited.

## 13. Rollout and rollback

### Rollout

1. Implement package and mapping against C0 mock.
2. Add SQLite migrations and daemon poller behind `notifications` selection.
3. Run full direct Telegram regression.
4. Run packed-package contract canary.
5. Connect to Notifications staging in AR3/N3.

### Rollback

- User selects `telegram` or `fake`.
- Hosted poller stops cleanly.
- Local SQLite retains hosted mappings/events for diagnosis.
- No migration down is required.
- Reinstalling previous prerelease is allowed only when its SQLite schema reader
  is compatible.

## 14. Decisions already made

- Notifications is an optional hosted transport.
- Direct Telegram remains supported.
- Transport selection is explicit.
- Broad project credentials are not stored as the default runtime credential.
- Machine credential is narrow to one machine/notifier/subscriber stream.
- Machine credential secrets are generated and retained locally; Notifications
  stores only their digest.
- Local SQLite remains authoritative for decisions and continuation.
- Inbound answers use durable long polling in V1.
- Local commit occurs before hosted acknowledgement.
- WebSocket is a future latency optimization.
- Automatic dual-send/failover is excluded.
- Hosted provider types do not enter Agent Relay.
- No arbitrary local command crosses the Notifications contract.

## 15. Decisions deliberately left to implementation

- Exact internal class/file names for the bounded interfaces.
- Poll jitter/backoff constants within service contract bounds.
- SQLite index names.
- CLI progress display.
- Whether browser opening is automatic or opt-in when printing the link always
  works.
- Internal HTTP client helper selection.

## 16. Open decisions

### 16.1 Hosted resolved-message update

**Recommended:** Notifications exposes a bounded idempotent resolution update
for the originating machine client. If it is not in Commercial V1, AR2 treats
presentation update as an optional capability and does not block local
resolution.

## 17. Delivery slices

1. **Contract client and mapping (complete prerequisite)** — outbound delivery
   passes the pinned C0 mock.
2. **Safe setup and configuration** — narrow credential and explicit transport
   selection work.
3. **Durable interaction poller** — local claim/resolve/ack survives restart.
4. **Presentation and diagnosis** — resolved update, status, doctor, and error
   handling work.
5. **Transport parity and packaged canary** — fake/direct/hosted core behavior
   and distribution evidence pass.

## 18. Story map

Linear is authoritative for execution status and relationships. The completed C0
consumer is a prerequisite, not a duplicate AR2 story. Material implementation
stories receive a companion file under:

`docs/projects/notifications-transport-adapter/stories/`

| Order | Linear story                                                                                                                                  | Purpose                          | Primary prerequisite            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------- |
| C0    | [FXO-1048 — Prove Agent Relay against the Notifications contract](https://linear.app/flowxo/issue/FXO-1048)                                   | Provider-neutral consumer proof  | Complete                        |
| 1     | [FXO-1150 — Configure a narrow Notifications machine client without retaining a broad project key](https://linear.app/flowxo/issue/FXO-1150)  | Safe hosted setup                | C0 machine bootstrap contract   |
| 2     | [FXO-1151 — Select fake, direct Telegram, or Notifications explicitly and diagnose readiness](https://linear.app/flowxo/issue/FXO-1151)       | Predictable operation            | FXO-1150                        |
| 3     | [FXO-1152 — Poll, claim, resolve, and acknowledge hosted interaction events durably](https://linear.app/flowxo/issue/FXO-1152)                | Exact-session hosted answer path | C0 poll/ack and FXO-1150–1151   |
| 4     | [FXO-1153 — Reflect local resolution and classify hosted failures without changing local authority](https://linear.app/flowxo/issue/FXO-1153) | Accurate presentation/diagnosis  | FXO-1152                        |
| 5     | [FXO-1154 — Run common attention and decision behavior across fake, Telegram, and Notifications](https://linear.app/flowxo/issue/FXO-1154)    | Prevent hosted divergence        | FXO-1152–1153                   |
| 6     | [FXO-1155 — Document and prove the hosted adapter from a packed release artifact](https://linear.app/flowxo/issue/FXO-1155)                   | AR3-ready reproducible handoff   | FXO-1150–1154 and AR1 packaging |

## 19. Acceptance evidence

- Agent Relay sends through the C0 mock with stable local idempotency.
- Equivalent retry returns one hosted message.
- Idempotency mismatch fails safely.
- Broad bootstrap credential is not retained.
- Narrow credential cannot read another machine/client stream.
- Restart before/after local claim produces no duplicate continuation.
- Terminal/hosted answer race resolves once.
- Confirm/select/input map correctly.
- Stale, expired, duplicate, malformed, and wrong-machine events are safe.
- Server ack failure repeats harmlessly.
- Resolved presentation failure does not reverse local resolution.
- Direct Telegram passes unchanged.
- Hosted transport can be removed without deleting local state.
- Packed artifact completes the mock end-to-end canary.
- Logs/status contain no credential, provider ID, question, answer, transcript,
  or raw session identity.

## 20. Definition of done

- The hosted adapter is complete against pinned executable C0 contracts.
- Local authority and transport replaceability are demonstrable.
- Contract/update/migration/security review gates pass.
- Direct Telegram remains a tested release path.
- Production integration work can begin in AR3/N3 without architectural
  invention.

## 21. References

- `docs/product/open-source-v1-charter.md`
- `docs/implementation-brief.md`
- `docs/progress.md`
- `packages/core/src/transport.ts`
- `packages/core/src/service.ts`
- `packages/core/src/reply-router.ts`
- Portfolio
  `docs/projects/shared-contracts-and-autonomous-delivery-conventions/project-spec.md`
- Portfolio `docs/roadmaps/delivery-roadmap.md`
