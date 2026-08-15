# Local Relay MCP server

Agent Relay exposes a small, versioned stdio MCP surface for typed operator
questions from a supervised local harness. The server is an adapter over the
existing durable `agent-interaction.v1` request and answer model. It does not
create another interaction store, answer authority, activity policy, permission
path, or network listener.

The frozen surface version is `agent-relay-mcp.v1` over MCP `2025-11-25`:

| Tool             | Input schema                       | Successful result                         |
| ---------------- | ---------------------------------- | ----------------------------------------- |
| `relay_ask`      | `agent-relay-mcp-ask.v1`           | one `agent-relay-mcp-result.v1` answer    |
| `relay_ask_many` | `agent-relay-mcp-questionnaire.v1` | one ordered structured answer             |
| `relay_cancel`   | `agent-relay-mcp-cancel.v1`        | the exact request's terminal cancel state |
| `relay_status`   | `agent-relay-mcp-status.v1`        | safe binding, activity, and request state |

This is the smallest useful V1 surface. A separate notify tool would duplicate
the native lifecycle notification path. A separate check tool would duplicate
`relay_status`. Tool definitions contain strict JSON input and output schemas,
bounded titles, IDs, expiry, question counts, option counts, free-text lengths,
and waits. `relay_ask_many` accepts two through ten ordered questions. The
question kinds remain exactly `confirm`, `single-select`, `multi-select`, and
`free-text` from the shared interaction contract.

Every tool result includes both MCP `structuredContent` and an equivalent text
content item. Application failures use `agent-relay-mcp-error.v1`, set MCP
`isError`, provide a bounded machine-readable code and retry flag, and direct
the harness to its native local question mechanism. Invalid input is
content-free: Relay never echoes tool arguments or schema-invalid values.

## Exact native-session binding

The supervisor generates one high-entropy `mcpbind_…` authority and passes it
only to its owned harness child, native hook invocations, and MCP subprocess. It
first registers the authority with the exact machine, bridge session, and
harness. After a native hook has durably registered the native session, that
same hook claims the authority for the exact parsed native session ID.

SQLite persists only a keyed digest of the authority. Registration, claim, and
end transitions are transactional and survive daemon or MCP reconnects. A second
native session, different machine, different bridge, or different harness using
the same authority permanently marks it `ambiguous`. Questions then fail closed.
Binding never uses a project path, project hash, timestamp, process name, PID,
session age, event ordering guess, or “most recent session.” Two concurrent
sessions in the same project receive independent authorities and cannot
cross-answer.

The binding lifecycle is `pending → bound → ended`; `ambiguous` and `revoked`
are terminal fail-closed states. A bounded tool wait may observe `pending` while
the first native hook establishes the exact session. It never guesses.
Supervisor shutdown ends the authority, while a reconnect or supported
late-resume loop within the same supervisor retains it. Cursor's frozen CLI has
no selected session-start activity event, so the plugin installs a
handshake-only `sessionStart` hook that claims the same exact session ID without
feeding the activity reducer.

Native harness question tools (`request_user_input`, `AskUserQuestion`,
`AskQuestion`) remain terminal-only. Relay does not intercept, rewrite, or
answer them. Ordinary operator questions in an installed session are produced by
the official skill calling these MCP tools under `agent-relay run`. Missing,
incompatible, pending, or unbound MCP returns a typed error and `localFallback`
directing the harness to its native local question mechanism. Permission,
`ExitPlanMode`, and shell-approval hooks stay on the native approval path and
never become questionnaires.

## Durable request behavior

An ask creates an ordinary durable `input.required` event containing an
`agent-interaction-request.v1` question set. The existing SQLite request row,
delivery queue, provider negotiation, draft persistence, first-writer answer,
expiry, cancellation, retention, and late-resume logic remain authoritative. The
canonical activity projection therefore becomes **Needs input** while the
request is open and clears through the same resolution transition used by
Telegram, the loopback web companion, and other supported operator surfaces.

`requestId` is the idempotency key. Retrying the exact owner, title, questions,
and expiry is a duplicate read of the retained request. Reusing it for another
session or payload is `request-conflict`. Cancellation and an operator answer
race through the existing first-writer-wins transition. Expired, canceled, and
failed requests never accept a late replacement answer.

`waitTimeoutMs` is a client wait, not the request lifetime. It is bounded from
zero through 120 seconds. `answer-timeout` leaves the request open and durable;
a later operator response may be returned by `relay_status` or by retrying the
same ask. Expiry is independently bounded from one minute through seven days.
Offline delivery remains queued and is reported as degraded or unavailable; it
does not silently turn into a local answer.

## Safe invocation and diagnosis

The supported entrypoint is:

```sh
agent-relay mcp
```

It uses newline-delimited JSON-RPC on stdin/stdout and opens no listener. The
supervised runtime supplies `AGENT_RELAY_MCP_BINDING`,
`AGENT_RELAY_MCP_HARNESS`, the exact machine and bridge IDs, and loopback daemon
connection values. Official plugin manifests forward those placeholders through
the native MCP `env` block so a harness that spawns a clean environment still
receives them. Do not create or copy these values manually. The installer
adds the official harness skill artifacts but does not add, replace, or delete
any user MCP configuration. A harness without the exact compatible surface uses
its native local question mechanism.

Run `agent-relay doctor` to check that the packaged MCP entrypoint exists. In a
supervised child environment it also safely reports whether correlation is
pending, bound, ended, revoked, or ambiguous. It also reports
`interaction-production` (MCP, correlation, official skills, plugins, and the
Cursor `sessionStart` handshake) and `configured-surfaces` (selected delivery
transport plus whether the local web companion is enabled). The report never
includes the binding authority, native session ID, request contents, answers,
paths, provider IDs, or credentials. `ambiguous` and `revoked` are failures; an
unbound but available handshake is a warning.

Do not use Relay MCP for permission, privilege, credential, or security approval
prompts. Those stay on the harness's native approval path. Tool descriptions and
server instructions state this boundary explicitly.

## Fixtures and verification

The checked synthetic request fixtures are
`packages/protocol/fixtures/interactions/mcp-ask.v1.json` and
`mcp-questionnaire.v1.json`. Tests cover schema and tool negotiation, malformed
and unknown calls, typed timeout and cancel outcomes, daemon HTTP composition,
fake delivery, answer reconnect, restart persistence, duplicate requests,
offline delivery, expiry races, same-project concurrency, ambiguous binding,
native-hook correlation, doctor results, and log redaction. They use only local
SQLite, loopback HTTP, fake delivery, and synthetic values.
