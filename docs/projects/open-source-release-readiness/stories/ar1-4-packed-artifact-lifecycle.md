# AR1.4: Packed-artifact lifecycle

- **Linear:** FXO-1145
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

The private `0.1.0-alpha.1` candidate now proves the complete user-level
lifecycle from exact tarballs. A sanitized prior `0.1.0-alpha.0` fixture is
installed into a quoted-path home and prefix, reconciles three pre-existing
harness configs, records an answered request and fake canary, and upgrades in
place to the current artifact.

Install manifests record the public package version. Doctor compares it with the
running CLI, validates exact ownership targets, checks the generated launcher
against the manifest, and can identify stale package entry or Node targets
before reconciliation. The installer canonicalizes its executable targets and
rejects a symlink anywhere in its owned root paths before mutation.

SQLite stores now carry explicit schema version `1`. An unversioned prior-alpha
store migrates forward with retained data; a future schema is rejected and left
unchanged rather than being opened by an older binary.

## Evidence

`pnpm package:lifecycle:check`, part of the full repository gate, proves:

- scripts-disabled prior/current tarball installation plus explicit
  `better-sqlite3` rebuild;
- clean-home install dry run, installation, and healthy doctor;
- one fake delivery with no retry or dead letter before and after upgrade;
- a committed terminal answer remains authoritative after package and schema
  upgrade;
- pre-reconciliation doctor fails specifically on package version and runtime
  entry mismatch;
- upgrade dry run, reconciliation, and a second unchanged install;
- SQLite schema migration preservation through schema `3` and schema `4`
  downgrade refusal;
- web credential, relay log history, explicit credential/log fixtures, config
  backups, SQLite answer, and unrelated harness settings survive;
- uninstall dry run and owned uninstall remove the launcher, manifest, and only
  Agent Relay hook entries;
- retained state and backups remain after uninstall; and
- package-manager removal occurs last and leaves no Agent Relay-owned hook.

Focused unit regressions cover symlink refusal, hostile filesystem-root
rejection, package/launcher mismatch diagnosis, forward schema migration, and
future-schema immutability. Existing malformed JSON, path quoting, partial
rollback, ownership, and merge-preservation tests remain in the full suite.

The final local gate passed 41 Vitest files/309 tests, 17 contract and
supply-chain tests, the six-test isolated Notifications consumer, the
102,408-byte packed/479,554-byte unpacked artifact check, the full packed
lifecycle, all three Chromium scenarios, and `pnpm audit --prod` with no known
vulnerability.

## Assumptions and open risks

- The prior package is a deterministic sanitized fixture derived from the
  current code with the prior version identity; `0.1.0-alpha.0` was never
  published.
- This slice ran through Rosetta; FXO-1149 later proved the exact current
  artifact under native arm64 Node 22.23.1 in a clean temporary home and prefix.
- Automatic background service lifecycle remains excluded from AR1.
- Package scope control and any registry publication remain explicit owner
  gates.
