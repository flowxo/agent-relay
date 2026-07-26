# Optional hosted Notifications boundary

Flow XO Notifications is an optional, replaceable notification transport. It is
not required for local SQLite, hooks, fake delivery, direct Telegram, the web
companion, supervision, or continuation.

Open Source V1 remains a local Node.js application. It does not require a hosted
Agent Relay account, Cloudflare runtime, public callback, or Flow XO credential.

## Current implementation state

`packages/notifications-transport` contains a private, test-constructed adapter
against exact pinned Notifications C0 artifacts. It proves:

- provider-neutral delivery mapping;
- stable event identity and idempotency key;
- bounded confirm/select/input interaction projection;
- explicit unsupported-shape failure;
- retryable, terminal, and ambiguous outcome classification;
- authenticated signed-answer validation;
- exact local machine/session/request/option/expiry binding;
- SQLite-first resolution and provider acknowledgement; and
- crash-before-ack replay without duplicate resume.

The adapter is not selected by the production daemon yet. It does not include
hosted credential persistence, production polling, callback deployment,
subscriber onboarding, or release-ready C0 promotion. Those belong to AR2 and
the centrally owned Notifications compatibility/security gates.

## Data contract

The hosted provider may receive only the bounded `DeliveryMessage` projection:

- deterministic event/correlation identity;
- rendered title and secret-redacted text;
- prompt, safe option labels, and opaque values for supported interactions; and
- expiry and acknowledgement metadata required by the contract.

It must not receive a raw hook payload, full transcript, repository contents,
tool input, executable command, process arguments, absolute path, machine
identity, or local credential. The provider cannot select or execute a resume.

Provider answers are untrusted until signature/schema/stream evidence,
configured scope, hosted message/interaction, local request identity, option
membership, occurrence, and expiry all match. The local first-writer-wins
transition remains authoritative.

## Failure boundary

Retries preserve the same event ID. Authentication, scope, validation,
subscriber, known terminal provider, and idempotency-conflict failures do not
retry as new messages. An ambiguous provider outcome forbids a fresh automatic
send and remains visible for diagnosis.

A provider acknowledgement happens after the local result commits. A crash
before acknowledgement can repeat the hosted answer, but the reopened SQLite
state proves it is a duplicate and the resume command remains single-owner.

## Deployment boundary

A future hosted adapter may call a Cloudflare-hosted Notifications service. That
does not move Agent Relay protocol, SQLite, hooks, installer, daemon, or
supervisor into Cloudflare. Direct Telegram and fake/local operation remain
independent transport choices.

Before production selection, AR2 must document and test:

- opt-in configuration and explicit disablement;
- credential storage, rotation, and uninstall behavior;
- endpoint/account scope and subscriber binding;
- polling or callback lifecycle and durable cursors;
- provider retention and privacy terms;
- retry/quarantine/reconciliation behavior;
- local fallback without double delivery;
- fake executable contract testing; and
- direct-Telegram parity for local authority and continuation.

No hosted service may silently become required for installation, doctor, local
canary, or uninstall.

See the [transport contributor guide](extending-transports.md), the pinned
[consumer package README](../packages/notifications-transport/README.md), and
the
[AR2 specification](projects/notifications-transport-adapter/project-spec.md).
