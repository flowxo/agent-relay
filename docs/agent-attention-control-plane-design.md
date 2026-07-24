# Agent Attention and Telegram Control Plane

**Status:** Design recommendation

**Date:** 2026-07-24

**Scope:** Codex, Claude Code, Cursor IDE/CLI, Flow XO agent platform, Telegram

**Recommendation:** Build an internal, hook-first control loop with a small
local bridge and a dedicated Telegram operator bot. Do not begin with
cross-agent permission policy or transcript mirroring.

## 1. Executive answer

The product is feasible, and the core user problem is easier than Pushary's full
product:

1. Every main-agent turn ending should deterministically emit an event.
2. Explicit questions and permission requests should become correlated Telegram
   prompts.
3. A Telegram response should resume the same session when the harness supports
   it.
4. A local supervisor should detect abnormal exits that hooks cannot see.

The key is to separate four mechanisms that Pushary presents as one product:

- **Lifecycle observation:** native hooks report start, stop, tool, permission,
  and error events.
- **Semantic human input:** an MCP tool plus instructions asks a question when
  the model recognizes that it needs help.
- **Deterministic continuation:** a stop hook or permission hook injects the
  Telegram answer back into the active turn.
- **Process supervision:** a launcher detects crashes, signals, and silent
  process exits, and can resume an idle CLI session later.

Instructions in `AGENTS.md`, `CLAUDE.md`, or Cursor rules are useful for
semantic questions, but they are not reliable event detection. Native hooks and
process supervision must own detection.

### Recommended first release

Build an internal macOS-first version with:

- Codex CLI, Claude Code, Cursor CLI: stop, error, explicit question,
  permission, and abnormal-exit events; Telegram replies resume the same
  session.
- Cursor IDE: deterministic notifications and inline stop-hook replies; late
  remote resume remains notify-only until Cursor exposes a stable cross-surface
  session API.
- One operator, one Telegram bot, multiple local machines and concurrent
  sessions.
- No transcript upload by default. Send only bounded summaries and the last
  assistant message after redaction.
- Local durable spooling, idempotent server ingest, and an installer/doctor
  command from the first usable release.

Estimated effort:

- **Proof of loop:** 4-7 engineer-days.
- **Useful internal MVP:** 12-18 engineer-days.
- **Hardened multi-machine v1:** 25-40 engineer-days.
- **Reliable late steering of Cursor IDE:** currently blocked by Cursor's
  separation of IDE and CLI session stores; do not include it in the committed
  v1 estimate.

## 2. What Pushary actually is

