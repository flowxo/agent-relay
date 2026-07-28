# AR1.1: Governance and maintainer policy

- **Linear:** FXO-1142
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

The repository now has a consistent public governance boundary:

- the standard MIT license names Flow XO, LLC and every workspace package
  declares `MIT`;
- security reporting uses GitHub's private advisory path without inventing an
  email address;
- privacy documentation enumerates local files, bounded private content,
  outbound transports, defaults, credentials, retention, uninstall, and erasure;
- support guidance defines the narrow evidence-backed platform boundary and
  prohibits unsafe public diagnostics;
- the Contributor Covenant and maintainer policy define conduct, review, merge,
  security, and release expectations; and
- the GitHub issue chooser prevents blank issues and the bug form requires an
  explicit privacy review.

`pnpm governance:check` makes the required documents, license metadata, private
report path, privacy disclosures, review gates, and public issue warnings a
deterministic repository gate. It is part of `pnpm check`.

## Evidence and limits

The policy is based on current implementation behavior:

- state defaults to `~/.agent-relay`;
- the daemon stores SQLite state and bounded redacted logs locally;
- local web credentials are mode-`0600`;
- Telegram receives bounded rendered cards rather than raw hook payloads; and
- uninstall preserves retained state and config backups by design.

GitHub private vulnerability reporting cannot be enabled while this repository
is private. The exact private-report URL and policy are ready, but enabling and
verifying the feature remains an explicit gate immediately before the repository
is made public. Making the repository public is outside this story and requires
maintainer approval.

No monitored security or conduct email was available or invented.
