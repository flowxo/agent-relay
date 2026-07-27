## Outcome

<!-- What user-visible or maintainer-visible outcome does this produce? -->

Closes <!-- Linear/GitHub issue -->

## Change type

- [ ] Bug fix
- [ ] Compatibility evidence or support claim
- [ ] Notification transport
- [ ] Harness adapter or native event
- [ ] Documentation or contributor experience
- [ ] Security-sensitive design change
- [ ] Package or release workflow

## Evidence

<!-- Describe focused tests, synthetic fixtures, and observed versions. Never claim evidence that was not collected. -->

- Focused checks:
- `pnpm check`:
- `pnpm test:e2e` when an operator surface changed:
- `pnpm package:check` / `pnpm package:lifecycle:check` when applicable:
- `pnpm audit --prod` when dependencies or release inputs changed:

## Maintainer and security gates

Mark each applicable boundary and explain its disposition:

- [ ] Protocol schema or hook continuation output
- [ ] Execution authority, sandbox/trust propagation, resume ownership, or
      session correlation
- [ ] Installer path, config merge, rollback, uninstall, or launcher behavior
- [ ] Redaction, local web authentication, CSRF, SQLite migration, or retention
- [ ] Transport authentication, callback validation, or default outbound data
- [ ] Capability, operating-system, harness-version, or runtime support claim
- [ ] Package contents, dependency, provenance, or release workflow
- [ ] None of these boundaries changed

## Safety and privacy

- [ ] I used synthetic fixtures and updated their exact manifest inventory.
- [ ] I did not include tokens, `.env` files, private keys, SQLite databases,
      raw logs, hook payloads, transcripts, source code, account/chat/session
      identifiers, usernames, hostnames, repository identities, or
      machine-specific paths.
- [ ] Operator text remains data and is never shell-interpreted.
- [ ] Transport, harness, local-authority, and fail-closed boundaries remain
      explicit.
- [ ] This pull request is not a vulnerability report. I used the private
      security-advisory path if sensitive exploitation details exist.

## Documentation and release notes

- [ ] Public documentation and `CHANGELOG.md` are updated, or not applicable.
- [ ] `docs/progress.md` and the owning project/story evidence are updated, or
      not applicable.
- [ ] Generated compatibility/support material is regenerated, or not
      applicable.
- [ ] Remaining assumptions, skipped checks, and open risks are listed below.

<!-- Remaining assumptions, skipped checks, or risks -->
