# Cursor integration

Agent Relay supplies the smallest accurately named Cursor integration: a **local
plugin** at `~/.cursor/plugins/local/agent-relay`. It contains
`.cursor-plugin/plugin.json`, `mcp.json`, `hooks/hooks.json`, the canonical
skill, commands, and one executable wrapper.

The frozen `2026.07.23-e383d2b` CLI exposes plugin marketplace management and a
global `--plugin-dir` option, but no native local plugin install, disable, or
uninstall subcommand. Agent Relay does not claim otherwise.

## Install and trust

```sh
agent-relay integrations install --harness cursor
agent-relay run cursor -- cursor-agent --plugin-dir "$HOME/.cursor/plugins/local/agent-relay"
```

Use Cursor's native local-plugin UI in products that discover the documented
local directory automatically. Review the plugin, MCP declaration, and `stop`
hook before trusting them. Agent Relay never substitutes for Cursor permissions,
approvals, authentication, or hook trust.

The Relay supervisor supplies the exact opaque MCP binding. Without it the MCP
server fails closed; no project, path, process, timing, or session heuristic is
used.

## Data and compatibility

Only the frozen `stop` activity event is installed. The wrapper delegates it to
Relay's canonical Cursor parser and FXO-1602 reducer. It does not infer starts,
permissions, subagents, compaction, or session end. MCP is local stdio and uses
only the Relay supervisor's exact opaque binding.

Other recognizable Cursor versions are compatible-unverified. Missing local
plugin support is reported explicitly; run the Relay commands directly and keep
native questions and approvals in Cursor.

## Updates, conflicts, disable, rollback, and uninstall

```sh
agent-relay integrations upgrade --harness cursor
agent-relay integrations repair --harness cursor
agent-relay integrations disable --harness cursor
agent-relay integrations enable --harness cursor
agent-relay integrations rollback --harness cursor
agent-relay integrations uninstall --harness cursor
```

Restart Cursor or its CLI after discovery changes. An unowned local-plugin
target or manual Agent Relay MCP/hook/skill stops preflight with remediation.
Unrelated Cursor plugins, MCP servers, hooks, commands, skills, settings, and
formatting are untouched. Disable and uninstall affect only the owned local
tree; Relay data remains.

Source contracts: [plugins](https://cursor.com/docs/plugins) and
[plugin reference](https://cursor.com/docs/reference/plugins).
