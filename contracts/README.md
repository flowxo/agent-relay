# Agent Relay contract release gate

`contract-lock.json` is Agent Relay's exact consumer lock for cross-repository
public contracts. It pins only the three WhooshBang artifacts consumed by the C0
transport boundary, each at its own exact version; they no longer share one
release candidate number. Agent Relay owns no C0 artifact.

The lock records the producer repository and full commit, exact SemVer, artifact
SHA-256, repository-relative tarball, and exact fixture-set identities. The
byte-identical lock schema and compatibility policy are pinned by their own
canonical digests. Neither a branch, tag, version range, sibling checkout, nor
copied producer schema is an authority.

Run the complete consumer gate with:

```sh
pnpm contracts:whooshbang
```

The legacy `pnpm whooshbang:contract:check` alias invokes the same command. The
stable gate:

1. strictly compiles and applies `contract-lock.schema.json` with Ajv 2020;
2. applies the independent semantic validator and exact Agent Relay topology;
3. verifies the canonical schema and policy bytes;
4. verifies every artifact digest before parsing or installing it;
5. rejects unsafe archive members, secret-like paths, links, lifecycle scripts,
   mutable transitive dependencies, and package or fixture identity drift;
6. rejects any retired `@flowxo/*` transitive package identity outright, because
   WhooshBang's pre-alpha hard cut publishes no compatibility alias;
7. checks the `vendor/whooshbang-rc10-rc11-rc13` provenance manifest against the
   lock, including the producer repository and per-artifact full commit;
8. installs the verified bytes in a fresh temporary pnpm project with lifecycle
   scripts disabled, proves the installed WhooshBang closure is exactly the
   locked set, and imports all three packages;
9. enforces the production transport import boundary;
10. runs the lock, supply-chain, additive-compatibility, mapping, SQLite replay,
    acknowledgement, quarantine, and direct-Telegram parity tests; and
11. writes deterministic aggregate evidence to `.contract-results/c0-08.json`.

The result directory is generated and ignored. The result identifies the exact
consumer `HEAD`, producer commits, versions, digests, fixture sets, canonical
schema/policy bytes, command, and checks. It contains no timestamp, credential,
message content, or machine path.

`vendor/notifications-c0` holds the retired pre-rename `1.0.0-rc.1` tarballs as
immutable C0 history. No active path installs, resolves, overrides, or checks
them.

## Install ordering

The vendored tarballs are package dependencies, so CI must prevent lifecycle
execution before the artifact audit. CI uses this order:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
```

The first command resolves and links dependencies without running lifecycle
scripts. `contracts:preinstall` then performs the digest, archive, package,
fixture, dependency, and clean-install checks. Only after it passes may
`pnpm rebuild` run the repository's approved `better-sqlite3` and `esbuild`
builds. The lock's malicious-lifecycle regression proves the installer is not
invoked when any artifact declares `preinstall`, `install`, or `postinstall`.

Use the same sequence for a fresh local checkout. An ordinary install followed
by a post-install check is not release-gate evidence.

## Compatibility behavior

Within V1, Agent Relay ignores unknown optional success-response and known-event
fields while retaining the fields it consumes. Unknown request or response
discriminators remain rejected unless the owning contract explicitly declares
unknown-value tolerance. Removing or renaming public elements, making optional
fields required, tightening accepted inputs, or changing authorization,
identity, idempotency, signing, retry, ordering, or expiry semantics is
breaking.

The canonical `compatibility-policy.json` contains the complete executable C0
classification vocabulary.

## Updating a WhooshBang pin

Every update is an explicit reviewable change:

1. Start from an immutable full source commit for every WhooshBang artifact
   being updated. Confirm the owner changelog, canonical schema, generated
   artifact, fixture, manifest version, and any required migration or
   deprecation note.
2. Produce or obtain the replacement tarball from its exact source commit
   without running lifecycle scripts. Record its package version and SHA-256
   digest; unchanged artifacts retain their existing source commits and bytes.
3. Replace only the corresponding files under the vendor directory. The
   directory is named for the pinned candidate set, so a version change renames
   it to `vendor/whooshbang-<candidates>` — naming every candidate when the
   three artifacts no longer share one number — and the superseded directory is
   removed rather than kept beside it; the retired candidate stays reproducible
   from its recorded producer commit and its digests stay recorded in the story
   specification that pinned it. Update the provenance manifest and
   `contract-lock.json` with the exact commit, versions, digests, paths, and
   fixture identities.
4. Update the deliberately duplicated expected C0 inventory in
   `contracts/lib/whooshbang-preflight.mjs`. A canonical schema or
   compatibility-policy change also requires byte-for-byte portfolio
   coordination and new pinned digests.
5. Run the safe install ordering above, then `pnpm contracts:whooshbang` and the
   normal `pnpm check`.
6. Include the owner changelog/migration note, exact producer build evidence,
   generated `.contract-results/c0-08.json`, and consumer output in the pull
   request.

Do not fetch a mutable branch in the ordinary gate, import a sibling checkout,
publish an npm package, alter production configuration, or synchronize product
deployments as part of this procedure.

## Runner protocol candidate updates

`runner-protocol-lock.json` is a separate exact consumer lock for the
experimental `runner.protocol/v1` artifacts. Normal install, build, test,
package, and runtime paths use only the two committed archives under
`vendor/runner-protocol-v1`; they never discover a sibling checkout.

The producer first builds a clean, deterministic candidate. Check it without
writing:

```sh
pnpm contracts:runner:update -- \
  --artifacts /absolute/path/to/runner-protocol-v1
```

The command requires the versioned producer manifest, clean 40-character source
commit, `internal-until-gate-5` commitment, exact two-package inventory, byte
counts, SHA-256 digests, scripts-free package manifests, expected dependency
closure, and the 33-case fixture corpus. It stages and runs the same hardened
preflight as the ordinary consumer gate.

The default mode is read-only. If the result reports `changed: true`, use a
dedicated review branch and apply only after inspecting the producer change:

```sh
pnpm contracts:runner:update -- \
  --artifacts /absolute/path/to/runner-protocol-v1 \
  --apply
```

Apply refuses dirty lock/vendor targets. It derives the lock from validated
bytes, replaces only the lock plus two vendored archives, verifies the complete
new set, and restores the prior set if replacement is interrupted. Then run
`pnpm contracts:runner`, the exact native canary, `pnpm check`, and the producer
consumer verifier before committing the update.

Do not treat an unchanged archive digest as permission to rewrite provenance by
hand. Do not widen the compatibility commitment, publish either private `0.0.0`
package, or force an older Agent Relay package to open newer local SQLite state.
