# Public release walkthrough

This is the sanitized record of the FXO-1162 non-implementer walkthrough. It
contains no credential, transcript, source payload, username, hostname, raw
path, private identifier, or live-provider data.

> **Status:** Follow-up verification completed successfully on 2026-08-11. No
> tag, publication, production change, or live-provider operation is authorized
> by this record.

## Scope and isolation

The follow-up evaluator used exact Node.js 22.23.1 and pinned pnpm 11.17.0. All
follow-up runtime operations used a temporary home, temporary state directory,
local loopback ports, synthetic sessions, and the fake transport. The first-pass
help defect and its restored local effects are recorded below. No external
credential was loaded and no live provider was contacted.

The walkthrough covered evaluation, install dry-run, install, doctor, fake
canary, concurrent web demo, explicit transport diagnosis, supported-harness
guidance and capability evidence, same-build upgrade reconciliation, uninstall
dry-run, uninstall, retained state, and exact temporary-state erasure. No
harness session was launched. It also followed vulnerability, support,
contribution, issue-reporting, rollback, deprecation/yank, and bundled
license/notice documentation paths.

## First-pass results

- The isolated lifecycle completed: dry-run wrote nothing; install created the
  three owned hook entries, launcher, and manifest; doctor was healthy with only
  compatible-unverified version warnings; and the fake canary delivered one
  event with zero retries and zero dead letters.
- The local web demo returned its UI and authenticated API for four concurrent
  synthetic sessions across four ready topics and four delivered events.
- Repeated install was unchanged, uninstall removed only owned integration and
  retained SQLite/transport state, and bounded erasure removed the exact
  temporary state directory.
- The documentation kept direct Telegram independent of any hosted Agent Relay
  account or public server. WhooshBang remained an optional explicit transport;
  neither path was live-tested in this walkthrough.

The evaluator also found that several subcommand `--help` requests executed the
underlying command, and that the README put the fake canary before install and
doctor. The accidental local install/uninstall effects were immediately restored
byte-for-byte from the installer's private backups without reading their
contents; generated backups were removed and the original installation state was
rechecked. The implementation now intercepts every top-level `--help` and `-h`
before command dispatch, with no-state regression coverage, and the onboarding
order has been corrected.

## Follow-up results

The non-implementer repeated the walkthrough against the corrected candidate:

- Exact Node.js 22.23.1 and pnpm 11.17.0 built all ten workspace projects.
- All 20 top-level commands handled both `--help` and `-h` without creating the
  isolated root/state, checking a daemon, or contacting a provider. The focused
  regression covers those 40 subcommand combinations plus both inert global help
  flags.
- Install dry-run left no manifest; install created five owned actions; doctor
  was healthy with no failed check; and compatible-unverified local harness
  versions stayed warnings rather than support claims.
- The fake canary delivered one event with zero retry or dead letter. The web
  demo served four concurrent synthetic sessions, four ready topics, and four
  delivered events with zero pending work.
- Direct Telegram without a hosted account and optional WhooshBang were equally
  discoverable. Their isolated not-configured diagnosis failed closed; neither
  contacted a provider.
- Upgrade dry-run, reconcile, and a second reconcile were unchanged and
  idempotent. Uninstall dry-run preserved the manifest; owned uninstall removed
  five actions while retaining SQLite/transport state; exact temporary erasure
  then succeeded.
- Vulnerability, support, contribution, issue chooser, rollback,
  deprecation/yank, then-current no-tag/native-non-green status, and bundled
  WhooshBang license/notice gates all resolved to their documented paths.

All temporary roots were erased and loopback ports released. No real-home change
remained after byte-for-byte restoration, and the follow-up changed no real-home
state. No credential, live provider, tag, publication, registry, repository
promotion, or production resource was changed.
