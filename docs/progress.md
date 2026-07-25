# Progress ledger

## Proven

- Repository ownership branch is `codex/initial-mvp`.
- Local harness versions and CLI resume help were observed on 2026-07-24 and
  2026-07-25, then recorded in `docs/harness-evidence.md`.
- Official stop, permission, failure, and resume contracts are represented as
  runtime-validated protocol types and sanitized synthetic fixtures.
- Capability differences are generated from code, including the explicit lack of
  Cursor IDE late resume and native process-crash proof.
- Milestone 0 is green locally: protocol and adapter contract tests cover all
  three harnesses, malformed and unknown inputs produce actionable diagnostics,
  native continuation JSON is exact, CLI resume invocations use argv arrays, and
  format, lint, typecheck, tests, capability drift check, and build pass.
- Milestone 1 is green locally. SQLite is the source of truth for sessions,
  events, leases, attempts, retries, dead letters, pending requests, and
  Telegram update claims. The fake transport completes the local
  ingest-to-delivery loop, while the Bot API adapter covers success, rate-limit,
  timeout, callback acknowledgement, and resolved-message edits.
- Milestone 2 is green locally. Opaque choice tokens and replied-to transport
  message IDs correlate answers to the expected machine, harness, session, and
  turn. Terminal and Telegram answers use one atomic first-writer-wins
  transition; duplicates, stale answers, unauthorized senders, timeouts, and
  concurrent sessions are covered.
- Milestone 3 is green locally. The opt-in CLI supervisor owns the child PID,
  classifies real exit codes, signals, forwarded termination, and startup
  failure, and requires runtime-validated `owned-child` evidence for every
  `process.exited` event. SQLite resume commands provide atomic ownership and an
  audited claimed/running/succeeded/failed lifecycle. A fake Telegram end-to-end
  test resumes the exact stopped Codex session once.
- Milestone 4 is green locally. The fallback spool applies deep secret redaction
  and bounded lossless rotation, atomically isolates replay workers, retains
  failed records, and durably reports malformed input. The daemon replays at
  startup and reconnect intervals.
- Installation is idempotent and transactional across the exact Codex, Claude,
  and Cursor user config paths. Clean install, repeated install, upgrade,
  uninstall preservation, malformed-config preflight, partial rollback, and path
  quoting are covered. Private backups and atomic writes protect existing
  configuration; uninstall leaves state, logs, credentials, and unrelated hooks
  untouched.
- Doctor checks the launcher, installed hook counts, SQLite and capability
  records, harness availability, and the exact locally tested versions. Version
  drift is a warning and a missing executable is a failure.
- Retention expires stale requests and prunes only terminal/proven-inactive
  records in bounded batches. Redacted rotating logs have fixed size/count
  limits and surface file-write failures through a fallback logger.
- Telegram reply intake defaults to local Bot API long polling. It validates
  update arrays, routes updates in order, advances offsets only after handling,
  retries diagnosed failures, and shuts down active polls cleanly. Webhook mode
  uses Telegram's secret independently of daemon bearer authentication.
- FXO-1051 is green against the fake transport and the Telegram Bot API 10.2
  contract. SQLite now owns one topic record per logical
  machine/harness/session/transport scope. Topic creation is lazy, atomically
  claimed before the transport call, retried through the owning event spool,
  durably diagnosed, and reused after database reopen. The fake transport proves
  repeated-event reuse, competing first deliveries, concurrent-session
  isolation, restart persistence, retryable and terminal failures, and
  path/secret-safe topic metadata. The real adapter fixtures prove
  `createForumTopic` parsing and `message_thread_id` delivery; live
  private-topic creation is not yet claimed.
- A compiled-distribution canary in an isolated temporary home proved dry-run
  install, install, healthy doctor output against all three local harness
  versions, idempotent reinstall, and ownership-safe uninstall without touching
  the real user home.
- A bounded `telegram-canary` command now refuses the fake transport and proves
  the real send/reply path when credentials are present. Its daemon-level test
  exercises synthetic delivery, authorized Telegram HTTP reply intake,
  replied-to-message correlation, durable resolution, exact challenge matching,
  and transcript-free result output against the fake transport.
- A credentialed private-chat activation on 2026-07-24 proved real Bot API
  delivery and long polling. An intentionally late reply was correlated and
  rejected as expired; a fresh direct reply was accepted from the configured
  operator, matched the canary challenge, and persisted as `answered` with
  `resolvedBy: telegram`. No token or private message content was printed or
  committed.
- The live activation exposed a race in which the daemon background worker could
  deliver an event before the canary's explicit drain claimed it. The canary now
  waits for the durable delivery receipt instead of reporting a false delivery
  failure, with a regression test for that interleaving.
