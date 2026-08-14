# Development, dogfood, and release lifecycle

Agent Relay deliberately separates integration from release. `dev` is the normal
working branch. `main` contains only commits that have passed an explicit,
immutable release-candidate qualification. Feature and fix branches start from
`dev` and normally return to `dev` through a pull request.

```text
feature/fix ──PR──> dev ──explicit qualification──> exact candidate SHA
     │               │                                  │
     └─ exploratory dogfood                             ├─ fast-forward main
                                                       └─ tag/publication
```

This is a control boundary, not a convention. PR workflows cannot publish or
qualify a release. Candidate qualification is manual, permission-checked, and
bound to one SHA. `main` promotion verifies that evidence and fast-forwards to
the same SHA, avoiding an untested merge commit. Publication downloads and
verifies the qualification artifact instead of rebuilding trust from scratch.

## Normal development loop

From a feature branch based on current `origin/dev`:

```sh
pnpm check
# pnpm check is intentionally an alias for pnpm check:fast

pnpm check:pr
```

Use focused Vitest or package commands during each edit. `check:fast` adds the
repository's deterministic policy, formatting, secret scan, affected static
checks, and focused tests. `check:pr` is the one reproducible local equivalent
of required PR CI. Both derive changed files from the merge base with `dev`
(falling back to `main`) and include working-tree changes locally. Pass
`--base <sha> --head <sha>` to reproduce a CI selection exactly, or inspect it
without execution:

```sh
pnpm sdlc:classify
pnpm check:pr -- --base <base-sha> --head <head-sha> --dry-run
```

The canonical machine-readable inventory and classifier live in
`sdlc/checks.json`. `scripts/sdlc/run.mjs` is the only phase runner; workflows
consume that control plane from protected `dev` and select its groups rather
than duplicating command lists. Unknown paths fail safe to shared, security,
browser, and lifecycle risk. A failed check prints the exact `--only`
remediation command and writes an ignored result under `.artifacts/sdlc/`.

Expected latency budgets are 3 minutes for `check:fast`, 10 minutes for an
ordinary PR, 5 minutes for exploratory dogfood deployment, and 45 minutes for
release qualification. These are targets rather than reasons to skip checks;
unexpected regressions should lead to classifier or check-graph repair.

## Deterministic risk selection

| Change class                  | PR selection                                                                                  | Release-only work excluded from the PR                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Documentation only            | formatting, governance, secret scan, public-doc contracts                                     | build, native package, browser, lifecycle, audit, reproducibility                |
| Web, authentication, session  | Relay/static/unit checks, security policy where applicable, packaged Chromium E2E             | hosted package matrix, reproducible bundle, clean-home release evidence, audit   |
| Persistence or migration      | core tests, static checks, isolated package/migration smoke proof                             | full upgrade/repair/rollback/uninstall matrix and complete release qualification |
| Installer or vendor lifecycle | Relay tests, generated assets, distribution, package and integration/lifecycle proofs         | unrelated browser work unless web risk is also present; release bundle and exit  |
| Contract or shared core       | broad unit/static/contract/capability/fixture checks                                          | release bundle, hosted candidate, production audit                               |
| Release/policy files          | policy, distribution, package and lifecycle proofs needed to review the changed release path  | actual candidate qualification or publication                                    |
| Unknown                       | fail-safe broad PR unit, security, browser, distribution, package, integration, and lifecycle | publication remains impossible                                                   |

`scripts/test/sdlc.node-test.mjs` proves representative selections, manifest
integrity, workflow parity and triggers, fork privilege isolation, candidate
authorization, UX applicability, SHA binding, stale evidence rejection, artifact
reuse, and publication boundaries.

## Two dogfood modes

Exploratory dogfood is part of development and may use a coherent feature or
`dev` working tree before PR merge:

```sh
pnpm dogfood:deploy
pnpm dogfood:status
pnpm dogfood:rollback
```

`dogfood:deploy` runs the fast risk-selected preflight, builds a retained local
candidate, and reconciles the owned launcher without replacing unrelated harness
configuration. It restarts `com.flowxo.agent-relay.dogfood` only when that
separately configured local service exists; otherwise it reports `not-installed`
and the operator restarts the foreground daemon normally. It keeps existing
Agent Relay configuration, SQLite state, sessions, logs, backups, and unrelated
plugins/hooks/settings. The record contains only the commit, branch, dirty flag,
artifact digest, and time. It explicitly says `formalReleaseEvidence: false`. It
does not inspect provider credentials, capture private coding-session content,
contact a provider, create an RC, or run release qualification. Use
`--no-restart`, `--root`, or `--service` for bounded local testing.

