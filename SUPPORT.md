# Support

Agent Relay is preparing its first public prerelease. There is no stable release
or commercial support commitment yet.

## Supported surface

The current release-candidate validation target is macOS on Apple silicon with
Node.js 22. Linux CI and other Node.js versions provide development evidence,
not an end-user runtime support claim. Windows, Linux runtime operation, Intel
macOS, native application packaging, and automatic background-service
installation are not currently supported claims.

Harness support is exact and evidence-based. The generated
[capability matrix](docs/capability-matrix.md) is authoritative for enabled
Codex, Claude Code, and Cursor surfaces. Version drift is a doctor warning, not
a compatibility claim. Cursor permission automation remains disabled pending a
current sanitized live fixture.

Direct Telegram and the fake transport are available without a hosted Flow XO
account. The local web companion is optional and loopback-only. Flow XO
Notifications is an optional replaceable transport and is not required for local
operation.

## Before opening an issue

Run the checks that are safe for your environment:

```sh
agent-relay doctor
agent-relay status
agent-relay canary
```

Prefer reproducing with the fake transport and synthetic data. Search existing
issues, then use the
[issue chooser](https://github.com/flowxo/agent-relay/issues/new/choose).

A useful public report contains only:

- Agent Relay version or commit;
- macOS version and architecture;
- Node.js and pnpm versions;
- harness name, surface, and version;
- the relevant doctor check names and statuses, with private values removed;
- a minimal synthetic reproduction and expected/actual behavior; and
- whether the fake transport reproduces the problem.

Replace usernames, hostnames, account IDs, chat/topic IDs, session IDs,
repository names, branch names, and paths with obvious synthetic values. Review
every command and screenshot before posting it.

Never attach or paste:

- bot, daemon, webhook, registry, API, or access tokens;
- `.env` or local activation files;
- `relay.sqlite`, WAL/SHM files, or fallback-spool records;
- raw logs, diagnostic exports, hook payloads, or config backups;
- private transcripts, prompts, agent answers, or source code; or
- real usernames, hostnames, account IDs, repository paths, or worktree paths.

Treat all real working paths as private, even when the repository itself is
public.

If a diagnostic cannot be sanitized safely, do not publish it. Maintainers may
ask for a smaller synthetic reproduction; they will not ask for a token or
private transcript.

## Where different reports belong

- Suspected vulnerabilities or privacy leaks: follow [SECURITY.md](SECURITY.md),
  never a public issue.
- Reproducible bugs and documentation problems: use the public issue chooser.
- Harness behavior that Agent Relay cannot observe or control: report upstream
  after confirming the boundary in
  [the capability matrix](docs/capability-matrix.md).
- General design exploration: start with the documented product boundary; public
  discussions may be enabled after the first prerelease.

Support is limited to documented, current release behavior. Maintainers cannot
guarantee future harness compatibility, recover Telegram updates after
Telegram's retention window, prove crashes from native hooks, recover a resume
after an at-most-once claim is interrupted, or support direct modification of
the SQLite database.
