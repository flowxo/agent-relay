# Local web control API

> **Status:** Phase 3 local companion contract
>
> **Default boundary:** authenticated HTTP on `127.0.0.1:4317`

The daemon exposes a small local API for a future browser control surface. It is
not a second source of truth: browser answers use the same SQLite request state,
runtime validation, expiry checks, and first-writer-wins transition as Telegram
and terminal answers.

The built-in session board is served at `http://127.0.0.1:4317/ui/`. Its static
shell is public on loopback and contains no relay data or credential. Paste the
generated bearer and CSRF token into its connection form; the page retains both
only in JavaScript memory, never browser storage. Authenticated API responses
remain the only source of session and attention data.

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
| `GET /v1/web/sessions/:key/timeline`       | Correlated retained session evidence                                         |
| `GET /v1/web/events/:eventId`              | One bounded event/request detail                                             |
| `GET /v1/web/events/:eventId/reveal`       | Explicit bounded private-content reveal                                      |
| `GET /v1/web/diagnostics/export`           | Downloadable re-sanitized diagnostic evidence                                |
| `GET /v1/web/changes?after=0&limit=100`    | Ordered durable changes and retained cursor bounds                           |
| `GET /v1/web/stream?after=0`               | Ordered Server-Sent Events                                                   |
| `POST /v1/web/requests/:requestId/resolve` | Idempotent typed response resolution                                         |
| `POST /v1/web/sessions/:key/actions`       | Exact-event Continue, Mute, or End command                                   |

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

Request read models advertise only actions proven for the event's harness
capabilities:

- `continue` and `respond-text` for eligible continuation requests;
- `respond-text` for free text;
- `choose-option` for confirmation, single-select, and permission requests;
- `choose-multiple` with explicit selection bounds; and
- `answer-question-set` for ordered confirm, single-select, multi-select, and
  free-text sets.

Session summaries separately advertise `details`, `continue`, `mute`, and `end`.
Unavailable controls remain visible but disabled in the UI. Details opens the
bounded transcript-free event view; End affects only the relay lane and never
claims to terminate an unowned harness process. End is unavailable while a
request remains open.

## Timeline, detail, and diagnostics

Selecting a session in the board loads at most 200 newest timeline rows. The
timeline is assembled from the same retained SQLite records and distinguishes:

- harness hook events, including proven crashes and failures;
- individual delivery attempts, retries, and terminal delivery states;
- request creation and the winning Telegram, terminal, or browser resolution;
- Telegram card actions; and
- claimed, running, succeeded, or failed harness continuation attempts.

Event IDs and request correlation IDs connect those rows without copying the
operator answer, assistant transcript, delivery error message, process
arguments, or draft text into the timeline. The default event-detail route
continues to omit `lastAssistantMessage`.

The separate `/reveal` route is called only after the operator activates
**Reveal private assistant excerpt**. It returns at most 2,000 characters and
still redacts recognized credentials. The UI renders default details and
revealed content as text, never injected markup.

Diagnostic export is bounded to 500 newest retained records. It applies current
secret and machine-path redaction again at export time, including to older
records stored before a redaction improvement. The response declares
`sanitized: true` and includes the default 90-day diagnostic retention window.

## Idempotent resolution

A mutation body is runtime validated:

```json
{
  "schema": "agent-relay-web-resolve.v1",
  "operationId": "browser-operation-opaque-1234",
  "sessionKey": "0123456789abcdef01234567",
  "response": {
    "kind": "multi-select",
    "optionIds": ["provider-option-one", "provider-option-two"]
  }
}
```

The response discriminator is `text`, `option`, `multi-select`, or
`question-set`. Question-set answers use the existing ordered
`InteractionQuestionAnswer` contract; the daemon constructs and validates the
canonical `agent-interaction-answer.v1` envelope. Multi-select IDs are validated
against the retained request and stored in request order.

`operationId` is persisted with a digest of the request ID and typed response;
private text is not copied into the replay ledger. Repeating the same operation
returns its stored outcome. Reusing an operation ID for different content
returns `409 replay_conflict`. The submitted `sessionKey` must match the
retained request, preventing a stale form from crossing lanes.

A different operation that loses the Telegram/terminal/browser race returns the
shared immutable terminal state and `resolvedBy` without returning the private
answer. When the browser wins, the daemon removes controls and marks the
Telegram card terminal through the interactive transport. An edit failure never
rolls back the committed answer, but it returns a surface-sync failure and
records a durable sanitized diagnostic.

Session mutations carry an exact retained `eventId`:

```json
{
  "schema": "agent-relay-web-session-action.v1",
  "operationId": "browser-session-operation-1234",
  "eventId": "event-opaque-1234",
  "action": "mute"
}
```

They execute through the same card-action command used by Telegram. The event
must belong to the URL's session and remain that session's latest event.
Duplicate operations replay their durable result; changed payloads conflict; and
a Telegram action that arrives after a browser win observes the already
completed command instead of repeating it.

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

The built-in UI keeps unfinished form values only in page memory while live
snapshots re-render. It never writes private drafts to browser storage. Terminal
request change events identify the winning surface and remove stale controls;
reconnecting then refreshes the authoritative request list. Server identity,
expiry, compatibility, and operation-ledger checks remain authoritative even if
the page was open across a race.

Timeline rows are projections of their source records, not a second unbounded
history. Event and delivery rows disappear with event retention; resolved
request, action, and continuation rows disappear with request retention;
diagnostics disappear with diagnostic retention; and terminal sessions may then
be removed. The UI reports an empty/pruned state rather than inferring missing
history.

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
