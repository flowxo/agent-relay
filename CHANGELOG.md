# Changelog

All notable user-visible changes to Agent Relay will be documented here. The
project uses Semantic Versioning; prerelease entries explicitly call out
breaking changes and required operator action.

## 0.1.0-alpha.1 — Unreleased

### Added

- Exact packed-artifact lifecycle proof covering dry run, install, doctor,
  upgrade, idempotent reconciliation, fake canary, uninstall, and package
  removal from an isolated quoted-path home.
- Package/runtime/install-manifest and launcher-target diagnosis.
- Explicit SQLite schema versioning, forward migration from the unversioned
  alpha fixture, and refusal to open a newer schema.
- Symlinked owned-path refusal before installer mutation.
- Runtime-validated `agent-relay-compatibility.v1` evidence registry, safe
  `agent-relay capabilities` output, generated classified matrix, and
  drift-checked README/SUPPORT summaries.
- Doctor evidence IDs plus explicit `verified`, `compatible-unverified`, and
  known-incompatible version diagnosis.

### Changed

- Install manifests now record the public package version.
- Cursor permission decisions now fail closed as `disabled` instead of being
  advertised by a protocol flag while the installer intentionally omits them.
- The release candidate version advances to `0.1.0-alpha.1`; it remains private
  and unpublished.

## 0.1.0-alpha.0 — 2026-07-26 (local candidate only)

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
- This candidate was not published to npm and remained marked private.
