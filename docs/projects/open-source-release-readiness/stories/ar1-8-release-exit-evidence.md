# AR1.8: Native minimum-runtime release exit

- **Linear:** FXO-1149
- **Status:** Implementation in progress
- **Started:** 2026-07-26

## Outcome

The AR1 exit gate must prove the exact private release artifact on current
Apple-silicon macOS with a native Node 22 runtime, a temporary clean home and
prefix, no linked workspace package, real installed harness observations, and
the complete bounded evaluation/removal path.

`packaging/release-exit.json` pins Node.js 22.23.1's official native arm64
archive, versioned checksum source, and exact SHA-256. `pnpm release:exit`
verifies the clean-commit bundle before installing anything and emits only a
safe ignored evidence record.

## Required evidence

- native `darwin/arm64` Node observation and native SQLite addon;
- exact tarball/commit/checksum/SBOM binding;
- scripts-disabled isolated install with explicit reviewed rebuild;
- no symlink or globally linked repository package;
- all three harnesses observed with safe evidence IDs and at least one exact
  verified version;
- install dry-run, install, unchanged reinstall, healthy doctor, and one fake
  delivery without retries or dead letters;
- owned uninstall and package removal with SQLite retained and zero owned hooks;
- no credential forwarding, message content, private path, or real-home change;
  and
- the non-implementer answers in `docs/release-readiness.md`.

## Unclaimed

This proof does not publish, create signed GitHub provenance, validate Intel
macOS/Windows/Linux end-user operation, approve npm scope control, or claim that
the later AR2 Notifications adapter is already selectable.
