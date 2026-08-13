# AR5.1: Cross-harness activity evidence and timing policy

- **Linear:** FXO-1601
- **Status:** Complete
- **Started:** 2026-08-13
- **Completed:** 2026-08-13
- **Compatibility boundary:** unchanged

## Outcome

This is the implementation-facing research ledger for the canonical session
activity reducer planned in AR5.2. It separates evidence already proven on the
frozen Agent Relay support versions from newer official contract surfaces.
Nothing in this document widens the generated compatibility matrix.

The accepted user-visible states remain `Working`, `Needs input`,
`Background work`, `Idle`, `Done`, `Failed`, `Unknown`, and `Ended`. Muted
delivery is an orthogonal flag and never substitutes for execution state.

## Evidence boundary

The frozen, live-verified CLI versions remain:

| Harness     | Frozen verified version | Locally observed on 2026-08-13 | Classification               |
| ----------- | ----------------------- | ------------------------------ | ---------------------------- |
| Codex       | `codex-cli 0.145.0`     | `codex-cli 0.147.0`            | newer, compatible-unverified |
| Claude Code | `2.1.219 (Claude Code)` | `2.1.231 (Claude Code)`        | newer, compatible-unverified |
| Cursor CLI  | `2026.07.23-e383d2b`    | `2026.08.04-aaa8809` (`agent`) | newer, compatible-unverified |

`cursor --version` reported the editor version `3.15.6`; it is not substituted
for the frozen Cursor CLI evidence. Version commands were the only local harness
commands run for this baseline. No model, credential, transcript, live provider,
or user hook configuration was used.

Official hook references were rechecked on 2026-08-13:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)

The official pages describe the current product, not historical behavior for the
frozen versions. Current-only events are therefore deferred from AR5.2 until an
exact version-gated sanitized fixture and bounded observation exist. This is a
final scope decision, not unfinished research and not a compatibility expansion.

## Current Agent Relay hook coverage

This table records what the repository installer owns, not every hook that a
user may have configured. Installer merge tests remain the authority for
preserving unrelated hooks.

| Harness     | Owned events                                                                   | Existing exact sanitized fixtures                                                                                                            |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`                | `SessionStart`, `UserPromptSubmit`, `Stop`; current-contract and synthetic-correlated permission research fixtures                           |
| Claude Code | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest` | `SessionStart`, `UserPromptSubmit`, ordinary/background `Stop`, `StopFailure`; current-contract and synthetic-correlated permission fixtures |
| Cursor      | `stop`                                                                         | `stop`                                                                                                                                       |

The permission research fixtures resolve the contract boundary by exclusion.
Both current official permission examples omit `tool_use_id`; the existing
parsers require it to avoid ambiguous routing. Tests prove the current
documented shape fails safely and the synthetic correlated shape parses, but
neither is frozen-version support evidence. Native `PermissionRequest` is not an
AR5.2 activity input. The existing attention hook remains fail-closed, and a
future version-gated expansion must prove exact durable correlation before
selection.

## Event/evidence matrix

The classifications below have precise meanings:

- **selected/frozen**: frozen-version fixture evidence exists and the event may
  be an AR5.2 reducer input without widening compatibility;
- **deferred/version-gated**: useful in the current official contract, but not
  an AR5.2 input because exact frozen-version evidence is absent;
- **excluded**: absent, redundant, unsafe to retain, or too ambiguous for the
  canonical reducer.

### Codex CLI

