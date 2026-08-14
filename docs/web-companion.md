# Local web companion

The optional web companion is a session board for many concurrent harness lanes.
It is built into the local daemon and is not a hosted dashboard or a second
source of truth.

## Try the credential-free demo

```sh
pnpm build
node apps/relay/dist/cli.js web-demo
```

Open `http://127.0.0.1:4318/ui/`. The demo uses a separate local database, fake
Telegram, and bounded synthetic sessions. It ignores real Telegram and daemon
credentials.

The command creates a synthetic `web-credential.json` beside the demo database.
Open **Advanced recovery: connect manually** to use its bearer and CSRF fields.
Do not paste them into a screenshot, issue, fixture, shell history, or browser
storage. This manual demo path keeps credentials and unfinished drafts in
JavaScript memory only.

## Use the board with the normal daemon

The companion is enabled by default. With the daemon running, the normal entry
is one command:

```sh
agent-relay dashboard --web
```

The launcher verifies the loopback daemon, web enablement, protected API/asset
compatibility, and current private credential before creating any browser
authority. It creates a 60-second single-use grant scoped to the exact loopback
Origin and Host, opens the default browser, and lets that page exchange the
grant for a host-bound HttpOnly session cookie plus an ephemeral session CSRF
value. The page removes the grant from the address bar and current history entry
as soon as exchange starts. Grant replay, malformed or stale material, expiry,
cross-site requests, and Host/Origin mismatch fail closed.

Startup creates `~/.agent-relay/web-credential.json` beside the default SQLite
database. The file must be a regular mode-`0600` file and contains independent
persistent bearer and CSRF secrets. The launcher reads them only from that
private file and sends them only as protected loopback request headers. It never
prints or puts them in a URL, shell argument, browser store, log, analytics
event, error, or diagnostic.

Refresh and another direct `http://127.0.0.1:4317/ui/` tab reuse the browser
session while it is valid. The idle lifetime is 30 minutes and the absolute
lifetime is eight hours; the cookie has no persistent expiry and ends with the
browser session. A daemon restart invalidates every grant and browser session.
Expiry, missing cookie, or restart returns the compact recovery screen and the
exact launcher command. Rerunning the command creates a fresh independent
session.

The static shell contains no relay data and can load without a credential. Every
`/v1/web/*` data request requires either the browser session or the persistent
manual bearer. Mutations additionally require the matching session/manual CSRF,
exact loopback Origin/Host agreement, and a typed operation body. There is no
CORS opt-in. Direct `/ui/` access puts `agent-relay dashboard --web` above the
fold; manual bearer/CSRF fields remain behind the clearly labeled **Advanced
recovery** disclosure.

Set `AGENT_RELAY_WEB_ENABLED=0` or pass `agent-relay daemon --no-web` to disable
the UI and all web routes. Disabled startup does not create or read a web
credential. Hooks, SQLite, Telegram, supervision, health, and fake delivery
continue.

Binding beyond loopback is not a supported security boundary. Tunnels and
reverse proxies provide reachability, not the missing remote authentication, TLS
termination policy, forwarded-host validation, rate limiting, or operator
authorization. Public exposure and tunnels remain unsupported.

Outbound whooshbang can link to `/ui/?request=<opaque-request-id>`. After the
operator enters the normal web credential, the board scrolls to and focuses that
exact retained request. The URL contains no bearer, CSRF secret, answer, or
callback authority; it is a navigation hint only. See the
[outbound webhook guide](outbound-webhooks.md) for the custom-integration use
case.

## What the board shows

The board projects retained SQLite state into:

- Working, Needs input, Background work, Idle, Done, Failed, Unknown, and Ended
  session lanes from the [durable activity model](session-activity.md), with
  mute shown independently;
- open attention requests with only currently valid controls;
- a bounded correlated timeline of events, delivery attempts, answers, card
  actions, and continuation attempts;
- bounded event details; and
- re-sanitized diagnostic export.

It uses a stable public session key and a readable suffix that matches Telegram,
not the full machine or harness session identifier. Default views omit working
paths, process arguments, stored answers, drafts, callback tokens, and full
assistant text.

Private assistant content is available only through the explicit **Reveal
private assistant excerpt** action. It is bounded and credential redaction still
applies.

## Decisions and races

Browser answers use the same SQLite transition as Telegram and terminal answers.
Every mutation includes an opaque operation ID and expected session. Repeating
an operation returns its stored result; reusing the operation ID for a different
payload conflicts.

If Telegram wins first, a stale browser form shows the immutable resolved state
without the answer. If the browser wins first, Agent Relay commits locally and
then edits the Telegram card. A Telegram edit failure is visible but cannot roll
back or duplicate the committed answer.

The Server-Sent Events stream resumes from a durable cursor. If retention
removed history or the database changed, the server sends a reset and the board
refetches authoritative state.

The daemon also exposes an additive presentation-neutral project read for future
browser and TUI clients. It supplies opaque exact-worktree identity, safe
labels, exact aggregate/current/attention counts, cursor-paginated terminal
history, canonical activity, and bounded pull invalidations. Clients consume the
protected API; they do not read `relay.sqlite` or implement a second activity
reducer. The current board's existing API remains compatible. See
[Presentation-neutral project read](local-web-api.md#presentation-neutral-project-read)
for the complete reconnect and failure contract.

## Security and privacy defaults

- loopback listener only;
- 60-second single-use, Origin/Host-scoped bootstrap grants;
- 30-minute-idle/eight-hour-absolute, HttpOnly browser sessions;
- independent persistent bearer/CSRF manual recovery credentials that never
  enter the normal browser flow;
- exact same-origin mutations and no CORS;
- no CDN, analytics, hosted backend, or direct Telegram connection;
- ephemeral session/manual CSRF and drafts only in page memory;
- no-store and restrictive browser security headers;
- bounded projections and explicit private reveal; and
- retention inherited from source SQLite records rather than a second history.

For the versioned API, schemas, curl examples, and automated browser evidence,
read [the local web API reference](local-web-api.md). For local files and
erasure, read [PRIVACY.md](../PRIVACY.md).

## Launcher failures and recovery

The launcher emits actionable, secret-free failures:

- unavailable daemon: start `agent-relay daemon` and rerun the command;
- disabled companion: restart without `--no-web` and with
  `AGENT_RELAY_WEB_ENABLED=1`;
- protected-app or asset mismatch: rebuild/reinstall the exact package and
  restart the daemon;
- browser-open failure: repair the desktop default-browser association and rerun
  the command (the unused grant is revoked or expires within 60 seconds);
- stale, expired, or replayed link: rerun the command; and
- missing/expired session or daemon restart: rerun the command.

If the desktop launcher alone is unavailable, open `/ui/`, expand **Advanced
recovery: connect manually**, and paste both current private-file fields. Never
put either persistent value in a URL, command line, screenshot, issue, or log.
