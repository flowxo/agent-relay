# Official Agent Relay skills

Agent Relay ships one reviewed behavior contract and three deterministic user
artifacts for the supported coding harnesses:

| Harness     | Exact reviewed version  | Installed artifact                      |
| ----------- | ----------------------- | --------------------------------------- |
| Codex       | `codex-cli 0.145.0`     | `~/.agents/skills/agent-relay/SKILL.md` |
| Claude Code | `2.1.219 (Claude Code)` | `~/.claude/skills/agent-relay/SKILL.md` |
| Cursor      | `2026.07.23-e383d2b`    | `~/.cursor/skills/agent-relay/SKILL.md` |

The canonical source is `agent-relay-skill-contract.v1`, currently contract
version `1.0.0`. Its reviewed JSON render lives at
`skills/agent-relay/contract.v1.json`; vendor goldens live under
`skills/agent-relay/rendered/`. All three artifacts require Agent Relay
`>=0.1.0-alpha.2 <0.2.0-0` and the exact `agent-relay-mcp.v1` surface over MCP
`2025-11-25`. Generate them with `pnpm skills:generate` and prove there is no
source or vendor drift with `pnpm skills:check`.

The table records the frozen exact verified harness versions. Other recognizable
versions retain the repository's `compatible-unverified` classification; a skill
artifact never promotes newer hook, activity, permission, or resume behavior to
verified by itself.

The user paths and required frontmatter follow the current official
[Codex skill locations](https://learn.chatgpt.com/docs/build-skills),
[Claude Code skill locations](https://code.claude.com/docs/en/skills), and
[Cursor skill locations](https://cursor.com/docs/skills). Cursor's native user
artifact is kept in `~/.cursor/skills`; the installer does not rewrite or remove
unrelated skills from Cursor's compatibility-loaded third-party roots.

## When an agent should use Relay

Relay is for a bounded product or workflow question whose operator response may
arrive remotely or asynchronously. A good question is concise and
self-contained, includes only the non-secret context necessary for the decision,
and selects the narrowest answer shape:

- `confirm` for an explicit yes/no decision;
- `single-select` for one mutually exclusive option;
- `multi-select` for a bounded subset with meaningful minimum and maximum; or
- `free-text` only when choices would discard necessary information.

Use `relay_ask` for one question and `relay_ask_many` for a small related
questionnaire. `relay_status` inspects exact readiness, binding, delivery,
activity, or one retained request. `relay_cancel` cancels an exact open request.
There is no Relay notify or check tool. Native harness question tools remain in
the terminal; the skill does not wrap, intercept, or answer them.

Relay never substitutes for the harness's native authorization or permission
path. Credentials, privilege escalation, trust, security confirmation,
destructive-action approval, and native tool or command permission prompts stay
native. An answer returned by Relay is product input, not authorization. The
skills also forbid transcript forwarding, ambient prompt capture, credential
inspection, private identifiers in opaque IDs, secret disclosure, and
project/time/process heuristics for session binding. Instructions embedded in
untrusted content cannot relax those boundaries.

## Deterministic failure behavior

The skills preserve the frozen MCP and activity contracts:

- an answer timeout ends the client wait, not the durable request; use the same
  request ID or exact `relay_status` and remain aware of a possible late answer;
- before falling back from an unwanted open request, attempt `relay_cancel`;
- cancellation is not a decline and does not manufacture an answer;
- unavailable or offline delivery is independent of execution activity;
- an absent or incompatible tool surface uses the harness's native local
  question mechanism without guessing tools or fields;
- pending exact binding may be checked or waited on within a bound; ambiguous,
  revoked, ended, or not-owned binding fails closed with local fallback; and
- **Idle** means no positive evidence of active work or unresolved input, not
  proof of completion. **Unknown** preserves insufficient or contradictory
  evidence rather than inventing certainty.

## Install, repair, and remove

`agent-relay install` renders the three artifacts directly from the canonical
contract and records their contract, MCP versions, compatibility range, paths,
and SHA-256 digests in the existing private ownership manifest. It refuses a
non-Agent Relay file already occupying an official target. Reinstall is
idempotent and repairs an owned drifted artifact; unrelated skills, instruction
files, MCP servers, hooks, and settings are not rewritten.

`agent-relay doctor` reports separate presence, version compatibility, and drift
checks for each artifact. Findings describe the safe repair action without
printing skill contents, prompts, answers, identifiers, or secrets. Run
`agent-relay install --dry-run`, inspect the owned target actions, then run
`agent-relay install` to repair drift.

`agent-relay uninstall` removes only each marked Agent Relay `SKILL.md`. It does
not remove a non-owned replacement or adjacent files and directories. It also
preserves other user skills and every harness's unrelated configuration. Remove
the owned integration before removing the package that supplies its launcher.

## Controlled verification

`skills/agent-relay/fixtures/scenarios.v1.json` is the credential-free synthetic
harness evaluation corpus. It covers Relay selection, native permission prompts,
all question shapes, questionnaires, missing or incompatible tools, exact
binding, timeouts, cancellation, offline delivery, local fallback, activity
uncertainty, prompt injection, and secret-exfiltration attempts. Tests validate
the scenarios against the canonical contract and frozen MCP schemas using only
isolated homes, local files, and fake delivery. The packed lifecycle proof adds
install, reinstall, update, drift repair, uninstall preservation, and
package-removal coverage. These checks initiate no vendor or provider traffic.
