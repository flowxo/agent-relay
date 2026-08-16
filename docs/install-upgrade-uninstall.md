# Install, upgrade, uninstall, and erase

> **Current distribution:** public npm prerelease
> `@flowxo/agent-relay@0.1.0-alpha.2`
>
> **Verified target:** macOS on Apple silicon, Node.js 22, pnpm 11

The vendor-native lifecycle writes only Agent Relay-owned plugin trees and
launcher metadata. The legacy direct-hook lifecycle changes user-level harness
configuration. Always inspect the relevant dry run before installation or
upgrade.

## Prepare a source build safely

From a clean checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
pnpm check:pr
pnpm build
```

The first install is scripts-disabled. The contract preflight verifies the exact
vendored WhooshBang archives before the approved SQLite native build runs. No
Telegram credential is needed.

For a contributor who wants to use a coherent feature branch in real local
coding sessions before it is a release candidate, use:

```sh
pnpm dogfood:deploy
pnpm dogfood:status
```

This lightweight path runs `check:fast`, retains the built CLI, reconciles the
owned launcher, preserves the existing Agent Relay home/session/configuration,
and restarts the separately configured `com.flowxo.agent-relay.dogfood` service
when present. Otherwise it reports `not-installed`; restart a foreground daemon
normally. It does not run the release suite or create formal evidence.
`pnpm dogfood:rollback` restores the previous retained build. See
[the two dogfood modes](sdlc.md#two-dogfood-modes).

Do not install the unrelated unscoped `agent-relay` package from npm. For the
public prerelease, use an exact version and keep dependency lifecycle scripts
disabled until explicitly rebuilding the reviewed SQLite native dependency:

```sh
mkdir agent-relay-alpha && cd agent-relay-alpha
npm init -y
npm install --save-exact --ignore-scripts @flowxo/agent-relay@0.1.0-alpha.2
npm rebuild better-sqlite3
./node_modules/.bin/agent-relay --version
./node_modules/.bin/agent-relay capabilities
```

The source-build procedure above remains a contributor path and performs no
registry mutation.

## Build and inspect the local package candidate

The PR classifier selects an isolated package proof for package, installer, or
persistence changes. Run it directly when inspecting that boundary:

```sh
pnpm package:check
pnpm package:lifecycle:check
```

To retain the exact candidate tarball locally:

```sh
pnpm pack --out .artifacts/agent-relay-0.1.0-alpha.3.tgz
tar -tzf .artifacts/agent-relay-0.1.0-alpha.3.tgz
```

Packing runs only the repository's deterministic staging build. It does not
publish or change harness configuration. The alpha.3 staged manifest remains
private and publication is blocked. The bounded FXO-1164 alpha.2 authorization
is consumed and does not authorize publishing this or any other version.

The automated proof installs the tarball with dependency lifecycle scripts
disabled, explicitly rebuilds the reviewed SQLite native dependency, and runs
CLI help, the fake delivery canary, and web asset/API checks from an isolated
home and prefix. See [the packaging boundary](packaging.md) for the exact
allowlist and budgets.

For a retained local installation from that exact tarball:

```sh
mkdir -p .artifacts/local-install
pnpm --dir .artifacts/local-install add \
  --ignore-scripts \
  "$PWD/.artifacts/agent-relay-0.1.0-alpha.3.tgz"
