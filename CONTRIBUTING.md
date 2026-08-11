# Contributing to Agent Relay

Agent Relay accepts bounded changes that preserve its local authority, privacy,
and harness contracts. A contribution should be understandable and testable
without a Telegram token, hosted account, private transcript, or access to the
original implementation environment.

Please read the [code of conduct](CODE_OF_CONDUCT.md), the
[maintainer policy](MAINTAINERS.md), and the [security policy](SECURITY.md)
before contributing. Report a vulnerability privately; do not open a public
issue or pull request for it.

## Development setup

The supported contributor baseline is Node.js 22 or newer and pnpm 11.17.0. The
repository records Node 22 in `.node-version` and pins pnpm through the root
`packageManager` field.

Start from a clean checkout:

```sh
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:preinstall
pnpm rebuild
```

The scripts-disabled install verifies the pinned WhooshBang artifacts before the
explicitly approved native rebuild. Do not replace this sequence with an
unreviewed lifecycle-script install.

No hosted credential is needed. Keep local activation files under ignored
`.env*` names, never commit them, and use the fake transport for normal
development.

## Run focused checks while developing

Run the smallest relevant tests first. Examples:

```sh
pnpm exec vitest run packages/protocol
pnpm exec vitest run packages/harnesses
pnpm exec vitest run packages/core
pnpm --filter @agent-relay/relay typecheck
pnpm capabilities:check
pnpm fixtures:check
pnpm contracts:whooshbang
```

Use a specific test file when possible:

```sh
pnpm exec vitest run packages/core/test/daemon.test.ts
```

Before requesting review, run the same credential-free gate as CI:

```sh
pnpm check
```

For a changed operator-facing web flow, install the repository-pinned Chromium
once and run the packaged browser proof:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

For package, installer, migration, or release-boundary changes, also run the
artifact checks explicitly so their evidence is easy to review:

```sh
pnpm package:check
pnpm package:lifecycle:check
pnpm release:policy:check
pnpm audit --prod
```

These commands publish nothing and require no npm, Telegram, GitHub, or hosted
service credential. `pnpm release:bundle` additionally requires a clean checkout
and produces a local six-file bundle without publishing it. From that exact
clean commit, `pnpm release:evidence` verifies the bundle and writes a sanitized
clean-home fake-transport proof. Follow the
[prerelease guide](docs/releasing.md).

## Architecture boundaries

The [architecture guide](docs/architecture.md) is the primary system boundary.
Keep these ownership rules intact:

- runtime-validated protocol contracts live in `packages/protocol`;
- native payload parsing, capability evidence, continuation output, and resume
  invocation construction live in `packages/harnesses`;
- provider-neutral delivery, receipt, interaction, capability, and transport
  failure contracts live in `packages/notification-contracts`;
- SQLite in `packages/core` is authoritative for events, requests, answers,
  retries, and resume claims;
- provider-neutral presentation code lives under `packages/core/src/whooshbang`,
  while concrete providers live in sibling adapter packages such as
  `packages/telegram-transport` and `packages/whooshbang-transport`;
- transports deliver bounded presentations and submit candidate answers; core
  never imports a concrete provider, and providers do not decide request state
  or execute commands;
- `apps/relay` is the composition root that selects and assembles concrete
  transports;
- only a supervisor that owns a child process can prove its exit;
- native hooks do not prove crashes and must fail with bounded diagnostics plus
  safe native output;
- operator text is data and must never be shell-interpreted; and
- optional hosted transports must remain replaceable and unnecessary for local
  operation.

Read [extending notification transports](docs/extending-transports.md) or
[extending harness adapters](docs/extending-harnesses.md) before changing those
surfaces.

## Fixtures and compatibility evidence

Follow the [safe fixture guide](docs/fixtures.md). In particular:

- construct synthetic, sanitized evidence outside git instead of committing a
  raw payload and cleaning it later;
- record source, exact version, observation date, evidence class, and
  sanitization in the nearest manifest;
- keep every JSON fixture at or below 64 KiB and update the exact manifest
  inventory;
- use obvious synthetic identifiers, content, and `/workspace/...` paths; and
- never include a credential, private transcript, database, raw log, account
  identifier, username, hostname, repository identity, or machine-specific path.

Run `pnpm fixtures:check`. A parser test alone does not justify a public
`verified` compatibility claim; follow the evidence ladder in
[compatibility.md](docs/compatibility.md) and regenerate derived material with
`pnpm capabilities:generate`.

## Change-specific review gates

Explicit maintainer review with security impact considered is required for:

- protocol schemas or hook continuation output;
- execution authority, sandbox, trust, resume ownership, or session correlation;
- installer paths, config merging, rollback, uninstall ownership, or launcher
  behavior;
- redaction, web authentication, CSRF, SQLite migrations, or retention;
- transport authentication, default outbound data, or callback validation;
- supported capability, operating-system, harness-version, or runtime claims;
  and
- package contents, dependencies, provenance, or release workflows.

Call out every applicable gate in the pull request. Actual vulnerabilities use
the private security-advisory path in [SECURITY.md](SECURITY.md), not the
security-sensitive design issue form.

## Pull requests

Keep each change coherent and tie it to its owning issue. A reviewable pull
request:

1. explains the user-visible outcome and the boundary it preserves;
2. includes deterministic tests for relevant duplicates, retries, malformed
   input, timeouts, stale answers, and concurrent-session isolation;
3. updates public docs, `CHANGELOG.md`, generated evidence, and
   `docs/progress.md` when their claims change;
4. records the focused and full checks actually run;
5. calls out assumptions, skipped evidence, and residual risk; and
6. contains no private or machine-specific data.

Use conventional, imperative commit subjects and include the Linear issue when
one exists, for example:

```text
feat: add bounded provider retry mapping (FXO-1234)
```

Do not mix unrelated formatting or refactors into a behavioral slice. Do not
claim a check, canary, compatibility version, or review that did not occur.
