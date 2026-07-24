# Codex Handoff Prompt

You are taking ownership of the greenfield `agent-relay` repository. Work as
autonomously as possible; I do not want to babysit this session.

Start by reading these files in full:

1. `docs/agent-attention-control-plane-design.md`
2. `docs/implementation-brief.md`
3. The repository `README.md` and any applicable agent instructions

The product goal is a dependable attention and control layer for concurrent
Codex, Claude Code, and Cursor sessions. It should notice deterministic stop and
question events, report crashes when supervision can prove them, route events to
Telegram, correlate human replies to the correct session, and continue the agent
where the harness officially supports it.

Begin implementing now. Do not stop after producing another plan. Execute
Milestone 0 from the implementation brief, then continue directly into Milestone
1 while the work remains locally testable. If time and evidence allow, continue
into Milestone 2.

Operating mandate:

- Make routine architecture and dependency decisions yourself.
- Use current official harness documentation and locally installed tool behavior
  as the source of truth. Record versions and preserve sanitized fixtures for
  observed payloads.
- Prefer a small TypeScript workspace, runtime-validated protocol contracts, a
  local daemon, SQLite durable spool, and transport interfaces. You may adjust
  the exact structure when testing provides a concrete reason.
- Build the complete loop against a fake Telegram transport before requiring a
  real bot token.
- Never silently swallow hook or delivery failures. Make diagnosis a first-class
  behavior.
- Write tests as you build, including duplicates, retries, malformed payloads,
  timeouts, stale answers, and concurrent-session isolation.
- Keep private transcripts, credentials, and machine-specific paths out of git.
- Maintain `docs/progress.md` as a compact ledger of completed work, evidence,
  open risks, and the next action. Clearly distinguish proven behavior from
  assumptions.
- Run all available checks and keep iterating until the current milestone is
  green. When blocked by an external credential, substitute a fake and proceed.
- Create a `codex/initial-mvp` branch, make coherent local commits as slices
  turn green, push the branch, and open a draft PR when there is a reviewable
  milestone. This is authorized.

Do not ask me to choose names, folder layouts, libraries, formatting tools, or
other reversible implementation details. Ask only when you need an unavailable
credential/account action, face a genuinely architecture-changing product
decision, would incur cost or deploy to production, or have exhausted reasonable
ways around a hard external blocker.

Before asking, document what you tried, the evidence, your recommended choice,
and what work you can continue independently. Otherwise, keep going.