| Native evidence                  | Classification                    | Safe projection                                                               | State use and boundary                                                                                                  |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                   | selected/frozen                   | source enum only                                                              | Session presence; does not by itself prove active work                                                                  |
| `UserPromptSubmit`               | selected/frozen                   | turn ID and constant reason; discard prompt                                   | `Working`, confirmed                                                                                                    |
| `Stop`                           | selected/frozen                   | turn ID and stop-active bit; discard assistant text                           | `Idle` when no exact open work remains                                                                                  |
| `PermissionRequest`              | deferred/version-gated            | turn ID, exact durable request correlation, bounded tool class; discard input | Current docs omit `tool_use_id`; fail closed and do not project `Needs input`                                           |
| `PreToolUse` / `PostToolUse`     | deferred/version-gated            | turn ID, tool-use ID, bounded tool class; discard input and response          | Correlated in-flight work only after exact-version selection                                                            |
| `SubagentStart` / `SubagentStop` | deferred/version-gated            | turn ID, agent ID, bounded agent class; discard transcript path and message   | Correlated in-flight work only after exact-version selection                                                            |
| `PreCompact` / `PostCompact`     | deferred/version-gated            | turn ID and trigger enum only                                                 | Activity only after exact-version selection; never completion                                                           |
| `SessionEnd`                     | deferred/version-gated            | fixed reason enum only                                                        | Current docs include inactivity-driven end; not selected for the frozen CLI                                             |
| Tool failure                     | excluded as a distinct hook       | none                                                                          | Current Codex has no separate failure hook; parsing tool output would retain content and misclassify recoverable errors |
| Transcript/app-server inference  | excluded from native-hook reducer | none                                                                          | Transcript format is explicitly unstable; the separately versioned app-server driver remains its own surface            |

### Claude Code CLI

