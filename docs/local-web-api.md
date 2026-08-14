# Local web control API

> **Status:** Phase 3 local companion contract
>
> **Default boundary:** authenticated HTTP on `127.0.0.1:4317`

The daemon exposes an optional built-in browser control surface. It is not a
second source of truth: browser answers use the same SQLite request state,
runtime validation, expiry checks, and first-writer-wins transition as Telegram
and terminal answers.

For operator setup and the shorter privacy/threat summary, start with the
[local web companion guide](./web-companion.md). This document is the versioned
HTTP and browser-behavior reference.

The built-in session board is served at `http://127.0.0.1:4317/ui/`. Its static
shell is public on loopback and contains no relay data or credential. The normal
entry is `agent-relay dashboard --web`: the CLI verifies the protected app,
creates a 60-second single-use grant, and opens an authenticated browser
session. Direct `/ui/` access shows that command first; persistent manual bearer
and CSRF fields are behind **Advanced recovery** and remain page-memory-only.
Authenticated API responses remain the only source of session and attention
data.

The companion is enabled by default for loopback development. Set
`AGENT_RELAY_WEB_ENABLED=0` or pass `agent-relay daemon --no-web` to disable the
UI and every `/v1/web/*` route. Disabled startup does not create or read a web
credential. Hook ingestion, health/status, the durable spool, Telegram
delivery/replies, and supervision keep their existing routes and behavior.

## Credential

Daemon startup creates `web-credential.json` beside `relay.sqlite` (normally
`~/.agent-relay/web-credential.json`). The file contains independent bearer and
CSRF tokens and must remain mode `0600`. Startup fails if an existing credential
is a symlink, malformed, or accessible to group/other users. The daemon reports
the path to callers that embed it, but never logs or returns either token.

The credential is intentionally separate from `AGENT_RELAY_DAEMON_TOKEN`.
Existing hook and supervisor clients therefore keep their current authentication
contract, while web routes always require the generated web credential.

The normal flow never returns the persistent credential to the browser. The CLI
uses these headers only on loopback to verify readiness and create/revoke a
bootstrap grant:

```http
Authorization: Bearer <credential.token>
```

Browser mutations additionally require an exact same-origin `Origin` header and:

```http
X-Agent-Relay-CSRF: <credential.csrfToken>
```

`POST /v1/web/bootstrap-grants` accepts only that persistent authority and
returns a random grant valid for 60 seconds. `POST /v1/web/bootstrap/exchange`
requires exact loopback Origin/Host scope and atomically consumes the grant. A
successful exchange sets a host-only `HttpOnly; SameSite=Strict; Path=/` session
cookie with no persistent expiry and returns only a session-specific CSRF value
for JavaScript memory. It never returns the persistent bearer or CSRF.

Browser-session reads authenticate with the cookie. Browser-session mutations
also send the ephemeral session CSRF in `X-Agent-Relay-CSRF`. Sessions slide for
up to 30 minutes idle but never beyond eight hours total. Refresh and reopening
on the same exact loopback Host recover the ephemeral CSRF from
`GET /v1/web/session`; browser-session loss, expiry, Host change, or daemon
restart fails closed. Grants and sessions are daemon-memory-only, bounded, and
invalidated by restart.

The daemon rejects cross-site fetch metadata, non-loopback origins, mismatched
Host/Origin pairs, credential reuse across operation payloads, CORS preflights,
and bodies above the daemon limit. It never emits an
`Access-Control-Allow-Origin` header.

## Read models

The established general list routes default to 100 and are bounded from 1
through 500. The project read routes have narrower bounds documented below.

