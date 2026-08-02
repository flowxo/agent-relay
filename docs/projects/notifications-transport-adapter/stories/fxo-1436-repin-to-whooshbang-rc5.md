# Story specification: Re-pin the hosted transport to WhooshBang 1.0.0-rc.5

- **Status:** Complete against the exact `@whooshbang/*` `1.0.0-rc.5` candidate
- **Story code:** FXO-1436
- **Product:** Agent Relay
- **Project:** AR3 — Agent Relay Hosted Dogfood & Reliability Hardening
- **Wave:** `wave:2-agent-relay-dogfood`
- **Priority:** High
- **Linear issue:** [FXO-1436](https://linear.app/flowxo/issue/FXO-1436)
- **Owning repository:** `agent-relay`
- **Producer repository:** `flowxo/whooshbang`
- **Blocks:** [FXO-1156](https://linear.app/flowxo/issue/FXO-1156) (AR3.1)
- **Related:** [FXO-1373](https://linear.app/flowxo/issue/FXO-1373),
  [FXO-1376](https://linear.app/flowxo/issue/FXO-1376),
  [FXO-1190](https://linear.app/flowxo/issue/FXO-1190) (N1-08)
- **Last reviewed:** 2026-08-02

## Why this was required

FXO-1373 pinned the exact `1.0.0-rc.4` candidate. WhooshBang has since issued
`1.0.0-rc.5`, which restores the documented `paused` Telegram binding state:

| Candidate    | `BindingSummary.status`           |
| ------------ | --------------------------------- |
| `1.0.0-rc.4` | `active` \| `revoked`             |
| `1.0.0-rc.5` | `active` \| `paused` \| `revoked` |

This is a reachable state rather than a documentation change. N1-08 (FXO-1190)
shipped the subscriber pause, resume, and unsubscribe controls that produce it.

Agent Relay's `assertBinding` required `binding.status === "active"` and threw a
non-retryable `whooshbang-setup-invalid` for anything else, with the message
"WhooshBang did not prove the expected subscriber binding." A subscriber who
paused their own binding would have been told the binding was unprovable, with
no retry path, when the remedy is simply to resume it. The old behavior was
fail-closed and therefore safe, but it misnamed a recoverable condition.

## Producer artifacts

| Artifact                    | Version      | SHA-256                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------ |
| `@whooshbang/contracts`     | `1.0.0-rc.5` | `442f4fcae4448bc9a1d8e6ea001a1117c76ebe1786f3765696e97bb9d1029028` |
| `@whooshbang/sdk`           | `1.0.0-rc.5` | `b68e9b693575807f8dd998861c3202cd72668789c88ab9dabf1eb0dafae75d0a` |
| `@whooshbang/contract-mock` | `1.0.0-rc.5` | `a7a6e87c64b6ded9f0fd048c1fd838b36dd45f4fe73a56193e6a24c247175ae5` |

- **Producer commit:** `d34e45ab8262fd7afcc4fcb049018d38d8772bb4`
- **Consumer fixture boundary:** `vendor/whooshbang-rc5`
- **Fixture sets:** the eleven `1.0.0-rc.5` contract fixture sets plus
  `contract-mock-scenarios.v1@1.0.0-rc.5`

The tarballs were produced by the producer's own packing pipeline
(`apps/contract-mock/scripts/pack.ts`) from a clean detached worktree at that
commit, with lifecycle scripts disabled. That pipeline builds the SDK and mock
twice and compares digests, audits packed contents, and runs both npm and pnpm
consumer proofs before emitting the artifacts; it reported `C0_05_PACK_OK` with
`consumers: {npm: pass, pnpm: pass}`.

## Retired candidate

`vendor/whooshbang-rc4` is removed rather than retained beside the current pin.
The rc.4 bytes stay reproducible from
`flowxo/whooshbang@c6f4eb3bee2391137c15364e7cb84e468728aab8`, their three exact
digests are recorded in the FXO-1373 story specification, and they remain in
this repository's history. A vendored archive that no active check verifies is
an unauditable binary rather than evidence.

`vendor/notifications-c0` is a different case and is untouched. Those
`@flowxo/notifications*` package identities were retired by WhooshBang's hard
cut and cannot be rebuilt from the producer repository, so their bytes are the
only remaining record.

## Paused binding behavior

`connectWhooshBangMachine` gained a distinct terminal-free outcome:

```ts
status: "authorization_pending" | "authorization_incomplete" | "binding_paused";
```

An activated subscription link whose binding is `paused` returns
`binding_paused` before any machine client is created, so nothing has to be
revoked afterwards and no credential material is minted. The CLI adds a fixed
remedy — resume the subscription in Telegram, then rerun `whooshbang connect` —
and still never echoes the project credential.

`assertBinding` is unchanged. A revoked binding, an absent binding, a
non-activated link, and every identity mismatch remain terminal
`whooshbang-setup-invalid` failures.

The consumer contract suite proves this against the producer's own
`core-v1/success/subscription-link-paused.json` fixture — an activated link with
a paused binding — rather than a hand-written approximation, and asserts the
fixture still validates under the pinned `validateSubscriptionLink`.

## Preserved behavior

Local SQLite first-writer-wins resolution, crash-before-ack replay, contiguous
acknowledgement, quarantine fail-closed handling, non-executable hosted fields,
cross-machine stream isolation, and direct-Telegram parity are unchanged. No
schema version, configuration key, transport identifier, or stored value moved.

## Completion evidence

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
```

The preflight reports the exact consumer `HEAD`, the producer commit, and all
three artifact digests and fixture sets, then installs the verified bytes in a
fresh scripts-disabled pnpm project. `pnpm check` passes end to end, including
the `pnpm contracts:whooshbang` gate, the packed clean-home mock canary, the
packed lifecycle proof, direct-Telegram parity, and the secret and local-path
scans.
