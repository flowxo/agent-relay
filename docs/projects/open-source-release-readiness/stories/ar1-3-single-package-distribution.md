# AR1.3: Single-package distribution

- **Linear:** FXO-1144
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

The release boundary is one private, unpublished
`@flowxo/agent-relay@0.1.0-alpha.0` package exposing only the `agent-relay`
executable. Internal protocol, harness, core, and relay packages remain
workspace-only and are bundled into the executable. The installed artifact has
only two runtime dependencies: exact `better-sqlite3@13.0.1` and `zod@4.4.3`.

The staged package has no programmatic export, so no declaration contract is
required. It contains no lifecycle scripts, development dependencies,
`workspace:*` links, TypeScript source, tests, fixtures, or repository-only
design documents. Source maps are omitted after the explicit path-disclosure and
CLI-support review recorded in `docs/packaging.md`.

The recommended scope remains an owner-controlled decision before publication.
Both the repository and staged manifest stay `private: true`; this story did not
publish to npm.

## Evidence

`pnpm package:check` is part of `pnpm check`. On 2026-07-26 it:

- invoked the exact `pnpm pack` lifecycle against the generated stage;
- matched all 11 archive entries to `packaging/package-files.json`;
- measured 100,883 compressed bytes and 474,271 unpacked bytes, below the
  2,000,000-byte and 5,000,000-byte budgets;
- rejected workspace, internal-package, repository, machine, source-map,
  activation, and token-shaped content;
- installed the tarball with scripts disabled in a temporary prefix;
- explicitly rebuilt the approved SQLite native dependency;
- ran the installed executable's help;
- started the installed daemon in a temporary home with no provider credential;
- delivered exactly one fake canary with zero retries and dead letters; and
- served the five packaged web assets and matching authenticated API/asset
  versions.

The first platform check caught that the Apple-silicon test machine currently
runs an x64 Node executable. Package metadata now permits native arm64 and
Rosetta x64 Node on macOS; documentation still makes no Intel Mac support claim.

## Assumptions and open risks

- Flow XO npm scope ownership and trusted-publishing configuration are not yet
  proven. Publication remains blocked by policy, not architecture.
- The local proof used Node 23.10.0. FXO-1149 owns clean evidence on the
  documented minimum Node 22 runtime.
- Linux CI can prove deterministic contents, metadata, scans, and budgets, but
  correctly skips runtime installation because the package supports macOS.
- FXO-1145 still needs full packed-artifact install, repeated reconciliation,
  upgrade, doctor, uninstall, state preservation, and unsafe-downgrade evidence.
