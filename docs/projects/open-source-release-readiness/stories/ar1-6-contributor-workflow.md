# AR1.6: Bounded contributor workflow and review gates

- **Linear:** FXO-1147
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

`CONTRIBUTING.md` now gives a new contributor one credential-free path from a
clean checkout to the same local gate as CI. It pins Node 22 as the baseline and
pnpm 11.17.0 exactly, preserves the scripts-disabled frozen install and
Notifications preflight order, documents focused tests, browser and packed
artifact proof, explains component ownership, and defines commit, evidence,
documentation, privacy, and security-reporting expectations.

The transport and harness extension guides link that common workflow and the
safe fixture policy, name their extension interfaces, enumerate contract,
failure, authority, privacy, retry, stale-answer, race, and concurrent-session
tests, and give credential-free focused commands.

## Intake and review boundary

The public issue chooser now distinguishes:

- sanitized bug reports;
- exact compatibility evidence;
- notification transports;
- harness adapters and native events;
- documentation improvements; and
- planned security-sensitive design changes that contain no vulnerability
  detail.

Every form warns against credentials, private databases, logs/configs, native
payloads, transcripts, identities, repositories, and machine-specific paths.
Actual or suspected vulnerabilities remain on the private GitHub Security
Advisory route.

The pull request template requires evidence and explicit disposition of protocol
schema/hook output, execution authority/resume, installer, redaction/web, SQLite
migration/retention, transport authentication/outbound data, support claim, and
package/release gates. The governance checker fails if the contributor guide,
issue categories, safety warnings, or review gates drift.

## Fixture boundary

`docs/fixtures.md` prohibits committing a raw private payload before
sanitization. Contributors must construct a minimal synthetic fixture outside
git and record source, exact version, date, evidence class, privacy treatment,
and its exact filename in the nearest manifest.

`pnpm fixtures:check`, now part of `pnpm check`, covers three manifests and 12
JSON fixtures. It enforces:

- valid UTF-8 JSON at or below 64 KiB;
- regular files with no symlinks or traversal;
- exact, duplicate-free inventories;
- date/source/version/evidence/privacy metadata;
- common Telegram, GitHub, OpenAI, private-key, and machine-user-path patterns;
  and
- no populated token, secret, password, API-key, authorization, or cookie key.

Seven Node tests prove valid synthetic input plus malformed JSON, oversize,
symlink, non-JSON file, machine-path/sensitive-key, duplicate-inventory, and
missing-provenance behavior. Vendored Notifications archives remain outside the
ordinary fixture system and retain their immutable contract-lock checks.

## Evidence

- All six issue forms parse as YAML.
- `pnpm governance:check`, `pnpm docs:check`, `pnpm fixtures:check`, lint,
  typecheck, compatibility generation checks, and distribution checks pass.
- The full gate passes 41 Vitest files/311 tests, seven fixture-boundary tests,
  17 contract and supply-chain tests, and the isolated six-test Notifications
  consumer.
- The 105,127-byte packed/491,406-byte unpacked artifact proof and the complete
  `0.1.0-alpha.0` to `0.1.0-alpha.1` lifecycle pass.
- All three packaged Chromium scenarios pass.
- `pnpm audit --prod` reports no known vulnerability.
- No hosted, npm, Telegram, or GitHub credential is required.

## Open boundary

The contributor baseline records Node 22, while the current development machine
ran this slice on Node 23.10.0. FXO-1149 owns the isolated clean-machine/minimum
Node 22 proof. GitHub private vulnerability reporting still cannot be enabled
and verified until the repository-public promotion step described in
`SECURITY.md`.