- The compiled installer is active in the real user configuration. A subsequent
  doctor run found the owned launcher, the expected hook counts, a healthy
  SQLite store, and the exact tested Codex, Claude Code, and Cursor versions.
- A model-backed Codex CLI canary proved the installed Stop hook, real Telegram
  delivery, stale-reply rejection, exact-session reply correlation, and
  successful `codex exec resume`. The first non-interactive attempt also proved
  that Codex skips an untrusted user hook; the vetted automation retry used the
  documented one-invocation hook-trust override.
- The Codex canary exposed execution-authority widening: a read-only initial
  process resumed with full filesystem access. Late-resume policy is now derived
  once from the initial argv, defaults to read-only, preserves explicit sandbox
  and dangerous-bypass choices, and preserves the one-invocation hook-trust
  override. A second live exact-session resume reported read-only mode.
- A model-backed Claude Code CLI canary proved the installed Stop hook, real
  Telegram delivery, exact-session reply correlation, and successful
  `claude --resume` under the initial `plan` permission mode. An invalid initial
  invocation exited non-zero first; the owning supervisor produced and delivered
  a durable `process.exited` notification from observed child evidence.
- A model-backed Cursor CLI canary proved the current `2026.07.23-e383d2b`
  interactive Stop hook, real Telegram delivery, exact-session reply
  correlation, and successful `cursor-agent --resume=<session>`. The login flow
  auto-updated the initially observed CLI. The live run proved that workspace
  trust is retained without widening to `--force`, while the current `--print`
  initial path exits without emitting Stop and is not claimed.
- Supervisors now have an explicit `--max-resumes` bound. The last allowed
  resumed child cannot create another late-resume request, which keeps bounded
  canaries from leaving orphan continuations. Expected empty resume polls are no
  longer logged every 250 ms; claims and exceptional outcomes remain visible.
- A Cursor cleanup exposed that terminal stop signals can be normalized to exit
  status 130 or 143. The supervisor now treats that status as expected only when
  it matches a signal the owning parent actually observed and forwarded;
  unrelated non-zero exits remain durable crash events. Supervised hook version
  metadata also now overrides stale install-time metadata.
- `pnpm check` passes all 119 tests across 19 test files, including the
  SQLite-backed daemon, retries/dead letters, malformed ingress, hook fallback
  privacy, inline and late continuation, owned-child exit observation, stale
  answer rejection, concurrent-session isolation, installation rollback,
  retention, log rotation, Telegram poll/webhook intake, and the activation
  canary. The check also validates formatting, lint, types, capability drift,
  and compiled package exports. `pnpm audit --prod` reports no known
  vulnerabilities.

## Assumptions and open risks

- Cursor's permission payload evolves quickly; its fixture must be replaced by a
  sanitized live capture before permission automation is enabled by default.
- Cursor `--print` did not emit Stop on the tested build. The supported
  supervised initial path is interactive; the late-resume leg remains headless.
- Native hooks still cannot prove crashes. Crash reporting is supported only for
  processes launched through `agent-relay run`; the protocol rejects a
  `process.exited` event without owned-child evidence.
- Telegram's Bot API has no caller-supplied idempotency key. SQLite prevents
  normal duplicate messages and concurrent topic creators, but a process crash
  or ambiguous timeout after Telegram accepts a message or topic and before the
  receipt commits remains an at-least-once duplicate window.
- The real Telegram activation proves one private-chat send/reply path. Rate
  limiting, network retries, webhook intake, and shutdown remain proven through
  deterministic HTTP fixtures rather than induced failures against the live
  account.
- Telegram retains unconfirmed Bot API updates for no longer than 24 hours.
  Local request retention cannot recover an upstream update after that window.
- Resume claims are deliberately at-most-once. A supervisor crash after the
  durable claim but before spawn leaves a visible `claimed` command for manual
  recovery instead of risking a duplicate resume.
- The supervisor never labels inactivity as a hang. `suspected_stalled` exists
  as a distinct state, but emission remains disabled until a harness-specific
  health probe supplies evidence.
- Branch `codex/initial-mvp` is published in
  [PR #1](https://github.com/flowxo/agent-relay/pull/1).
- Activation values remain only in a mode-`0600`, gitignored local environment
  file. Credential values, numeric account identifiers, private messages,
  harness session IDs, and machine-specific paths are not recorded in git.

## Next action

Run one credentialed private-topic activation against the rebuilt daemon, retain
only the sanitized response shape, then begin FXO-1052 by routing every event
and reply through the persisted topic mapping.
