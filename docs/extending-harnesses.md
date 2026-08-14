# Extending harness adapters

A harness adapter converts one documented native event into the normalized Agent
Relay protocol and converts a correlated answer back into only the native
continuation mechanism the harness officially supports.

The adapter is not allowed to infer a crash, invent a session, widen execution
authority, parse a private transcript as its primary contract, or run arbitrary
shell text.

Start with the repository [contribution workflow](../CONTRIBUTING.md) and
[safe fixture guide](fixtures.md). A harness change uses the dedicated issue and
pull-request paths because native output, execution authority, resume ownership,
and support claims can each trigger explicit maintainer review.

## Source map

| Area                                     | Responsibility                                      |
| ---------------------------------------- | --------------------------------------------------- |
| `packages/harnesses/src/parsers.ts`      | Runtime-validate native payload and normalize it    |
| `packages/harnesses/src/continuation.ts` | Render bounded native inline continuation JSON      |
| `packages/harnesses/src/resume.ts`       | Build exact late-resume executable + argv           |
| `packages/harnesses/src/capabilities.ts` | Classify evidence-backed surfaces and capabilities  |
| `packages/harnesses/fixtures/<harness>/` | Sanitized native payload fixtures and provenance    |
| `apps/relay/src/installer.ts`            | Merge owned hooks and install official skills       |
| `packages/protocol/src/skill.ts`         | Canonical skill behavior and compatibility contract |
| `apps/relay/src/agent-skills.ts`         | Deterministic vendor rendering and evaluation       |
| `apps/relay/src/hook-runner.ts`          | Bounded stdin, daemon/fallback, stdout discipline   |
| `apps/relay/src/supervisor.ts`           | Owned child exit and late-resume lifecycle          |

Protocol types live in `packages/protocol`. Do not bypass their runtime schemas.

## Add or change a native event

1. Locate the current primary harness documentation.
2. Observe exact installed `--version` and relevant `--help` output without
   invoking a model when possible.
3. Capture only the minimum payload shape needed to establish the contract.
4. Replace identifiers, user/host names, repository/working paths, prompts,
   messages, commands, and transcripts with obvious synthetic values.
5. Record source URL, observation date, harness version, surface, and whether
   the fixture is official-example-derived, local-help-observed, fake-proven, or
   live-proven.
6. Define a strict-enough Zod schema and normalize through
   `AgentAttentionEventV1Schema`.
7. Return a bounded diagnostic and safe native no-op for malformed, unknown, or
   unsupported input.

Never commit a raw private payload first and “sanitize it later.” Construct the
reviewable sanitized fixture outside git and inspect it before adding it.

Do not store or forward `transcript_path`, absolute `cwd`, tool input, or
process arguments. The project reference keeps a sanitized display name and
one-way working-directory hash; summaries and questions are bounded.

If a harness supplies structured evidence that work remains active when its main
Stop hook fires, normalize only the minimum provider-neutral evidence. Claude
Code's `background_tasks` and `session_crons` currently become bounded counts;
task IDs, types, status strings, descriptions, commands, agent names,
server/tool names, workflow names, schedules, and prompts are discarded. Never
replace a missing structured field with transcript or model-text inference.

## Declare capabilities narrowly

Each runtime-validated harness + surface entry classifies deterministic Stop,
inline continuation, permission decision, late resume, active steer, failure
signal, and process-exit observation separately. Exact verified CLI versions,
known-incompatible versions, safe evidence IDs, fixture paths, and evidence
records live in that same registry so doctor and public claims cannot diverge.

Official documentation alone can establish a contract shape, but a public
`verified` claim needs the evidence ladder in
[compatibility.md](compatibility.md). An unsupported or disabled capability must
remain explicit.

`unsupported` and `disabled` both become false protocol flags. Native hooks
always declare no process-exit proof. Only the owning supervisor can add
validated `owned-child` evidence.

Run `pnpm capabilities:generate` after a reviewed evidence change. It updates
`docs/capability-matrix.md` plus the bounded README and SUPPORT summaries.
`pnpm capabilities:check` validates those generated sections, fixture paths, and
evidence anchors and fails on drift.

## Inline continuation

Return only the harness's documented stdout JSON. Current examples are:

- Codex and Claude Stop: `decision: "block"` with a bounded `reason`;
- Cursor Stop: bounded `followup_message`; and
- safe failure: an empty object.

Respect the harness recursion field so one remote answer cannot create an
unbounded Stop loop. Expired or ambiguous answers remain native prompts.

Permission output has a different schema from Stop output. Do not reuse a
generic “approve” object across harnesses or events.

## Late resume and execution authority

Late resume is valid only for a supported CLI surface with an owned supervisor.
Construct a `ResumeInvocation` containing an executable and discrete argv. The
operator answer is one argv value and is never evaluated by a shell.

Derive authority from the initial invocation once. Preserve an explicit initial
sandbox/permission/trust choice, and use the least-authority documented default
when it was absent. Never add a dangerous bypass, trust flag, or writable
sandbox because resume is non-interactive.

Structured surfaces such as Codex App Server or the Claude SDK require their
structured API. Do not pretend their continuation can be safely mapped to a CLI
argv.

## Installer changes

User-level hook edits must carry the ownership marker, preserve unrelated
configuration, preflight all targets, back up existing files privately, write
atomically, and roll back partial failure. Add uninstall and idempotent upgrade
coverage.

Do not enable an event by default until its sanitized live shape and safe native
failure behavior are proven.

## Minimum tests and evidence

- valid Stop/question/failure payload;
- malformed JSON, missing/extra/unknown event, and oversized stdin;
- deterministic stable event identity and duplicate ingestion;
- safe no-op output and no stdout diagnostics;
- exact native inline continuation output and recursion prevention;
- stale answer, timeout, terminal race, and concurrent-session isolation;
- exact late-resume argv without shell interpolation;
- fail-closed authority derivation and no widening;
- owned exit status/signal/spawn failure when supervision changes;
- fallback-spool redaction and daemon outage recovery;
- install/reinstall/upgrade/uninstall ownership; and
- generated capability and evidence documentation.

Run the full repository checks and a fake transport canary. A new `verified`
claim also needs a bounded live canary on the exact surface/version, with no
private value retained.

For a normal adapter change, the minimum local command sequence is:

```sh
pnpm fixtures:check
pnpm exec vitest run packages/harnesses
pnpm capabilities:check
pnpm check:pr
```

Run `pnpm capabilities:generate` first when the reviewed compatibility registry
changed. Operator-facing behavior also requires `pnpm test:e2e`. These checks
need no hosted credential; substitute sanitized fixtures and the fake transport
for private accounts.

## Primary sources currently used

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using)