| Native evidence                                       | Classification         | Safe projection                                                                                                     | State use and boundary                                                               |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SessionStart`                                        | selected/frozen        | source enum only                                                                                                    | Session presence; not active-work proof by itself                                    |
| `UserPromptSubmit`                                    | selected/frozen        | constant reason; discard prompt                                                                                     | `Working`, confirmed                                                                 |
| `Stop`                                                | selected/frozen        | stop-active bit and bounded background/scheduled counts; discard messages, commands, prompts, descriptions, and IDs | `Idle` with empty work; `Background work` with an exact aggregate snapshot           |
| `StopFailure`                                         | selected/frozen        | bounded error class only; discard details and assistant text                                                        | `Failed`, confirmed turn failure rather than process crash                           |
| `PermissionRequest`                                   | deferred/version-gated | exact durable request correlation and bounded tool class; discard input and suggestions                             | Current docs omit `tool_use_id`; fail closed and do not project `Needs input`        |
| `PreToolUse` / `PostToolUse`                          | deferred/version-gated | tool-use ID and bounded tool class; discard input/response                                                          | Correlated in-flight work only after exact-version selection                         |
| `PostToolUseFailure`                                  | deferred/version-gated | tool-use ID, interrupt bit, bounded failure class; discard input and error text                                     | Would close work; a recoverable tool failure would not itself make the turn `Failed` |
| `SubagentStart` / `SubagentStop`                      | deferred/version-gated | agent ID and bounded agent class; discard messages and transcript paths                                             | Correlated in-flight work only after exact-version selection                         |
| `Notification`                                        | deferred/version-gated | notification type only                                                                                              | Suggestive only and never sufficient for `Needs input`                               |
| `PreCompact` / `PostCompact`                          | deferred/version-gated | trigger enum only                                                                                                   | Activity only after exact-version selection; discard instructions and summary        |
| `SessionEnd`                                          | deferred/version-gated | reason enum only                                                                                                    | Not selected without exact frozen-version evidence                                   |
| `TaskCreated` / `TaskCompleted`                       | excluded               | none                                                                                                                | Product task-list state is not necessarily executing work                            |
| `InstructionsLoaded`, file/config/cwd/worktree events | excluded               | none                                                                                                                | Configuration activity is not evidence that the agent is working on a turn           |

### Cursor CLI and IDE hook contract

| Native evidence                            | Classification                 | Safe projection                                                                                                              | State use and boundary                                                                                 |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `stop`                                     | selected/frozen CLI            | conversation ID, status enum, loop count; discard paths                                                                      | `Idle` for completed, `Failed` for error, `Unknown` for ambiguous abort                                |
| `sessionStart` / `sessionEnd`              | deferred/version-gated         | session ID, background bit, mode/reason enum                                                                                 | Cloud agents omit both; not selected for the frozen CLI                                                |
| `beforeSubmitPrompt`                       | deferred/version-gated         | generation correlation and constant reason; discard prompt and attachments                                                   | `Working` only after exact-version selection                                                           |
| `preToolUse` / `postToolUse`               | deferred/version-gated         | generation/tool-use ID and bounded tool class; discard input, output, agent message, model, and user identity                | Correlated in-flight work only after exact-version selection                                           |
| `postToolUseFailure`                       | deferred/version-gated         | tool-use ID, failure enum, interrupt bit; discard input and error text                                                       | Would close work, not automatically fail the turn                                                      |
| `subagentStart` / `subagentStop`           | deferred/version-gated         | subagent/tool-call IDs, bounded type, status, parallel bit; discard task, summary, files, branch, model, and transcript path | Correlated work only after exact-version selection                                                     |
| `preCompact`                               | deferred/version-gated         | trigger enum and first-compaction bit only                                                                                   | Activity only after exact-version selection; no `postCompact` counterpart is documented                |
| `afterAgentResponse` / `afterAgentThought` | excluded                       | none                                                                                                                         | Raw response and reasoning text are prohibited and redundant with safer lifecycle evidence             |
| Shell/MCP/read/edit-specific hooks         | excluded from activity reducer | none                                                                                                                         | They duplicate generic tool hooks and expose commands, outputs, file content, or paths                 |
| Native permission request                  | absent                         | none                                                                                                                         | Current `preToolUse` may decide a tool but does not prove that a user-facing permission prompt is open |

The current Cursor common schema also includes `user_email`, workspace roots,
model parameters, and transcript path. None may enter the activity ledger or a
safe reason.

### Codex app-server structured driver

The separately versioned app-server surface is selected because its generated
schema hash, sanitized transcript, bounded canary, and driver behavior are all
proven on the frozen `codex-cli 0.145.0` artifact. It is not transcript
inference and does not widen the CLI-hook selection.

| Structured evidence                            | Classification  | AR5.2 projection                                                                                       |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `thread/started`, controlled `session.resumed` | selected/frozen | Establish the exact lane as `Idle`; neither proves active work                                         |
| `turn/started`                                 | selected/frozen | `Working`, with the exact turn correlation                                                             |
| `item/started`, `item/completed`               | selected/frozen | Open/close one correlated work item; retain only the item correlation and bounded item class           |
| command/file-change approval request           | selected/frozen | `Needs input`; retain the exact request/item correlation and bounded approval class, not command/input |
| `turn/completed` with `completed`              | selected/frozen | `Idle`, then inferred `Done` after the grace period                                                    |
| `turn/completed` with `failed`                 | selected/frozen | `Failed`, confirmed                                                                                    |
| `turn/completed` with `interrupted`            | selected/frozen | `Unknown`; do not guess completion                                                                     |
| terminal/retrying `error`                      | selected/frozen | Terminal is `Failed`; retrying refreshes `Working`; discard native error content                       |
| owned process exit                             | selected/frozen | Unexpected is `Failed`; intentional exit alone does not imply `Ended`                                  |

Malformed envelopes, unsupported methods, and future status values fail closed
before reducer application and create `evidence_gap` only when durable sequence
continuity proves an observation was lost.

### Frozen selection and exact fixtures

This is the complete AR5.2 native evidence set. Anything not listed here is
omitted from hook expansion until a later version-gated decision.

| Surface/version                 | Selected event types                                                     | Exact sanitized evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI `0.145.0`             | `SessionStart`, `UserPromptSubmit`, `Stop`                               | [`session-start.json`](../../../../packages/harnesses/fixtures/codex/session-start.json), [`user-prompt-submit.json`](../../../../packages/harnesses/fixtures/codex/user-prompt-submit.json), [`stop.json`](../../../../packages/harnesses/fixtures/codex/stop.json)                                                                                                                                                                                                                          |
| Claude Code CLI `2.1.219`       | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`                | [`session-start.json`](../../../../packages/harnesses/fixtures/claude/session-start.json), [`user-prompt-submit.json`](../../../../packages/harnesses/fixtures/claude/user-prompt-submit.json), ordinary [`stop.json`](../../../../packages/harnesses/fixtures/claude/stop.json), background [`stop-background-work.json`](../../../../packages/harnesses/fixtures/claude/stop-background-work.json), [`stop-failure.json`](../../../../packages/harnesses/fixtures/claude/stop-failure.json) |
| Cursor CLI `2026.07.23-e383d2b` | `stop`                                                                   | [`stop.json`](../../../../packages/harnesses/fixtures/cursor/stop.json)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Codex app server `0.145.0`      | thread/turn/item lifecycle, approvals, native errors, owned process exit | [`contract.json`](../../../../packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/contract.json), [`transcript.json`](../../../../packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/transcript.json), [`live-canary.json`](../../../../packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/live-canary.json), and [driver tests](../../../../packages/codex-app-server-driver/test/driver.test.ts)                                             |
| Relay-owned CLI process         | unexpected owned-child exit                                              | [`owned-process-exit.json`](../../../../packages/harnesses/fixtures/activity-policy/owned-process-exit.json) and [supervisor tests](../../../../apps/relay/src/supervisor.test.ts)                                                                                                                                                                                                                                                                                                            |