| Method and route                           | Result                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST /v1/web/bootstrap-grants`            | Persistent-authority creation of one scoped, 60-second single-use grant              |
| `POST /v1/web/bootstrap/exchange`          | Same-origin grant consumption and browser-session establishment                      |
| `POST /v1/web/bootstrap/revoke`            | Best-effort revocation after a browser-open failure                                  |
| `GET /v1/web/session`                      | Active browser-session metadata and ephemeral page-memory CSRF                       |
| `GET /v1/web/meta`                         | Static-asset/API and mutation-contract compatibility                                 |
| `GET /v1/web/projects`                     | Opaque project summaries, complete active sets, and one recent-history page          |
| `GET /v1/web/project-changes?cursor=...`   | Bounded, coalesced project-snapshot invalidations                                    |
| `GET /v1/web/sessions?limit=100`           | Session key, harness/surface, repository/branch, canonical activity, attention count |
| `GET /v1/web/attention?limit=100`          | Open request previews, expiry, safe choices, supported actions                       |
| `GET /v1/web/sessions/:key/timeline`       | Correlated retained session evidence                                                 |
| `GET /v1/web/events/:eventId`              | One bounded event/request detail                                                     |
| `GET /v1/web/events/:eventId/reveal`       | Explicit bounded private-content reveal                                              |
| `GET /v1/web/diagnostics/export`           | Downloadable re-sanitized diagnostic evidence                                        |
| `GET /v1/web/changes?after=0&limit=100`    | Ordered durable changes and retained cursor bounds                                   |
| `GET /v1/web/stream?after=0`               | Ordered Server-Sent Events                                                           |
| `POST /v1/web/requests/:requestId/resolve` | Idempotent typed response resolution                                                 |
| `POST /v1/web/sessions/:key/actions`       | Exact-event Continue, Mute, or End command                                           |

Session summaries use a stable 24-character key instead of returning the machine
or harness session ID. Their display ID matches Telegram's readable
eight-character session suffix plus a six-character collision digest, so the
operator can correlate the same lane across surfaces. Event detail omits
`lastAssistantMessage`, working-directory hashes, process IDs and arguments,
option callback tokens, stored answers, and structured draft content. Prompt,
label, summary, and failure previews are secret-redacted and bounded.

The v2 session summary schema is `agent-relay-web-session.v2`. Its `activity`
field is the canonical `agent-relay-session-activity.v1` record. Its state is
`working`, `needs_input`, `background_work`, `idle`, `done`, `failed`,
`unknown`, or `ended`; `stateLabel` contains the exact operator-facing label.
Confidence, bounded reason and source, server-clock last activity, open counts,
and independent mute configuration travel with that projection. See the
[durable activity reference](session-activity.md). `lifecycleState` remains as a
legacy underlying harness observation and is not an operator-state contract.

### Presentation-neutral project read

`GET /v1/web/projects` is the protected read surface for project-centric browser
and terminal dashboards. It is additive to web API version 3; the existing
`/sessions`, `/attention`, `/changes`, and `/stream` responses are unchanged.
The response schema is `agent-relay-project-read.v1` and its nested project and
session schemas are independently versioned.

The `project` query defaults to `all`. An exact checkout or worktree has a
stable `prj_...` key derived with a private database key from its existing path
digest. A sibling worktree, another checkout, and two unrelated directories with
the same basename therefore remain distinct. The key survives daemon restart
with the same database. The human label is a separately sanitized, bounded
convenience and must never be used as identity; duplicate labels gain a short
suffix from the opaque project key. Unsafe path-, URL-, Git-, control-, or
credential-shaped labels become `Project`.

`projects.all` is the exact **All projects** aggregate. Each summary reports
current, needs-attention, needs-input, failed-or-unknown, recent, and total
session counts. At most 200 individual project summaries are returned, with an
explicit `totalCount` and `truncated`; the selected project remains present even
when it falls outside that window. Aggregate counts remain exact and do not
depend on this presentation bound.

The session sets use only the canonical `agent-relay-session-activity.v1`
projection:

- `currentByHarness` contains every session not canonically `Done` or `Ended`;
- `needsAttention` independently contains every current `Needs input`, `Failed`,
  or `Unknown` session; and
- `recent.items` contains only `Done` and `Ended` history.

The current and needs-attention sets are never truncated by `limit`. Their
explicit safety capacity is 1,000 sessions; exceeding it returns
`503 complete_set_capacity_exceeded` instead of a misleading partial result.
Only recent history is paginated. `limit` defaults to 50 and is bounded from 1
through 100. Optional `harness` and canonical `state` filters apply consistently
to the returned session sets and history; `project` selects one opaque project.

Recent history sorts newest first by server receive-clock `lastSeenAt`, then by
a stable internal lane tuple. The tuple is held only inside the authenticated
opaque cursor and is never returned. A history cursor binds the project and
filters, the first page's change watermark, projection time, and keyset
position. This prevents timestamp ties, clock-only state transitions, and deep
history from omitting or repeating sessions. A changed database returns
`409 stale_cursor`; a malformed, wrong-scope, or foreign-database cursor returns
`400 invalid_cursor`; cursors older than 24 hours return `409 stale_cursor`.
Fetch a fresh first page in either stale case.

Each session exposes only its opaque session and project keys, safe label,
harness/surface, canonical activity state/confidence/safe reason and last
activity, bounded known in-flight count, bounded pending-interaction
state/count, and orthogonal muted delivery health. It does not expose absolute
paths, home directories, remotes, branches, prompts, transcripts, answers,
credentials, OAuth URLs, machine IDs, native session IDs, bridge IDs, path
digests, or the private pagination tie-break values. A presentation client must
not read SQLite or derive another activity state from events.

### Project change and reconnect protocol

The snapshot's opaque `changeCursor` starts
`GET /v1/web/project-changes?cursor=...`. A call reads at most 100 changes by
default and never more than 200. It returns zero or one content-free
invalidation containing only bounded kinds, a safe timestamp, and a coalesced
count. `hasMore` says that additional retained rows exist. This pull protocol
keeps no per-subscriber queue, so a slow, paused, or duplicated browser/TUI
cannot consume unbounded daemon memory.

Clients use this deterministic sequence:

1. On startup or reconnect, discard any assumed live state and fetch one fresh
   project snapshot. An empty response is authoritative, not an error.
2. Poll changes from that snapshot's cursor. With no invalidation, retain the
   data and advance to the returned cursor. Also fetch a fresh snapshot at least
   once per minute so server-clock activity thresholds advance without a durable
   write.
3. Coalesce any invalidation or `hasMore` backlog into one fresh snapshot fetch;
   do not replay changes as session state. Replace all visible data and restart
   polling from the new snapshot cursor.
4. On `invalid_cursor`, `stale_cursor`, retention loss, database replacement, or
   daemon restart, fetch a fresh snapshot. Never guess across the gap.

Multiple durable writes may coalesce into one invalidation, and repeated fresh
snapshots are safe. Snapshot data and its watermark share one SQLite read
transaction, as do change bounds and their returned batch. Native timestamps do
not control ordering: the daemon's monotonic receive time updates session
recency, while the canonical reducer consumes unique evidence in durable receive
order. Late or out-of-order native sequences cannot rewind the retained native
sequence. Missing or contradictory evidence remains the literal canonical
`Unknown`; clients must not relabel it. Current activity changes caused only by
the documented clock thresholds are reflected on the next fresh snapshot.

The new routes are GET-only and use the existing persistent web bearer or
host-bound browser session. They need no CSRF because they do not mutate. Every
web mutation retains its same-origin and CSRF requirements. Rollback at the HTTP
boundary is simply to stop consuming these additive routes. SQLite schema 12 is
forward-only: an older schema-11 binary must use a reviewed pre-migration backup
or be replaced by a schema-12-capable build; never edit `user_version`.

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

The UI refuses to connect when `/v1/web/meta` reports a different API or asset
version. API version 3 provides the browser-session bootstrap without changing
the canonical session/request authority. Asset version 5 distinguishes a
post-authentication data-load failure from an invalid or replayed bootstrap
grant. The package check separately verifies that all five static files, their
version marker, API negotiation, and both mutation schemas survived the build.
CI runs that check from compiled output before the browser suite.

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

The built-in UI keeps its session CSRF and unfinished form values only in page
memory while live snapshots re-render. It never writes private drafts to browser
storage. Terminal request change events identify the winning surface and remove
stale controls; reconnecting then refreshes the authoritative request list.
Server identity, expiry, compatibility, and operation-ledger checks remain
authoritative even if the page was open across a race.

Timeline rows are projections of their source records, not a second unbounded
history. Event and delivery rows disappear with event retention; resolved
request, action, and continuation rows disappear with request retention;
diagnostics disappear with diagnostic retention; and terminal sessions may then
be removed. The UI reports an empty/pruned state rather than inferring missing
history.

## Local verification

### Credential-free concurrent-session demo

Build and start a separate synthetic daemon:

```sh
pnpm build
node apps/relay/dist/cli.js web-demo
```

The command uses `127.0.0.1:4318`, the fake Telegram transport, a fixed
dedicated demo SQLite file and log beneath `~/.agent-relay/web-demo/`, and four
bounded synthetic lanes across Working, Needs input, Idle, and Failed. It
ignores provider and daemon bearer environment credentials, never contains
assistant transcript content, and does not log either generated local credential
value. Open `http://127.0.0.1:4318/ui/` and copy the two fields from
`~/.agent-relay/web-demo/web-credential.json`. Only `--port` is configurable;
the command rejects `--db`, `--log`, and `--host` so a demo cannot read another
database, write another log, or leave the loopback boundary. Stop an existing
demo before reusing its fixed state directory.

