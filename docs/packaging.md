# Package identity and artifact boundary

Agent Relay has one end-user package candidate:

- **name:** `@flowxo/agent-relay`
- **version:** `0.1.0-alpha.0`
- **public surface:** the `agent-relay` executable
- **supported target:** macOS on Apple silicon, Node.js 22 or newer
- **publication state:** private and unpublished

The scoped name avoids the unrelated unscoped `agent-relay` package already on
npm. Control of the Flow XO npm scope remains an explicit owner gate before any
publication. Building, packing, or testing this candidate does not publish it.

## Why one package

The TypeScript workspace keeps protocol, harness, core, and relay boundaries for
development. Publishing those as separately versioned packages would expose
internal APIs and workspace coordination without helping an operator.

The release build bundles all internal runtime TypeScript into one executable
JavaScript file. Only `better-sqlite3` and `zod` remain runtime dependencies.
The packed manifest contains no `workspace:*` links, development dependencies,
lifecycle scripts, TypeScript source, or repository-relative imports.

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

The staged manifest restricts installation to macOS. It accepts arm64 Node and
x64 Node because an Apple-silicon Mac may run the x64 Node executable through
Rosetta. That metadata does not create an Intel Mac support claim; physical
Apple-silicon hardware remains the tested boundary.

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

The runtime portion runs on macOS; unsupported CI operating systems still prove
the content, manifest, scan, and size boundary and report the runtime skip
explicitly.

To retain a tarball for manual review:

```sh
pnpm pack --out .artifacts/agent-relay-0.1.0-alpha.0.tgz
tar -tzf .artifacts/agent-relay-0.1.0-alpha.0.tgz
```

`.artifacts/` is generated and gitignored. Never put credentials, activation
files, databases, logs, or private transcripts into the staging directory.
