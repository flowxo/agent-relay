# Vendor-native integrations

Agent Relay 0.1.0-alpha.3 introduces versioned, locally installable integration
bundles for Codex, Claude Code, and Cursor. The bundles contain native manifests
and declarations, but Relay core remains authoritative for interaction storage,
the activity reducer, the `agent-relay-mcp.v1` schemas and exact-binding
handshake, the official skill contract, security decisions, and the loopback
operator UI.

The evidence below was reviewed on 2026-08-13 against current official
documentation and the frozen executable versions from FXO-1601. The fixture is
[`capabilities.v1.json`](../integrations/agent-relay/fixtures/capabilities.v1.json).

## Reviewed capability matrix

| Surface                 | Codex                                                                 | Claude Code                                               | Cursor                                                                                    |
| ----------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Frozen version          | `codex-cli 0.145.0`                                                   | `2.1.219 (Claude Code)`                                   | `2026.07.23-e383d2b`                                                                      |
| Accurate bundle name    | Codex plugin in an Agent Relay-owned local marketplace                | Claude Code local plugin                                  | Cursor local plugin                                                                       |
| Manifest                | `.codex-plugin/plugin.json`                                           | `.claude-plugin/plugin.json`                              | `.cursor-plugin/plugin.json`                                                              |
| MCP                     | `.mcp.json`; local stdio                                              | `.mcp.json`; local stdio                                  | `mcp.json`; local stdio                                                                   |
| Frozen activity hooks   | `SessionStart`, `UserPromptSubmit`, `Stop`                            | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure` | `stop`                                                                                    |
| Handshake hooks         | `SessionStart` (also selected activity)                               | `SessionStart` (also selected activity)                   | `sessionStart` (MCP binding only; not activity evidence)                                  |
| Skill/instructions      | `skills/*/SKILL.md`                                                   | `skills/*/SKILL.md`                                       | `skills/*/SKILL.md`                                                                       |
| Entry points            | connect, doctor, and dashboard auxiliary skills                       | connect, doctor, and dashboard commands                   | connect, doctor, and dashboard commands                                                   |
| Settings/trust          | native plugin enablement, MCP policy, and hook review                 | native hook trust; no settings rewrite                    | native plugin enablement and hook trust                                                   |
| Update channel          | Relay lifecycle upgrade, then native local-marketplace refresh        | Relay lifecycle upgrade                                   | Relay lifecycle upgrade                                                                   |
| Disable                 | Relay lifecycle disable and native plugin removal when activated      | Relay lifecycle disable; omit `--plugin-dir`              | Relay lifecycle disable; marketplace UI applies only to published plugins                 |
| Uninstall               | native plugin removal, marketplace removal, then owned-bundle cleanup | Relay lifecycle uninstall                                 | Relay lifecycle uninstall; marketplace UI applies only to published plugins               |
| Frozen local activation | `codex plugin marketplace add`, then `codex plugin add`               | `claude --plugin-dir`                                     | `--plugin-dir`; the frozen CLI has marketplace management but no local install subcommand |

Primary sources: [Codex plugins](https://developers.openai.com/codex/plugins),
[Codex MCP](https://developers.openai.com/codex/mcp),
[Codex hooks](https://developers.openai.com/codex/hooks),
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Cursor plugins](https://cursor.com/docs/plugins), and
[Cursor plugin reference](https://cursor.com/docs/reference/plugins). Claude's
official plugin guide documents `--plugin-dir` for local loading; its personal
skills directory is not represented here as an implicit plugin installer.

Cursor's frozen executable does not expose an official local plugin install or
uninstall command. Agent Relay therefore calls its deliverable a **local
plugin**, stages only the documented local-plugin tree, and reports the native
`--plugin-dir` activation. It does not invent a marketplace installation.

## One bounded lifecycle command

All examples may use `--root <isolated-home>` for evaluation. Omitting `--root`
selects the current user's home.

```sh
agent-relay integrations install
agent-relay integrations status
agent-relay integrations reinstall
agent-relay integrations upgrade
agent-relay integrations repair
agent-relay integrations disable
agent-relay integrations enable
agent-relay integrations rollback
agent-relay integrations uninstall
```

Add `--harness codex`, `--harness claude`, or `--harness cursor` to select one
harness. `--dry-run` performs preflight and reports intent without writing.

Install, reinstall, upgrade, and repair preflight all known manual and legacy
Agent Relay declarations. An unowned target, duplicate MCP server or hook,
malformed vendor configuration, or ownership ambiguity stops before mutation
with remediation. Unrelated plugins, servers, hooks, commands, skills, settings,
formatting, and user configuration are never rewritten.

Handled write failures restore the prior trees and lifecycle metadata. An
abruptly interrupted process can leave only bounded owned-tree drift, which
`status` detects and `repair` restores. Upgrade and reinstall retain one bounded
owned-artifact rollback snapshot. Disable moves only owned plugin trees outside
native discovery; enable restores them. Uninstall removes only manifest-owned
bundles, lifecycle metadata, and a launcher with the Relay owner marker. Relay
databases, logs, delivery configuration, credentials, and user content remain in
place.

For an exact live MCP session, start the harness through Relay's canonical
supervisor and include local plugin flags after `--` when needed:

```sh
agent-relay run codex -- codex
agent-relay run claude -- claude --plugin-dir "$HOME/.agent-relay/vendor/claude/agent-relay"
agent-relay run cursor -- cursor-agent --plugin-dir "$HOME/.cursor/plugins/local/agent-relay"
```

The supervisor creates the opaque binding and passes it to that one harness and
its plugin MCP process. An unsupervised plugin MCP launch has no binding and
fails closed; it never guesses from project, process, path, timing, or session
metadata.

## Contract and security boundaries

Each bundle carries explicit metadata for:

- Agent Relay `>=0.1.0-alpha.2 <0.2.0-0`;
- MCP surface `agent-relay-mcp.v1` over MCP `2025-11-25`;
- skill contract `agent-relay-skill-contract.v1` version `1.0.0`;
- the exact frozen harness version and `compatible-unverified` policy for other
  recognizable versions; and
- loopback-only networking and native-only authorization.

The MCP wrapper only executes `agent-relay mcp`. It inherits the opaque
`AGENT_RELAY_MCP_BINDING` created by the Relay supervisor and contains no
session-correlation logic. Hook wrappers only send native payloads to
`agent-relay hook`; the canonical parsers and FXO-1602 reducer decide what those
signals mean. The main skill is copied byte-for-byte from the FXO-1605 canonical
renderer. Connect, doctor, and dashboard entry points delegate to Relay core.

No manifest contains a bearer value, CSRF value, OAuth URL, account identifier,
private path, or session heuristic. The plugins cannot approve permissions,
grant trust, authenticate, elevate privilege, or bypass a denied native hook.
The lifecycle performs no provider call, registry mutation, package publish,
marketplace submission, release, or deployment.

Every generated dashboard auxiliary skill/command invokes
`agent-relay dashboard --web`; each executable wrapper delegates `dashboard` and
its arguments directly to Relay core. Vendor artifacts contain no grant, bearer,
CSRF, session cookie, or alternate dashboard authority. Install, reinstall,
upgrade, repair, disable, rollback, and uninstall retain the existing
ownership-preservation rules while keeping this canonical entry point.

## Doctor and evidence

When vendor integrations are installed, `agent-relay doctor` reports only
bounded states: artifact presence, ownership, drift, enabled/disabled state,
harness compatibility, Relay/MCP/skill-contract compatibility, native hook trust
status, conflicts, and the matching repair action. It does not echo
configuration contents, prompts, credentials, identifiers, paths, or session
data. An unavailable executable is an explicit compatibility warning; denied or
unknown hook trust remains on the native trust path.

Lifecycle scenarios are frozen in
[`lifecycle-scenarios.v1.json`](../integrations/agent-relay/fixtures/lifecycle-scenarios.v1.json).
The test suite uses isolated homes, synthetic payloads, fake delivery, and no
credentials. Artifact snapshots cover every vendor manifest and file digest;
packaging checks cover inventory, provenance, executable modes, dependency
footprint, and rollback metadata.

Per-harness operations:

- [Codex](integrations/codex.md)
- [Claude Code](integrations/claude-code.md)
- [Cursor](integrations/cursor.md)
