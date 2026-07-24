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
- `pnpm check` passes all 62 tests across nine test files, including the
  SQLite-backed daemon, retry/dead-letter recovery, malformed ingress, hook
  fallback privacy, inline and late continuation, real owned-child exit
  observation, stale answer rejection, and concurrent-session isolation.
  `pnpm audit --prod` reports no known vulnerabilities.

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
- A real Telegram token and operator account have not been used. Bot API
  behavior is proven against deterministic HTTP fixtures; real delivery remains
  an integration canary.
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
- Branch `codex/initial-mvp` is pushed and reviewable in draft PR
  [#1](https://github.com/flowxo/agent-relay/pull/1). GitHub's PR service
  returned HTTP 500 through automated paths on 2026-07-24; the operator created
  the draft through the recovered web UI.

## Next action

Begin Milestone 4 with idempotent install/doctor flows for hook registration,
fallback-spool replay, retention controls, and log rotation. Before enabling
permission automation, replace the Cursor permission fixture with a sanitized
live capture.
