# Maintainer policy

Agent Relay is maintained by the Flow XO repository maintainers. Repository
roles and GitHub permissions, rather than this file, are the authoritative list
of people who can merge or release.

## Responsibilities

Maintainers:

- keep protocol, capability, fixture, privacy, and support claims aligned with
  observed behavior;
- require deterministic tests for failures, duplicates, retries, timeouts, stale
  answers, and concurrent-session isolation where relevant;
- preserve local-first operation and transport/harness boundaries;
- protect credentials, private fixtures, and machine-specific data;
- review dependency, package, and release evidence before promotion;
- coordinate private vulnerability reports and disclosure; and
- keep `docs/progress.md`, project specs, and Linear state consistent with
  proven work.

## Review gates

The following changes require explicit maintainer review with security impact
considered in the pull request:

- protocol schemas or hook continuation output;
- execution-authority or sandbox propagation;
- resume claim ownership and session correlation;
- installer paths, config merge behavior, rollback, or uninstall ownership;
- secret redaction, local web authentication, or CSRF behavior;
- SQLite migrations or retention;
- transport authentication or default outbound payloads;
- supported capability, operating-system, or runtime claims; and
- package, dependency, provenance, or release workflows.

Ordinary documentation, sanitized fixtures, diagnostics, and provider adapters
behind existing interfaces may use normal review after the relevant checks pass.
A fixture is not acceptable evidence until its source/version is recorded and
private values are removed. The [safe fixture policy](docs/fixtures.md) and
exact manifest inventory apply to every ordinary JSON fixture; vendored contract
artifacts remain governed by their immutable contract locks.

When more than one maintainer is available, the author should not be the sole
approver of a security-sensitive or release change. A repository owner may
document and make an emergency decision when delay would increase user risk.

## Merge and release expectations

- Keep changes reviewable and tie them to the owning issue.
- Do not merge a red quality gate or dismiss a relevant secret/security alert
  without a documented disposition.
- Do not claim compatibility from parsing alone.
- Do not publish from an uncommitted worktree or an unprotected manual laptop
  command.
- Do not make the repository public until the public-promotion checklist,
  including GitHub private vulnerability reporting, is green.
- Do not publish a package until scope ownership, artifact inspection, and the
  protected prerelease workflow are approved.

Stable V1 publication remains a later project decision after hosted dogfood.

## Governance changes

Material changes to licensing, privacy defaults, security reporting, telemetry,
support scope, ownership, or release authority require a dedicated issue and
maintainer approval. No contributor may commit on behalf of another person or
add a contact address that is not demonstrably owned and monitored.
