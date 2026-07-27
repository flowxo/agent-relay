# AR1.5: Generated compatibility and support evidence

- **Linear:** FXO-1146
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

One runtime-validated `agent-relay-compatibility.v1` registry now owns the
evidence-backed support claim for every Codex, Claude Code, and Cursor surface.
It defines `verified`, `compatible-unverified`, `unsupported`, and `disabled`;
records exact verified CLI versions and safe evidence IDs; classifies each
capability independently; and links verified rows to sanitized fixtures and the
bounded live-canary record.

Runtime protocol flags, `agent-relay capabilities`, doctor version expectations,
`docs/capability-matrix.md`, and the concise README/SUPPORT tables all derive
from that registry. The generation check also proves that every linked fixture
file and evidence heading exists.

## Fail-closed behavior

Only `verified` and `compatible-unverified` capabilities become true protocol
flags. `unsupported` and `disabled` become false. This corrects Cursor
permission decisions to false on both CLI and IDE surfaces while the installer
intentionally omits Cursor permission automation.

Doctor classifies:

- an exact verified version as `pass`;
- another available version as a `compatible-unverified` warning;
- a version explicitly listed as contract-incompatible as `fail`; and
- an unavailable binary as `fail`.

Each harness check carries the exact verified version and an evidence ID. A
non-model local observation proved the drift path: Codex `0.145.0` and Cursor
`2026.07.23-e383d2b` matched their verified records, while installed Claude Code
`2.1.220` warned against the last live-proven `2.1.219` record. No model call
was made and the verified claim was not silently advanced.

## Public support and reporting

The generated artifact explicitly avoids Windows, Linux end-user runtime, Intel
macOS, Cursor IDE late resume, native-hook crash proof, and Cursor permission
automation claims. It records macOS arm64 and Node.js 22 as the validation
target while leaving the clean-machine minimum-runtime package proof to the AR1
exit gate.

The public bug form and SUPPORT policy now request only:

- Agent Relay version or commit;
- OS, architecture, and Node version;
- exact harness version and surface;
- manually redacted doctor classifications and evidence IDs;
- the transcript-free capability record;
- bounded diagnostic IDs; and
- a synthetic reproduction.

They explicitly reject databases, raw logs, configs, transcripts, credentials,
identifiers, and machine-specific paths.

## Evidence

- Current official Codex, Claude Code/Agent SDK, and Cursor sources were
  rechecked on 2026-07-26.
- `pnpm capabilities:check` proves the matrix, both public summaries, fixture
  paths, and evidence anchors agree with the registry.
- Focused harness/doctor regressions prove exact, drifted, known-incompatible,
  missing, disabled, and safe-record behavior.
- The packed executable emits the versioned compatibility record, including six
  classified surfaces and disabled Cursor permission decisions.
- The final gate passes 41 Vitest files/311 tests, 17 contract and supply-chain
  tests, the six-test isolated Notifications consumer, the 104,988-byte
  packed/491,088-byte unpacked artifact proof, the full packed lifecycle, all
  three Chromium scenarios, and `pnpm audit --prod` with no known vulnerability.
  No credential or model call is required.

## Open boundary

There are no invented incompatible-version entries: the fail path is implemented
and tested with a synthetic record, while the curated production list remains
empty until evidence proves a real incompatibility. Exact harness versions are
snapshots, not ranges. FXO-1149 still owns the isolated clean-machine Node.js 22
release proof.
