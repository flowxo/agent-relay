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

The command creates `web-credential.json` beside the demo database. Copy its
bearer and CSRF values into the connection form. Do not paste them into a
screenshot, issue, fixture, shell history, or browser storage. The built-in page
keeps credentials and unfinished drafts in JavaScript memory only; reload
requires authentication again.

## Use the board with the normal daemon

The companion is enabled by default and served at `http://127.0.0.1:4317/ui/`.
Startup creates `~/.agent-relay/web-credential.json` beside the default SQLite
database. The file must be a regular mode-`0600` file and contains independent
bearer and CSRF secrets.

The static shell contains no relay data and can load without a credential. Every
`/v1/web/*` data request requires the bearer. Mutations additionally require the
CSRF token, exact loopback Origin/Host agreement, and a typed operation body.
There is no CORS opt-in.

Set `AGENT_RELAY_WEB_ENABLED=0` or pass `agent-relay daemon --no-web` to disable
the UI and all web routes. Disabled startup does not create or read a web
credential. Hooks, SQLite, Telegram, supervision, health, and fake delivery
continue.

Binding beyond loopback is not a supported security boundary.

Outbound whooshbang can link to `/ui/?request=<opaque-request-id>`. After the
operator enters the normal web credential, the board scrolls to and focuses that
exact retained request. The URL contains no bearer, CSRF secret, answer, or
callback authority; it is a navigation hint only. See the
[outbound webhook guide](outbound-webhooks.md) for the custom-integration use
case.

## What the board shows

The board projects retained SQLite state into:

- running, waiting, crashed, stale, muted, and ended session lanes;
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

## Security and privacy defaults

- loopback listener only;
- independent bearer and CSRF credentials;
- exact same-origin mutations and no CORS;
- no CDN, analytics, hosted backend, or direct Telegram connection;
- credentials and drafts only in page memory;
- no-store and restrictive browser security headers;
- bounded projections and explicit private reveal; and
- retention inherited from source SQLite records rather than a second history.

For the versioned API, schemas, curl examples, and automated browser evidence,
read [the local web API reference](local-web-api.md). For local files and
erasure, read [PRIVACY.md](../PRIVACY.md).
