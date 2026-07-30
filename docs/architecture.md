# Architecture and threat boundaries

> **Audience:** prospective users, operators, security reviewers, and
> contributors
>
> **Last verified:** 2026-07-28

Agent Relay is a local Node.js control layer between coding harness lifecycle
events and replaceable notification surfaces. It is not an agent runtime, a
remote shell, a transcript service, or a hosted control plane.

## The dependable loop

```text
Codex / Claude Code / Cursor
          │ native hook JSON
          ▼
runtime-validated harness adapter
          │ normalized attention event
          ▼
local daemon ─── SQLite queue, requests, claims, diagnostics
    │                         ▲
    │ bounded card            │ correlated answer
    ▼                         │
fake / Telegram / signed webhook / optional WhooshBang / local web
          │
          ▼
inline native hook response OR one owned late-resume command
```

SQLite is authoritative. A provider message, browser form, or in-memory worker
cannot independently decide that a request was answered. Every operator surface
uses the same runtime-validated, expiring, first-writer-wins transition.

## Components

| Component                 | Responsibility                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Protocol                  | Strict event, request, answer, command, session, and diagnostic contracts                         |
| Harness adapters          | Parse native payloads or implement one exact structured driver without channel coupling           |
| Hook runner               | Read one bounded stdin payload, contact the daemon, or write a redacted fallback                  |
| Local daemon              | Compose concrete adapters and own HTTP ingress, scheduling, polling, and retention                |
| SQLite store              | Persist identity, event order, attempts, requests, answers, topics, cleanup, and resume ownership |
| Notification contracts    | Define bounded delivery, receipt, topic, interaction, capability, and failure contracts           |
| Notification presentation | Render provider-neutral cards and negotiate interaction capabilities in core                      |
| Provider adapters         | Project cards to Telegram, a signed webhook, WhooshBang, or a fake without owning request state   |
| Supervisor                | Own a CLI child, observe its exit, and execute an officially supported late resume                |
| Web companion             | Present authenticated projections and submit typed decisions to the same store                    |
| Runner bridge             | Optional outbound session protocol, separate state, typed local harness actuation                 |

## Notification dependency direction

Notification providers are outbound and inbound adapters around one local
authority, not features embedded in core:

```text
@agent-relay/notification-contracts
            ▲                ▲
            │                │
  @agent-relay/core    provider adapter packages
            ▲          (telegram / webhook / WhooshBang)
            └──────────────┬─┘
                           │
                    apps/relay composition
```

`packages/notification-contracts` owns the provider-neutral transport protocol.
`packages/core/src/whooshbang` owns canonical presentation, interaction
negotiation, deterministic action identity, and the in-memory fake adapter.
`packages/telegram-transport` owns Bot API calls, callbacks, reply routing, and
sanitized Telegram fixtures. `packages/whooshbang-transport` owns the optional
hosted mapping. `packages/webhook-transport` owns the strict outbound envelope,
exact-byte signing, response validation, and HTTP failure policy. Only
`apps/relay` selects and assembles a concrete provider.

Provider adapters may depend inward on core application services when handling
an inbound answer. Core never imports a concrete provider adapter. This keeps
SQLite request authority reusable while allowing a provider to translate its
authenticated callback into the existing first-writer-wins transition.

The generic webhook is intentionally outbound-only in V1. Its opaque action
values do not grant callback authority. For open requests, it can carry a
credential-free local web handoff; the browser still authenticates with the
independent bearer and CSRF credential. A future inbound integration API
requires a separate threat model rather than exposing the current local routes
through a reverse proxy by implication.

The packages remain ordinary Node.js/macOS code. A transport may call a hosted
service, but protocol, hooks, SQLite, the installer, the daemon, and
continuation logic do not require Cloudflare or another hosted runtime.

The experimental [outbound runner bridge](runner-bridge.md) is an orthogonal,
default-off component. It owns a separate SQLite spool/effect ledger and a typed
structured-harness port. The app composition exposes one narrow core-store
ownership adapter for explicit local session adoption; neither bridge package
imports core. The bridge does not extend `NotificationTransport` or route runner
frames through Telegram, WhooshBang, or the web companion.

