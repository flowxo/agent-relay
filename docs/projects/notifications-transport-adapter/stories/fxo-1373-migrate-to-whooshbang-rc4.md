# Story specification: Migrate the hosted transport to WhooshBang 1.0.0-rc.4

- **Status:** Complete against the exact `@whooshbang/*` `1.0.0-rc.4` candidate
- **Story code:** FXO-1373
- **Product:** Agent Relay
- **Project:** AR3 — Agent Relay Hosted Dogfood & Reliability Hardening
- **Wave:** `wave:2-agent-relay-dogfood`
- **Priority:** Urgent
- **Linear issue:** [FXO-1373](https://linear.app/flowxo/issue/FXO-1373)
- **Owning repository:** `agent-relay`
- **Producer repository:** `flowxo/whooshbang`
- **Blocks:** [FXO-1156](https://linear.app/flowxo/issue/FXO-1156) (AR3.1)
- **Related:** [FXO-1049](https://linear.app/flowxo/issue/FXO-1049) (C0-08);
  [FXO-1370](https://linear.app/flowxo/issue/FXO-1370) (N1-15)
- **Last reviewed:** 2026-07-29

## Why this was required

WhooshBang PR #17 / FXO-1370 made a deliberate pre-alpha hard cut. It published
no compatibility aliases, no dual package identities, and no acceptance of the
old contract. The producer repository became `flowxo/whooshbang`, and its public
artifacts became `@whooshbang/contracts`, `@whooshbang/sdk`, and
`@whooshbang/contract-mock` at `1.0.0-rc.4`.

Agent Relay pinned and imported the retired pre-rename `@flowxo/notifications*`
`1.0.0-rc.1` packages. The completed C0/AR2 proof remains valid evidence for
those exact bytes, but it is not evidence of compatibility with the breaking
candidate. AR3.1 could not begin against a producer identity the consumer had
never executed.

## Exact migrated inputs

| Artifact                    | Version      | SHA-256                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------ |
| `@whooshbang/contracts`     | `1.0.0-rc.4` | `eeee4c3b31bd3c976d26359e5fb48ce196e7b7dac788b5ee7bb1ccfb5de950ed` |
| `@whooshbang/sdk`           | `1.0.0-rc.4` | `27080980b8f1766345c217ed63d17dbcc75b1b0ba6b774f59a26aa7b276c0054` |
| `@whooshbang/contract-mock` | `1.0.0-rc.4` | `6163f68fa6bb7c2953428db8a9dfc36f87e2e24522d0610dbf7316e4f7bae454` |

- **Producer repository:** `flowxo/whooshbang`
- **Producer commit:** `c6f4eb3bee2391137c15364e7cb84e468728aab8`
- **Consumer fixture boundary:** `vendor/whooshbang-rc4`
- **Fixture sets:** the eleven `1.0.0-rc.4` contract fixture sets plus
  `contract-mock-scenarios.v1@1.0.0-rc.4`

The vendored bytes are byte-identical to the committed producer candidate. The
`vendor/whooshbang-rc4/artifacts.json` provenance manifest binds the producer
repository and full commit and is checked for exact parity with
`contracts/contract-lock.json`.

## Absorbed breaking producer changes

The cut renamed public elements the consumer had already bound. Each was
migrated exactly rather than shimmed:

| Retired element                                           | WhooshBang `1.0.0-rc.4` element                        |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `@flowxo/notifications-contracts`                         | `@whooshbang/contracts`                                |
| `@flowxo/notifications`                                   | `@whooshbang/sdk`                                      |
| `@flowxo/notifications-contract-mock`                     | `@whooshbang/contract-mock`                            |
| `NotificationsClient` / `NotificationsFetch`              | `WhooshBangClient` / `WhooshBangFetch`                 |
| `Notifications{Contract,Problem,Protocol,Transport}Error` | `WhooshBang{Contract,Problem,Protocol,Transport}Error` |
| `createNotificationsContractMock`                         | `createWhooshBangContractMock`                         |
| `NotificationsContractMock`                               | `WhooshBangContractMock`                               |
| `notifications.interaction-event.v1`                      | `whooshbang.interaction-event.v1`                      |
| `notifications.machine-events.v1`                         | `whooshbang.machine-events.v1`                         |
| `https://flowxo.com/notifications/problems/`              | `https://whooshbang.flowxo.com/problems/`              |
| `x-contract-mock-token`                                   | `whooshbang-contract-mock-token`                       |
| `flowxo-notifications-contract-mock` bin                  | `whooshbang-contract-mock` bin                         |

The machine credential bearer prefix also moved from `fxon_mc1.` to `wb_mc1.`.
Agent Relay never constructs or parses that prefix; it generates a local secret,
registers only its SHA-256 digest, and treats the returned bearer as opaque, so
no consumer change was required.

`project_slug_conflict` is a new additive `ProblemCode`. Agent Relay never
creates a WhooshBang project, so it is mapped exhaustively to a safe terminal
`notifications-request-invalid` rejection rather than a retry or a new identity.
The remaining core-contract additions (accounts, projects, API credentials) are
additive and unconsumed.

## Preserved local authority

This migration changed no local behavior. Specifically unchanged:

- local SQLite first-writer-wins `RelayStore.resolveRequest` authority;
- the persisted `notifications` transport name and `resolvedBy` value;
- `~/.agent-relay/notifications.json`,
  `~/.agent-relay/notifications-credential.json`, and `transport.json`;
- `agent-relay notifications connect|status|disconnect` and
  `agent-relay transport select notifications`;
- crash-before-ack replay, contiguous acknowledgement, and committed-cursor
  progress;
- quarantine and fail-closed identity/authentication/contract handling;
- non-executable hosted fields and the redaction boundary; and
- direct-Telegram selection and parity.

No SQLite schema change, configuration migration, or operator action is
required.

## Repository independence

The gate resolves only committed bytes under `vendor/whooshbang-rc4`. It reads
no sibling checkout, shared runtime package, monorepo layout, mutable branch, or
live WhooshBang environment. The production import boundary additionally rejects
relative `../../whooshbang` imports alongside the existing retired-path rule.

The preflight now rejects any `@flowxo/*` transitive package identity outright,
because the hard cut guarantees no legitimate artifact can declare one.

## Retired evidence

`vendor/notifications-c0` retains the pre-rename tarballs and its
`artifacts.json` byte-identical as immutable C0 history. No active runtime,
package, lock, setup, or support path installs, resolves, overrides, or checks
them. The [C0-07 story](c0-07-prove-notifications-contract-consumer.md) and the
AR2.1–AR2.6 stories keep the exact retired identities they reviewed and are not
rewritten to appear compatible with `1.0.0-rc.4`.

## Completion evidence

Reproduce with:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
```

`pnpm check` runs formatting, governance, documentation, fixture and secret
scans, lint, typecheck, the complete test suite, capability generation checks,
`pnpm contracts:notifications`, `pnpm contracts:runner`, distribution checks,
`pnpm package:check`, `pnpm package:hosted:check`, and
`pnpm package:lifecycle:check`.

`pnpm contracts:notifications` writes the exact repository-native consumer
result to `.contract-results/c0-08.json`. That result binds the consumer `HEAD`,
the WhooshBang producer commit, the three exact versions and digests, every
fixture-set identity, the canonical lock schema and compatibility-policy bytes,
the command, and the check list. It contains no timestamp, credential, message
content, or machine path.

`pnpm package:hosted:check` packs the release artifact, installs it with
lifecycle scripts disabled into a clean home and prefix, rejects workspace or
sibling resolution, and drives the installed public CLI against the exact packed
`@whooshbang/contract-mock@1.0.0-rc.4` through setup, confirm/select/input,
crash-before-ack replay, acknowledgement, safe presentation diagnosis, hosted
revoke/erasure, retained SQLite authority, a real direct-Telegram adapter
against a synthetic Bot API, and owned uninstall. The mock remains verifier-only
and is never bundled into the product.

## Explicitly excluded

This story did not deploy WhooshBang, create or rotate credentials, connect a
real WhooshBang environment, publish a package, rewrite the C0 `1.0.0-rc.1`
evidence packet, or change Agent Relay's local authority model. FXO-1156 (AR3.1)
remains blocked on separate owner authorization of an approved environment.
