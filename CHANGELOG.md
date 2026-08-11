# Changelog

All notable user-visible changes to Agent Relay will be documented here. The
project uses Semantic Versioning; prerelease entries explicitly call out
breaking changes and required operator action.

## 0.1.0-alpha.2 — Unreleased

### Fixed

- Normalize the npm archive's platform-specific gzip operating-system byte
  before reproducibility comparison and verification, so supported macOS and
  protected Linux builds produce identical compressed bytes.
- Replace two CodeQL High findings with bounded operations: encode every slash
  in SPDX npm purls consistently and trim handoff URL slashes in linear time.

### Changed

- Preserve `v0.1.0-alpha.1`, its tagged workflow, and its build/SBOM
  attestations as immutable stopped-publication evidence. The corrected
  candidate advances to `0.1.0-alpha.2`; publication remains blocked until
  FXO-1574 records renewed exact-candidate approval.
- The packed lifecycle proof now upgrades from an alpha.1 fixture to alpha.2.

Native release-exit remains **not green**, and the accepted Low ambient-hook
isolation residual remains named and uncredited. No live traffic was run.

## 0.1.0-alpha.1 — Stopped before registry publication

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
  checksums, an SPDX 2.3 file/runtime-dependency SBOM, exact package-content
  evidence, curated release notes, and an exact source manifest.
- Immutable GitHub Action pins, separate build/SBOM attestation permissions,
  repository secret scanning, and a protected npm OIDC publication path that
  remains gated on the exact public repository, environment, tag, workflow, and
  confirmed post-bootstrap trusted publisher.
- An owner-approved MIT license and shipped notice for the exact bundled
  WhooshBang contracts rc.12 and SDK rc.13 artifacts, plus a fail-closed
  interactive 2FA first-publish bootstrap that configures the OIDC publisher,
  verifies it, and ends the npm session without retaining a registry token.
- A native Apple-silicon Node.js 22.23.1 release-exit gate that verifies the
  exact bundle, installs without workspace links in a temporary home/prefix,
  proves doctor and one fake delivery, and removes owned hooks and the package.
  The current attempt reached the exact Node target but is not green because no
  installed harness matched an exact frozen verified snapshot.
- An optional hosted WhooshBang adapter with secret-safe narrow machine
  bootstrap, explicit transport selection, durable confirm/select/input polling,
  crash-safe acknowledgement replay, safe diagnosis, explicit revocation, and
  retained local authority.
- Browser-based WhooshBang OAuth/MCP onboarding that creates and retains only a
  narrow machine bearer, durably replays uncertain bootstrap attempts, and adds
  one bounded hosted send/reply/ack canary plus live doctor evidence without
  exposing provider or subscriber identifiers.
- A common fake/direct-Telegram/WhooshBang behavior matrix covering delivery
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
- A provider-neutral signed outbound webhook with strict v1 request and
  acknowledgement contracts, exact-byte HMAC authentication, stable idempotency,
  bounded retries and `Retry-After`, private file/stdin configuration, safe
  status/doctor output, a loopback canary, and an authenticated local-web
  handoff for questions.
- Contextual Telegram `/status`: exact session state inside a coding topic and
  an aligned open-session table from New Chat or any non-coding topic.
- Durable state-prefixed topic titles with independent SQLite leases, bounded
  retry, restart recovery, unavailable-topic reconciliation, and diagnostics.

### Changed

- Every top-level command now treats `--help` and `-h` as inert. Help cannot
  install, uninstall, create local state, start a daemon, or contact a provider.
- Packed package and lifecycle proofs now build an allowlisted environment,
  explicitly force the fake transport, and cannot inherit Telegram, webhook, or
  WhooshBang credentials or transport selection from the invoking shell.
- Interactive Telegram and WhooshBang canaries now expose separate bounded
  client-wait and durable-request-TTL controls. Exit-zero acceptance also
  requires aggregate pre/post status to prove exactly one new delivered event;
  ambient hook traffic fails closed with `canary-attribution-conflict`.
- The optional hosted transport now pins WhooshBang's exact contracts rc.12 /
  SDK rc.13 / mock rc.15 artifacts from producer
  `50de931fed8d819d1a70ec27201351b09f0ef251`. Its consumer proof now uses the
  published content-redaction shape, omits already-acknowledged events across a
  cursor gap, and reports acknowledgement replay from current durable state.
  **Required operator action:** reconnect an existing hosted connection because
  its retained contract version is deliberately exact.
- Telegram cards now put summary content first and event/session metadata in a
  final footer. Trusted headings, state, and labels use explicit Bot API
  entities without parsing Markdown or HTML from agent text.
- Routine session, prompt-submission, background-work, and session-end lifecycle
  events now use provider-neutral silent delivery; Telegram projects that as
  `disable_notification`, and outbound webhooks expose the requested mode. Codex
  and Claude Code installs add privacy-safe `SessionStart` and
  `UserPromptSubmit` hooks without retaining prompt text. Stop cards now keep a
  compact beginning/end excerpt and place the waiting state at the bottom.
