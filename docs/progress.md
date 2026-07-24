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

## Assumptions and open risks

- Live stop-hook canaries have not been run because they may consume model
  quota. Current proof is official documentation plus local binary help.
- Cursor's permission payload evolves quickly; its fixture must be replaced by a
  sanitized live capture before permission automation is enabled by default.
- Native hooks cannot prove crashes. Process exit stays unsupported until a
  launcher owns the child process.

## Next action

Implement the SQLite daemon, fake Telegram delivery loop, hook entry points,
retry diagnostics, and local status/doctor commands for Milestone 1.
