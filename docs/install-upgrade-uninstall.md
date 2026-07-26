# Install, upgrade, uninstall, and erase

> **Current distribution:** source build while the first prerelease artifact is
> being prepared
>
> **Verified target:** macOS on Apple silicon, Node.js 22, pnpm 11

Agent Relay changes user-level harness configuration. Always inspect the dry run
before installing or reconciling an upgrade.

## Prepare a source build safely

From a clean checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check
pnpm build
```

The first install is scripts-disabled. The contract preflight verifies the exact
vendored Notifications archives before the approved SQLite native build runs. No
Telegram credential is needed.

No public npm package exists yet. Do not install the unrelated unscoped
`agent-relay` package from npm. The eventual package name and exact artifact
commands will replace this source-build section only after package-scope and
prerelease approval.

## Inspect and install hooks

```sh
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer preflights every target before writing. It creates private
timestamped backups, writes atomically, and rolls back earlier writes if a later
write fails.

The owned paths are:

| Path                             | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `~/.agent-relay/bin/agent-relay` | Exact Node.js/CLI launcher                   |
| `~/.agent-relay/install.json`    | Ownership and installed-version manifest     |
| `~/.codex/hooks.json`            | Owned Codex Stop/permission entries          |
| `~/.claude/settings.json`        | Owned Claude Stop/failure/permission entries |
| `~/.cursor/hooks.json`           | Owned Cursor Stop entry                      |

Existing hooks and unrelated settings are preserved. A Cursor permission entry
is intentionally not installed until a current sanitized live payload exists.

Review newly installed hooks through each harness. Codex marks new or changed
non-managed hooks for review; use `/hooks` to inspect and trust the exact entry.
Do not disable hook trust globally. Claude Code and Cursor provide their own
hook/configuration views.

`doctor` checks the launcher, ownership manifest, hook counts, SQLite schema,
capability data, installed harness binaries, and the exact locally verified
versions. A missing executable or owned hook is a failure. Version drift is a
warning that invalidates a compatibility claim until evidence is refreshed.

## Start with the fake canary

Leave Telegram credentials unset:

```sh
node apps/relay/dist/cli.js daemon
```

In another terminal:

```sh
node apps/relay/dist/cli.js canary
node apps/relay/dist/cli.js status
node apps/relay/dist/cli.js doctor
```

The daemon must report `fake-telegram`, and the canary must reach a durable
delivered state. The fake transport exercises the complete local
ingest/SQLite/delivery loop without an account or network provider.

Continue to [direct Telegram setup](telegram.md) only after this passes.

## Reconcile an upgrade

For a new source commit:

1. stop the daemon and supervised Agent Relay processes;
2. install dependencies through the same scripts-disabled/preflight/rebuild
   sequence;
3. run `pnpm check` and `pnpm build`;
4. run `install --dry-run` and inspect exact changes;
5. run `install` to update only owned entries and the launcher;
6. start the daemon, allowing forward SQLite migrations; and
7. run `doctor` and the fake canary before enabling a real transport.

An upgrade preserves local state, credentials, logs, fallback records, config
backups, and unrelated hooks. The install reconciliation is idempotent.

SQLite migrations are forward-only. Do not open a database with an older release
unless that release explicitly supports the current schema. A later packaging
story adds an isolated packed-artifact upgrade proof and explicit
schema-downgrade refusal; until that evidence lands, keep a backup and do not
claim arbitrary downgrade safety.

## Uninstall safely

Uninstall hooks before removing the source checkout or future package:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

The command removes only hook handlers carrying Agent Relay's ownership marker,
the owned launcher, and the manifest. It preserves user hooks, unrelated
settings, SQLite, fallback records, logs, web credentials, Telegram
configuration, and installer backups.

Package-manager removal alone does not remove installed hooks because those
hooks live in user configuration and point to the owned launcher.

## Optional erasure

Uninstall is intentionally non-destructive. To erase retained data:

1. stop Agent Relay processes;
2. complete the owned uninstall;
3. confirm the exact configured state directory;
4. remove that one directory (default `~/.agent-relay`) only after inspection;
5. inspect exact `*.agent-relay-backup-*` files next to the harness configs and
   remove only the backups you no longer need; and
6. remove the separate secret-manager entry or local activation file.

Provider data is separate. Delete Telegram messages/topics or other provider
records through that provider.

See [PRIVACY.md](../PRIVACY.md) before erasure and
[troubleshooting](troubleshooting.md) when a dry run, rollback, or doctor check
does not match the expected boundary.
