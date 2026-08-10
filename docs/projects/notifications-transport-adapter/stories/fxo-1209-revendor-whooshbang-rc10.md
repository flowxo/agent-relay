# Story specification: Re-vendor the hosted transport to WhooshBang RC.10/RC.11/RC.13

- **Status:** Complete against the exact `@whooshbang/*` `1.0.0-rc.10` /
  `1.0.0-rc.11` / `1.0.0-rc.13` candidates
- **Product:** Agent Relay
- **Project:** AR3 — Agent Relay Hosted Dogfood & Reliability Hardening
- **Owning repository:** `agent-relay`
- **Producer repository:** `flowxo/whooshbang`
- **Related:** [FXO-1209](https://linear.app/flowxo/issue/FXO-1209) (WhooshBang
  N2 release gate, §23 acceptance evidence);
  [FXO-1436](fxo-1436-repin-to-whooshbang-rc5.md) (the prior re-pin)
- **Last reviewed:** 2026-08-09

## Why this was required

WhooshBang's N2 release gate claims "Agent Relay AR2 consumer suite passes
against the mock" as §23 acceptance evidence, and WhooshBang deliberately does
not report that claim itself: its `contracts/README.md` forbids a check there
from importing a sibling checkout. The claim is the consumer's to run and to
vouch for.

Agent Relay pinned `1.0.0-rc.5`, so the recorded pass in `.contract-results/`
described a five-candidate-old contract. Between rc.5 and this set, WhooshBang
landed the machine event stream's committed cursor and poison quarantine,
self-service machine-client creation, the customer endpoint lifecycle with
signed customer events, and the account-scoped agent surface.

## Exact vendored inputs

The three artifacts no longer share a release candidate number. All three come
from one immutable producer commit.

| Artifact                    | Version       | SHA-256                                                            |
| --------------------------- | ------------- | ------------------------------------------------------------------ |
| `@whooshbang/contracts`     | `1.0.0-rc.10` | `2253e94e1d78092bb605b2c16c453a6526b173e6753f36f1446a1527b4bc98cb` |
| `@whooshbang/sdk`           | `1.0.0-rc.11` | `8230ef4918b7d555be3688396882dfd9d1ba6b1b7b96ea72dd20f30a7e2be7e4` |
| `@whooshbang/contract-mock` | `1.0.0-rc.13` | `56a612ea65c0b53c24677666ac3b7dc5f15af93f3092b4fa178e8dadd6b6ab56` |

- **Producer repository:** `flowxo/whooshbang`
- **Producer commit:** `08d4203fc2f52c4ab80fcfbc6416951351fba8ae`
- **Consumer fixture boundary:** `vendor/whooshbang-rc10-rc11-rc13`
- **Fixture sets:** the eleven `1.0.0-rc.10` contract fixture sets plus
  `contract-mock-scenarios.v1@1.0.0-rc.9`

The vendored bytes are byte-identical to the committed producer candidate and to
the digests recorded in WhooshBang's own `contracts/contract-lock.json`.

## What a single version constant could no longer express

`contracts/lib/whooshbang-preflight.mjs` asserted one `WHOOSHBANG_VERSION`
against all three pins, the vendor manifest's `contractVersion`, every fixture
set version, and the fresh-install override. A diverged set makes that assertion
false, so the pin became per artifact:

- `WHOOSHBANG_CONTRACTS_VERSION`, `WHOOSHBANG_SDK_VERSION`, and
  `WHOOSHBANG_MOCK_VERSION` replace `WHOOSHBANG_VERSION`;
- each expected dependency carries its own `version` and `fixture_version`; and
- the vendor manifest moved to `agent-relay.whooshbang-artifacts.v2`, which
  records version and full producer commit per artifact instead of one set-wide
  pair, so a future diverged set needs no new manifest shape.

The mock's scenario corpus is versioned separately from the mock package. It
declares `contract-mock-scenarios.v1` at `1.0.0-rc.9` — the contract candidate
the scenarios were generated against — while the mock package is `1.0.0-rc.13`.
WhooshBang's own lock records the same pairing. Both identities are pinned
exactly by `WHOOSHBANG_MOCK_SCENARIO_CONTRACT_VERSION` and the lock.

## Absorbed producer changes

| Producer change                                                                                 | Consumer change                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `endpoint_rotation_conflict` added to the closed `ProblemCode` enum (rc.8 customer endpoints)   | Mapped exhaustively in both `SAFE_PROBLEM_MESSAGES` tables and in `setupProblemCode`                               |
| `GET /v1/messages/{id}` gained a bounded inspection wait that **defaults to 30 seconds** (rc.9) | `diagnoseMessage` passes `wait: 0` to keep its point-in-time read                                                  |
| The mock's loopback CLI defaults to the system clock (mock rc.11)                               | The packed-mock contract test starts it with `--clock fixed` and asserts the started event reports it              |
| The mock dev-depends on `@whooshbang/mcp`, deliberately outside every consumer lock             | The lock rule applies to installed sections; a new post-install check proves the closure is exactly the locked set |
| The SDK now declares an exact `@whooshbang/contracts` dependency                                | The workspace override moved to `@whooshbang/contracts@1.0.0-rc.10`                                                |

