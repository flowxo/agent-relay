# Agent Relay — Open Source V1 Product Charter

- **Status:** Product and release source of truth
- **Initiative:**
  [Agent Relay — Open Source V1](https://linear.app/flowxo/initiative/agent-relay-open-source-v1-664f633c9408)
- **Last reconciled:** 2026-07-26
- **Technical sources of truth:**
  - `docs/agent-attention-control-plane-design.md`
  - `docs/implementation-brief.md`
  - `docs/capability-matrix.md`
  - `docs/harness-evidence.md`
  - `docs/progress.md`

## 1. Product outcome

Agent Relay gives a developer a reliable way to leave concurrent coding agents
running, receive attention events on a phone, and return an answer to the exact
session that needs it.

Open Source V1 should be:

- useful without a hosted account;
- safe to install and remove;
- honest about each harness's capabilities;
- deterministic about identity and continuation;
- private by default;
- diagnosable when a hook, network, provider, or resume path fails; and
- easy to connect to WhooshBang as an optional hosted transport.

## 2. Product statement

> Agent Relay is a local-first attention router for Codex, Claude Code, and
> Cursor. It turns harness events into durable notifications and routes an
> authenticated answer back to the correct session when the harness supports
> continuation.

It is not merely a notification hook. Its essential value is deterministic
correlation and safe continuation.

## 3. Current product evidence

The completed prototype already proves, through local tests and documented
fixtures:

- a versioned harness-neutral event and command protocol;
- Codex, Claude Code, and Cursor capability differences;
- safe native stop continuation where supported;
- local SQLite state for events, delivery, decisions, and resume commands;
- retry, dead-letter, retention, and redacted logs;
- direct Telegram delivery, callbacks, edits, and reply intake;
- first-writer-wins terminal/Telegram answers;
- concurrent-session isolation;
- opt-in process supervision and abnormal-exit evidence;
- late CLI resume under durable ownership;
- fallback spooling and replay;
- idempotent transactional installation and ownership-safe uninstall; and
- a diagnostic command and compiled-distribution canary.

Open Source V1 planning should build from this evidence. It must not restart the
architecture or rewrite the product around WhooshBang.

### 3.1 Release-candidate baseline

The authoritative Open Source V1 candidate is the integrated `main` history. It
descends from the completed multi-session MVP at `a4a6b5b`, then consumes the
coherent Agent Relay C0 history reviewed in
[PR #2](https://github.com/flowxo/agent-relay/pull/2):

1. `68b2fbf` — prove the Notifications contract consumer;
2. `100c250` — enforce the Notifications contract release gate;
3. `fee4629` — refresh Notifications routing evidence; and
4. `76240c4` — restore the C0-07 companion specification; and
5. `22a85f1` — consume the approved Notifications `1.0.0-rc.1` artifacts.

This lineage deliberately preserves the centrally reviewed commits. C0-07,
C0-08, and [C0-09](https://linear.app/flowxo/issue/FXO-1050) are complete; C0-09
recorded `go` for the exact pre-rename `1.0.0-rc.1` artifacts. That producer
identity was later retired by WhooshBang's pre-alpha hard cut, so
[FXO-1373](https://linear.app/flowxo/issue/FXO-1373) migrated the consumer to
the exact `@whooshbang/*` `1.0.0-rc.4` candidate and
[FXO-1436](https://linear.app/flowxo/issue/FXO-1436) advanced it to the exact
`1.0.0-rc.5` candidate, and the FXO-1209 re-vendor advanced it to
`contracts@1.0.0-rc.10`, `sdk@1.0.0-rc.11`, and `contract-mock@1.0.0-rc.13`,
which Agent Relay now consumes. Neither that approval, the migration, nor
mainline integration constitutes a public Agent Relay release or authorizes a
real WhooshBang service environment.

## 4. Target users

### Primary

- Individual developers running multiple coding-agent sessions.
- Small engineering teams comfortable operating a local developer tool.
- FlowXO's own engineering workflow as the first sustained dogfood user.

### Secondary

- Agent-harness and developer-tool authors who need a normalized attention
  protocol.
- Contributors adding transports or harness adapters.
- Teams evaluating a future hosted fleet-control layer.

### Not Open Source V1

- Non-technical consumer users.
- Enterprise policy administration.
- A hosted multi-user fleet dashboard.
- Full remote terminal or transcript mirroring.
- Guaranteed active steering for every harness and surface.

## 5. Product principles

### 5.1 Local state is authoritative

Machine, session, turn, pending-decision, continuation, and process ownership
remain local. A notification transport cannot authorize or resume a different
session by inference.

### 5.2 Harness capabilities are explicit

Unsupported behavior is a capability flag and user-visible limitation, never a
silent approximation.

### 5.3 Hooks detect; instructions assist

Native hooks and supervised process state own deterministic lifecycle
observation. MCP tools and instruction files improve explicit question semantics
but are not trusted as the only completion signal.

### 5.4 Privacy is the default

Agent Relay sends bounded summaries and identifiers. It does not upload full
transcripts, source code, environment variables, command output, raw usernames,
or hostnames by default.

### 5.5 Transports are replaceable

Fake transport, direct Telegram, and WhooshBang implement the same product-level
delivery responsibility. Open-source users are not required to adopt a hosted
service.

### 5.6 Continuation is never guessed

Every answer binds to machine, harness, surface, session, turn/request,
correlation ID, expiry, and supported continuation capability.

### 5.7 Portable core with conservative defaults

Agent Relay does not inherit the hosted FlowXO deployment architecture. Its core
protocol, storage, harness, process-control, and transport boundaries stay
behind interfaces that can be implemented on the operating systems and runtimes
supported by the open-source release.

SQLite remains the default local durable store because it is embedded,
inspectable, widely available, and already proven by the prototype. A
Cloudflare-backed capability may be offered as an optional hosted adapter, but
Durable Objects, Workers, queues, or any FlowXO private service must not become
requirements for local event capture, decision ownership, or continuation.

## 6. Open Source V1 release definition

### 6.1 Required

- Codex CLI, Claude Code CLI, Cursor CLI, and Cursor IDE capability matrix.
- Deterministic main-turn stop notifications where supported.
- Explicit input and permission events where supported and proven.
- Failure notification where a reliable harness signal exists.
- Optional process supervision for exit evidence.
- Safe inline continuation.
- Safe late CLI resume for supported surfaces.
- Local SQLite durability and offline spool.
- Idempotent retry and visible dead letters.
- Direct Telegram transport with long polling and webhook option.
- Correlated confirm/select/input handling.
- Atomic terminal-versus-phone decision resolution.
- Safe installer, upgrade, doctor, and uninstall.
- Redaction, payload limits, retention, and log rotation.
- Clear Cursor IDE late-resume limitation.
- Real credentialed Telegram canary.
- One live stop/continue canary per supported harness path where feasible.
- Public README, architecture, privacy, security, support, and contribution
  documentation.
- MIT license and copyright notice.
- Reproducible release packaging and versioned changelog.
- WhooshBang transport adapter.
- Direct Telegram fallback after WhooshBang integration.
- Sustained internal dogfood evidence.

### 6.2 Not required for V1

- Windows and Linux installers.
- Cursor IDE late resume after the stop hook returns.
- Active-turn steering for Cursor.
- Automatic restart after suspected stalls.
- Full encrypted transcript synchronization.
- A hosted session board.
- Team policies and cross-agent permission policy.
- Mobile-originated creation of new coding sessions.

## 7. WhooshBang relationship

WhooshBang becomes the recommended hosted transport for users who do not want to
create and operate a Telegram bot.

Agent Relay sends a normalized delivery request containing:

- stable local event ID as idempotency identity;
- bounded title and summary;
- correlation identity;
- optional confirm/select/input interaction;
- expiry; and
- safe display context.

WhooshBang returns:

- stable hosted message ID;
- durable acceptance state;
- delivery status/diagnostic identity; and
- authenticated interaction events.

Agent Relay remains authoritative for:

- whether the request is still open;
- which session it belongs to;
- whether a terminal response already won;
- whether the harness can continue;
- the exact continuation command; and
- whether a resume was already claimed.

WhooshBang never receives arbitrary local commands to execute. An interaction
becomes a typed Agent Relay command only after local validation and atomic
claim.

## 8. Transport behavior

The existing `NotificationTransport` abstraction is the starting point. The
Shared Contracts project may extend it carefully to support:

- hosted message identity;
- cursor-based long polling and acknowledgement for interactions;
- delivery-status diagnosis;
- explicit expiry/cancellation;
- resolved-message updates; and
- transport capability reporting.

The abstraction should not be widened to mirror every WhooshBang feature. Agent
Relay needs only its bounded attention/control use case.

### 8.1 Direct Telegram

Direct Telegram remains:

- the no-hosted-account path;
- a local integration canary;
- a fallback when WhooshBang is unavailable;
- a reference for transport contributors; and
- protection against product lock-in.

### 8.2 WhooshBang transport

The hosted transport should provide:

- account/device subscription onboarding without a bot token;
- durable server-side delivery and retries;
- phone/browser reach managed by WhooshBang;
- interaction ingress without exposing a local webhook;
- status and diagnostics; and
- future channel choice without changing Agent Relay's core protocol.

## 9. Open-source trust and governance

Open Source V1 should document:

- MIT license;
- maintainer and security contact;
- supported harness versions;
- compatibility policy;
- data sent by default;
- secrets and local files;
- telemetry policy;
- release signing or provenance;
- issue and contribution process;
- vulnerability reporting;
- hosted-service boundary; and
- how to use the product without FlowXO.

Hosted integration must not create an “open core in name only” design. Local
control, direct Telegram, protocol, harness adapters, storage, and continuation
remain open.

Agent Relay is released under the MIT license.

## 10. Operational and quality expectations

- Contract fixtures contain no private transcripts, tokens, usernames,
  hostnames, or real work paths.
- Every harness adapter has malformed, version-drift, and stop-recursion tests.
- Every delivery path has duplicate, timeout, retry, and terminal failure tests.
- Every interaction path has unauthorized, duplicate, stale, expired, and race
  tests.
- Every resume path has durable ownership and at-most-once execution.
- Installer changes are merge-aware, atomic, backed up, and reversible.
- A release is not claimed compatible with a harness version until the
  capability record and canary evidence are updated.

## 11. Success measures

- Installation succeeds without hand-editing configuration.
- A canary produces one correctly attributed phone notification.
- Duplicate local or hosted events do not create duplicate continuations.
- Eight simultaneous sessions remain isolated.
- A terminal and phone response racing resolve exactly once.
- A supported late reply resumes the exact CLI session once.
- WhooshBang can be disabled without disabling Agent Relay.
- Direct Telegram and WhooshBang transports pass the same core contract suite.
- Internal developers use the hosted path for a sustained period without
  bypassing it for reliability.
- Open-source users can understand the privacy model from the repository alone.

## 12. Principal risks

| Risk                                                | Response                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Harness hooks change rapidly                        | Versioned capabilities, fixtures, doctor warnings, compatibility canaries          |
| Hosted transport compromises local determinism      | Local source of truth and typed bounded transport contract                         |
| Open-source product appears to advertise WhooshBang | Preserve direct Telegram, document hosted service as optional                      |
| Permission automation becomes unsafe                | Enable only proven hook contracts; never turn infrastructure failure into approval |
| Resume executes twice                               | Durable local claim and at-most-once command ownership                             |
| User assumes all Cursor surfaces resume             | Explicit capability UI and retained non-resumable answers                          |
| Maintenance burden spans three harnesses            | Generated capability matrix and bounded support policy                             |

## 13. Initiative projects and dependency

### Cross-product dependency — Shared Contracts

- **Wave:** `wave:0-contracts`
- **Priority:** Highest
- **Status:** Complete; C0-09 recorded `go`

Agent Relay supplies a bounded transport-mapping work package to the single
cross-product Shared Contracts project. It does not create a second Agent
Relay-owned Linear project for the same seam.

The canonical cross-product specification lives in the neutral portfolio
repository at
`flowxo-portfolio/docs/projects/shared-contracts-and-autonomous-delivery-conventions/project-spec.md`.
Agent Relay's exact `1.0.0-rc.10`/`rc.11`/`rc.13` consumer and compatibility
gates are green. The separately controlled public package and
service-environment decisions remain outside C0.

### Completed prerequisite — Prototype evidence baseline

The direct Telegram activation and model-backed Codex, Claude Code, and Cursor
CLI stop/resume canaries are complete. The generated capability matrix,
implementation brief, harness evidence, and progress ledger remain the evidence
sources.

Cursor permission automation stays disabled until a current sanitized live
payload exists. That limitation does not justify a new project or block the
supported Open Source V1 surface.

### AR1 — Open Source Release Readiness

- **Wave:** `wave:1-independent-alpha`
- **Priority:** High
- **Linear:**
  [AR1 — Agent Relay Open Source Release Readiness](https://linear.app/flowxo/project/ar1-agent-relay-open-source-release-readiness-b2b3bf7d5fe3)
- **Status:** Completed

Complete licensing, security, privacy, contribution, packaging, provenance,
compatibility, and release documentation.

### AR2 — WhooshBang Transport Adapter

- **Wave:** `wave:1-independent-alpha`
- **Priority:** High
- **Linear:**
  [AR2 — FlowXO Notifications Transport Adapter](https://linear.app/flowxo/project/ar2-flowxo-notifications-transport-adapter-89e35890c6d7)
- **Status:** Completed against the executable mock and packed artifact

Implement against Shared Contracts mocks, preserve direct Telegram, and cover
delivery/interaction behavior with the common contract suite. The C0 outbound
mapping and executable consumer proof are already complete; production dogfood
waits for an approved WhooshBang environment and production implementation of
the narrow machine bootstrap and durable poll/ack stream.

### AR3 — Hosted Dogfood and Reliability Hardening

- **Wave:** `wave:2-agent-relay-dogfood`
- **Priority:** High
- **Linear:**
  [AR3 — Agent Relay Hosted Dogfood and Reliability Hardening](https://linear.app/flowxo/project/ar3-agent-relay-hosted-dogfood-and-reliability-hardening-96621124993f)
- **Status:** Planned; AR1, AR2, and C0-09 are complete, but no approved real
  WhooshBang machine-stream environment exists yet

Route real FlowXO engineering sessions through WhooshBang, collect evidence, and
fix reliability or diagnostic gaps in either product.

### AR4 — Public Open Source V1 Release

- **Wave:** `wave:4-external-beta`
- **Priority:** High after dogfood
- **Linear:**
  [AR4 — Agent Relay Public Open Source V1 Release](https://linear.app/flowxo/project/ar4-agent-relay-public-open-source-v1-release-7ff2a45ac039)
- **Status:** Planned; follows AR3 evidence

Publish the supported release, onboarding material, demonstration, and its
reproducible contribution to the separate reference-stack case study.

## 14. Decisions intentionally deferred

- Whether a later Agent Relay release adds WebSocket wake-up as an optimization
  over the V1 cursor-based long-poll contract.
- Whether Agent Relay exposes hosted setup through its own CLI or redirects to a
  browser/device flow.
- Final package registry and installer distribution channels.
- Supported-version window for each harness.
- Windows/Linux release timing.
- Whether a future hosted fleet product belongs in this initiative or a separate
  product.

These decisions belong in the relevant project specifications and must not
invalidate the local-first principles above.
