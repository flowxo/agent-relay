# Terminal dashboard

`agent-relay dashboard` opens a full-screen, real-time operator console in the
terminal. It consumes the same protected project/session API and change stream
as the [browser dashboard](web-companion.md). The local daemon must be running;
the browser does not need to be open. The TUI does not read or write SQLite and
does not implement a second activity reducer.

## Launch

```sh
agent-relay dashboard
```

The TUI runs on the product Node.js 22 floor. The command needs an interactive
TTY. It reads the private local web credential from
`~/.agent-relay/web-credential.json` in-process and sends it only as loopback
`Authorization` and CSRF headers. It never prints the credential, puts it in
argv, writes it to logs, or leaves it in scrollback.

Related commands:

```sh
agent-relay dashboard --web
agent-relay dashboard --json
agent-relay dashboard --demo
agent-relay dashboard --web --demo
```

`--web` remains the authenticated browser launch. `--json` prints the existing
`agent-relay-dashboard-entry.v1` document for scripts. A non-interactive stdout
also prints that JSON document so automation does not hang in a TUI. `--demo`
targets the isolated `web-demo` on `127.0.0.1:4318` and
`~/.agent-relay/web-demo`, not the everyday daemon.

## Keys

| Key               | Action                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `↑` `↓` / `j` `k` | Move in the focused list                                          |
| `←` `→` / `h` `l` | Move between projects, the session list, and detail               |
| `Tab`             | Cycle focus                                                       |
| `Enter`           | Select a project, open detail without leaving the list, or submit |
| `/`               | Filter already loaded sessions; arrows still move                 |
| `p`               | Focus the project list                                            |
| `r`               | Refresh or reconnect from a fresh snapshot                        |
| `n`               | Load more recent history                                          |
| `a`               | Answer the selected question                                      |
| `Space`           | Toggle the focused option in an answer form                       |
| `c` / `m` / `e`   | Continue, mute, or end when the API proves the control            |
| `u`               | Apply updates that were held so focus did not jump                |
| `?`               | Help                                                              |
| `Esc`             | Leave help, detail, or an unsent answer; clear filter             |
| `q`               | Quit, except while typing an answer or filter                     |
| `Ctrl-C`          | Always quit and restore the terminal                              |

End asks for a second `e` before it closes the relay lane. It never terminates a
harness process.

## What the panes mean

The layout mirrors the browser information architecture:

- **Projects** — All projects first, then one item per opaque checkout identity,
  with attention and current counts.
- **Needs attention** — every `Needs input`, `Failed`, and `Unknown` session,
  plus open Relay questions.
- **Current** — every session that is not `Done` or `Ended`, grouped by harness.
- **Recent** — finished `Done` and `Ended` lanes, newest first, with `n` to
  page.
- **Detail** — canonical state, last activity, safe reason/confidence, known
  in-flight work, delivery health, and pending interaction.

Connection labels are `online`, `reconnecting`, `stale`, and `disconnected`.
Reconnecting keeps the last safe snapshot visible. Stale means no successful
update for 30 seconds. Disconnected means there is no trusted snapshot.

Activity labels are exactly the shared `Working`, `Needs input`,
`Background work`, `Idle`, `Done`, `Failed`, `Unknown`, and `Ended` states. The
TUI never invents a more certain state.

## Recovery

- unavailable daemon: start `agent-relay daemon` and rerun the command;
- rejected credential: restart the daemon with the intended state directory;
- incompatible API/assets: rebuild or reinstall Agent Relay and restart;
- reconnecting or stale: wait, press `r`, or restart the daemon;
- interrupt, hangup, or crash: the process restores alternate-screen and cursor
  modes on every controllable exit path, including `SIGTSTP` / `SIGCONT`;
- stuck answer or filter: `Esc` leaves the field; `Ctrl-C` still quits;
- terminal smaller than 40x12: widen the window; `q` still quits.

If the terminal is left in a bad state after a kill `-9`, run `reset`. If a
click selected dashboard text, `Ctrl-C` copies in some terminal hosts; press
`Esc` then `q`, or `Ctrl-C` after clearing the selection.

## Accessibility

Keyboard-only operation and an obvious `>` / `*` focus marker are required.
Color is part of the visual hierarchy (pane borders, activity state,
connection). Honor `NO_COLOR` when the environment requests it. Upstream Ink
screen-reader support is an explicit current limitation. Use `--json` or `--web`
when a screen reader is required.

The TUI never renders prompts, transcripts, raw tool arguments, command output,
credentials, OAuth URLs, or private identifiers.

## Answers

Answers bind to the exact pending `requestId` and `sessionKey`. A second submit
is ignored while one is in flight. Cancel, timeout, stale question, late answer,
and delivery failure are shown as status text. Native permission authorization
stays on the existing protected path. Questionnaires walk fields with arrows;
Space selects an option; typing fills free-text; Enter submits the whole set. A
missing required field stays on the form and names that field.

## Renderer inventory

The contracted framework is `ink@7.1.1` on React 19.2.8, isolated behind an
internal adapter. It needs no native FFI and no experimental Node flags. The
in-process host exists only in tests, for restore and secret-free frame
coverage.

## Relationship to the web dashboard

Both surfaces consume `GET /v1/web/projects`, `GET /v1/web/project-changes`,
`GET /v1/web/sessions`, and `GET /v1/web/attention`. Mutations use the same
resolve and session-action routes. Prefer `--web` for the evidence drawer and
narrow-viewport layout; prefer the TUI when you want to stay in the terminal.
See [the local web API](local-web-api.md) for the shared reconnect contract.
