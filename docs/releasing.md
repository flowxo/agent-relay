# Prerelease build, attestation, and publication

This story does not authorize publication. The checked-in pipeline builds and
verifies a reviewable prerelease bundle, while registry mutation remains behind
an explicit code approval, an exact tag, a manual workflow input, a protected
GitHub environment, a public-repository check, and npm OIDC.

The current `packaging/release.json` has `publication.approved: false` and
`registryAction: blocked`. The staged package therefore remains private and
`scripts/publish-release.mjs` refuses to contact the registry. The FXO-1162
freeze created or authorized no tag; generated manifests record build-time tag
state. The frozen [V1 release boundary](v1-release-boundary.md) is a
documentation/control record, not tag authorization.

## Release inputs

The release source is one clean commit. `pnpm release:bundle` refuses modified
tracked files and unignored untracked files. Ignored `.artifacts/` output cannot
enter the package; `packaging/package-files.json` remains the exact 11-file
allowlist.

Before proposing a tag:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
pnpm audit --prod
git status --short
```

The semantic prerelease version must agree across `package.json`,
`packaging/release.json`, and the compiled source version. Its exact tag is
`v<version>`, and the npm dist-tag is the first prerelease identifier, currently
`alpha`. Curate `CHANGELOG.md`; generated commit lists are not release notes.

From the clean commit, run:

```sh
pnpm release:bundle
pnpm release:bundle:verify
pnpm release:evidence
```

On the supported Apple-silicon target, the separate native Node 22
installed-artifact matrix uses `pnpm release:exit`; see the
[release-readiness evaluation](release-readiness.md). The current attempt is
**not green**: it reached exact arm64 Node.js 22.23.1, then failed closed
because no installed harness matched an exact frozen verified snapshot. Do not
widen support or run live traffic merely to remove that limitation. The command
publishes nothing.

The builder rebuilds and packs twice with the commit timestamp as
`SOURCE_DATE_EPOCH`, then rejects different SHA-256 digests. It emits only:

```text
.artifacts/release/
├── RELEASE_NOTES.md
├── SHA256SUMS
├── agent-relay-release.json
├── flowxo-agent-relay-<version>.spdx.json
├── package-contents.json
└── flowxo-agent-relay-<version>.tgz
```

The SPDX 2.3 SBOM binds to the tarball SHA-256, inventories every packed file
with SHA-1 and SHA-256, includes the exact runtime dependency closure, and
records the bundled WhooshBang contracts/SDK components and their source archive
checksums. `package-contents.json` independently records every exact packed
path, byte size, and SHA-256. `RELEASE_NOTES.md` is copied from the reviewed
source. The release manifest records the exact commit, commit time, intended
tag, whether that tag existed at build time, package identity, package manager,
source-input paths/digests, artifact/SBOM/content/note digests and sizes, and
the two-build match.

`pnpm release:evidence` re-verifies that exact clean-commit bundle, installs its
tarball into an isolated home and prefix, and proves help, version,
capabilities, the fake canary, web assets, and authenticated loopback API
without forwarding provider credentials to the installed runtime. Its ignored
mode-`0600` JSON and checksum live under `.artifacts/release-evidence/`. This is
credential-free evidence, not a live provider test or a replacement for native
release-exit.

`SHA256SUMS` and the manifest are integrity metadata, not signed provenance.
Signed provenance comes from the GitHub attestation job described below.

## Tagged GitHub build

Push an exact tag only after its commit is green:

```sh
git tag --annotate v0.1.0-alpha.1 --message "Agent Relay 0.1.0-alpha.1"
git push origin v0.1.0-alpha.1
```

Tag creation and push are external release actions and require owner approval at
execution time. The `Prerelease` workflow also supports a manual dispatch, but
the selected ref must be the exact tag or the build fails.

The workflow:

1. checks out the full tagged commit without persisted Git credentials;
2. performs the frozen scripts-disabled install and approved native rebuild;
3. runs `pnpm check`, packaged Chromium E2E, and the production audit;
4. produces the reproducible six-file bundle;
5. uploads the bundle for 14 days; and
6. grants OIDC/attestation write permissions only to a separate attestation job.

All third-party actions are pinned to immutable commit SHAs in
`packaging/actions-lock.json`. Updating a pin requires rechecking the official
action repository and current GitHub documentation.

GitHub artifact attestations require `contents: read`, `id-token: write`, and
`attestations: write`. The workflow creates both build-provenance and SBOM
attestations with `actions/attest@v4` when the repository is public. A private
Enterprise repository may opt in with the reviewed
`AGENT_RELAY_PRIVATE_ATTESTATIONS=enabled` repository variable. Other private
repository plans still produce checksums and an SBOM, but must not claim signed
GitHub provenance.

After downloading the bundle:

```sh
sha256sum --check SHA256SUMS
node scripts/verify-release-bundle.mjs /path/to/release-bundle
gh attestation verify \
  flowxo-agent-relay-0.1.0-alpha.1.tgz \
  --repo flowxo/agent-relay
