# Durable session activity

Agent Relay derives one durable activity record for each session lane. Telegram,
the local web companion, and future operator surfaces consume this record; they
do not infer execution state independently from the latest notification.

The model implements the frozen AR5.1 policy and fixture corpus. It deliberately
does not turn delivery success, delivery failure, mute state, a transport
disconnect, elapsed wall time alone, or an unselected native hook into execution
evidence.

## Operator states

| State               | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| **Working**         | Recent foreground activity or exact correlated foreground work exists.  |
| **Needs input**     | A selected durable interaction request is open.                         |
| **Background work** | Foreground work stopped while bounded background work remains open.     |
| **Idle**            | Foreground work stopped cleanly and the short completion grace is open. |
| **Done**            | The idle grace elapsed with no open request or work. This is inferred.  |
| **Failed**          | A selected turn failure or unexpected owned-process exit was observed.  |
| **Unknown**         | Evidence is missing, contradictory, unmatched, or stale.                |
| **Ended**           | An explicit selected session-end or operator End was observed.          |

`Ended` is sticky. An exact open request outranks failure and work. A new prompt
starts a new epoch and can recover `Done`, `Idle`, `Unknown`, or a recoverable
`Failed` state. Ambiguous activity cannot revive a stopped, failed, or ended
lane. Terminal evidence that arrives before its exact start is retained as a
tombstone and projects `Unknown`; a later matching start closes the tombstone
without inventing new work.

## What every surface receives

The canonical `agent-relay-session-activity.v1` record contains:

- the exact state label, confidence (`confirmed` or `inferred`), bounded reason
  code and safe reason text;
- the selected evidence source and server receive-clock last-activity time;
- bounded in-flight work and open-request counts;
- the durable epoch and receive sequence; and
- an independent `muted` delivery flag.

Telegram topic titles and `/status` use this record. The authenticated web API
returns it as `activity`, and the browser filters and renders the same eight
states. `muted` is subordinate delivery configuration: muting a lane or failing
to deliver a notification never changes its execution state.

## Frozen timing policy

The defaults and allowed bounds are:

| Transition                                       | Default | Allowed range |
| ------------------------------------------------ | ------- | ------------- |
| `Idle` to inferred `Done`                        | 90 s    | 30 s–10 min   |
| `Working` without terminal evidence to `Unknown` | 5 min   | 1–30 min      |
| Open foreground work to `Unknown`                | 2 h     | 5 min–24 h    |
| Open background work to `Unknown`                | 24 h    | 30 min–7 days |

Configure milliseconds at daemon startup with either the command-line flag or
environment variable:

| Flag                                       | Environment variable                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `--activity-idle-to-done-ms`               | `AGENT_RELAY_ACTIVITY_IDLE_TO_DONE_MS`               |
| `--activity-working-to-unknown-ms`         | `AGENT_RELAY_ACTIVITY_WORKING_TO_UNKNOWN_MS`         |
| `--activity-foreground-work-to-unknown-ms` | `AGENT_RELAY_ACTIVITY_FOREGROUND_WORK_TO_UNKNOWN_MS` |
| `--activity-background-work-to-unknown-ms` | `AGENT_RELAY_ACTIVITY_BACKGROUND_WORK_TO_UNKNOWN_MS` |

Startup fails outside the frozen ranges. Threshold evaluation uses the daemon's
receive clock, including after restart; event timestamps do not advance state on
their own.

## Selected evidence and limitations

The current frozen CLI evidence is intentionally narrow:

- Codex CLI: session start, prompt submission, and stop;
- Claude CLI: session start, prompt submission, stop with bounded background
  counts, and stop failure;
- Cursor CLI: stop only for activity, plus handshake-only `sessionStart` that
  registers the exact conversation for MCP binding and is not selected work
  evidence; and
- the experimental Codex app-server adapter: selected thread, turn, item,
  approval, error, and owned-process lifecycle observations.

Relay's own durable structured interactions—including exactly bound local MCP
questions—and unexpected owned-child exits are selected too. The MCP adapter
creates the same durable `input.required` event and does not reinterpret this
policy. Permission, tool, subagent, compaction, notification, and session-end
hooks that AR5.1 marked current-only or deferred remain excluded. They require
new exact-version evidence before they can influence activity.

A transport disconnect affects delivery health, not execution. Missing or
contradictory lifecycle evidence fails closed to `Unknown`; restart never
manufactures `Working` or `Done`. Databases upgraded from schema 9 receive a
conservative `Unknown` projection except for exact retained requests, explicit
failures, and explicit ended sessions.

## Privacy and persistence

SQLite schema 11 stores only the allowlisted activity fields, bounded counts,
receive sequence, policy provenance, and keyed correlation digests. A private
random database secret keys source-event and native correlation identities. Raw
prompts, assistant text, tool input/output, commands, error detail, transcripts,
working paths, environment, arguments, credentials, account IDs, model/task
descriptions, and raw native IDs are not stored in activity tables.

Schema 11 also stores local MCP/native-session bindings. Only a keyed digest of
the ephemeral binding authority and exact bounded identity fields are retained;
the authority itself, prompts, answers, tool arguments, and paths are not. This
binding selects which existing session may open a request. It does not add
activity evidence or change any state precedence or timing rule.

SQLite schema 12 adds the opaque project identity and presentation-neutral
project read model. It returns this canonical activity record unchanged,
including confidence, safe reason, server receive-clock activity, bounded work
and request counts, and independent mute state. Project summaries classify
`Done` and `Ended` as recent history and all other states as current;
`Needs input`, `Failed`, and `Unknown` additionally form the complete attention
set. Browser and terminal clients may filter or render these values, but must
not read SQLite directly, inspect events to infer a replacement state, or treat
delivery health as execution evidence.

The executable frozen timing corpus lives at
`packages/harnesses/fixtures/activity-policy/timing-trials.json`. The policy and
fixture provenance is recorded in every canonical projection so diagnostics can
identify the exact interpretation in use.