Relay's existing durable typed interaction records—not an uncorrelated native
notification—are the selected source for `Needs input` outside the structured
app-server approval surface. Native Codex and Claude permission hooks remain
installed only for their existing fail-closed attention behavior; they are not
selected activity evidence. The exact synthetic request/answer contracts are
[`request-question-set.v1.json`](../../../../packages/protocol/fixtures/interactions/request-question-set.v1.json)
and
[`answer-question-set.v1.json`](../../../../packages/protocol/fixtures/interactions/answer-question-set.v1.json).

## Canonical reducer inputs

AR5.2 must normalize the selected evidence to this bounded vocabulary:

| Input                  | Required safe correlation                                    | Effect                                                                                             |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `session_observed`     | Relay lane key                                               | Establish a lane as `Idle`; process/session presence does not prove work                           |
| `prompt_submitted`     | lane epoch; keyed turn digest when exposed                   | Advance the epoch, set `Working`, and clear recoverable `Done`/`Idle`/`Failed`/`Unknown`           |
| `activity_observed`    | lane epoch; keyed turn digest when exposed                   | Refresh recent foreground evidence only when that epoch is already working                         |
| `work_started`         | exact keyed item digest                                      | Add one open work item and set `Working`                                                           |
| `work_finished`        | same keyed item digest                                       | Close one item; do not infer turn completion                                                       |
| `work_failed`          | same keyed item digest plus bounded class                    | Close one item; a recoverable item failure does not make the turn `Failed`                         |
| `background_snapshot`  | lane epoch plus exact source event; bounded aggregate counts | Replace the selected Claude Stop background/scheduled snapshot                                     |
| `request_opened`       | exact Relay request ID or keyed structured approval digest   | Set `Needs input` and increment exact request count                                                |
| `request_resolved`     | same exact request correlation                               | Remove it and re-project foreground/background evidence                                            |
| `foreground_stopped`   | lane epoch; keyed turn digest where exposed                  | Set `Background work` when work/snapshot remains, otherwise `Idle`                                 |
| `turn_failed`          | lane epoch plus bounded failure class                        | Close impossible waits and set confirmed `Failed`                                                  |
| `session_ended`        | Relay lane key plus selected explicit close source           | Set sticky `Ended`; frozen CLI `SessionEnd` hooks are not selected                                 |
| `owned_process_failed` | exact supervisor key plus bounded unexpected-exit class      | Set confirmed `Failed`; an expected/intentional exit alone is discarded and never means `Ended`    |
| `evidence_gap`         | lane plus durable stream/sequence scope                      | Set confirmed `Unknown` until replay/resnapshot or a new authoritative prompt re-establishes state |

