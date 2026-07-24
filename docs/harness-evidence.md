# Harness contract evidence

Recorded on 2026-07-24 on macOS arm64. The fixture corpus under
`packages/harnesses/fixtures` contains only synthetic identifiers, paths, and
messages.

## Local observations

| Harness     | Installed version       | Commands observed                                                                        |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | `codex-cli 0.145.0`     | `codex --version`, `codex --help`, `codex exec resume --help`, `codex app-server --help` |
| Claude Code | `2.1.219 (Claude Code)` | `claude --version`, `claude --help`                                                      |
| Cursor      | `3.12.30`               | `cursor-agent --version`, `cursor-agent --help`, `cursor-agent resume --help`            |

The local help output proves that all three CLIs expose a session-resume entry
point. It also proves that Codex App Server is installed and exposes a
structured transport. These checks do not invoke a model or incur API cost.

## Supervisor observations

The Milestone 3 test process launches owned Node.js children and observes a
non-zero exit, self-delivered `SIGTERM`, and `ENOENT` startup failure through
Node's child-process contract. The supervisor preserves those statuses and
records only bounded exit metadata; it inherits stdio and does not capture
command output. These fixtures do not invoke a model.

## Official contract sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) documents `Stop` input,
  `decision: "block"` continuation, hook trust, and permission decisions.
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
  documents `codex exec resume`.
- [Codex App Server](https://developers.openai.com/codex/app-server) documents
  `thread/resume`, `turn/start`, and `turn/steer`.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) documents `Stop`,
  `StopFailure`, `Notification`, and permission wire contracts.
- [Cursor hooks](https://cursor.com/docs/hooks) and the official
  [agent best-practices example](https://cursor.com/blog/agent-best-practices)
  document the `stop` payload and `followup_message`.
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using) documents session
  resume.

## Evidence boundary

The checked-in hook payloads are sanitized official examples adapted into
synthetic fixtures, not private local transcripts. Adapter and continuation
tests prove our parser and emitted JSON match the documented contracts. A live
harness round trip would consume model quota and is therefore deliberately not
claimed. `docs/progress.md` keeps that as an open canary task.