`endpoint_rotation_conflict` is unreachable from any call Agent Relay makes: it
never owns a customer endpoint. It is mapped rather than defaulted so an
unexpected response stays a safe terminal rejection.

## Findings routed to WhooshBang

Three producer-side defects were found and deliberately not worked around here.
Agent Relay adapted where adaptation was correct on its own merits, and filed
the rest rather than absorbing them.

- [FXO-1510](https://linear.app/flowxo/issue/FXO-1510) — `GET /v1/messages/{id}`
  defaults its bounded inspection wait to 30 seconds, so an existing rc.5-era
  caller that omits `wait` changed from an immediate read to a 30-second long
  poll with no version signal. WhooshBang's own compatibility policy classes a
  timing-semantics change on an existing operation as breaking.
- [FXO-1511](https://linear.app/flowxo/issue/FXO-1511) —
  `whooshbang-contract-mock-1.0.0-rc.11.tgz` exists in the producer repository
  as two different byte sequences under one immutable version. None of the three
  artifacts vendored here is affected; each is byte-identical in both producer
  locations and matches WhooshBang's own lock.
- [FXO-1512](https://linear.app/flowxo/issue/FXO-1512) — the mock's scenario
  corpus is generated against contract `1.0.0-rc.9`, so this suite proves
  rc.9-generated scenarios against the rc.10 contract and reaches none of the
  account-scoped surface rc.10 added. Agent Relay consumes none of that surface,
  so its pass is honest for the transport it owns.

## Forward tolerance for the queued bump

N2-16 (FXO-1505) closes a seven-day content window on a machine event's answer
while keeping the event, its cursor, its message and interaction references, its
timestamps, and its type. A poll can then legitimately return an
`interaction.received` event whose `response` is absent.

`validateHostedAnswer` no longer requires `response`. A content-stripped event
classifies as `terminal` / `processed` / `answer_unavailable`, ahead of the
expiry-window check it would otherwise fall outside of, so it acknowledges and
advances the committed cursor instead of quarantining, and the local request
keeps its negotiated local fallback rather than being resolved from an answer
that no longer exists. Every identity, correlation, and local-state check still
runs first.

The envelope cannot yet arrive stripped: `response` is required in
`1.0.0-rc.10`, and the SDK validates every poll response against the pinned
contract. The consumer suite therefore proves the leg with the real mock over
the real SDK and removes only that one field between what the stream delivered
and what the transport classifies.

N2-15 (FXO-1504) adds a dedicated `409` code for customer-event replay
unavailability. Three sites match exhaustively over `ProblemCode` and stop
compiling when it lands, all in `packages/whooshbang-transport/src`:

1. `errors.ts` — the `SAFE_PROBLEM_MESSAGES` delivery table, indexed in
   `asWhooshBangDeliveryError`;
2. `bootstrap.ts` — the second `SAFE_PROBLEM_MESSAGES` setup table, indexed in
   `asWhooshBangSetupError`; and
3. `bootstrap.ts` — the `setupProblemCode` switch, which has no `default` arm.

No speculative branch is added for a code that does not exist yet.

## Preserved local authority

This re-vendor changed no local behavior. Local SQLite first-writer-wins
authority, the persisted `whooshbang` transport name and `resolvedBy` value, the
connection and credential files, the CLI surface, crash-before-ack replay,
contiguous acknowledgement and committed-cursor progress, quarantine and
fail-closed handling, the redaction boundary, and direct-Telegram parity are all
unchanged. No SQLite schema change or operator action is required.

The persisted connection configuration records `contractVersion` as a literal of
the pinned contract, so it moves from `1.0.0-rc.5` to `1.0.0-rc.10`. An existing
connection file written against the prior pin no longer validates and must be
reconnected.

## Repository independence

The gate resolves only committed bytes under `vendor/whooshbang-rc10-rc11-rc13`.
It reads no sibling checkout, shared runtime package, monorepo layout, mutable
branch, or live WhooshBang environment. The superseded `vendor/whooshbang-rc5`
is removed rather than kept beside the new set, as the contract update procedure
requires. It stays reproducible from producer commit
`d34e45ab8262fd7afcc4fcb049018d38d8772bb4` and its digests stay recorded in the
FXO-1436 story specification.

## Completion evidence

Reproduce with:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
```

`pnpm contracts:whooshbang` writes the exact repository-native consumer result
to `.contract-results/c0-08.json`, binding the consumer `HEAD`, the producer
commit, the three exact versions and digests, every fixture-set identity, the
canonical lock schema and compatibility-policy bytes, the command, and the check
list.

## Explicitly excluded

This story did not deploy WhooshBang, create or rotate credentials, connect a
real WhooshBang environment, publish a package, rewrite the retired `1.0.0-rc.1`
C0 evidence packet, or vendor any artifact WhooshBang has not published. The
`binding_paused` connect outcome FXO-1436 added is carried forward unchanged.
