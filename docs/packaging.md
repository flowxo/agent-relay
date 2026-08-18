# Package identity and artifact boundary

Agent Relay has one current unpublished package candidate:

- **name:** `@flowxo/agent-relay`
- **version:** `0.1.0-alpha.3`
- **public surface:** the `agent-relay` executable
- **supported target:** macOS on Apple silicon, Node.js 22 or newer
- **publication state:** blocked; published alpha.2 remains immutable on npm and
  in its GitHub prerelease

The scoped name avoids the unrelated unscoped `agent-relay` package already on
npm. FXO-1568 confirms owner control of the Flow XO scope and exact package
name. Building, packing, or testing the repository still does not publish it.
`packaging/release.json` is the reviewed identity/runtime metadata used by the
staging and verification scripts. Its publication approval is false and its
registry action is `blocked`, so the staged artifact remains private; the
workspace root also stays private to prevent accidental publication. FXO-1164's
bounded alpha.2 authorization is consumed; alpha.3 or any later registry
mutation requires renewed approval and must use OIDC.

## Why one package

The TypeScript workspace keeps protocol, harness, notification-contract,
provider-adapter, core, runner-bridge, and relay composition boundaries for
development. In particular, Telegram and hosted WhooshBang are private sibling
adapter packages; neither is part of core's dependency surface. Publishing those
as separately versioned packages would expose internal APIs and workspace
coordination without helping an operator.

The release build bundles all internal runtime TypeScript into one executable
JavaScript file. Direct runtime dependencies are `better-sqlite3`, `zod`,
`ink@7.1.1`, and `react@19.2.8`. Ink runs on the product Node.js 22 floor with
no native FFI and no experimental Node flags. The published transitive closure
is listed in `THIRD_PARTY_NOTICES.md`. The packed manifest contains no
`workspace:*` links, development dependencies, lifecycle scripts, TypeScript
source, or repository-relative imports.

The experimental runner bridge CLI/status and private local-adoption peer are
bundled, but the bridge is disabled by default and the candidate contains no
native structured-harness adapter or remote service configuration. The adoption
peer opens no listener and makes no provider call. The vendored development
protocol archives and contract lock are repository test inputs, not package
contents.

This alpha is deliberately CLI-only. It has no `exports` field and therefore no
supported programmatic JavaScript API. Type declarations are not included
because there is no programmatic export to type; adding one requires a separate
API-support decision and declaration contract.

## Exact contents

`packaging/package-files.json` is the reviewed content snapshot. The current
artifact contains exactly:

```text
CHANGELOG.md
LICENSE
README.md
THIRD_PARTY_NOTICES.md
dist/cli.js
dist/web/app.js
dist/web/index.html
dist/web/state.js
dist/web/styles.css
dist/web/version.js
package.json
```

The compressed tarball budget is 2,000,000 bytes and the unpacked budget is
5,000,000 bytes. Both intentionally leave room for ordinary executable growth
while still rejecting accidental tests, source trees, caches, or workspace
packages. Any new runtime asset requires an explicit snapshot change.

The staged manifest restricts installation to macOS on Apple silicon. It accepts
native arm64 Node and x64 Node through Rosetta; this does not create an Intel
Mac support claim. Windows, Linux, and Intel macOS are not V1 end-user support
claims. Node.js 22 or newer is the metadata range; native arm64 release-exit
targets exact Node.js 22.23.1. Native release-exit is green on that target with
an isolated exact Codex CLI `0.145.0` harness, credentials omitted, hooks
denied, and one clean fake delivery. No live-provider traffic was run.

## Source-map policy

The published candidate omits source maps. The workspace compiler retains maps
for local development, but a CLI-only public artifact does not need them to run.
Omission avoids publishing source paths and private workspace structure. The
release check rejects both map files and `sourceMappingURL` references.

Stack traces still identify executable functions and line offsets in
`dist/cli.js`. A future decision to ship maps must first add a contents review,
path scan, size budget, and public source-disclosure policy.

## Reproduce and verify

From a scripts-disabled, preflighted checkout:

```sh
pnpm package:build
pnpm package:check
pnpm package:hosted:check
pnpm package:lifecycle:check
```

`package:check` executes `pnpm pack`, then:

1. compares the archive to the exact file snapshot;
2. verifies manifest identity, platform, executable, and dependencies;
3. enforces packed and unpacked size budgets;
4. scans textual content for workspace links, internal package imports, source
   paths, machine paths, activation filenames, source maps, and token shapes;
5. installs the tarball with scripts disabled into an isolated prefix;
6. explicitly rebuilds `better-sqlite3`;
7. proves `agent-relay --help`;
8. starts the packed daemon with an isolated home and fake transport;
9. proves one delivery with no retry or dead letter; and
10. proves the packaged web UI and authenticated API versions agree.

