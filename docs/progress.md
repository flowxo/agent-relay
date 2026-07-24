# Progress ledger

## Proven

- Repository ownership branch is `codex/initial-mvp`.
- Local harness versions and CLI resume help were observed on 2026-07-24 and
  recorded in `docs/harness-evidence.md`.
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
- `pnpm check` passes all 103 tests across 17 test files, including the
  SQLite-backed daemon, retries/dead letters, malformed ingress, hook fallback
  privacy, inline and late continuation, owned-child exit observation, stale
  answer rejection, concurrent-session isolation, installation rollback,
  retention, log rotation, Telegram poll/webhook intake, and the activation
  canary. The check also validates formatting, lint, types, capability drift,
  and compiled package exports. `pnpm audit --prod` reports no known
  vulnerabilities.

## Assumptions and open risks

- Live stop-hook canaries have not been run because they may consume model
  quota. Current proof is official documentation plus local binary help.
- Cursor's permission payload evolves quickly; its fixture must be replaced by a
  sanitized live capture before permission automation is enabled by default.
- Native hooks still cannot prove crashes. Crash reporting is supported only for
  processes launched through `agent-relay run`; the protocol rejects a
  `process.exited` event without owned-child evidence.
- Telegram's Bot API has no caller-supplied idempotency key. SQLite prevents
  normal duplicates, but a process crash after Telegram accepts a message and
  before the receipt commits remains an at-least-once duplicate window.
- The real Telegram activation proves one private-chat send/reply path. Rate
  limiting, network retries, webhook intake, and shutdown remain proven through
  deterministic HTTP fixtures rather than induced failures against the live
  account.
- Telegram retains unconfirmed Bot API updates for no longer than 24 hours.
  Local request retention cannot recover an upstream update after that window.
- A model-backed late-resume canary has not been run because it would consume
  harness quota. Local proof covers the official argv contracts, real child
  process observation, durable command ownership, and the complete fake Telegram
  loop.
- Resume claims are deliberately at-most-once. A supervisor crash after the
  durable claim but before spawn leaves a visible `claimed` command for manual
  recovery instead of risking a duplicate resume.
- The supervisor never labels inactivity as a hang. `suspected_stalled` exists
  as a distinct state, but emission remains disabled until a harness-specific
  health probe supplies evidence.
- Branch `codex/initial-mvp` is published in
  [PR #1](https://github.com/flowxo/agent-relay/pull/1).
- Credential discovery on 2026-07-24 found no Telegram or daemon values in the
  process environment, no repository credential file beyond `.env.example`, and
  no available Doppler or 1Password CLI. No credential values were printed or
  added to git. The recommended activation path is a dedicated BotFather bot and
  private operator chat, with values supplied through a secret manager or a
  mode-`0600`, gitignored `.env.activation` file.

## Next action

With explicit approval to consume model quota, run one short live stop/resume
canary per harness. Before enabling Cursor permission automation, replace its
evolving permission fixture with a sanitized live capture.