The first implementation of that port is the exact-version Codex app-server
driver. It owns a stdio child and exposes only typed lifecycle, turn, and
approval operations plus content-free observations. Local project/path and turn
material resolution remains outside the wire command. Durable adoption and
product/native event correlation are bridge-owned and remain separate from the
notification system. Existing hooks use an observation-only profile whose
advertised capabilities cannot be widened into product actuation.

## Evidence is deliberately separated

### Native hook evidence

A native hook proves that a documented harness event fired with a particular
session identifier. Stop and permission payloads can create attention requests.
Claude Code `StopFailure` and Cursor failure status can report a turn-level
failure. A native hook does not own the harness process and cannot prove that
the process crashed.

Codex and Claude Code `SessionStart` and `UserPromptSubmit` hooks also provide
privacy-safe lifecycle evidence. Agent Relay records that a session opened or an
operator submitted work, but never copies the submitted prompt into the
normalized event. These routine events use the transport's silent delivery mode;
stops, questions, permission decisions, failures, and stale-process warnings
remain notifying deliveries.

Claude Code Stop payloads also expose structured `background_tasks` and
`session_crons` collections. When either is non-empty, the adapter records only
their bounded counts as `turn.activity` and keeps the lane active. Transports
that advertise silent delivery receive the update without an operator ping.
Notify-only transports retain the durable `background-work` suppression guard.
Agent Relay never classifies background work from assistant prose, task
descriptions, commands, prompts, or a private transcript. A later Stop with both
collections empty follows the ordinary notifying waiting path. Equivalent
behavior is not claimed for another harness without an official structured
signal.

Malformed, oversized, or unknown input produces a bounded diagnostic. The raw
payload is not copied into SQLite, logs, the fallback spool, or a transport.

Native hook retries use two separate durable identities. The source fingerprint
keeps the event ID stable, while a per-machine/harness/session SQLite allocator
assigns a monotonic sequence. Retrying the same fingerprint reuses its original
allocation; distinct hooks advance under an immediate transaction across hook
processes and restarts. On first use after an upgrade, the allocator seeds from
retained event and session sequence state, including the earlier hash-derived
values, so a new event cannot rewind the displayed lane.

If the ordering store cannot be opened or written, the hook still preserves the
attention event in its ordinary daemon/fallback path using the former
retry-stable sequence and emits a bounded `hook-sequence-allocation-failed`
diagnostic. That is an explicit reduced-fidelity mode, not a claim of monotonic
ordering.

### Supervised exit evidence

`agent-relay run` starts and owns a CLI child. Only this owning process can
observe a spawn failure, non-zero status, or signal and create the validated
`owned-child` evidence required for `process.exited`. An ordinary hook cannot
manufacture that event.

Inactivity is not proof of a hang. The `suspected_stalled` state is reserved for
a future harness-specific health probe; Agent Relay currently emits no automatic
hang event or restart.

### Inline continuation

When a harness permits a Stop or permission hook to return a decision, the hook
may wait for a bounded interval. A correlated answer is encoded into that
harness's documented JSON output. The hook recursion field prevents the answer
from opening another wait loop.

Inline continuation ends when the hook timeout or request expiry wins. A later
answer is rejected as stale.

### Late CLI resume

For a supervised CLI session, a Stop event can create a durable continuation
request without holding the hook open. After the owned child exits, one
supervisor atomically claims the answer and invokes the harness's official
session-resume command using an argv array, never a shell string.

Execution authority is derived once from the initial invocation and fails
closed:

- Codex defaults to the `read-only` sandbox unless the initial argv selected
  another mode;
- Claude Code defaults to `plan` unless the initial argv selected another
  permission mode; and
- Cursor preserves workspace trust and `--force` only when the initial argv
  contained them.

A claimed resume is at-most-once. If the supervisor dies after the durable claim
but before process creation, the command remains visibly `claimed` for manual
diagnosis instead of risking a duplicate execution.

Cursor IDE late resume is unsupported. An IDE hook cannot safely be converted
into a separately owned Cursor CLI process. The tested Cursor CLI supports late
resume, but its initial Stop was proven only through the interactive path.

