# Compatibility and evidence policy

Agent Relay treats compatibility as an evidence claim, not a permissive
semantic-version range.

## Classifications

| Classification          | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `verified`              | Exact surface/version has current fixture plus bounded canary evidence    |
| `compatible-unverified` | Contract parses or local help agrees, but no complete compatibility claim |
| `unsupported`           | Required binary, surface, or capability is absent or known incompatible   |
| `disabled`              | Code understands a contract, but the capability is intentionally off      |

A single surface can have different classifications by capability. For example,
Cursor IDE Stop parsing can be compatible while late CLI resume is unsupported
and permission automation is disabled.

The [generated capability matrix](capability-matrix.md) is authoritative for the
protocol capabilities declared by code. A `Yes` means the adapter knows a
documented contract; it does not by itself mean the exact installed harness is
verified or that the installer enables the capability.

The [harness evidence ledger](harness-evidence.md) records exact versions,
official sources, local help observations, sanitized fixtures, and live
canaries. `doctor` compares installed binaries and hooks with that evidence.

## Current verified user path

Recorded on macOS arm64 with Node.js 22:

| Harness/surface | Exact verified version  | Proven path and limitation                                  |
| --------------- | ----------------------- | ----------------------------------------------------------- |
| Codex CLI       | `codex-cli 0.145.0`     | Stop, Telegram correlation, read-only late resume           |
| Claude Code CLI | `2.1.219 (Claude Code)` | Stop, owned crash, Telegram correlation, `plan` late resume |
| Cursor CLI      | `2026.07.23-e383d2b`    | Interactive Stop, Telegram correlation, trusted late resume |

These are evidence snapshots, not maximum/minimum version promises. Run
`doctor`; drift is a warning and the new version is `compatible-unverified`
until its official contract/local behavior is rechecked and sanitized evidence
is refreshed.

Other declared surfaces have narrower status:

- Codex App Server and Claude SDK capabilities come from official contracts and
  are not wired as the current installed user path.
- Cursor IDE late resume is `unsupported`.
- Cursor permission automation is `disabled` until a current sanitized live
  payload is captured.
- Cursor CLI `--print` did not emit the initial Stop on the verified build; the
  supported supervised initial leg is interactive.
- Native hooks for every harness have no process-exit proof.

## Platform and runtime support

The current release-readiness target is macOS on Apple silicon with Node.js 22.
pnpm 11 is used for source development. Linux CI proves that repository checks
can run in that CI environment; it does not establish Linux end-user harness
operation. Node.js 24 CI likewise does not replace the Node.js 22 clean-machine
release target.

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
5. update `HARNESS_CAPABILITIES`;
6. regenerate the capability matrix;
7. run the full repository and relevant canary checks; and
8. update the evidence ledger and changelog.

Never commit a real transcript, token, user identity, hostname, repository path,
or raw working path as evidence.

FXO-1146 will make these classifications and the supported-version summary a
single generated artifact with a drift check. Until that slice lands, the code
matrix plus evidence ledger are the two required sources and this document is
the public interpretation layer.

## Primary harness sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using)
