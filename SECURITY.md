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

The repository is private during release preparation. GitHub exposes private
vulnerability reporting to external reporters only after a repository becomes
public and the feature is enabled. Enabling and verifying that private path is a
required public-promotion gate. Until then, invited collaborators should use the
repository's existing private GitHub access. Agent Relay does not advertise an
unmonitored security email address.

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
