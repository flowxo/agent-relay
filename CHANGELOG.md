# Changelog

All notable user-visible changes to Agent Relay will be documented here. The
project uses Semantic Versioning; prerelease entries explicitly call out
breaking changes and required operator action.

## 0.1.0-alpha.0 — Unreleased

### Added

- Local SQLite attention and control daemon with durable delivery, retries, dead
  letters, diagnostics, retention, and a fake transport.
- Runtime-validated Codex, Claude Code, and Cursor hook adapters.
- Direct Telegram topics, compact cards, buttons, structured questions,
  correlated replies, and a credentialed canary.
- An opt-in CLI supervisor for owned-process crash evidence and officially
  supported late resume.
- Transactional user-level hook install, reconciliation, doctor, and uninstall.
- Loopback-only web companion for concurrent-session triage and response.
- A single, allowlisted `@flowxo/agent-relay` CLI artifact for local release
  testing.

### Known limitations

- The supported runtime target is macOS on Apple silicon with Node.js 22 or
  newer.
- Cursor IDE late resume is unsupported.
- Cursor permission automation remains disabled pending current live evidence.
- Native hooks do not prove process crashes; crash reporting requires the Agent
  Relay supervisor to own the child process.
- This candidate is not published to npm and remains marked private.