pnpm --dir .artifacts/local-install rebuild better-sqlite3
.artifacts/local-install/node_modules/.bin/agent-relay --version
```

Keep that prefix in place while hooks are installed because the owned launcher
targets its exact package entry. Prefer the exact public-registry installation
above unless evaluating a source change.

## Open the installed local dashboard

After starting the loopback daemon, use the installed canonical command:

```sh
agent-relay dashboard --web
```

The command verifies daemon and protected-app readiness before it creates a
60-second, single-use exact-loopback browser grant. Refresh/reopen uses a
host-bound browser session for 30 minutes idle and at most eight hours; session
loss, expiry, or daemon restart requires the command again. Direct `/ui/` access
shows the same recovery command above a collapsed **Advanced recovery** manual
credential form. See the [web companion guide](web-companion.md) for failure
remediation and the unsupported tunnel/public-listener boundary.

Install, repeat install, upgrade, vendor-integration repair/disable/rollback,
and owned uninstall must not rewrite the canonical launcher behavior or inject
credentials into vendor artifacts. The Codex, Claude Code, and Cursor dashboard
entry points delegate to `agent-relay dashboard --web`. Existing local web
credentials, browser-independent state, unrelated plugins, MCP servers, hooks,
commands, skills, settings, formatting, backups, logs, and user data remain
under their existing ownership/preservation rules. Browser grants and sessions
are daemon-memory-only and deliberately do not survive a daemon restart or
package lifecycle operation that restarts it.

## Install the vendor-native integrations

The recommended AR5 path composes native plugin or local-integration bundles
without editing vendor settings:

```sh
node apps/relay/dist/cli.js integrations install --dry-run
node apps/relay/dist/cli.js integrations install
node apps/relay/dist/cli.js doctor
```

Follow the [vendor-native integration guide](vendor-integrations.md) for Codex
and Claude Code local-marketplace activation, trust, updates, conflicts,
disable, rollback, and uninstall. Cursor is not offered. Do not run this path
alongside the legacy direct-hook installation: preflight reports duplicate Agent
Relay hooks, MCP servers, or skills rather than creating ambiguous ownership.

## Legacy direct-hook installation

The original direct-hook lifecycle remains supported for an installation that
has not migrated yet:

```sh
node apps/relay/dist/cli.js install --dry-run
node apps/relay/dist/cli.js install
node apps/relay/dist/cli.js doctor
```

The installer preflights every target before writing. It creates private
timestamped backups, writes atomically, and rolls back earlier writes if a later
write fails.

The owned paths are:

| Path                                    | Purpose                                      |
| --------------------------------------- | -------------------------------------------- |
| `~/.agent-relay/bin/agent-relay`        | Exact Node.js/CLI launcher                   |
| `~/.agent-relay/install.json`           | Ownership and installed-version manifest     |
| `~/.codex/hooks.json`                   | Owned Codex Stop/permission entries          |
| `~/.claude/settings.json`               | Owned Claude Stop/failure/permission entries |
| `~/.cursor/hooks.json`                  | Owned Cursor Stop entry                      |
| `~/.agents/skills/agent-relay/SKILL.md` | Official Codex skill                         |
| `~/.claude/skills/agent-relay/SKILL.md` | Official Claude Code skill                   |
| `~/.cursor/skills/agent-relay/SKILL.md` | Official Cursor skill                        |

Existing hooks, skills, instruction files, MCP servers, and unrelated settings
are preserved. A non-owned file at one official skill target is a preflight
conflict rather than something the installer overwrites. A Cursor permission
entry is intentionally not installed until a current sanitized live payload
exists.

Review newly installed hooks through each harness. Codex marks new or changed
non-managed hooks for review; use `/hooks` to inspect and trust the exact entry.
Do not disable hook trust globally. Claude Code and Cursor provide their own
hook/configuration views.

`doctor` checks the launcher, ownership manifest, official skill presence,
contract/MCP compatibility and deterministic drift, hook counts, SQLite schema,
installed harness binaries, exact verified versions, and the
`agent-relay-compatibility.v1` registry. A missing executable or owned hook is a
failure. An available version mismatch is a `compatible-unverified` warning; a
version explicitly recorded as incompatible is a failure. Skill findings name
only the check and repair action; they never print artifact contents, prompts,
identifiers, or secrets. Harness checks include safe evidence IDs.

The behavior and compatibility boundary is documented in the
[official Agent Relay skill guide](agent-relay-skills.md). The installer does
not install into Cursor. A leftover owned Cursor `agent-relay` user MCP server
is removed; unrelated MCP server configuration is not mutated.

Inspect the transcript-free source record directly:

```sh
agent-relay capabilities
```

## Start with the fake canary

Use an explicit fake override so a retained durable transport choice cannot
contact a configured provider:

```sh
node apps/relay/dist/cli.js daemon --transport fake --no-web
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

For a new source commit or local packed candidate:

1. stop the daemon and supervised Agent Relay processes;
2. install the new artifact through the same scripts-disabled/explicit-rebuild
   sequence;
3. run `agent-relay doctor` and confirm that any package/runtime/manifest
   mismatch is the expected pre-reconciliation state;
4. run `install --dry-run` and inspect exact changes;
5. run `install` to update only owned entries, the launcher, and official
   skills;
6. run `install` again and require an unchanged result;
7. start the daemon, allowing forward SQLite migrations; and
8. run `doctor` and the fake canary before enabling a real transport.