## Identity and isolation

The durable identity is machine + harness + session, with bridge, turn, request,
event, and tool identifiers where available. Telegram topics and browser session
keys are projections of that identity. Readable suffixes help the operator
distinguish sessions, while full opaque values remain local.

All answer paths verify the expected request and session. Telegram additionally
verifies configured operator, chat, topic, and originating delivery. Browser
mutations verify the local credential, CSRF token, origin, operation ID, session
key, and current event. Duplicate updates replay their stored outcome; a
different payload reusing an operation ID conflicts.

## Reliability boundary

- Event IDs make ingestion idempotent.
- Native hook sequence allocations are durable and monotonic per local session;
  exact retries reuse their first allocation.
- Delivery attempts use leases, retries, and visible dead letters.
- Fallback files are redacted, bounded, rotated, atomically claimed, and
  replayed.
- Telegram topic mappings survive restarts and are reconciled when the provider
  proves a topic is unavailable.
- Destructive topic cleanup requires a durable exact-set preview and authorized
  confirmation, then revalidates each explicit terminal tombstone immediately
  before provider deletion.
- Telegram maintenance controls echo the authenticated command's private-topic
  ID. Callback authority remains bound to the configured operator and chat,
  opaque operation token, and exact retained control message rather than an
  assumed General channel.
- Inactive-topic pruning is a distinct operator-authorized selection mode. Its
  durable cutoff never implies session death; successful deletion removes only
  the transport mapping so later activity provisions a fresh topic.
- A claimed deletion temporarily owns its exact topic mapping. Concurrent
  delivery retries instead of entering a topic being deleted; new queued work
  either makes revalidation skip deletion or provisions a fresh topic after the
  provider confirms it.
- Telegram has no caller-supplied send idempotency key. A crash after Telegram
  accepts a message but before its receipt commits leaves a narrow at-least-once
  duplicate window.
- Outbound webhooks reuse a stable delivery ID on every retry. Each attempt
  signs its exact JSON bytes as `<unix-seconds>.<body>` with HMAC-SHA256,
  refuses redirects, validates bounded acknowledgements, honors bounded
  `Retry-After`, and retains terminal or exhausted failure as a visible dead
  letter.
- Delivery or card-edit failure never silently reverses a committed operator
  decision.

## Data and trust boundaries

| Boundary           | Default posture                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- |
| Harness to hook    | Bounded stdin, runtime validation, safe native no-op on failure                     |
| Hook to daemon     | Loopback HTTP; optional independent daemon bearer                                   |
| Local persistence  | Private state directory, SQLite, redacted rotating logs, explicit retention         |
| Browser to daemon  | Loopback, generated bearer + CSRF, same-origin mutations, no CORS                   |
| Telegram           | Bounded plain-text card and opaque buttons; configured bot/chat/operator only       |
| Outbound webhook   | Strict bounded JSON, HTTPS/loopback endpoint, exact-byte HMAC, no inbound authority |
| Hosted WhooshBang  | Optional bounded transport contract; local SQLite retains decision authority        |
| Resume process     | Discrete argv, exact session, fail-closed initial authority, at-most-once claim     |
| Public diagnostics | Synthetic reproduction only; no databases, raw logs, credentials, or transcripts    |
| Runner bridge      | Outbound versioned frames; local binding and execution authority; no generic RPC    |

See [PRIVACY.md](../PRIVACY.md) for exact local files, outbound fields,
retention, and erasure, and [SECURITY.md](../SECURITY.md) for private reporting.

## Current source evidence

The generated [capability matrix](capability-matrix.md), public summaries,
doctor expectations, and runtime capability flags come from one
runtime-validated registry. The linked
[harness evidence ledger](harness-evidence.md) records official source links,
local CLI help, sanitized fixtures, and bounded live canaries. Parsing a payload
proves contract compatibility; it does not by itself prove a complete user
workflow.

The earlier [control-plane design](agent-attention-control-plane-design.md)
explains the design exploration. Where it differs from this document, the
current implementation, generated matrix, tests, and evidence ledger take
precedence.
