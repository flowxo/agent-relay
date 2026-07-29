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
- A credential-free contribution workflow, dedicated compatibility/transport/
  harness/docs/security-design issue forms, and a review-gated pull request
  template.
- A 64 KiB sanitized JSON fixture boundary with exact manifest inventories,
  provenance requirements, privacy scanning, and negative regression tests.
- A clean-commit prerelease bundle with two-build reproducibility proof, SHA-256
  checksums, an SPDX 2.3 file/runtime-dependency SBOM, and an exact source
  manifest.
- Immutable GitHub Action pins, separate build/SBOM attestation permissions,
  repository secret scanning, and a protected npm OIDC publication path that
  remains disabled pending owner approval.
- A native Apple-silicon Node.js 22.23.1 release-exit gate that verifies the
  exact bundle, installs without workspace links in a temporary home/prefix,
  proves doctor and one fake delivery, and removes owned hooks and the package.
- An optional hosted Notifications adapter with secret-safe narrow machine
  bootstrap, explicit transport selection, durable confirm/select/input polling,
  crash-safe acknowledgement replay, safe diagnosis, explicit revocation, and
  retained local authority.
- A common fake/direct-Telegram/Notifications behavior matrix covering delivery
  identity, retries, answers, expiry, races, restart, and single-owner resume.
- A clean-home packed hosted proof covering setup, interaction, crash-before-ack
  replay, disconnect/erasure, retained SQLite state, direct-Telegram canary,
  owned uninstall, and private-data exclusion.
- A default-off outbound runner bridge with immutable `runner.protocol/v1`
  artifacts, a separate durable effect ledger, exact command authority,
  reconnect/reconciliation, and standalone-transport isolation.
- An isolated exact-version Codex app-server driver with owned stdio lifecycle,
  typed thread/turn/approval operations, content-free observations, canonical
  schema locking, sanitized fixtures, and a bounded model-backed canary.
- A private, local-only session-adoption peer with privacy-safe candidate
  choices, exact live-checkpoint comparison, monotonic ownership transfer, and
  durable forward recovery after process exit or offer expiry.

### Changed

- Notification delivery contracts now live in a provider-neutral internal
  package, generic presentation code is grouped under core notifications, and
  direct Telegram owns a separate adapter package. The end-user distribution
  remains one bundled CLI and no configuration, protocol, SQLite schema, or
  runtime behavior changes.
- Install manifests now record the public package version.
- Cursor permission decisions now fail closed as `disabled` instead of being
  advertised by a protocol flag while the installer intentionally omits them.
- Delivery-success diagnostics now hash local event and provider receipt
  identities instead of logging either raw value.
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
