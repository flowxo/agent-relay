# Security policy

Agent Relay can install coding-harness hooks, route bounded agent output to a
notification provider, and resume an owned harness process after an operator
decision. Reports that could affect those trust boundaries are handled
privately.

## Supported versions

Agent Relay has not published a public release yet, so no released version is
currently supported. During the prerelease period, security fixes will target
the latest published prerelease only. Older prereleases and arbitrary source
commits may receive a fix at the maintainers' discretion.

This table will be replaced with concrete release lines when the first
prerelease is published:

| Version                     | Security fixes |
| --------------------------- | -------------- |
| Latest published prerelease | Yes            |
| Older prereleases           | No             |
| Unreleased source snapshots | No guarantee   |

## Report a vulnerability privately

Do not open a public issue or discussion for a suspected vulnerability. Do not
include an exploit, access token, bot token, private transcript, SQLite
database, username, hostname, account identifier, or working path in a public
report.

Use
[GitHub private vulnerability reporting](https://github.com/flowxo/agent-relay/security/advisories/new).
Include only the minimum information needed to reproduce the issue:

- the affected Agent Relay version or commit;
- the operating system, architecture, Node.js version, harness, and surface;
- a sanitized description of the impact and reproduction;
- whether the issue was reproduced with fake credentials or synthetic data;
- any known preconditions or mitigations; and
- a safe way to continue the private conversation through GitHub.

The repository is public. During FXO-1164, GitHub private vulnerability
reporting and the available repository security controls were enabled and
verified before release promotion. Use the private advisory path above for
security reports; Agent Relay does not advertise an unmonitored security email
address. The stopped alpha.1 publication attempt and the corrected alpha.2
candidate do not weaken this reporting boundary.

## What to expect

Maintainers aim to acknowledge a complete private report within three business
days and provide an initial status within ten business days. These are
best-effort response targets, not remediation or disclosure guarantees.
Complexity, upstream harness behavior, and maintainer availability can change
the timeline.

Maintainers will validate the report, agree on safe disclosure timing, prepare a
fix and regression test when appropriate, and credit the reporter if they want
attribution. Please allow coordinated disclosure before publishing details. If a
report is out of scope, maintainers will explain why and direct it to the
relevant upstream project when possible.

## Security-relevant scope

Examples include:

- hook parsing or continuation output that executes unintended commands;
- widening sandbox, permission, or execution authority during resume;
- claiming or resuming the wrong session;
- accepting an answer from the wrong operator, chat, topic, or request;
- leaking credentials, transcripts, private paths, or unredacted payloads;
- bypassing local web authentication or CSRF controls;
- unsafe installer paths, config merges, rollback, or ownership removal;
- SQLite migration, retention, or concurrency behavior that breaks isolation;
- transport authentication, callback verification, or outbound-data changes;
- dependency or release-artifact compromise; and
- unsupported capability claims that create a safety hazard.

General bugs and support questions belong in the
[public issue chooser](https://github.com/flowxo/agent-relay/issues/new/choose)
once the repository is public. Follow [SUPPORT.md](SUPPORT.md) when preparing a
sanitized report.

## Development and release workflow boundary

Normal feature work targets `dev`; `main` is advanced only to an exact commit
whose release-candidate evidence has already passed. Pull-request validation is
credential-free, has read-only repository permission, and cannot access a
protected environment, publish, attest, promote `main`, or qualify a release.
Fork pull requests receive no secrets. Unknown paths broaden the central risk
classification rather than silently skipping checks.

Exploratory `pnpm dogfood:deploy` is a local development operation. It preserves
the existing local security boundary and records only commit/build identity; it
does not read provider credentials or private coding-session content and cannot
be treated as release evidence. Formal UX evidence is bounded, secret-free,
fresh, and tied to an exact candidate SHA. Field names or values resembling
credentials, prompts, answers, sessions, private paths, or transcripts are
rejected.

Release qualification requires an explicit manual dispatch, a protected
`release-candidate` environment, write-or-higher actor permission, exact-SHA
confirmation, and applicable dogfood evidence. Publication accepts only a
successful, non-dry-run artifact from that workflow and re-verifies its
repository, workflow, run, SHA, manifest, complete check inventory, and file
digests. The `npm-prerelease` OIDC/provenance, immutable version/tag, public
repository, and release-policy gates remain separate. See
[the SDLC boundary](docs/sdlc.md).

## Local web bootstrap boundary

The supported browser entry is `agent-relay dashboard --web` against the exact
loopback daemon. The CLI verifies daemon/web readiness and current protected
API/asset compatibility before using the private persistent bearer/CSRF to
create one 60-second, single-use grant. Grants are bound to the intended
loopback Origin and Host, consumed atomically, replay-protected, bounded in
memory, and invalidated by daemon restart.

Exchange establishes only a host-bound HttpOnly, SameSite-Strict browser-session
cookie and an ephemeral session CSRF held in page memory. Browser sessions have
a 30-minute idle and eight-hour absolute limit. Mutations retain explicit
same-origin and CSRF checks. The persistent bearer and CSRF never enter the
normal URL, argv, browser store, log, analytics, error, or diagnostic path.
Direct `/ui/` access exposes no Relay data and keeps the persistent manual path
behind **Advanced recovery**.

Project-centric dashboard reads use this same protected boundary. They are
GET-only, need no CSRF, and return bounded opaque projections from the
authoritative SQLite store. The additive routes do not accept the daemon hook
bearer. All writes retain the existing exact Origin/Host, browser-session, and
CSRF checks. Project identities and cursors are private-keyed; a safe display
label is never authorization or correlation identity.

This is a local-process trust boundary, not remote access. Tunnels, reverse
proxies, public listeners, and repurposing these credentials/sessions for an
internet origin are unsupported. They do not add a reviewed public identity,
TLS/forwarded-host policy, operator authorization, rate limiting, or revocation
model.

## Custom webhook boundary

The V1 custom webhook is outbound-only. Agent Relay authenticates each attempt
with an exact-body HMAC and stable idempotency key, but the receiver must verify
the signature before parsing, reject stale timestamps, deduplicate the delivery
ID, bound the body, and protect any onward delivery it performs. The local web
handoff contains no credential and does not weaken normal browser
authentication.

Do not expose the daemon's existing local hook or browser routes as a public
inbound integration API. Configurable inbound authentication, replay protection,
request/option authorization, reverse-proxy behavior, and rate limits are
deferred to a separately reviewed post-release design.