The current public package is
[`@pushary/agent-hooks`](https://www.npmjs.com/package/@pushary/agent-hooks).
The inspected npm artifact was version `0.54.1`, published 2026-07-21. Its npm
metadata names `https://github.com/pushary/pushary`, but that repository
returned 404 on 2026-07-24. The published artifact is MIT-licensed and readable,
but the source repository is not publicly accessible.

Pushary is not a single hook. The package contains:

- a setup/upgrade/clean/doctor CLI;
- per-harness hook adapters;
- MCP configuration and a reusable skill;
- instruction blocks for `AGENTS.md`/`CLAUDE.md`/Cursor rules;
- local pending-question files and policy caches;
- a hosted event, question, policy, mode, and audit API;
- session and machine identity;
- a polling/WebSocket command relay;
- a Claude launcher that swaps between the native local CLI and an Agent
  SDK-driven remote leg;
- optional encrypted transcript synchronization;
- a daemon that can start a new Claude session from a phone command.

The public product page describes the same layers: approvals and questions,
notifications, a fleet view, policy, a kill switch, and an audit trail
([Pushary overview](https://pushary.com/),
[control panel](https://pushary.com/ai-agent-control-panel)).

### 2.1 Configuration written by the package

#### Claude Code

The package writes `~/.claude/settings.json` entries for:

- `PreToolUse`
- `PermissionRequest`
- `PermissionDenied`
- `PostToolUse`
- `UserPromptSubmit`
- `Notification`
- `Stop`
- `StopFailure`
- `SessionStart`
- `SessionEnd`

It also installs an MCP server, permits the Pushary MCP tools, writes proactive
instructions, and can alias `claude` to `pushary claude`.

#### Codex

For Codex versions with native hooks, it writes `~/.codex/hooks.json` entries
for:

- `PermissionRequest`
- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`
- `SessionStart`

It writes the MCP server and API key into `~/.codex/config.toml`, installs a
skill and global `AGENTS.md` instructions, and tries to pre-populate Codex's
hook trust hash for versions it recognizes. Older Codex versions receive a
deprecated `notify` handler instead.

#### Cursor

The current package installs a local Cursor plugin with:

- an MCP server;
- an always-on rule;
- a Pushary skill;
- commands;
- one global `beforeShellExecution` permission gate.

The inspected Cursor plugin does **not** install a deterministic `stop` hook.
Generic "task complete" notifications therefore depend on the model following
its always-on rule and calling the MCP tool. That is materially weaker than the
Claude and Codex paths and is a plausible explanation for silent non-delivery in
Cursor.

### 2.2 Server and local wire behavior

The package uses:

- MCP `ask_user`, `wait_for_answer`, `cancel_question`, and `send_notification`;
- `/api/agent/event` for lifecycle and activity;
- `/api/mcp/policy` and `/api/mcp/mode` for policy and live overrides;
- `/api/agent/poll` and command-drain endpoints for phone-to-machine commands;
- a WebSocket relay when advertised, with polling as fallback;
- `sessionId + machineId` as the session identity;
- correlation IDs for pending questions;
- short local files for pending questions and recent prompt intent;
- bounded retries, timeouts, policy caching, redaction, and delivery modes.

The Claude wrapper is the most technically ambitious part. It:

1. runs the native Claude CLI for the local terminal leg;
2. captures the session id;
3. listens for remote commands;
4. stops or yields the local leg;
5. resumes the same Claude session through the Agent SDK;
6. streams assistant output while accepting phone input;
7. lets the user switch control back to the terminal.

Pushary does not currently implement an equivalent remote wrapper for Codex or
Cursor in the inspected artifact.

### 2.3 Why the product can fail in confusing ways

The observed design has many failure boundaries:

- config mutation across three unrelated schemas;
- global package binary resolution;
- shell profile/environment inheritance;
- hook trust in Codex;
- Cursor restart/plugin loading;
- Cursor hook stdin and fail-open/fail-closed behavior;
- MCP authentication and tool auto-approval;
- network requests inside synchronous hooks;
- hook timeout budgets;
- hosted question state and local pending state;
- multiple sessions sharing cleanup paths;
- aliases/wrappers changing which executable actually runs;
- rapidly changing harness hook contracts.

The package's release history is unusually fast: more than 60 npm releases
between May 8 and July 21, 2026. The public changelog is also behind the npm
package version. The changelog itself records fixes for cross-session decision
loss and stale policy behavior
([Pushary changelog](https://pushary.com/docs/changelog)). This is evidence of a
young integration surface, not evidence that the concept is unsound.

## 3. Native harness capabilities

### 3.1 Capability matrix

| Capability                             | Codex                                                               | Claude Code                         | Cursor CLI                                                      | Cursor IDE                                        |
| -------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Deterministic main-turn stop hook      | Yes, `Stop`                                                         | Yes, `Stop`                         | Yes, `stop`                                                     | Yes, `stop`                                       |
| Last assistant message in stop payload | Yes                                                                 | Yes                                 | Transcript/session fields; summary can be derived               | Transcript/session fields; summary can be derived |
| Stop hook can auto-continue            | Yes: `decision: "block"` + `reason`                                 | Yes: `decision: "block"` + `reason` | Yes: `followup_message`                                         | Yes: `followup_message`                           |
| Permission hook can allow/deny         | Yes                                                                 | Yes                                 | Yes                                                             | Yes                                               |
| Native "ask" hook result is reliable   | Normal prompt fallback                                              | Yes                                 | `ask` has documented enforcement limitations on some hook paths | Same limitation                                   |
| Explicit API/CLI session resume        | App Server, SDK, `codex exec resume`                                | Agent SDK, `claude --resume`        | `cursor-agent --resume`                                         | No stable bridge from IDE chat to CLI session     |
| Active-turn steering API               | App Server `turn/steer`                                             | Agent SDK input stream              | Not publicly documented                                         | Not publicly documented                           |
| API failure event                      | Infer from turn status/supervisor; no Pushary `StopFailure` adapter | `StopFailure`                       | Stop status and stream result                                   | Stop/status hooks                                 |
| Process crash detection by hooks alone | No                                                                  | No                                  | No                                                              | No                                                |

### 3.2 Codex

Codex native hooks are the strongest fit:

- `Stop` receives `session_id`, `turn_id`, `stop_hook_active`, and
  `last_assistant_message`.
- Returning `{"decision":"block","reason":"..."}` creates a new continuation
  prompt and keeps Codex going.
- `PermissionRequest` can allow, deny, or decline to decide.
- `PreToolUse` can block or rewrite supported local tool calls.
- `SessionEnd` is advisory and can occur much later than a turn stop, so it is
  not the attention signal.
- Hook definitions require review/trust unless managed.

The current contract is documented in
[Codex Hooks](https://developers.openai.com/codex/hooks).

For late Telegram replies, Codex provides three viable mechanisms:

- `codex exec resume <session-id> <prompt>` for a detached continuation;
- the Codex SDK's `resumeThread`;
- App Server `thread/resume` + `turn/start`, with `turn/steer` for an active
  turn.

App Server is the best long-term control-plane integration because it provides
structured lifecycle events, active-turn steering, approvals, and thread status
([Codex App Server](https://developers.openai.com/codex/app-server),
[Codex SDK](https://developers.openai.com/codex/sdk)).

### 3.3 Claude Code

Claude Code exposes the broadest hook event set:

- `Notification` distinguishes `permission_prompt`, `idle_prompt`,
  `agent_needs_input`, and `agent_completed`.
- `Stop` fires when Claude finishes a response and may block the stop to
  continue with a reason.
- `StopFailure` covers API failures.
- `PermissionRequest` and `PreToolUse` can enforce approvals.
- `SessionEnd` reports terminal session termination.

Important boundaries:

- `Stop` does not fire on user interrupts.
- command hooks block the agent while running;
- hook errors other than an explicit block are generally surfaced and execution
  continues;
- repeated stop-hook continuations are capped unless configured;
- a hook cannot directly invoke slash commands or tools.

See [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide).

Late continuation can use `claude --resume <session-id>` in print mode or the
Agent SDK. Pushary's wrapper confirms that the native local leg and SDK-driven
remote leg can be swapped while retaining the same Claude session, but the
wrapper/TTY handoff is a separate product-sized component.

### 3.4 Cursor

Cursor's current hooks are capable enough for deterministic notifications:

- `stop` receives a stable `conversation_id` and `loop_count`;
- returning `followup_message` automatically submits a new user message;
- `beforeShellExecution` and `preToolUse` can return permissions;
- `failClosed` is available for security-critical hook failures;
- `postToolUseFailure`, `sessionStart`, `sessionEnd`, and response hooks provide
  supporting telemetry.

See [Cursor Hooks](https://cursor.com/docs/hooks).

Cursor CLI can resume its own sessions with `cursor-agent --resume <id>` and
supports structured stream output
([Cursor CLI usage](https://docs.cursor.com/en/cli/using),
[output format](https://docs.cursor.com/en/cli/reference/output-format)).

The important limitation is surface identity: Cursor IDE chats and Cursor CLI
chats currently use separate local stores. A conversation id captured from the
IDE cannot safely be resumed through `cursor-agent --resume`. Therefore:

- immediate replies can continue Cursor IDE through the still-running `stop`
  hook;
- late replies can resume Cursor CLI sessions;
- late replies to an already-returned Cursor IDE stop hook are notification-only
  unless we accept brittle UI automation or Cursor publishes a cross-surface
  API.

## 4. Product behavior

### 4.1 Events that should notify

Default policy for the main agent:

- `turn.stopped`: every main turn ended and the agent is awaiting the next user
  prompt;
- `input.required`: explicit question or elicitation;
- `permission.required`: actionable permission prompt;
- `turn.failed`: API error, tool pipeline failure that ends the turn, or hook
  failure;
- `process.exited`: supervised child exited unexpectedly;
- `process.stale`: optional warning after no observable progress plus a failed
  health probe;
- `session.ended`: only when the process/session actually ends, not merely a
  normal turn stop.

Subagent stops should update session state but not notify by default.

### 4.2 Telegram experience

Each message should identify:

- harness and surface;
- project/worktree;
- machine;
- short task title;
- state (`Waiting`, `Needs approval`, `Failed`, `Exited`);
- bounded last-message summary;
- age and session short id.

Examples:

```text
Codex · flowxo-agents · MacBook
Waiting for your next instruction

Finished the Telegram control-plane design. No files changed outside docs/strategy.

Reply to this message to continue.
```

```text
Claude · api-refactor · Mac mini
Approval required

Allow: git push origin codex/telegram-bridge

[Allow once] [Deny] [Handle at terminal]
```

Free-text replies should use Telegram's native "reply to message" relationship.
Buttons should carry only an opaque decision id, never a command or session id.
Telegram callback queries must be acknowledged quickly and the original message
edited to show the chosen outcome.

Telegram supports webhook secret tokens, duplicate-detectable `update_id`
values, inline keyboard callback queries, and message edits in the official
[Bot API](https://core.telegram.org/bots/api).

### 4.3 Terminal/Telegram race

Both channels may answer the same pending item. Resolution must be atomic:

1. create pending decision with state `open`;
2. accept the first valid terminal or Telegram response;
3. record `resolved_by`;
4. reject later responses as stale;
5. edit the Telegram message to show where it was handled;
6. cancel or drain the local hook waiter.

This avoids two continuations from one stop and prevents a late Telegram
approval from authorizing a different tool call.

## 5. Proposed architecture

```text
┌──────────────────────────────── local machine ────────────────────────────────┐
│                                                                               │
│  Codex / Claude / Cursor                                                      │
│       │ native hooks (JSON stdin/stdout)                                      │
│       ▼                                                                       │
│  harness adapter ── local socket ──▶ agent-bridge daemon                      │
│       ▲                              │                                        │
│       │ continuation JSON            ├─ SQLite spool + session registry        │
│       │                              ├─ child-process supervisor (optional)    │
│       │                              └─ authenticated WebSocket + HTTP         │
└───────┼───────────────────────────────────────────┬───────────────────────────┘
        │                                           │
        │ hook answer                               │ signed events / commands
        │                                           ▼
┌───────┴──────────────────── Flow XO control plane ────────────────────────────┐
│  event ingress Worker                                                        │
│       │ validate, redact, dedupe                                              │
│       ▼                                                                       │
│  AgentControlSessionDO (machine + harness session)                            │
│       ├─ state machine + pending decisions                                    │
│       ├─ command queue / bridge WebSocket                                     │
│       ├─ idempotency and audit                                                │
│       └─ Telegram delivery coordinator                                        │
│                          │                                                    │
│  dedicated operator-bot webhook ◀────────── Telegram Bot API                  │
└──────────────────────────┼────────────────────────────────────────────────────┘
                           ▼
                      Telegram user
```

### 5.1 Local `agent-bridge`

Use one small Node executable and daemon, not separate network logic in every
hook.

Responsibilities:

- normalize harness payloads;
- assign stable `machine_id`, `bridge_session_id`, and event ids;
- keep a SQLite event spool;
- maintain one authenticated WebSocket to the platform;
- expose a Unix-domain socket to hook processes;
- return harness-specific hook output;
- supervise opted-in CLI processes;
- execute late-resume commands under a per-session ownership lock;
- redact secrets before an event leaves the machine;
- expose `setup`, `doctor`, `status`, `logs`, and `uninstall`.

Hook behavior if the daemon is unavailable:

- append to the spool through a tiny standalone library or file;
- return safe native behavior;
- never silently approve;
- write one concise diagnostic to stderr;
- avoid depending on shell profile output or global `PATH` where possible.

### 5.2 Platform `AgentControlSessionDO`

Key one durable object by `{accountId}:{machineId}:{harness}:{sessionId}`.

Store:

- current state and monotonic state version;
- last-seen/activity timestamps;
- project and surface identity;
- capability flags;
- pending prompts/permissions/stops;
- Telegram message correlation;
- outbound commands awaiting the local bridge;
- audit events and idempotency keys.

The DO is the single writer for resolution races. A WebSocket is the low-latency
path; durable queued commands plus reconnect replay are the reliability path.

### 5.3 Dedicated operator bot

Reuse the existing Telegram HTTP client, types, webhook-secret validation,
update deduplication, retry classification, callback handling, and telemetry. Do
**not** route these messages through the normal customer `ChannelActor` or
blueprint execution path.

The operator bot is control-plane traffic with different semantics:

- one authenticated operator allowlist;
- no first-contact channel provisioning;
- no model turn on inbound messages;
- strict reply/callback correlation;
- short retention and audit controls;
- immediate callback acknowledgment.

### 5.4 Event envelope

```ts
interface AgentAttentionEventV1 {
  schema: "agent-attention.v1";
  eventId: string; // UUIDv7/ULID, idempotency key
  occurredAt: string;
  sequence: number; // monotonic within bridge session

  accountId?: string; // assigned/verified server-side
  machineId: string; // random installation id, not hostname hash
  bridgeSessionId: string; // local process-supervision identity
  harness: "codex" | "claude" | "cursor";
  surface: "cli" | "ide" | "app-server" | "sdk";
  harnessVersion: string;

  sessionId: string;
  turnId?: string;
  toolUseId?: string;
  pid?: number; // local only unless explicitly enabled
  project: {
    displayName: string;
    cwdHash: string;
    worktree?: string;
    branch?: string;
  };

  type:
    | "session.started"
    | "turn.started"
    | "turn.activity"
    | "turn.stopped"
    | "turn.failed"
    | "input.required"
    | "permission.required"
    | "process.exited"
    | "process.stale"
    | "session.ended";

  summary?: string;
  lastAssistantMessage?: string;
  failure?: { class: string; message: string };
  request?: {
    correlationId: string;
    kind: "confirm" | "select" | "input" | "permission" | "continuation";
    question: string;
    options?: Array<{ id: string; label: string }>;
    expiresAt: string;
  };
  capabilities: {
    inlineContinue: boolean;
    lateResume: boolean;
    activeSteer: boolean;
    permissionDecision: boolean;
  };
}
```

Do not make transcript formats part of the protocol. Harness docs explicitly
treat them as unstable. A local adapter may read a transcript as a best-effort
enrichment source, but the event must remain valid without it.

## 6. Harness adapter flows

### 6.1 Normal stop

1. Hook receives stop payload.
2. Adapter emits `turn.stopped` with a bounded summary.
3. Platform sends a Telegram message.
4. Hook normally returns immediately so the terminal becomes usable.
5. If the user replies in Telegram:
   - supervised/resumable CLI: daemon resumes the same session with the reply;
   - active App Server/SDK session: daemon sends `turn/start` or active
     steering;
   - Cursor IDE: if the stop hook is no longer alive, edit the Telegram message
     to say "Reply received; continue in Cursor" and retain the response for
     copy/display.

Optional **remote mode** changes step 4: the stop hook waits for a configured
window and returns a native continuation directly when Telegram answers.

### 6.2 Native stop continuation outputs

Codex:

```json
{
  "decision": "block",
  "reason": "Telegram reply text"
}
```

Claude Code:

```json
{
  "decision": "block",
  "reason": "Telegram reply text"
}
```

Cursor:

```json
{
  "followup_message": "Telegram reply text"
}
```

Adapters must check the harness's stop-recursion field (`stop_hook_active` or
`loop_count`) and must not notify/continue recursively without a new user
decision.

### 6.3 Explicit semantic question

Install a small MCP server or remote MCP tool set:

- `ask_operator`
- `notify_operator`
- `cancel_operator_request`
- optionally `list_agent_sessions`

The instruction file tells the model to call `ask_operator` whenever it would
otherwise ask in chat. This remains cooperative, but it improves the question
UX. The deterministic stop hook is the backstop when the model simply ends its
turn.

The MCP call should create the same pending-decision record as a native
permission hook. There must be one question store and one race-resolution path.

### 6.4 Permission request

Add only after stop/question reliability is proven.

- Codex: use `PermissionRequest`, with `PreToolUse` only for policy that must
  run before normal approval.
- Claude: use `PermissionRequest`; use `PreToolUse` for non-bypassable
  restrictions.
- Cursor: return only concrete `allow` or `deny` remotely. Do not depend on
  `ask` being enforced.

Timeout policy:

- never convert infrastructure failure into approval;
- when the user is at the terminal, fall back to the native prompt;
- in remote-only mode, deny or hold according to an explicit per-tool policy;
- bind answers to tool-use id + input digest + expiry.

### 6.5 Abnormal exit and silent hang

Hooks cannot report a process killed before the hook executes. A launcher is
required for "stops for any reason."

`agent-bridge run codex|claude|cursor` should:

- spawn the child;
- capture PID, session id, exit code, signal, and structured output where
  available;
- emit `process.exited` when the child ends unexpectedly;
- retain the terminal exit status;
- keep a per-session ownership lock for late resume;
- optionally restart only when explicitly configured.

A "hang" cannot be inferred from lack of hooks alone. The agent may be
reasoning, waiting on network, or running a long command. `process.stale` should
require:

1. activity deadline exceeded;
2. process still alive;
3. no known long-running tool;
4. failed harness-specific health/stream probe;
5. a warning, not an automatic restart.

## 7. Reliability and security requirements

### 7.1 Reliability

- At-least-once event delivery; idempotent server processing.
- Monotonic sequence per bridge session; tolerate gaps and replay.
- SQLite spool survives daemon, network, and laptop sleep.
- WebSocket for commands; HTTP long-poll fallback.
- Pending decisions survive Worker/DO eviction and local reconnect.
- Atomic first-writer-wins resolution.
- Telegram webhook acknowledges only after durable claim/receipt.
- Installer changes are merge-aware, backed up, and reversible.
- `doctor` validates every registered event by sending fixture payloads through
  the actual executable.
- Canary test command produces a real stop event and a real Telegram round trip.

### 7.2 Privacy

Default transmitted data:

- harness, surface, versions;
- random machine id;
- project display name and hashed cwd;
- branch/worktree if enabled;
- event state;
- redacted bounded summary;
- redacted permission target.

Default excluded data:

- full transcripts;
- source code;
- environment;
- raw hostname or username;
- arbitrary command output;
- secrets and credentials.

Use deterministic local redaction plus a hard byte cap before
signing/transmission. If transcript sync is ever added, make it a separate
opt-in feature with end-to-end encryption and distinct retention.

### 7.3 Authentication

- Pair each bridge installation with a short-lived browser/device flow.
- Store a rotating machine credential in the OS keychain.
- Sign event requests or use mutually authenticated bearer sessions.
- Authorize Telegram user ids explicitly.
- Use Telegram's webhook secret header and a high-entropy route id.
- Never place credentials in Telegram callback data.
- Bind every reply to account, machine, session, correlation id, and expiry.

## 8. Fit with the current Flow XO codebase

This repository already contains most of the server-side primitives:

- a production Telegram Bot API client with timeouts, telemetry, error
  classification, and typed methods;
- Telegram webhook secret verification and `update_id` deduplication;
- inline choice/callback handling and message edits;
- Durable Object single-writer patterns;
- a scheduled callback service for durable timeouts/retries;
- runtime audit event conventions;
- live agent steering and suspended-run resume through the Agent Signals bridge.

Reuse:

- `apps/worker/src/messaging/transports/telegram/client.ts`
- `apps/worker/src/messaging/transports/telegram/webhook-router.ts`
- `apps/worker/src/actors/channel/telegram-callback.ts`
- `apps/scheduler`
- `apps/worker/src/actors/channel/agent-signals-bridge.ts`
- `apps/agent-runtime/src/agent-do.ts`

Do not reuse the normal Telegram channel routing itself. Add a small
operator-control route/coordinator so an operator reply resolves a local harness
request rather than starting a Flow XO blueprint turn.

## 9. Delivery plan and LOE

Estimates assume one experienced engineer, current repository familiarity,
macOS-first internal use, and reuse of the existing Telegram stack.

### Phase 0 — contract spike

**Effort:** 2-3 days

- capture real hook fixtures from current Codex, Claude, Cursor CLI, and Cursor
  IDE;
- build an adapter conformance table;
- prove each stop-continuation response;
- prove explicit allow/deny for each permission hook;
- verify timeout and malformed-output behavior;
- test concurrent sessions and stop recursion.

Exit: a fixture corpus and executable contract tests, not a production service.

### Phase 1 — deterministic notification loop

**Effort:** 4-7 days cumulative

- local hook executable;
- event envelope;
- simple authenticated ingress;
- dedicated operator-bot webhook;
- stop/failure/session messages;
- event dedupe;
- manual install instructions;
- one canary command per harness.

Exit: every normal main-turn stop generates one Telegram message.

### Phase 2 — correlated questions and inline replies

**Effort:** 8-12 days cumulative

- pending-decision DO state;
- Telegram reply-to and button correlation;
- local long-poll/WebSocket command receipt;
- native hook continuation output;
- MCP `ask_operator`;
- terminal/Telegram first-writer-wins;
- expiry and cancellation.

Exit: a question or stop can be answered from Telegram while its hook is
waiting.

### Phase 3 — local daemon, spool, and late CLI resume

**Effort:** 12-18 days cumulative

- Unix socket daemon;
- SQLite event/command spool;
- machine pairing and keychain credential;
- supervised CLI launch;
- late resume for Codex, Claude, Cursor CLI;
- process exit/signal events;
- ownership locks and duplicate-resume prevention.

Exit: useful internal MVP. Telegram can continue an already-idle CLI session and
abnormal child exits are reported.

### Phase 4 — installer, doctor, and hardening

**Effort:** 18-28 days cumulative

- merge-aware setup for all config files;
- exact-path binaries, trust guidance, backups, uninstall;
- version compatibility gates;
- fixture-driven doctor;
- offline/reconnect tests;
- multiple machines and 8+ concurrent sessions;
- observability, alerting, retention, and audit views;
- rollout flags and emergency disable.

Exit: credible internal v1 for daily use.

### Phase 5 — product-grade fleet control

**Effort:** 25-40 days cumulative

- session board;
- notification policy and coalescing;
- permission policies and kill switch;
- operator/team authorization;
- encrypted optional transcript context;
- Windows/Linux packaging and test matrix;
- automatic update compatibility testing;
- support tooling and recovery runbooks.

Exit: a Pushary-class control plane rather than a personal tool.

### Separate Cursor IDE track

**Effort:** research first; not committed

The stop hook can wait and inject `followup_message`, but late resumption of a
returned IDE session is not exposed as a stable public API. Options:

1. remote-mode wait window in the stop hook: reliable but delays the IDE prompt;
2. a Cursor extension invoking internal commands: likely version-fragile;
3. UI automation: unacceptable as the primary path;
4. wait for a supported IDE/CLI session bridge.

Recommendation: ship Cursor IDE as deterministic notify + explicit in-hook
reply, clearly label late resume unsupported, and revisit when the API surface
changes.

## 10. Acceptance tests

### Awareness

- Eight parallel sessions each produce independently attributed stop
  notifications.
- One session ending does not cancel another session's pending question.
- Main-agent stops notify once; subagent stops do not notify by default.
- API error, non-zero child exit, SIGTERM, and laptop sleep/reconnect each
  produce the correct state.
- Duplicate hook/event delivery does not duplicate Telegram messages.

### Reply

- Telegram button approval reaches the exact tool call and cannot be replayed.
- Telegram text reply continues the exact stopped turn/session.
- Terminal answer wins cleanly against a near-simultaneous Telegram answer.
- Late reply resumes Codex/Claude/Cursor CLI once, under a session lock.
- Cursor IDE late reply is retained and marked non-resumable rather than
  silently discarded.

### Failure

- Daemon absent: hook exits safely and records a diagnostic.
- Platform unreachable: event spools locally and later delivers.
- Telegram unavailable: session state remains visible and retries are bounded.
- Invalid hook JSON never silently approves a permission.
- Hook timeout never causes an implicit destructive allow.
- Upgrade preserves user-authored config and all required hook registrations.

## 11. Decisions to make before implementation

Recommended defaults are shown first.

1. **Operator bot:** dedicated internal bot, not a normal customer Telegram
   connection.
2. **Stop policy:** notify immediately and return; use the daemon for late CLI
   resume.
3. **Remote mode:** opt-in stop-hook waiting window for Cursor IDE and
   situations where the user explicitly walks away.
4. **Content:** last assistant message capped and redacted; no transcript
   upload.
5. **Permissions:** phase after notification/question reliability.
6. **Platforms:** macOS first; Windows/Linux after internal proof.
7. **Session launch:** wrappers optional for notification-only, required for
   guaranteed abnormal-exit detection and safe late resume.

## 12. Bottom line

The useful product is not "push notifications for agents." It is an **attention
router with deterministic continuation**:

- hooks turn heterogeneous harness lifecycle events into one protocol;
- a local supervisor covers what hooks cannot observe;
- a durable session actor resolves races and retains pending work;
- Telegram is the human interface;
- harness-native continuation or resume mechanisms put the answer back into the
  same work.

That architecture fits the current Flow XO platform unusually well. The Telegram
transport, durable callbacks, audit/event patterns, and agent steering substrate
already exist. The main new engineering is on the local machine: adapters, a
resilient bridge, installer/doctor behavior, and safe ownership of resumed
sessions.
