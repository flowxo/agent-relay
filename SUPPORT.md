# Support

Agent Relay is preparing its first public prerelease. There is no stable release
or commercial support commitment yet.

## Supported surface

The V1 support range is macOS on Apple silicon with Node.js 22 or newer; native
release-exit validation uses exact Node.js 22.23.1. Linux CI provides
development evidence, not an end-user runtime support claim. Windows, Linux
runtime operation, Intel macOS, native application packaging, and automatic
background-service installation are not currently supported claims.

Harness support is exact and evidence-based. The generated
[capability matrix](docs/capability-matrix.md) is authoritative for enabled
Codex, Claude Code, and Cursor surfaces. The same runtime-validated registry
powers the summary below, `agent-relay capabilities`, and `doctor`. Version
drift is `compatible-unverified` and a warning, not a compatibility claim; a
version recorded as incompatible is a failure. Cursor permission automation
remains disabled and false at runtime pending a current sanitized live fixture.
Doctor warns for a missing unused harness, fails when no supported harness is
available, and fails when installed hook version stamps no longer match the
currently observed executables.

### Generated harness support

<!-- BEGIN GENERATED HARNESS SUPPORT -->

| Harness / surface | Exact verified version  | Classification          | Important boundary                                                                                                               |
| ----------------- | ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI         | `codex-cli 0.145.0`     | `verified`              | Stop and read-only late resume are live-proven; privacy-safe session and prompt lifecycle cards are fixture-proven.              |
| Codex App Server  | `codex-cli 0.145.0`     | `verified`              | The owned stdio driver, durable correlation, and local adoption recovery are exact-version proven behind the default-off bridge. |
| Claude Code CLI   | `2.1.219 (Claude Code)` | `verified`              | Stop and plan-mode late resume are live-proven; quiet lifecycle, structured background work, and StopFailure are fixture-proven. |
| Claude Agent SDK  | —                       | `compatible-unverified` | The streaming SDK contract is understood but is not the installed V1 user path.                                                  |
| Cursor CLI        | `2026.07.23-e383d2b`    | `verified`              | Interactive Stop and trusted late resume are live-proven; --print did not emit initial Stop.                                     |
| Cursor IDE        | —                       | `compatible-unverified` | Stop hooks are contract-backed; an IDE session cannot be safely resumed as a new CLI process.                                    |

Supported runtime: macOS on Apple silicon with native arm64 Node or x64 Node
through Rosetta, Node.js 22 or newer; release-exit evidence uses native Node.js
22.23.1. Not claimed: Windows, Linux end-user runtime, Intel macOS, Cursor IDE
late resume, native-hook crash proof, Cursor permission automation.
<!-- END GENERATED HARNESS SUPPORT -->

Direct Telegram, the signed outbound webhook, and the fake transport are
available without a hosted Flow XO account. The local web companion is optional
and loopback-only. WhooshBang is an optional replaceable transport and is not
required for local operation. The outbound webhook has no inbound response API
in V1. Exactly one transport is selected; there is no automatic dual-send or
failover and no hosted dashboard or team-policy surface.

Accepted Low residual: automation cannot prove that the invoking shell or GUI
session launched with every ambient hook disabled. Exact hook-denied isolation
and aggregate attribution mitigate it, and contaminated observation windows fail
closed. Telegram delivery is at least once across its documented acknowledgement
ambiguity window. Cursor IDE late resume is unsupported, and native hooks cannot
prove process crashes without supervised ownership.

## Before opening an issue

Run the checks that are safe for your environment:

```sh
agent-relay doctor
agent-relay status
agent-relay canary
agent-relay transport status
```

Prefer reproducing with the fake transport and synthetic data. Search existing
issues, then use the
[issue chooser](https://github.com/flowxo/agent-relay/issues/new/choose).

A useful public report contains only:

- Agent Relay version or commit;
- macOS version and architecture;
- Node.js and pnpm versions;
- harness name, surface, and version;
- redacted `doctor` check names, statuses, compatibility classifications, and
  evidence IDs;
- the safe `agent-relay capabilities` record;
- relevant bounded diagnostic IDs, without raw log lines;
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
