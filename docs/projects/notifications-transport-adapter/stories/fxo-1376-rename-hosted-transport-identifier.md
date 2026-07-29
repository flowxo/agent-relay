# Story specification: Rename the hosted transport identifier to WhooshBang

- **Status:** Complete
- **Story code:** FXO-1376
- **Product:** Agent Relay
- **Project:** AR3 — Agent Relay Hosted Dogfood & Reliability Hardening
- **Wave:** `wave:2-agent-relay-dogfood`
- **Priority:** High
- **Linear issue:** [FXO-1376](https://linear.app/flowxo/issue/FXO-1376)
- **Owning repository:** `agent-relay`
- **Blocks:** [FXO-1156](https://linear.app/flowxo/issue/FXO-1156) (AR3.1)
- **Related:** [FXO-1373](https://linear.app/flowxo/issue/FXO-1373)
- **Last reviewed:** 2026-07-29

## Why this was required

FXO-1373 moved the hosted transport onto WhooshBang's exact `@whooshbang/*`
`1.0.0-rc.4` artifacts but deliberately left Agent Relay's own transport
identifier as `notifications`, because that string is persisted in SQLite and in
local configuration files.

That deferral had a cost that only grows. Pre-alpha local state is disposable
today, no real hosted environment exists, and the package is unpublished, so the
rename is a one-line data migration now and a genuine user-data migration later.

## Renamed identity

| Retired                                                   | Current                                              |
| --------------------------------------------------------- | ---------------------------------------------------- |
| transport name / `resolvedBy` value `notifications`       | `whooshbang`                                         |
| `agent-relay notifications connect\|status\|disconnect`   | `agent-relay whooshbang connect\|status\|disconnect` |
| `agent-relay transport select notifications`              | `agent-relay transport select whooshbang`            |
| `AGENT_RELAY_TRANSPORT=notifications`                     | `AGENT_RELAY_TRANSPORT=whooshbang`                   |
| `~/.agent-relay/notifications.json`                       | `~/.agent-relay/whooshbang.json`                     |
| `~/.agent-relay/notifications-credential.json`            | `~/.agent-relay/whooshbang-credential.json`          |
| `agent-relay-notifications-config.v1`                     | `agent-relay-whooshbang-config.v1`                   |
| `@agent-relay/notifications-transport`                    | `@agent-relay/whooshbang-transport`                  |
| `packages/notifications-transport/`                       | `packages/whooshbang-transport/`                     |
| `apps/relay/src/notifications-{command,config,poller}.ts` | `apps/relay/src/whooshbang-*.ts`                     |
| `contracts/lib/notifications-preflight.mjs`               | `contracts/lib/whooshbang-preflight.mjs`             |
| `contracts/scripts/{verify,write}-notifications*.mjs`     | `contracts/scripts/{verify,write}-whooshbang*.mjs`   |
| `pnpm contracts:notifications`                            | `pnpm contracts:whooshbang`                          |
| `docs/hosted-notifications.md`                            | `docs/hosted-whooshbang.md`                          |
| `notifications-*` / `notifications.*` diagnostic codes    | `whooshbang-*` / `whooshbang.*`                      |

## Preserved provider-neutral seam

The replaceable-transport abstraction is not WhooshBang and keeps its generic
name:

- `@agent-relay/notification-contracts` and its `NotificationTransport`
  interface;
- `FakeNotificationTransport`;
- `packages/core/src/notifications/` presentation, interaction negotiation, and
  card-action code; and
- the `notification_groups` and `notification_group_members` SQLite tables.

Fake, direct Telegram, the signed outbound webhook, and WhooshBang still
implement one interface. Renaming that seam would wrongly imply the hosted
provider owns it.

## SQLite forward migration

`RELAY_STORE_SCHEMA_VERSION` moved from `6` to `7`. Neither affected column has
a `CHECK` constraint, so this is a data migration rather than a schema break. On
first open of a database older than version 7, one transaction rewrites
`notifications` to `whooshbang` in:

- `session_topics.transport_name`;
- `events.transport_name`;
- `topic_cleanup_operations.transport_name`;
- `notification_groups.transport_name`;
- `hosted_delivery_mappings.transport_name`; and
- `pending_requests.resolved_by`.

Retained answers, resolution sources, delivery mappings, acknowledgement state,
and committed cursors survive. Reopening a migrated database leaves the value
alone. Opening a newer schema still fails closed and leaves it untouched.

## Breaking local configuration change

The hosted configuration and credential files are read from their new paths
only. An operator who had connected against the executable mock must reconnect:

```sh
agent-relay whooshbang connect --credential-stdin ...
agent-relay transport select whooshbang
```

This is safe to do as a hard cut because no real WhooshBang environment exists
yet; the only possible prior connection is to the local mock. Direct Telegram,
the fake transport, the outbound webhook, the local web board, hooks, and the
supervisor are unaffected, and a durable `notifications` transport selection
fails closed on an unknown value rather than silently choosing another
transport.

## Retired evidence

The C0-07 and AR2.1–AR2.6 story records keep the paths and identifiers they
reviewed. They are historical evidence for the tree at their implementation
commits, not current navigation, so their `packages/notifications-transport`
references are intentionally left intact.

## Completion evidence

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
```

`pnpm check` passes end to end, including the renamed
`pnpm contracts:whooshbang` gate, the packed clean-home mock canary, the packed
lifecycle proof with the version-7 schema, direct-Telegram parity, and the
secret and local-path scans.
