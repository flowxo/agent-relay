# Compatibility and evidence policy

Agent Relay treats compatibility as an evidence claim, not a permissive
semantic-version range. The runtime-validated `agent-relay-compatibility.v1`
registry in `packages/harnesses/src/capabilities.ts` is the single source for
exact CLI versions, surface and capability classifications, evidence IDs,
runtime flags, doctor expectations, and generated public summaries.

## Classifications

The generated [compatibility matrix](capability-matrix.md) defines and displays
all four allowed classifications:

- `verified`;
- `compatible-unverified`;
- `unsupported`; and
- `disabled`.

A single surface can have different classifications by capability. For example,
Cursor IDE Stop parsing can be compatible while late CLI resume is unsupported
and permission automation is disabled.

The matrix is generated from the same registry used to emit protocol capability
booleans. `verified` and `compatible-unverified` capabilities may be enabled;
`unsupported` and `disabled` capabilities are always emitted as `false` and fail
closed. The linked [harness evidence ledger](harness-evidence.md) retains the
longer provenance and canary narrative, but it is not a second support table.

## Current verified user path

The exact versions and limitations are generated in the
[compatibility matrix](capability-matrix.md) and repeated in drift-checked
README/SUPPORT summaries. They are evidence snapshots, not maximum or minimum
harness-version promises.

Run `agent-relay doctor`. An exact registry match is `verified`; any other
available version is `compatible-unverified` and produces a warning unless the
registry records that exact version as incompatible, in which case doctor fails.
A missing binary also fails. Each check returns a safe evidence ID so a report
can identify the claim without including a transcript or machine path.
`agent-relay capabilities` prints the same safe classified record.

## Platform and runtime support

The current release-readiness target is macOS on Apple silicon with Node.js 22.
pnpm 11 is used for source development. Linux CI proves that repository checks
can run in that CI environment; it does not establish Linux end-user harness
operation. Node.js 24 CI does not replace the native Node.js 22 release target.
The isolated Node.js 22.23.1 package/install/doctor/fake-canary/uninstall proof
is complete on that target; exact harness support remains tied to the separate
versioned evidence records.

There is no current Windows, Linux runtime, Intel macOS, native app,
auto-service, Safari, or Firefox support claim.

## Evidence ladder

Strongest evidence combines:

1. current official harness documentation;
2. locally installed `--version` and relevant `--help` behavior;
3. a sanitized fixture with recorded provenance;
4. parser, malformed-input, continuation, and isolation tests;
5. a fake-transport end-to-end proof; and
6. a bounded credentialed or model-backed canary when the boundary requires it.

The repository labels evidence rather than blending it:

- `official-docs`: documented contract only;
- `official-docs+local-help`: documented contract plus non-model local CLI
  observation;
- fixture-proven: deterministic behavior using sanitized payloads;
- fake-canary-proven: complete local loop without external credentials; and
- live-canary-proven: exact dated version/account boundary, with private values
  omitted.

A live result for one version does not validate a future version. A fixture
proves our behavior for that input, not the provider's production availability.

## Changing a compatibility claim

A contribution that changes parsing, continuation output, resume argv, install
defaults, or capability claims must:

1. link the current primary source;
2. record exact observed local version/help behavior;
3. add or update a sanitized fixture and provenance;
4. cover success, malformed/unknown input, and safe fallback;
5. update the runtime-validated compatibility registry;
6. run `pnpm capabilities:generate` and inspect the matrix plus both public
   summaries;
7. run the full repository and relevant canary checks; and
8. update the evidence ledger and changelog.

Never commit a real transcript, token, user identity, hostname, repository path,
or raw working path as evidence. CI fails if the generated matrix, README
summary, or SUPPORT summary differs from the registry, or if a linked fixture or
evidence heading is missing.

## Primary harness sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using)