Compaction, notification, transport connection, and muted-delivery changes are
not activity inputs in the frozen selection. They cannot refresh last activity
or manufacture a completion state.

## Durable record and privacy contract

The reducer persists no raw native payload and no digest derived from private
content. Native correlation is transformed before durable storage with a
domain-separated keyed digest owned by the local Relay installation.

| Persisted field       | Bounded representation                               | Semantics                                                                                     |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `laneId`, `epoch`     | Relay product ID and monotonic integer               | Exact lane and turn epoch; never repository-name or nearest-time inference                    |
| `state`, `confidence` | closed enums                                         | One canonical projection and `confirmed` or `inferred` confidence                             |
| `reason`, `source`    | closed enums                                         | Renderer selects fixed user text; no native message is retained                               |
| `lastObservedAt`      | Relay receive-clock timestamp                        | Time of last applied non-duplicate activity evidence; timer-only projection never advances it |
| `idleSince`           | Relay receive-clock timestamp or null                | Exact normal foreground stop, or final work/request close after a stop                        |
| correlation keys      | domain-separated keyed digests                       | Exact turn/item/request/tombstone matching without persisting provider identifiers            |
| work/request counts   | integers bounded to `0..1000`                        | Exact open correlations plus the latest selected bounded aggregate background snapshot        |
| durable ordering      | monotonic receive sequence and last applied sequence | Sole application order; native timestamps are metadata only                                   |
| policy/provenance     | version enum and fixture-set version                 | Reproducible migration and diagnostics                                                        |
| `muted`               | independent boolean                                  | Delivery policy only; never participates in execution-state projection                        |

The source event identity is a keyed digest over only the bounded safe tuple:
source, lane key, epoch, event kind, safe correlation key, and terminal class.
For a source without a native event ID, repeated semantically identical evidence
inside one epoch is deliberately idempotent. A new selected prompt, structured
turn start, or owned launch advances the epoch. This replaces the current
raw-payload-derived `sourceFingerprint` for new activity records.

Prompt text, assistant text, tool arguments/results, commands, approval reasons,
error details, transcripts or transcript paths, cwd/workspace paths or hashes,
environment values, argv, credentials, account/user identifiers, raw native IDs,
model parameters, task descriptions, and unbounded payload extensions are
prohibited. They must be discarded before persistence, logs, diagnostics, or
user-facing reasons.

## Frozen state decision table

The checked-in timing corpus carries the same bounded reason vocabulary and
fixed user text. AR5.2 may change rendering punctuation, but not state,
confidence, or semantic meaning without a new product decision.

| Condition                                             | State             | Confidence | Safe reason code        | Fixed safe user-facing reason                               |
| ----------------------------------------------------- | ----------------- | ---------- | ----------------------- | ----------------------------------------------------------- |
| Lane observed with no turn evidence                   | `Idle`            | confirmed  | `session_observed`      | Session observed; no turn is running.                       |
| Recent prompt/turn evidence without open item         | `Working`         | confirmed  | `foreground_recent`     | Recent foreground activity was observed.                    |
| One or more exact foreground items are open           | `Working`         | confirmed  | `work_open`             | Correlated work is in progress.                             |
| One or more exact requests are unresolved             | `Needs input`     | confirmed  | `request_open`          | Waiting for your response.                                  |
| Normal foreground stop with no work/request           | `Idle`            | confirmed  | `foreground_stopped`    | Foreground work stopped; the session remains available.     |
| Foreground stopped with exact/snapshot work remaining | `Background work` | confirmed  | `background_work_open`  | Background work is still in progress.                       |
| Idle grace elapsed without newer evidence             | `Done`            | inferred   | `idle_grace_elapsed`    | No further work was observed after the completed turn.      |
| Foreground terminal evidence never arrived            | `Unknown`         | inferred   | `terminal_missing`      | Completion evidence did not arrive.                         |
| Exact foreground item became stale                    | `Unknown`         | inferred   | `foreground_work_stale` | Tracked foreground work has not reported activity recently. |
| Exact/snapshot background work became stale           | `Unknown`         | inferred   | `background_work_stale` | Tracked background work has not reported activity recently. |
| Evidence is missing, unpairable, or contradictory     | `Unknown`         | confirmed  | `evidence_gap`          | Recent activity evidence is incomplete or contradictory.    |
| Exact turn failure                                    | `Failed`          | confirmed  | `turn_failed`           | The turn failed.                                            |
| Unexpected Relay-owned child exit                     | `Failed`          | confirmed  | `owned_process_failed`  | The supervised agent process exited unexpectedly.           |
| Selected explicit session close                       | `Ended`           | confirmed  | `session_ended`         | The session ended.                                          |