Candidate dogfood is different. When the classifier finds UX risk between the
last released `main` SHA and a proposed candidate, the release-candidate
workflow requires compact evidence shaped like this:

```json
{
  "schema": "agent-relay-dogfood-evidence.v1",
  "candidateSha": "<40-character candidate SHA>",
  "result": "pass",
  "testedAt": "2026-08-13T11:00:00.000Z",
  "tester": "release operator",
  "environment": "local macOS dogfood",
  "flows": [
    "opened dashboard from a real coding session",
    "refreshed and reopened"
  ],
  "limitations": ["No live-provider traffic exercised"]
}
```

Use `"result": "fail"` to retain a failed checkpoint with the same bounded
shape; promotion rejects it until the exact candidate is retested and a pass is
recorded. The promotion validator requires a pass, exact candidate SHA, a
timestamp no older than 14 days, bounded one-line fields, and no secret/private-
content field names or credential/path shapes. Backend-only candidates do not
require UX evidence. Exploratory records are never silently upgraded into formal
evidence.

## Release-candidate promotion and qualification

Dispatch **Release candidate qualification** from the exact `dev` commit (or an
explicit `hotfix/*` branch) with:

- candidate SHA;
- last released `main` SHA as the comparison base;
- `QUALIFY <candidate-sha>` confirmation;
- dogfood JSON when UX applicability requires it; and
- `dry_run: false` for publication-eligible evidence.

The `release-candidate` environment and repository write/maintain/admin
permission establish the human promotion decision. A dry run exercises the same
mechanics but is marked permanently ineligible for publication. Identical
candidate, base, manifest, classification, dogfood evidence, and dry-run inputs
produce one qualification key; a later identical dispatch is rejected with the
successful run to reuse.

Qualification runs `pnpm check:release` once on macOS. It contains the complete
quality suite, Chromium E2E, package/hosted/integration/lifecycle proofs,
reproducible bundle and verification, clean-home candidate evidence, the pinned
Apple-silicon/Node release-exit matrix in pre-tag candidate mode, and production
dependency audit. The result artifact records command digests, durations,
manifest digest, candidate/base SHA, workflow/run identity, dogfood evidence,
and every release artifact digest. It contains synthetic results only, never
real session content or credentials.

Dispatch **Promote qualified candidate to main** with the candidate SHA,
qualification run, and `PROMOTE <candidate-sha>`. The workflow verifies the
successful manual run and every artifact digest, requires the candidate to be a
descendant of `main`, and uses a non-forced GitHub ref update. This makes `main`
the exact already-qualified commit. No full suite runs again on `main`.

## Publication and evidence reuse

After separate version/release authorization, create the immutable release tag
at the current exact `main` SHA. Dispatch **Prerelease publication** from the
tag with the qualification run ID. It rejects a tag that is not current `main`,
downloads the SHA-named artifact, and checks the successful workflow
event/path/run/head SHA, phase-manifest digest, complete check inventory,
publication eligibility, and every file digest. It permits the intended tag to
have been added after the pre-tag bundle only when the tag now resolves to the
bundle's exact commit.

The workflow then attests the already-qualified tarball and SBOM. The separate
`npm-prerelease` job retains the existing OIDC trusted-publisher, public
repository, exact tag/version, immutable version, environment, authorization,
and release-policy gates. No PR, `dev` merge, `main` promotion, scheduled
regression, or dry-run evidence can reach publication.

Evidence becomes invalid when any of these changes: candidate SHA, base SHA,
phase manifest, classification, dogfood evidence, qualification mode, workflow
identity, run conclusion, repository, artifact bytes, or publication
eligibility. The retained GitHub artifact expires after 30 days; a release not
promoted in that window must be qualified again.

## Emergency fixes

Branch `hotfix/<name>` from `main`, make the smallest coherent fix, and use the
same PR command and risk selection. Exploratory dogfood remains available. Then
qualify the exact hotfix SHA, fast-forward `main` through the promotion
workflow, and merge or fast-forward the same change back into `dev`. Emergency
means a shorter change path, not bypassed security, dogfood applicability,
qualification, provenance, or publication authorization.

## Check inventory and measured baseline