```

On macOS, `shasum -a 256 -c SHA256SUMS` is the checksum equivalent. Attestation
verification is meaningful only after the signed job ran.

## GitHub prerelease procedure

Create a draft GitHub prerelease from the exact tag. Do not rebuild or replace
an asset from a laptop. Attach the six workflow artifacts and record:

- package name, semantic prerelease version, tag, and exact commit;
- all artifact filenames and the `SHA256SUMS` content;
- links to the workflow run and build/SBOM provenance;
- supported OS/runtime and exact harness evidence;
- known limitations, especially native-hook crash proof, Cursor IDE resume,
  Cursor permission automation, Telegram's at-least-once ambiguity, no automatic
  dual-send, no hosted dashboard/team policy, the accepted ambient
  hook-isolation residual, and unverified runtime targets;
- required upgrade or migration actions;
- the supported install, doctor, canary, upgrade, uninstall, and erasure paths;
  and
- the rollback/deprecation contact and security-reporting path.

Keep the GitHub release in draft until the artifact, checksum, SBOM, provenance,
and notes have been reviewed. Mark it as a prerelease when publishing the GitHub
release record.

## npm owner gates

No long-lived npm token belongs in GitHub. The workflow contains no `NPM_TOKEN`,
`NODE_AUTH_TOKEN`, or `secrets.*` reference. npm trusted publishing exchanges
GitHub's short-lived OIDC identity only inside the registry job.

Before changing `publication.approved` to `true`, the owner must:

1. approve distributable license and notice metadata for the bundled
   `@whooshbang/contracts` and `@whooshbang/sdk` components; `NOASSERTION` is
   not a publication grant;
2. confirm control of the `@flowxo` npm scope and the exact
   `@flowxo/agent-relay` name;
3. make the source repository public so npm provenance is supported;
4. protect the `npm-prerelease` GitHub environment with a required reviewer and
   prevent self-review when the plan supports it;
5. configure the npm trusted publisher for organization `flowxo`, repository
   `agent-relay`, workflow filename `prerelease.yml`, and environment
   `npm-prerelease`;
6. enable two-factor authentication and disallow traditional publish tokens;
7. protect release tags; and
8. approve a dedicated code change setting the registry action.

An npm package must already exist before `npm stage publish` can be used. The
first approved prerelease therefore requires a separately reviewed direct
`publish` action. After that first package exists, prefer
`registryAction: stage`, configure the trusted publisher as stage-only, and
require a maintainer to inspect and approve the staged package with 2FA. Do not
grant both actions after staged publishing is available.

To request the registry job, manually dispatch `Prerelease` on the exact tag and
set `publish` to true. The job still refuses unless all checked-in and runtime
gates agree. Building, tagging, attesting, or creating a GitHub prerelease does
not implicitly approve npm publication.

## Rollback, deprecation, and compromise

- Do not delete or unpublish a normal bad prerelease. Deprecate it in npm, mark
  the GitHub prerelease clearly, publish a fixed version, and give exact upgrade
  guidance.
- Do not move or reuse a release tag or semantic version.
- SQLite migrations are forward-only. Recommend an older binary only when its
  schema support is explicit; otherwise fix forward.
- Reject a staged package rather than approving it when review fails.
- A suspected compromised artifact, workflow, action pin, OIDC relationship, or
  maintainer account triggers the private security process. Stop promotion,
  preserve evidence, revoke or replace affected trust, deprecate the version,
  and issue corrected provenance with a new version.
- Record the disposition in `CHANGELOG.md`, the GitHub prerelease, the progress
  ledger, and the owning Linear issue.

## Current primary sources

- [GitHub build and SBOM attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub SBOM guidance](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/export-dependencies-as-sbom)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm SBOM command](https://docs.npmjs.com/cli/v11/commands/npm-sbom/)

These contracts were rechecked on 2026-07-26. npm trusted publishing currently
requires npm 11.5.1 or newer; staged publishing requires npm 11.15.0 or newer.
