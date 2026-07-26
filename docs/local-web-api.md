# Local web control API

> **Status:** FXO-1068 implementation contract
>
> **Default boundary:** authenticated HTTP on `127.0.0.1:4317`

The daemon exposes a small local API for a future browser control surface. It is
not a second source of truth: browser answers use the same SQLite request state,
runtime validation, expiry checks, and first-writer-wins transition as Telegram
and terminal answers.

The built-in session board is served at `http://127.0.0.1:4317/ui/`. Its static
shell is public on loopback and contains no relay data or credential. Paste the
generated bearer token into its connection form; the page retains it only in
JavaScript memory, never browser storage. Authenticated API responses remain the
only source of session and attention data.

## Credential

Daemon startup creates `web-credential.json` beside `relay.sqlite` (normally
`~/.agent-relay/web-credential.json`). The file contains independent bearer and
CSRF tokens and must remain mode `0600`. Startup fails if an existing credential
is a symlink, malformed, or accessible to group/other users. The daemon reports
the path to callers that embed it, but never logs or returns either token.

The credential is intentionally separate from `AGENT_RELAY_DAEMON_TOKEN`.
Existing hook and supervisor clients therefore keep their current authentication
contract, while web routes always require the generated web credential.

Every `/v1/web/*` request requires:

```http
Authorization: Bearer <credential.token>
```

Browser mutations additionally require an exact same-origin `Origin` header and:

```http
X-Agent-Relay-CSRF: <credential.csrfToken>
```

The daemon rejects cross-site fetch metadata, non-loopback origins, mismatched
Host/Origin pairs, credential reuse across operation payloads, CORS preflights,
and bodies above the daemon limit. It never emits an
`Access-Control-Allow-Origin` header.

## Read models

All list limits default to 100 and are bounded from 1 through 500.

| Method and route                           | Result                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /v1/web/sessions?limit=100`           | Session key, harness/surface, repository/branch, lane state, attention count |
| `GET /v1/web/attention?limit=100`          | Open request previews, expiry, safe choices, supported actions               |
| `GET /v1/web/events/:eventId`              | One bounded event/request detail                                             |
| `GET /v1/web/changes?after=0&limit=100`    | Ordered durable changes and retained cursor bounds                           |
| `GET /v1/web/stream?after=0`               | Ordered Server-Sent Events                                                   |
| `POST /v1/web/requests/:requestId/resolve` | Idempotent text or option-ID resolution                                      |

Session summaries use a stable 24-character key instead of returning the machine
or harness session ID. Their display ID matches Telegram's readable
eight-character session suffix plus a six-character collision digest, so the
operator can correlate the same lane across surfaces. Event detail omits
`lastAssistantMessage`, working-directory hashes, process IDs and arguments,
option callback tokens, stored answers, and structured draft content. Prompt,
label, summary, and failure previews are secret-redacted and bounded.

Session `state` is the operator-facing lane state: `running`, `waiting`,
`crashed`, `stale`, `muted`, or `ended`. `lifecycleState` retains the underlying
harness lifecycle without asking the browser to infer controls or failures.

The currently supported browser actions are:

- `respond-text` for input and continuation requests;
- `choose-option` for confirmation, single-select, and permission requests.

Multi-select and question-set requests remain visible but advertise no action
until the structured browser UI implements their durable draft workflow.

## Idempotent resolution

A mutation body is runtime validated:

```json
{
  "schema": "agent-relay-web-resolve.v1",
  "operationId": "browser-operation-opaque-1234",
  "answer": "provider-option-id-or-free-text"
}
```

`operationId` is persisted with a digest of the request ID and normalized
answer; the private answer is not copied into the replay ledger. Repeating the
same operation returns its stored outcome. Reusing an operation ID for different
content returns `409 replay_conflict`. A different operation that loses the
Telegram/terminal/browser race returns the shared terminal state and cannot
overwrite the winner.

## Stream resume

Each change event has a monotonically increasing SQLite cursor:

```text
id: 42
event: change
data: {"cursor":42,"kind":"request",...}
```

Reconnect with `?after=42` or `Last-Event-ID: 42`. The daemon sends only larger
cursors. If retention removed the requested history, or the database was
replaced and the cursor is ahead of it, the stream emits `event: reset` with the
current bounds. The client must refetch sessions and attention, then reconnect
from the reported last cursor. Change rows and idempotency commands use the same
bounded retention windows as delivered events and resolved requests.

## Local verification

Keep token values out of shell tracing and terminal output:

```sh
set +x
relay_web_token="$(jq -r .token "$HOME/.agent-relay/web-credential.json")"
relay_web_csrf="$(jq -r .csrfToken "$HOME/.agent-relay/web-credential.json")"

curl --silent --show-error --fail \
  -H "Authorization: Bearer ${relay_web_token}" \
  -H "Origin: http://127.0.0.1:4317" \
  "http://127.0.0.1:4317/v1/web/sessions?limit=20"

curl --no-buffer --silent --show-error \
  -H "Authorization: Bearer ${relay_web_token}" \
  -H "Origin: http://127.0.0.1:4317" \
  -H "Last-Event-ID: 0" \
  "http://127.0.0.1:4317/v1/web/stream"
```

Unset the temporary shell variables after verification. Do not place either
token in `.env.activation`, browser storage, screenshots, fixtures, issues, or
git.