Before this split, `.github/workflows/ci.yml` ran the entire old `pnpm check`,
two-build bundle, production audit, and Chromium job on every PR and again on
every resulting `main` merge. The prerelease workflow repeated all of them and
built again. Run `31752245303` on 2026-08-13 measured 102 seconds for the check
job (78 seconds inside `pnpm check`) and 68 seconds for browser E2E (29 seconds
test time after setup). The paired CodeQL push run took 204 seconds. Recent
prerelease runs took about 167–171 seconds. The apparent two-minute PR wall time
hid duplicated runner work across parallel jobs and the identical merge run.

The following inventory records the old trigger and its new owner. Approximate
times are targets informed by those runs and local observations; actual timing
is recorded per check in `.artifacts/sdlc/<phase>-results.json`.

On the FXO-1680 implementation working tree, the new fast graph completed eight
selected checks in 62 seconds. The new PR graph completed 17 selected core and
package/integration checks in 145 seconds; it correctly omitted browser and the
full lifecycle/reproducibility/audit/release-exit work because this change did
not alter a product UX surface.

| Command/check                         | Approx. | Risk controlled                                        | Old trigger/duplication                                     | Inputs/credentials            | New owner                                                                             |
| ------------------------------------- | ------: | ------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| formatting                            |      8s | deterministic source                                   | PR + main + prerelease                                      | none                          | fast, selected PR, release                                                            |
| governance/docs/fixtures/skills       |    2–8s | policy, claims, safe evidence, generated assets        | all ran PR + main + prerelease, even when unrelated         | none/synthetic                | fast/PR when applicable; release                                                      |
| repository secret scan                |      3s | credential and private-data disclosure                 | PR + main + prerelease                                      | none                          | always fast/PR/release                                                                |
| release-policy tests                  |      8s | OIDC, tag, version, workflow, registry authorization   | PR + main + prerelease for every change                     | none                          | release/control PR; qualification                                                     |
| lint/typecheck                        |  12–20s | static and package contracts                           | full workspace PR + main + prerelease                       | none                          | code-changing fast/PR/release                                                         |
| Vitest workspace                      |     40s | behavior and integration                               | unconditional PR + main + prerelease                        | synthetic                     | focused fast; code PR; release                                                        |
| capability/WhooshBang/runner contract |    3–8s | generated support and exact external contracts         | unconditional PR + main + prerelease                        | synthetic vendored fixtures   | contract/shared PR; release                                                           |
| compiled distribution                 |     25s | build, version markers, packaged web assets            | unconditional PR + main + prerelease                        | none                          | affected PR; release                                                                  |
| package smoke                         |     45s | contents, isolated install, CLI, fake delivery, web    | unconditional PR + main + prerelease                        | isolated home, synthetic      | installer/release PR; release                                                         |
| vendor integration package            |     35s | install/repair/disable/rollback/uninstall preservation | unconditional PR + main + prerelease                        | isolated vendor homes         | integration/installer PR; release                                                     |
| hosted package proof                  |    120s | hosted replay, privacy, revocation, provider isolation | unconditional PR + main + prerelease                        | isolated home, synthetic API  | release qualification only                                                            |
| lifecycle/migration matrix            |     90s | upgrade, schema, repair, rollback, uninstall, data     | unconditional PR + main + prerelease                        | isolated homes, synthetic     | persistence/installer PR; release                                                     |
| Chromium E2E                          |     45s | browser UI/auth/session behavior                       | separate job PR + main + prerelease                         | isolated browser, synthetic   | web/UX/security PR; release                                                           |
| two-build release bundle              |     30s | reproducibility, checksums, SBOM                       | PR + main + prerelease                                      | clean commit, no credential   | release qualification only                                                            |
| clean-home release evidence           |     90s | exact bundle installation and fake runtime             | manual/tag path after repeated package proof                | isolated home, synthetic      | release qualification only                                                            |
| production dependency audit           |     30s | published dependency advisories                        | PR + main + prerelease                                      | public registry network       | release qualification only                                                            |
| native release exit                   |  ≤2700s | exact supported-platform installed-artifact exit       | separate manual release ceremony after all prior repetition | pinned runtime, isolated      | candidate qualification; public-registry validation may consume the released artifact |
| CodeQL                                |  1–4min | semantic static security analysis                      | GitHub default setup repeated on PR and main                | GitHub-managed, no PR secrets | non-doc PR/default schedule; no main rerun                                            |

The native release-exit proof supports an explicit pre-tag candidate mode for
qualification while retaining the immutable-tag and public-registry modes for
final validation. None of those modes is part of ordinary development or PR CI.
Public-registry validation consumes the released artifact and never authorizes
publication.
