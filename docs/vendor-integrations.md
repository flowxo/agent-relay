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

| Surface                 | Codex                                                                        | Claude Code                                                                | Cursor                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Frozen version          | `codex-cli 0.145.0`                                                          | `2.1.219 (Claude Code)`                                                    | `2026.07.23-e383d2b`                                                        |
| Accurate bundle name    | Codex plugin in an Agent Relay-owned local marketplace                       | Claude Code plugin in an Agent Relay-owned local marketplace               | Cursor local plugin                                                         |
| Manifest                | `.codex-plugin/plugin.json`                                                  | `.claude-plugin/plugin.json`                                               | `.cursor-plugin/plugin.json`                                                |
| MCP                     | `.mcp.json`; local stdio                                                     | `.mcp.json`; local stdio                                                   | user `mcp.json` (owned server); plugin `mcp.json` empty                     |
| Frozen activity hooks   | `SessionStart`, `UserPromptSubmit`, `Stop`                                   | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`                  | `stop`                                                                      |
| Handshake hooks         | `SessionStart` (also selected activity)                                      | `SessionStart` (also selected activity)                                    | `sessionStart` (MCP binding only; not activity evidence)                    |
| Skill/instructions      | `skills/*/SKILL.md`                                                          | `skills/*/SKILL.md`                                                        | `skills/*/SKILL.md`                                                         |
| Entry points            | connect, doctor, and dashboard auxiliary skills                              | connect, doctor, and dashboard commands                                    | connect, doctor, and dashboard commands                                     |
| Settings/trust          | native hook trust; Agent Relay writes only its marketplace enablement tables | native hook trust; Agent Relay writes only its marketplace enablement keys | not offered; Cursor does not state a conversation id to MCP                 |
| Update channel          | Relay lifecycle upgrade, then native local-marketplace refresh               | Relay lifecycle upgrade                                                    | Relay lifecycle upgrade                                                     |
| Disable                 | Relay lifecycle disable writes owned Codex enablement off                    | Relay lifecycle disable writes owned Claude enablement off                 | not offered                                                                 |
| Uninstall               | Relay lifecycle uninstall removes only owned Codex enablement tables         | Relay lifecycle uninstall removes only owned Claude enablement keys        | removes a leftover owned Cursor integration                                 |
| Frozen local activation | install writes Codex enablement; launch `codex` as usual                     | install writes Claude enablement; launch `claude` as usual                 | not offered; Cursor does not state a conversation id to MCP                 |

Primary sources: [Codex plugins](https://developers.openai.com/codex/plugins),
[Codex MCP](https://developers.openai.com/codex/mcp),
[Codex hooks](https://developers.openai.com/codex/hooks),
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Cursor plugins](https://cursor.com/docs/plugins), and
[Cursor plugin reference](https://cursor.com/docs/reference/plugins). Claude's
official plugin guide documents a local marketplace plus `--plugin-dir` for
one-off loading; its personal skills directory is not represented here as an
implicit plugin installer.

Cursor is not offered. `cursor-agent` states `CURSOR_CONVERSATION_ID` to hooks
and shell children, not to MCP stdio or `tools/call`. Install would show tools
that never deliver a question. `integrations install` therefore writes Claude
and Codex only, and removes a leftover owned Cursor plugin or user MCP server.

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

Add `--harness codex` or `--harness claude` to select one harness. `--harness
cursor` is refused for install, reinstall, upgrade, repair, and enable.
`uninstall --harness cursor` removes a leftover owned Cursor integration.
`--dry-run` performs preflight and reports intent without writing.

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

After `integrations install`, launch `codex` or `claude` as usual. Exact
binding uses the harness-stated native session ID. Concurrent
sessions in the same project do not share answers. Correlation never uses
project, path, process, PID, timing, or "most recent session."

`agent-relay run` remains for owned-child evidence and resume. It is not
required to ask an operator question.

## Contract and security boundaries

Each bundle carries explicit metadata for:

- Agent Relay `>=0.1.0-alpha.2 <0.2.0-0`;
- MCP surface `agent-relay-mcp.v1` over MCP `2025-11-25`;
- skill contract `agent-relay-skill-contract.v1` version `1.0.0`;
- the exact frozen harness version and `compatible-unverified` policy for other
  recognizable versions; and
- loopback-only networking and native-only authorization.

The MCP wrapper only executes `agent-relay mcp`. Plugin MCP manifests set a
literal harness name. Claude's plugin MCP spawn is a clean environment, so its
manifest forwards `${CLAUDE_SESSION_ID}` as the harness-stated native session.
Codex plugin MCP uses `cwd: "."` because Codex does not expand `${PLUGIN_ROOT}`
in `.mcp.json`. Codex inherits a harness-stated session from
`_meta.threadId`. Cursor is not offered: `cursor-agent` states
`CURSOR_CONVERSATION_ID` to hooks and shell children, not to MCP stdio.
The wrapper contains no session-correlation heuristics. Hook
wrappers only send native payloads to `agent-relay hook`; the canonical parsers
and FXO-1602 reducer decide what those signals mean. The main skill is copied
byte-for-byte from the FXO-1605 canonical renderer. Connect, doctor, and
dashboard entry points delegate to Relay core.

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