An upgrade preserves local state, credentials, logs, fallback records, config
backups, unrelated hooks, other skills, MCP servers, and harness instructions.
The install reconciliation is idempotent and repairs deterministic drift only
where the Agent Relay ownership marker remains present.

SQLite migrations are forward-only. The current schema is version `12`. Earlier
migrations include the unversioned alpha fixture, version `5` native-hook
sequence counters, version `7` WhooshBang naming, version `8` durable
topic-title state, version `9` content-free lifetime counters, and version `10`
the privacy-bounded durable shared activity model. Version `11` adds keyed,
digest-only exact MCP binding records. Version `12` adds keyed opaque project
identities, bounded project-read invalidations, and the terminal-history query
indexes. Stop the daemon and supervised processes before crossing a schema
boundary, and keep a private database backup. Native hooks and the daemon
intentionally share the same `relay.sqlite` so allocation commits are ordered
across processes. If a database advertises a newer schema than the running
package supports, Agent Relay refuses to open it and doctor reports
`refusing unsafe downgrade`; use the newer package or restore a database backup
instead of forcing the older binary. Arbitrary downgrade safety is not claimed.

## Roll back a candidate

Do not move or reuse a tag or semantic version. For a normal bad prerelease,
stop the daemon and supervised processes, explicitly select `fake`, preserve the
diagnostic IDs and a private database backup, and prefer a fixed forward
version. Deprecate the affected registry version and mark its GitHub prerelease
only after those owner-authorized artifacts exist; do not normally delete or
unpublish it.

Use an older binary only when its documented maximum SQLite schema includes the
current database schema. Otherwise restore a reviewed private backup made before
the migration. Never edit SQLite `user_version` to force a downgrade. After
installing the selected artifact, repeat `doctor`, `install --dry-run`, owned
install reconciliation, an unchanged second install, and the fake canary before
choosing a network transport.

If compromise is suspected, do not use the public issue tracker. Stop promotion,
preserve the artifact and provenance evidence, and follow the private process in
[SECURITY.md](../SECURITY.md). Maintainers then revoke or replace affected
trust, deprecate the version, and issue a new version with corrected provenance.

Runner-protocol vendor updates are source changes, not a substitute for this
installed-package reconciliation. Check a producer candidate with
`pnpm contracts:runner:update -- --artifacts <absolute-directory>` and use
explicit `--apply` only on a review branch. The updater never edits installed
state, hooks, credentials, notification configuration, or either SQLite
database.

Reverting a vendor/lock update does not establish runtime downgrade safety. If
the newer package wrote a later bridge or core schema, retain that package or
restore a reviewed backup; do not edit `user_version`. A product-managed
adoption also remains product-managed until a future explicit reverse-transfer
policy exists.

## Uninstall safely

Uninstall hooks before removing the source checkout, local prefix, or future
registry package:

```sh
node apps/relay/dist/cli.js uninstall --dry-run
node apps/relay/dist/cli.js uninstall
```

The command removes only hook handlers carrying Agent Relay's ownership marker,
the three marked Agent Relay skill files, the owned launcher, and the manifest.
It preserves user hooks, unrelated skills and instruction files, MCP servers,
settings, SQLite, fallback records, logs, web credentials, Telegram
configuration, WhooshBang configuration/narrow credentials, and installer
backups.

Package-manager removal alone does not remove installed hooks because those
hooks live in user configuration and point to the owned launcher.

For the retained local prefix above, remove the package only after the
successful owned uninstall:

```sh
pnpm --dir .artifacts/local-install remove @flowxo/agent-relay
```

## Optional erasure

Uninstall is intentionally non-destructive. To erase retained data:

1. stop Agent Relay processes;
2. complete the owned uninstall;
3. confirm the exact configured state directory;
4. remove that one directory (default `~/.agent-relay`) only after inspection;
5. inspect exact `*.agent-relay-backup-*` files next to the harness configs and
   remove only the backups you no longer need; and
6. remove the separate secret-manager entry or local activation file.

Provider data is separate. Revoke a hosted WhooshBang machine client before
local erasure:

```sh
credential_command | node apps/relay/dist/cli.js whooshbang disconnect \
  --revoke \
  --erase-credential \
  --erase-configuration \
  --credential-stdin
```

The project credential is bootstrap/revocation-only and is not retained. Delete
Telegram messages/topics or other provider records through that provider.

See [PRIVACY.md](../PRIVACY.md) before erasure and
[troubleshooting](troubleshooting.md) when a dry run, rollback, or doctor check
does not match the expected boundary.
