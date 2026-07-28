# AR1.8: Native minimum-runtime release exit

- **Linear:** FXO-1149
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

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

## Evidence

The isolated matrix completed on macOS 26.5.2 using the hash-pinned official
Node.js 22.23.1 native arm64 runtime and npm 10.9.8:

- the four-file bundle verified against its exact clean `HEAD`, with 11 packed
  files and four SPDX packages;
- the tarball installed with scripts disabled into a quoted temporary prefix,
  was a regular copied directory rather than a link, and exposed no package
  symlink;
- the reviewed SQLite lifecycle selected an arm64 prebuild and completed a real
  in-memory query under native Node;
- doctor was healthy with exact Codex and Cursor evidence, while newer Claude
  Code remained an explicit `compatible-unverified` warning;
- install dry-run, install, unchanged reinstall, one fake delivery with no
  retry/dead letter, uninstall dry-run, and uninstall passed;
- SQLite survived while the launcher, manifest, every owned hook, npm package,
  and package executable were removed; and
- the ignored mode-`0600` result contained no credential, message-content field,
  private path, or real-home mutation.

The enforced evaluator guide answers the five operational questions without
source access or private maintainer memory. The full repository, packaged
lifecycle, Chromium, audit, and contract gates remain separate mandatory
evidence rather than being inferred from this canary.

## Unclaimed

This proof does not publish, create signed GitHub provenance, validate Intel
macOS/Windows/Linux end-user operation, approve npm scope control, or claim that
the later AR2 Notifications adapter is already selectable.
