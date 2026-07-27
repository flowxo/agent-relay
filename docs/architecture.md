# Architecture and threat boundaries

> **Audience:** prospective users, operators, security reviewers, and
> contributors
>
> **Last verified:** 2026-07-27

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
fake transport / Telegram / optional Notifications / local web
          │
          ▼
inline native hook response OR one owned late-resume command
```

SQLite is authoritative. A provider message, browser form, or in-memory worker
cannot independently decide that a request was answered. Every operator surface
uses the same runtime-validated, expiring, first-writer-wins transition.

## Components

| Component              | Responsibility                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Protocol               | Strict event, request, answer, command, session, and diagnostic contracts           |
| Harness adapters       | Parse native payloads and emit only the native continuation JSON a harness supports |
| Hook runner            | Read one bounded stdin payload, contact the daemon, or write a redacted fallback    |
| Local daemon           | Own HTTP ingress, scheduling, transport delivery, reply routing, and retention      |
| SQLite store           | Persist identity, events, attempts, requests, answers, topics, and resume ownership |
| Notification transport | Deliver bounded cards; it cannot directly resume a harness                          |
| Supervisor             | Own a CLI child, observe its exit, and execute an officially supported late resume  |
| Web companion          | Present authenticated projections and submit typed decisions to the same store      |
| Runner bridge          | Optional outbound session protocol, separate state, typed local harness actuation   |

The packages remain ordinary Node.js/macOS code. A transport may call a hosted
service, but protocol, hooks, SQLite, the installer, the daemon, and
continuation logic do not require Cloudflare or another hosted runtime.

The experimental [outbound runner bridge](runner-bridge.md) is an orthogonal,
default-off component. It owns a separate SQLite spool/effect ledger and a typed
structured-harness port. It does not extend `NotificationTransport`, read the
attention database, or route runner frames through Telegram, Notifications, or
the web companion.

## Evidence is deliberately separated

### Native hook evidence

A native hook proves that a documented harness event fired with a particular
session identifier. Stop and permission payloads can create attention requests.
Claude Code `StopFailure` and Cursor failure status can report a turn-level
failure. A native hook does not own the harness process and cannot prove that
the process crashed.

Malformed, oversized, or unknown input produces a bounded diagnostic. The raw
payload is not copied into SQLite, logs, the fallback spool, or a transport.

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
- Delivery attempts use leases, retries, and visible dead letters.
- Fallback files are redacted, bounded, rotated, atomically claimed, and
  replayed.
- Telegram topic mappings survive restarts and are reconciled when the provider
  proves a topic is unavailable.
- Telegram has no caller-supplied send idempotency key. A crash after Telegram
  accepts a message but before its receipt commits leaves a narrow at-least-once
  duplicate window.
- Delivery or card-edit failure never silently reverses a committed operator
  decision.

## Data and trust boundaries

| Boundary             | Default posture                                                                  |
| -------------------- | -------------------------------------------------------------------------------- |
| Harness to hook      | Bounded stdin, runtime validation, safe native no-op on failure                  |
| Hook to daemon       | Loopback HTTP; optional independent daemon bearer                                |
| Local persistence    | Private state directory, SQLite, redacted rotating logs, explicit retention      |
| Browser to daemon    | Loopback, generated bearer + CSRF, same-origin mutations, no CORS                |
| Telegram             | Bounded plain-text card and opaque buttons; configured bot/chat/operator only    |
| Hosted Notifications | Optional bounded transport contract; local SQLite retains decision authority     |
| Resume process       | Discrete argv, exact session, fail-closed initial authority, at-most-once claim  |
| Public diagnostics   | Synthetic reproduction only; no databases, raw logs, credentials, or transcripts |
| Runner bridge        | Outbound versioned frames; local binding and execution authority; no generic RPC |

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
