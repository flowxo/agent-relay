# AR1.7: Protected reproducible prerelease pipeline

- **Linear:** FXO-1148
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

One clean commit produces a four-file private prerelease bundle: the exact
tarball, SHA-256 checksum manifest, source/reproducibility manifest, and SPDX
2.3 SBOM. The pack is repeated twice using the commit timestamp and fails unless
the artifact digests match.

The tagged GitHub workflow uses immutable action SHAs and separates ordinary
read-only build permissions from OIDC/attestation permissions. Any future npm
job requires successful provenance, manual dispatch, exact tag and workflow
identity, the canonical public repository, and the protected `npm-prerelease`
environment.

## Evidence

- Clean implementation commit `a331ab5` produced two identical 105,388-byte
  tarballs.
- The independent verifier covered all 11 packed files, the application and
  three-package runtime closure, manifest binding, and all checksums.
- Fifteen focused tests reject changed artifacts, duplicate checksum/SBOM
  records, dirty input, mutable versions, unsafe publication context,
  credentials, private state, and machine paths.
- The full 311-test gate, package/lifecycle checks, all three Chromium
  scenarios, and production audit passed.
- `docs/releasing.md` records the exact release, attestation, first-publish,
  staged-publish, limitations, upgrade, rollback, and deprecation procedure.

## Closed boundary

No tag, GitHub release, attestation, or npm publication was performed.
`publication.approved` remains false and `registryAction` remains blocked. Scope
control, repository promotion, protected-environment setup, trusted publisher
setup, and the first publication remain explicit owner actions.