### Automated package and browser proof

```sh
pnpm check:pr
pnpm audit --prod
```

The Chromium suite starts real loopback daemons with fake Telegram and synthetic
data. It covers bootstrap exchange and history cleanup, refresh and direct-tab
reopening, replay rejection, compact/manual recovery, browser-session loss and
page-memory draft clearance across a complete daemon restart, a stale browser
form after a Telegram-first answer, and a synchronized Telegram/browser race
with one durable winner. CI follows
[Playwright's documented browser installation](https://playwright.dev/docs/ci)
and runs one worker for reproducibility.

Do not reproduce protected API calls with bearer or CSRF values in `curl`
arguments: command arguments can enter process listings, shell history, error
capture, and terminal logs. Use `agent-relay dashboard --web` for normal
operation. Repository tests call the API in-process with isolated synthetic
credentials and bounded loopback servers. If manual recovery is necessary, use
the built-in Advanced form, which keeps both persistent values in page memory.
Do not put either value in `.env.activation`, browser storage, screenshots,
fixtures, issues, or git.

## Security and privacy defaults

- The listener defaults to `127.0.0.1`; exposing it on another interface is an
  explicit operator decision and is not a hosted/deployment mode.
- The static shell is credential-free. Normal data/API requests require the
  host-bound HttpOnly browser session; manual recovery uses the independent
  persistent local bearer. Mutations additionally require the matching
  ephemeral/manual CSRF and an exact loopback same-origin request.
- Static responses use no-store, a same-origin-only Content Security Policy,
  frame denial, no-referrer, MIME sniffing protection, and cross-origin opener
  isolation. There is no CORS opt-in.
- Persistent credentials remain file-only in the normal flow. The ephemeral
  session CSRF, manually entered credentials, and unfinished drafts exist only
  in page memory. Refresh/reopen recover an unexpired browser session; expiry,
  browser-session loss, or daemon restart requires a fresh launcher grant. The
  credential file is regular, private, non-symlinked, and mode `0600`.
- Default projections exclude machine/session identifiers, working paths,
  process arguments, stored answers, callback tokens, draft content, and
  assistant transcript text. Explicit reveal and diagnostic export remain
  bounded and secret-redacted.
- The console does not contact a CDN, analytics service, hosted backend, or
  Telegram directly. Disabling it removes its static and API attack surface
  without disabling relay operation.
- Tunnels, reverse proxies, and public listeners are unsupported. Reachability
  does not add a reviewed remote identity, TLS/proxy, rate-limit, or revocation
  boundary, and the loopback credential/session design must not be repurposed.
