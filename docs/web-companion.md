# Local web companion

The optional web companion is a project-centric operator dashboard for many
concurrent harness lanes. It is built into the local daemon and is not a hosted
dashboard or a second source of truth.

## Try the credential-free demo

```sh
pnpm build
node apps/relay/dist/cli.js web-demo
```

Run `agent-relay dashboard --web --demo`. The demo uses a separate local
database, fake Telegram, and bounded synthetic sessions. It ignores real
Telegram and daemon credentials.

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

## What the dashboard shows

The terminal console is `agent-relay dashboard`. It mirrors this information
architecture on the same protected API. See the
[terminal dashboard guide](terminal-dashboard.md) for keys, restore behavior,
and the Ink runtime inventory. The authenticated browser route is one project
view, not a flat session list.

### Project rail

The left rail lists **All projects** first, then one item per exact
checkout/worktree identity. Identity is the opaque `prj_...` project key from
the [project read model](local-web-api.md#presentation-neutral-project-read); a
sibling worktree and a same-named checkout elsewhere stay separate items and
receive a short non-path disambiguator. Each item carries an attention count and
a current count. The selected item is marked with `aria-current`. When more than
200 projects exist, the rail says so and the **All projects** counts remain
exact.

### Selected project pane

The pane is always ordered:

1. **Needs attention** — every canonical `Needs input`, `Failed`, and `Unknown`
   session, plus any session with an open Relay question. Answer controls live
   here and nowhere else.
2. **Current sessions** — every session that is not `Done` or `Ended`, grouped
   by harness. This set is complete and never paginated.
3. **Recent sessions** — only finished `Done` and `Ended` lanes, newest first,
   in cursor-paginated pages of 25 behind **Load more history**.

Needs-attention and current results never shrink because a history page limit
was reached, and the loaded history view stops at 1,000 rows with an explicit
notice rather than growing without bound.

### Session cards

Each card shows a readable session name such as `brisk-otter-42`. The name is a
fixed rendering of the already opaque public session key, so it is stable for
the life of the session and contains no path, harness session ID, or other
private identifier. The exact opaque key is shown in the evidence view when you
need to correlate precisely.

Each card also shows the harness, the canonical `Working`, `Needs input`,
`Background work`, `Idle`, `Done`, `Failed`, `Unknown`, or `Ended` state from
the [durable activity model](session-activity.md), last observed activity, known
in-flight work, pending interaction, and an independent muted delivery
indicator. **Why this state** discloses the confidence and the bounded safe
reason on demand. The dashboard never derives a state, a lane, or a completion
guess of its own; it renders exactly what the protected API returns, including a
literal `Unknown`.

"Active" is never used as a catch-all, and a delivery problem is only ever the
subordinate muted indicator — never the session state.

### Controls and evidence

`Details`, `Continue`, `Mute`, and `End` appear only when the protected API
proves them for the session's retained event and harness capabilities;
unsupported controls stay visible but disabled with the reason in their tooltip.
`End` asks for a second confirming activation before it closes the relay lane,
and it never terminates a harness process. `Details` opens the bounded,
transcript-free timeline and event evidence.

Working paths, repository remotes, branches, prompts, transcripts, command
output, process arguments, stored answers, drafts, callback tokens, machine
identifiers, and harness session identifiers are never rendered, never placed in
the URL, and never written to browser storage. This dashboard adds no transcript
or raw command-output viewer.

Private assistant content is available only through the explicit **Reveal
private assistant excerpt** action inside event evidence. It is bounded and
credential redaction still applies.

### Live updates and the movement policy

The page fetches one fresh project snapshot, then polls the bounded
`project-changes` cursor every three seconds. An invalidation or a change
backlog causes exactly one fresh snapshot fetch; the page also refreshes at
least once a minute so server-clock activity thresholds advance. It never
replays change rows as session state and never guesses across a gap.

Content under your pointer, under your keyboard focus, holding an unsent answer,
or behind an open evidence view never moves. New data waits behind a **Show
updates** control that names the count and the reason, and applies automatically
once you move away. Loading another history page appends rows only; it preserves
the selected project, filters, focus, and scroll position.

Once you have paged past the first page of history, a refresh no longer throws
those rows away. The loaded rows stay, a note says newer activity arrived, and
**Reload history** returns to the newest page when you want it.

A question that belongs to a project or filter you have not selected is counted
in a note under **Needs attention** instead of disappearing silently. Controls
that the protected API does not prove state their reason to screen readers as
well as in a tooltip.

### Secondary filters

State and harness filters are applied by the protected server read, so they
narrow the complete current and attention sets as well as history. The text box
is labelled **Filter loaded sessions** because the protected read contract has
no server-side search: it narrows only what is already on the page, and says so
whenever a query is active.

### States you will see

Loading, empty project, empty history, stale evidence, not synced, reconnecting,
disconnected, expired browser session, snapshot error, unknown project, and
too-many-concurrent-sessions all render an explanation and a recovery step
instead of a blank screen.

### Accessibility and viewport

The page provides a skip link, banner/navigation/main landmarks, labelled
regions for the three sections, one `h1`, full keyboard operation, a visible
focus ring, a polite status region that announces attention-count changes and
pagination results, a focus-trapped evidence dialog that restores focus on
close, and `prefers-reduced-motion` support. It is desktop-first and verified
without horizontal overflow at 1440, 1280, 1024, 768, and 390 CSS pixels; the
rail becomes a horizontal strip and the history table becomes stacked rows on
narrow viewports.

## Decisions and races

Browser answers use the same SQLite transition as Telegram and terminal answers.
Every mutation includes an opaque operation ID and expected session. Repeating
an operation returns its stored result; reusing the operation ID for a different
payload conflicts.

If Telegram wins first, a stale browser form shows the immutable resolved state
without the answer. If the browser wins first, Agent Relay commits locally and
then edits the Telegram card. A Telegram edit failure is visible but cannot roll
back or duplicate the committed answer.

An open question that is answered elsewhere disappears from **Needs attention**
and leaves one bounded notice naming the outcome the daemon reported — answered,
expired, or cancelled — without showing the answer. If the daemon cannot say how
it ended, the notice says exactly that rather than claiming an answer. A form
submitted after another surface won returns the shared immutable terminal state
instead of a second write. Expiry countdowns are a display hint from this
browser's clock only; the daemon decides whether a question is still open, so a
skewed clock never disables a control.

The dashboard consumes the additive presentation-neutral project read. It
supplies opaque exact-worktree identity, safe labels, exact
aggregate/current/attention counts, cursor-paginated terminal history, canonical
activity, and bounded pull invalidations. Clients consume the protected API;
they do not read `relay.sqlite` or implement a second activity reducer. The
existing `/sessions`, `/attention`, `/changes`, and `/stream` routes are
unchanged for other consumers, and the Server-Sent Events stream still resumes
from its durable cursor. See
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

## Dashboard troubleshooting

| What you see                                           | What it means and what to do                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Reconnecting** with the last snapshot still visible  | A poll failed. The daemon may be restarting; answers submitted now fail closed. Wait, or restart `agent-relay daemon`.                  |
| **Daemon stale**                                       | No successful update for 30 seconds. The data on screen is the last safe snapshot, not a live one.                                      |
| Recovery screen saying the browser session ended       | The daemon restarted or the session expired. Run `agent-relay dashboard --web` again.                                                   |
| "assets and daemon API are incompatible"               | The packaged dashboard and daemon disagree on the API/asset version. Rebuild or reinstall Agent Relay and restart the daemon.           |
| "That project has no retained sessions"                | The selected worktree aged out of retention. The view falls back to **All projects**.                                                   |
| "more concurrent sessions than the dashboard can show" | The complete current set exceeded its 1,000-session safety capacity. Select one project, or filter by state or harness.                 |
| "Recent history changed while paging"                  | A durable write invalidated the page cursor. The newest page is reloaded automatically; nothing is duplicated or skipped.               |
| A session with all controls disabled                   | The protected API did not prove those controls for its retained event, or the session is outside the newest 500-session control window. |
| An empty project view                                  | No session has reported for that worktree inside the retention window. This is authoritative, not an error.                             |