- The optional hosted transport now consumes WhooshBang's exact
  `@whooshbang/contracts`, `@whooshbang/sdk`, and `@whooshbang/contract-mock`
  `1.0.0-rc.4` artifacts. WhooshBang's pre-alpha hard cut retired the pre-rename
  `@flowxo/notifications*` `1.0.0-rc.1` packages with no compatibility alias, so
  the contract lock, vendored artifacts, imports, contract discriminators,
  Problem Details namespace, and mock control header all moved to the WhooshBang
  identities. Hosted diagnostics now name WhooshBang.
- The optional hosted transport now pins WhooshBang's exact `1.0.0-rc.5`
  artifacts. That candidate restores the documented `paused` Telegram binding
  state, which subscribers can now reach through WhooshBang's own pause, resume,
  and unsubscribe controls. `whooshbang connect` therefore reports a paused
  binding as its own recoverable `binding_paused` outcome, with a resume remedy
  and no provisioned machine client or credential, instead of failing terminally
  as though the binding could not be proven. A revoked binding, and any other
  non-active status, stays terminal.
- The optional hosted transport now pins WhooshBang's exact
  `@whooshbang/contracts@1.0.0-rc.10`, `@whooshbang/sdk@1.0.0-rc.11`, and
  `@whooshbang/contract-mock@1.0.0-rc.13` artifacts, which no longer share one
  release candidate number. Hosted delivery, interaction, quarantine,
  acknowledgement, and cursor behavior are unchanged. A hosted message diagnosis
  now asks for the current state explicitly rather than inheriting the
  contract's new 30-second inspection wait, and a machine event whose answer
  content window has closed is acknowledged and advanced past rather than
  quarantined. **Required operator action:** the stored hosted connection
  records the pinned contract version, so an existing connection written against
  `1.0.0-rc.5` no longer loads and must be reconnected with
  `agent-relay whooshbang connect`.
- **Breaking (pre-alpha):** the hosted transport is now identified as
  `whooshbang` rather than `notifications` everywhere it is selected, stored, or
  diagnosed. `agent-relay whooshbang connect|status|disconnect` replaces
  `agent-relay notifications …`, `transport select whooshbang` and
  `AGENT_RELAY_TRANSPORT=whooshbang` replace their former values, and the local
  files are `~/.agent-relay/whooshbang.json` and
  `~/.agent-relay/whooshbang-credential.json`. Local SQLite migrates forward
  automatically at schema version 7, preserving retained answers, resolution
  sources, delivery mappings, acknowledgement state, and committed cursors.
  **Required operator action:** anyone who had connected the hosted transport
  against the executable mock must rerun `whooshbang connect` and
  `transport select whooshbang`; a stale `notifications` selection fails closed
  rather than silently choosing another transport. Direct Telegram, the fake
  transport, the outbound webhook, the web board, hooks, and the supervisor are
  unaffected. The provider-neutral notification transport seam keeps its generic
  name because it is not WhooshBang-specific.
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
- SQLite schema `8` adds durable topic-title reconciliation state and schema `9`
  adds content-free lifetime insertion/deletion counters used by fail-closed
  canary attribution. Migration is automatic and forward-only. **Rollback
  warning:** an older binary refuses a database written at a newer schema; use
  the newer package or restore a reviewed private backup rather than editing
  `user_version`.
- The release candidate version advanced to `0.1.0-alpha.1`. It remained
  unpublished; the later tagged attempt stopped on cross-platform artifact
  drift, and the workspace root remained private.

### Known limitations

- V1 supports macOS on Apple silicon with Node.js 22 or newer; native release
  evidence uses exact Node.js 22.23.1. Windows, Linux, and Intel macOS end-user
  runtimes are not claimed.
- Cursor IDE late resume is unsupported. Cursor permission automation remains
  disabled.
- Native hooks cannot prove process crashes; crash evidence requires Agent Relay
  to own the supervised child.
- Telegram delivery is at least once across the documented acknowledgement
  ambiguity window, so a crash can produce a duplicate provider message.
- Exactly one transport is selected. There is no automatic dual-send or
  transport failover.
- Open Source V1 has no hosted dashboard or team-policy surface.
- Accepted Low residual: automation cannot prove that the invoking shell or GUI
  session launched with every ambient hook disabled. Exact hook-denied isolation
  and aggregate attribution mitigate it; contaminated windows fail closed.
- The retained live-reviewed alpha.1 tarball came from PR #39 and does not
  contain PR #40 or PR #41. PR #40 passed separate credential-free packed proof
  from an ephemeral tarball that was neither retained nor live-tested. The
  current frozen source after FXO-1161 is PR #41 merge
  `0adb7288483df331fbaaefb9b392ee2f4f3c7d84`; its separate credential-free
  release bundle has SHA-256
  `3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106`, 277,069
  bytes, 11 packed files, and six SPDX packages, and was not live-tested.
- The FXO-1162 freeze created no `v0.1.0-alpha.1` tag. FXO-1164 later created
  the immutable tag, but stopped before npm or GitHub release publication when
  its cross-platform archive digest differed. The tag and attestations remain
  preserved evidence. The authorization excluded production, central workspace
  release, live-provider traffic, credential retention, live cards, and broader
  publication.

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
