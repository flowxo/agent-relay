# Experimental outbound runner bridge

> **Audience:** contributors and integration evaluators
>
> **Status:** default-off development component; the exact Codex app-server
> adapter is verified, but ordinary daemon composition and a public service
> connection remain unavailable

The runner bridge is a separate outbound session-control component. It lets a
future structured harness adapter exchange `runner.protocol/v1` frames with a
session control plane while Agent Relay retains local execution authority.

It is not a notification transport. It does not import direct Telegram, Flow XO
Notifications, the local web companion, or rendered attention cards. Existing
standalone attention behavior continues through the current core and replaceable
`NotificationTransport` boundary.

## Component boundary

```text
session control plane
        ▲     │
 events │     │ typed commands
        │     ▼
runner.protocol/v1 outbound connection
        ▲     │
        │     ▼
@agent-relay/runner-bridge
  protocol codec · bridge SQLite · lane spool · effect ledger
        ▲     │
 native │     │ allowlisted methods
 events │     ▼
StructuredHarnessDriver
        ▲
        │ exact typed port
        ▼
@agent-relay/codex-app-server-driver
  owned stdio process · local material resolution · safe observations
```

`StructuredHarnessDriver` exposes one method per supported command family. It
has no generic executable, argv, shell, filesystem, environment, credential, or
native-RPC method. The exact `codex-cli 0.145.0` app-server implementation owns
its child process and implements session start/resume, turn
start/follow-up/steer/interrupt, and exact pending approval resolution.
Project/artifact/diagnose and session-pause operations remain unsupported.

Native notifications become content-free structured observations containing only
opaque native references, lifecycle status, item/approval kind, timestamp, and
safe code. The bridge resolves those local references through durable
session/turn/item/approval correlation and emits only product-qualified,
metadata-classified semantic events. The adapter never sends rendered attention
cards.

An observation-only structured profile also represents existing hook/CLI/IDE
attention evidence. Its capability descriptors contain only `session.observe`,
`turn.observe`, and `attention.observe`; every actuator method is unsupported.
The app composition derives its exact fidelity limits from the runtime-validated
harness registry. In particular, Codex, Claude, and Cursor CLI observation does
not claim active steering, Cursor permission automation remains disabled, Cursor
IDE late resume remains unavailable, and a hook never becomes process-exit
proof.

## Default-off composition

The daemon contains an optional composition point. It starts a bridge only when
both conditions are true:

1. the runner bridge is explicitly enabled; and
2. a structured bridge runtime has been installed at the composition root.

Either condition without the other fails before daemon networking starts.
Without both, no bridge store is opened and the existing fake, Telegram,
Notifications, web, hook, and supervisor paths run unchanged.

The experimental local selection commands are:

```sh
agent-relay runner-bridge status
agent-relay runner-bridge enable
agent-relay runner-bridge disable
agent-relay runner-bridge erase --confirm
```

The verified native adapter package is not automatically composed from CLI
configuration. `enable` records intent but still reports
`nativeAdapterRequired: true`; ordinary daemon startup fails closed until the
runner identity, project material resolver, transport, and durable adoption
runtime are installed together at the composition root. This command is for
integration development, not current end-user onboarding.

## Local state and privacy

Bridge state is separate from standalone attention state:

- `runner-bridge.json` is a strict, mode-`0600` enablement selection;
- `runner-bridge.sqlite` stores runner authority, product/native bindings, lane
  cursors, queued frames, sanitized effect outcomes, reconciliation state,
  product/native turn/item/approval correlation, observation deduplication, and
  adoption intents/outcomes.

The bridge database may contain private native session references and must not
be shared. Status and doctor expose only a hashed authority reference, counts,
cursors, lifecycle state, protocol version, and stable safe error codes. They do
not expose proof material, leases, native references, frame bodies, source,
transcripts, prompts, tool input/output, paths, environment, or credentials.

Disablement preserves both bridge and standalone state. `erase --confirm`
refuses while enabled and removes only the exact runner bridge selection,
database, and SQLite sidecars. It never erases `relay.sqlite`, Telegram state,
Notifications state, hooks, logs, web credentials, or fallback records.

## Durability and command safety

- Wire frames are validated by the exact pinned protocol codec.
- Inbound lane cursors advance only without gaps.
- Outbound frames are persisted before delivery and retained until acknowledged.
- Commands must match local runner authority, project authorization,
  product-managed binding, capability snapshot, exact scope, current revision,
  body schema, and expiry.
- Durable command acceptance precedes the allowlisted driver call.
- `turn.start` and `turn.follow_up` persist a pending product turn before native
  invocation, then bind the returned native turn before completing the effect.
  Steer and cancel require that exact durable mapping after restart.
- A native approval request stores one generated product approval/tool-call
  mapping with a normalized action digest and expiry. Resolution must match the
  complete closed runner binding. The bridge marks it `dispatching` before
  releasing the local native request reference; restart or ambiguity becomes
  `outcome_unknown` and is never retried automatically.
- `session.start` is the sole operation permitted without an existing native
  session reference. Its completed result must return one bounded opaque thread
  reference, which is persisted exactly once before the effect is completed.
- The idempotency key and canonical effect fingerprint identify one semantic
  effect. Changed reuse fails closed.
- A crash, timeout, or unprovable native result becomes `outcome_unknown` and is
  never executed again automatically.
- Reconciliation is lease-bound and carries bounded sanitized effect outcomes.
- Matching revocation persists before the connection closes and survives
  restart.
- Event flow control retains paused frames; spool exhaustion rejects new effects
  while preserving control-lane capacity.

## Standalone observation and adoption

Standalone attention and product-managed actuation have explicit, monotonic
ownership. Absence of a row in the standalone core store means
`standalone-attention`; an observation-only bridge binding does not change that
authority.

The local adoption service can claim one exact eligible Codex CLI checkpoint for
the verified Codex app-server profile. The request binds machine, surface,
native session, bridge session, sequence, project/capability digests, harness
version, product scope, revision, profile, issue time, and expiry. The core
compare-and-set rejects changed, terminal, unknown, competing, or interactive
sessions. After the claim commits, standalone event ingestion for that session
fails closed.

The bridge writes its intent before the core claim. If the process stops after
the core commit but before the bridge binding, restart inspects the same durable
receipt and completes only that request. It never implicitly restores standalone
ownership. Public adoption UX and reverse transfer are intentionally not
implemented in this experimental component.

## Pinned contract

`contracts/runner-protocol-lock.json` records the two vendored `0.0.0`
artifacts, exact SHA-256 digests, 33-case fixture inventory, and
`internal-until-gate-5` commitment. Run:

```sh
pnpm contracts:preinstall
pnpm contracts:runner
```

The current lock records an exact clean source commit and
`release_eligible: true`. The producer built both archives twice with
byte-identical output, and the cross-repository verifier matched this consumer's
33-case result to that producer manifest. This provenance permits review and
packaging; it does not by itself promote the experimental protocol to a public
compatibility promise or authorize publication.

No mutable branch or sibling checkout is used at runtime or during normal
contract verification.