The packed runtime environment is built from an explicit allowlist and forces
`AGENT_RELAY_TRANSPORT=fake`; it never forwards ambient Telegram, webhook, or
WhooshBang credentials or selection from the invoking shell. The lifecycle proof
uses the same boundary.

The runtime portion runs on macOS; unsupported CI operating systems still prove
the content, manifest, scan, and size boundary and report the runtime skip
explicitly.

The hosted check independently packs and installs that exact artifact into a
clean temporary home/prefix with scripts disabled and no workspace or sibling
runtime dependency. On macOS it then:

1. proves the installed version and hosted CLI surface;
2. connects through the public CLI to the exact pinned loopback WhooshBang mock,
   while separately proving the generated narrow bearer matches the registered
   digest;
3. inspects private configuration/credential separation and mode-`0600` files;
4. explicitly selects WhooshBang and starts the installed daemon;
5. delivers and resolves confirm, single-select, and bounded input requests;
6. kills the daemon after local select resolution but before provider
   acknowledgement, then proves restart replays and commits exactly one
   acknowledgement/cursor;
7. proves the pinned presentation capability is reported as unsupported without
   blocking local authority;
8. revokes and erases hosted connection material while retaining SQLite answers;
9. runs the installed direct-Telegram canary against a bounded synthetic Bot
   API;
10. proves uninstall removes owned files but retains local state; and
11. scans the CLI and diagnostic output for bootstrap/narrow credentials,
    provider identities, prompts, answers, transcript sentinels, paths, and
    executable sentinels.

The command emits one safe JSON proof containing the package version and tarball
SHA-256, the immutable contract-lock SHA-256, interaction/replay results,
direct-Telegram result, retention/uninstall result, and privacy-scan result. The
tarball digest describes that invocation's exact source state and therefore
changes when packed documentation or code changes. The contract lock pins the
three WhooshBang artifacts by package version, archive SHA-256, and source
commit, each at its own exact version; mutable branches, copied contract types,
and sibling checkouts are rejected by the existing contract and package gates.
Unsupported operating systems report a runtime skip, while content and
exact-contract gates remain mandatory.

The lifecycle check derives a sanitized `0.1.0-alpha.2` prior-package fixture
from the exact current artifact, installs it with scripts disabled into one
consumer prefix, records a durable answered request, then installs
`0.1.0-alpha.3` into a sibling consumer that reuses the same retained state
directory. Sibling installs avoid a pnpm offline-upgrade limitation after native
rebuild. It requires doctor to expose the stale package/entry mismatch before
reconciliation, then proves:

- install dry runs do not mutate configuration;
- an install followed by a repeat install is idempotent;
- SQLite migrates the retained prior fixture from schema `5` to the current
  schema `12`, preserving answers and durable delivery state;
- a schema newer than `12` (the lifecycle proof uses `13`) is refused without
  modification;
- the answer, web credential, diagnostic log, explicit retained files, and
  installer backups survive;
- unrelated Codex, Claude, and Cursor configuration survives;
- uninstall removes only the owned launcher, manifest, hook entries, and
  official skill files; and
- package-manager removal happens last and leaves no owned hook.

To create a disposable tarball for manual review:

```sh
pnpm pack --out .artifacts/agent-relay-0.1.0-alpha.3.tgz
tar -tzf .artifacts/agent-relay-0.1.0-alpha.3.tgz
```

`.artifacts/` is generated and gitignored. Never put credentials, activation
files, databases, logs, or private transcripts into the staging directory. Do
not reuse this filename as retained evidence: move reviewed evidence into a
private content-addressed location keyed by its SHA-256 before packing another
same-version candidate. The [V1 release record](v1-release-boundary.md) keeps
the retained PR #39 package, PR #40 ephemeral proof, and PR #41 release-bundle
proof distinct.

For the clean-commit, two-build six-file release bundle with SHA-256 checksums,
exact package-content snapshot, curated notes, SPDX 2.3 SBOM, explicit tag
status, signed GitHub attestation boundary, OIDC gates, and rollback procedure,
follow the [prerelease guide](releasing.md). `pnpm release:evidence` verifies
that exact bundle and records a sanitized clean-home fake-transport proof.

The final native Apple-silicon/Node 22 installed-artifact proof is separate:
follow the [release-readiness evaluation](release-readiness.md) after building
the exact clean-commit bundle.

## External-harness Gate 3 evidence

The session-product repository owns an explicit cross-repository compatibility
canary. From one clean commit in each checkout it:

- rebuilds the runner artifacts twice and compares them with this repository's
  lock/vendor bytes;
- runs this repository's full check and 33-case consumer;
- runs the exact Codex contract and live canary;
- builds and verifies the local release bundle without publication; and
- writes one mode-`0600`, path-free, ignored evidence record.

The command does not tag, publish, deploy, push, enable the bridge, configure a
hosted account, or change a notification transport. Final release installation,
signed provenance, and public compatibility remain later gates.