## Projection and precedence

Projection is condition-based rather than a last-event label:

1. `Ended` is sticky. Only creation of a separately identified native session
   creates a new lane.
2. One or more exact unresolved requests yields `Needs input`.
3. A terminal turn or owned-process failure newer than the last prompt yields
   `Failed`.
4. A proven gap, contradiction, or unmatched terminal yields `Unknown`.
5. A stopped foreground with non-stale exact or aggregate work yields
   `Background work`; stale work yields inferred `Unknown`.
6. An unstopped foreground with recent positive evidence yields `Working`;
   missing or stale terminal evidence yields inferred `Unknown`.
7. A normal foreground stop with no work or request yields confirmed `Idle`.
8. The reviewed idle grace advances that `Idle` to inferred `Done`.

A new prompt may move `Done`, `Idle`, `Unknown`, or a recoverable `Failed` to
`Working`. A notification never outranks an exact request record. Muted delivery
does not alter this projection, suppress questions, or suppress proven failure.

## Ordering, duplicates, and recovery

- Durable receive sequence orders reducer application. Native timestamps are
  evidence metadata, not ordering authority.
- Duplicate delivery reuses one safe source identity and is a no-op.
- Start/terminal pairs use exact tool, subagent, request, and turn correlation.
  Counts never decrement below zero.
- A terminal event received before its matching start installs a bounded
  tombstone and projects `Unknown`. A later matching start closes immediately,
  clears that unmatched condition, and never revives the work item.
- An unmatched terminal, conflicting terminal outcomes, unsafe future payload,
  or sequence gap produces `Unknown`; it is never guessed into `Done`.
- Restart reconstructs open correlations, foreground status, requests, timers,
  and the last durable sequence from SQLite before projecting a state.
- Transport disconnect alone is a delivery-health condition. A proven event gap
  or failed resnapshot is execution-state `Unknown`.

The present hook runner computes `sourceFingerprint` from the canonicalized raw
payload and transcript file metadata. Although it stores a digest rather than
raw content, that digest is derived from prompts, tool arguments/output, and
transcript state. AR5.2 must introduce the safe event identity above for new
activity inputs and forward/reverse-test migration and retry behavior. Existing
attention-event identity remains unchanged unless that implementation story
separately migrates it.

## Executable timing baseline

The following defaults and bounds are frozen as the AR5.2 implementation input.
The checked-in
[timing trial corpus](../../../../packages/harnesses/fixtures/activity-policy/timing-trials.json)
and [policy test](../../../../packages/harnesses/src/activity-policy.test.ts)
exercise every exact boundary with a deterministic clock:

| Transition/condition                                                   | Proposed default                  | Proposed safe bounds  | Rationale                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Working` + exact normal Stop + no work/request → `Idle`               | immediate                         | not configurable      | Completion evidence is stronger than a silence timer                                                                     |
| `Idle` → inferred `Done`                                               | 90 seconds                        | 30 seconds–10 minutes | Exceeds Claude Code's documented roughly 60-second idle notification and avoids rapid Stop/Done title churn              |
| `Working` + no terminal evidence + no tracked work/request → `Unknown` | 5 minutes                         | 1–30 minutes          | Silence cannot prove Idle or Done; five minutes bounds a falsely permanent Working state while allowing slow model turns |
| Open foreground work with no correlated activity → `Unknown`           | 2 hours                           | 5 minutes–24 hours    | Long-running commands are legitimate; an unclosed work item must eventually stop claiming certainty                      |
| `Background work` with no fresh evidence → `Unknown`                   | 24 hours                          | 30 minutes–7 days     | Background workflows and scheduled wakes may be long-lived; their existence prevents time-based Done                     |
| Proven event-stream gap → `Unknown`                                    | immediate after failed resnapshot | not configurable      | Ordering completeness, not elapsed time, is the missing evidence                                                         |

There is deliberately no silence-only `Working` → `Idle` → `Done` path. Missing
terminal evidence becomes `Unknown`, and known background work blocks `Done`.

## Controlled observations completed

Existing deterministic tests already establish these reusable facts:

- exact duplicate native payloads reuse one durable sequence across reconnect
  and SQLite restart;
- distinct native events advance monotonically and retained legacy sequence is
  not moved backwards;
- current selected fixtures discard prompt, transcript, background task, cron,
  and assistant-message content from normalized events;
- malformed, oversized, unknown, and missing-session payloads fail safely;
- Claude Code `Stop` with non-empty bounded work collections remains active
  instead of becoming a stopped turn;
- current Codex and Claude permission examples without `tool_use_id` fail safely
  instead of being correlated to a recent or apparent session;
- synthetic permission fixtures with an exact correlation normalize to one
  durable permission request;
- fourteen fake-clock timelines cover lane observation, exact timeout
  boundaries, missing terminal evidence, correlated and aggregate background
  work, request resolution, proven gaps, duplicate delivery,
  terminal-before-start tombstones, restart continuity, contradictory terminals,
  turn/process failure, recovery, and sticky Ended; and
- the exact app-server transcript now covers completed and failed turns plus a
  terminal native error while its bounded canary retains only enums/counts for
  the observed owned-process exit; and
- the frozen live canaries already establish normal Stop delivery for all three
  CLIs plus exact owned-process observation where Relay owns the child. Timing
  thresholds are conservative Relay policy, not claims about undocumented
  harness timers.

These tests freeze reducer behavior but do not select any deferred
current-contract event or prove a native event exists on an unobserved harness
version.

## AR5.2 implementation handoff

No AR5.1 product or evidence decision remains open. AR5.2 must:

- implement the selected event inventory, canonical inputs, precedence, privacy
  projection, keyed safe identity, and timing constants above;
- use the timing corpus as the reducer conformance input, then add durable
  SQLite migration/restart and property/sequence tests around the production
  reducer;
- preserve current fail-closed parsing and installer merge behavior for deferred
  native hooks rather than adding them opportunistically;
- treat the selected Claude background counts as an authoritative aggregate
  snapshot that blocks `Done` but becomes `Unknown` at the background staleness
  boundary; and
- keep version-gated hook expansion, new exact-version observations, and any
  compatibility widening outside AR5.2 unless separately authorized.

The companion AR5 specification was refined to state that recoverable item
failure is not terminal, missing completion becomes `Unknown` rather than
`Idle`, expected process exit is not `Ended`, and the selected defaults are 90
seconds, 5 minutes, 2 hours, and 24 hours. These refinements preserve the eight
accepted state names and the orthogonal muted-delivery boundary.

## Acceptance closure

- [x] Per-harness event/evidence matrix is checked in.
- [x] Every selected event type links exact sanitized fixture or controlled
      normalized process evidence.
- [x] The deterministic decision table covers ordinary, ambiguous, missing,
      duplicate, out-of-order, restart, and failure cases.
- [x] Timing defaults and bounds are justified and executable at exact
      boundaries.
- [x] The durable persistence allowlist and prohibited content are explicit.
- [x] The companion AR5 specification reflects the refined decisions.
- [x] AR5.2 can proceed without another product decision.
