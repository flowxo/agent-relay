# Story specification: Re-vendor the hosted transport to WhooshBang RC.12/RC.13/RC.15

- **Status:** Complete against the exact rc.12 / rc.13 / rc.15 artifact set
- **Linear:** [FXO-1531](https://linear.app/flowxo/issue/FXO-1531)
- **Product:** Agent Relay
- **Project:** AR3 — Agent Relay Hosted Dogfood & Reliability Hardening
- **Owning repository:** `flowxo/agent-relay`
- **Producer repository:** `flowxo/whooshbang`
- **Producer issue:** [FXO-1495](https://linear.app/flowxo/issue/FXO-1495)
- **Last reviewed:** 2026-08-10

## Outcome

Agent Relay consumes the final WhooshBang interaction-alpha candidate and owns
an exact, repository-native proof of the corrected machine poll and
acknowledgement behavior before G2 or hosted AR3 evidence advances.

This is a consumer re-vendor and proof refresh. It does not connect or deploy a
real service, publish a package, or change Agent Relay's local authority model.

## Exact vendored inputs

All three artifacts come from immutable producer commit
`50de931fed8d819d1a70ec27201351b09f0ef251`, named by WhooshBang lock commit
`151b61f9c52df49a35765eea6e20065abe6eea53`.

| Artifact                    | Version       | SHA-256                                                            |
| --------------------------- | ------------- | ------------------------------------------------------------------ |
| `@whooshbang/contracts`     | `1.0.0-rc.12` | `4b428d1d9094ea78e136084d56831a4c8bdee97b1c40e569cde5787ea176c2dd` |
| `@whooshbang/sdk`           | `1.0.0-rc.13` | `c3e67296c392f54b4d432d0bb57c70a6b8d031b1acdb17c44a2cb79626afefec` |
| `@whooshbang/contract-mock` | `1.0.0-rc.15` | `27ce251f6dfc283bf4eecfcb782bd577eba9d13751de63d032bad7ab733918b7` |

The active consumer boundary is `vendor/whooshbang-rc12-rc13-rc15`. All eleven
contract fixture sets and `contract-mock-scenarios.v1` are pinned at
`1.0.0-rc.12`.

## Consumer-relevant producer changes

Contracts rc.12 adds the closed `replay_unavailable` problem code and makes an
interaction event's `response` optional when `answer_retained` is false. Agent
Relay maps the new problem exhaustively to bounded text, accepts the published
redacted event without an unsafe cast, keeps the local request open, and
acknowledges the retained terminal fact without exposing or inventing answer
content.

Mock rc.15 fixes two machine-stream contradictions:

1. an event acknowledged beyond an earlier cursor gap is omitted from later
   polls even though the committed cursor cannot yet advance; and
2. replaying an acknowledgement reports `existing` plus the current committed
   cursor instead of replaying the stale first response body.

The consumer suite proves both behaviors against the exact mock over the exact
SDK. It covers both same-key replay—the published fixture and former defect—and
a fresh idempotency key against the same durable acknowledgement.

## Preserved invariants

- Local SQLite remains the first-writer-wins resolution authority.
- Local resolution or safe quarantine commits before remote acknowledgement.
- Crash-before-ack recovery cannot resolve or resume twice.
- Cursor advancement remains contiguous.
- Invalid identity, correlation, option, signature, or stream data fails closed.
- Hosted fields remain data and never become executable authority.
- Direct Telegram remains independently selectable and behaviorally covered.
- The packed proof uses no sibling checkout, live account, or retained broad
  project credential.

## Repository independence and history

The ordinary gate resolves only committed bytes under the active vendor
directory. The superseded contracts rc.10 / SDK rc.11 / mock rc.13 directory is
removed according to Agent Relay's update convention; producer commit
`08d4203fc2f52c4ab80fcfbc6416951351fba8ae`, its exact digests, and its consumer
evidence remain immutable in Git history and the FXO-1209 story specification.

## Acceptance evidence

Use the scripts-disabled install order and complete gates:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm contracts:whooshbang
pnpm package:hosted:check
pnpm check
```

`pnpm contracts:whooshbang` writes `.contract-results/c0-08.json`, binding the
exact consumer commit, producer commit, versions, digests, fixture identities,
canonical lock/policy bytes, command, and named checks. The generated result is
ignored; the PR and Linear issue record it as release evidence.

The scripts-disabled install, artifact preflight, and rebuild sequence passed.
The exact consumer suite passed 9/9, including the two named rc.15 regression
proofs. `pnpm check` passed with 593 tests across 75 Vitest files plus the lock,
supply-chain, documentation, security, build, contract, package, hosted-package,
and lifecycle gates. `pnpm audit --prod` reported no known vulnerabilities. A
real Telegram journey was not run because neither Telegram behavior nor its
provider boundary changed.

## Exclusions

This story does not deploy WhooshBang or Agent Relay, create or rotate
credentials, connect a real environment, run Telegram provider acceptance,
publish packages, reopen historical evidence, or begin AR3.1 canary operations.
