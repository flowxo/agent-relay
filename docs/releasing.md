# Prerelease build, attestation, and publication

FXO-1568 records a go with named non-blocking residuals for one bounded future
FXO-1164 publication. It approves the exact package scope, MIT licensing and
notices, security path, intended immutable tag, npm `alpha` channel, and GitHub
prerelease operations. FXO-1568 itself publishes nothing. FXO-1164 may execute
only after the final post-merge commit, regenerated digests, and green checks
are recorded; substantive drift stops for renewed approval.

The current `packaging/release.json` has `publication.approved: true` and
`registryAction: publish`. The staged package is therefore registry-eligible and
records `private: false`; the monorepo root remains `private: true` to block
accidental workspace publication. No public Agent Relay tag or package exists
yet. Generated manifests continue to record observed build-time tag state.

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

FXO-1568 authorizes this exact future tag operation only inside FXO-1164 after
the final candidate binding is recorded. The `Prerelease` workflow also supports
a manual dispatch, but the selected ref must be the exact tag or the build
fails. No second owner interview is required unless the candidate or authorized
scope drifts substantively.

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
GitHub's short-lived OIDC identity only inside the registry job. That job also
requires the protected environment and
`AGENT_RELAY_TRUSTED_PUBLISHER_CONFIGURED=true`; it cannot bootstrap a new npm
package.

The owner has approved the exact `@flowxo/agent-relay` name and scope, MIT for
the exact bundled WhooshBang contracts rc.12 and SDK rc.13 artifacts, their
notices, two-factor authentication, and this publication path. npm requires a
package to already exist before its trusted publisher can be configured. The
first package therefore uses one bounded interactive 2FA bootstrap, with no
long-lived or retained token:

1. make the repository public; enable and verify GitHub private vulnerability
   reporting and the available security controls; protect the `npm-prerelease`
   environment; and create the approved exact tag;
2. let the tagged workflow build, test, attest, and upload the exact bundle with
   `publish: false`;
3. download and verify that workflow bundle from a clean exact Node.js `22.23.1`
   environment with npm `11.15.0` or newer;
4. start a local interactive npm owner session protected by 2FA, without
   exporting a registry token, then run:

   ```sh
   pnpm release:bootstrap-publish -- --execute \
     --confirm @flowxo/agent-relay@0.1.0-alpha.1
   ```

5. the script verifies the public GitHub repository, clean tagged source, and
   exact bundle, confirms the version is absent, publishes it to `alpha`,
   immediately configures `flowxo/agent-relay` / `prerelease.yml` /
   `npm-prerelease` with `--allow-publish`, verifies that a trust relationship
   exists, and runs `npm logout` before returning success; and
6. verify the registry artifact and publisher settings, then set the protected
   repository variable `AGENT_RELAY_TRUSTED_PUBLISHER_CONFIGURED=true`. Every
   later publish must use OIDC. Do not add a repository or CI registry token.

If the exact package was published but trust setup was interrupted, restore a
fresh interactive 2FA session and rerun the same command with
`--resume-after-publish`. Recovery proceeds only when the registry's SHA-512
integrity matches the exact local tarball. A different artifact fails closed.

The initial version cannot be republished through OIDC after bootstrap. The
tagged workflow provides its GitHub build and SBOM attestations; OIDC is the
exclusive registry path for later versions. Staged publishing, including a
stage-only publisher, is a later explicit policy change and is not inferred for
this alpha.

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

These contracts were rechecked on 2026-08-11. OIDC publication requires npm
11.5.1 or newer; the `npm trust` command and staged publishing require npm
11.15.0 or newer.
