# Claude Code integration

Agent Relay installs the official Claude Code plugin shape under
`~/.agent-relay/vendor/claude-marketplace/plugins/agent-relay`:
`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, the canonical
skill, commands, and one executable wrapper. Install also writes an Agent
Relay-owned local marketplace at `~/.agent-relay/vendor/claude-marketplace` so
Claude Code can enable the plugin through its native marketplace action. After
that, launch `claude` as usual.

## Install and trust

```sh
agent-relay integrations install --harness claude
claude
```

Install writes only Agent Relay's marketplace and `enabledPlugins` keys into
`~/.claude/settings.json`, then launch `claude` as usual. Inspect the plugin and
approve its hooks through Claude's native trust path. `--plugin-dir` remains a
one-off development load, not the everyday path.

Exact binding uses Claude's harness-stated session ID. The plugin `.mcp.json`
forwards `${CLAUDE_SESSION_ID}` into the MCP subprocess because Claude's plugin
MCP spawn does not inherit the process environment. Missing or unsubstituted
session identity fails closed rather than correlating by path, process, timing,
or session metadata heuristics.

Operator questions in a Claude session are produced by the official skill
calling `agent-relay-mcp.v1`. Claude's native `AskUserQuestion` remains a
terminal prompt. Relay does not intercept it, including via PreToolUse.
`ExitPlanMode` and `PermissionRequest` stay on Claude's native approval path.

## Data and permissions

`${CLAUDE_PLUGIN_ROOT}` resolves only the owned local wrapper. MCP remains local
stdio, and selected hooks delegate raw input to Relay's canonical parser and
reducer. Claude Code owns permissions, approvals, authentication, trust, and
security prompts. Denied hooks remain inactive and doctor reports that state
without revealing their payload.

## Updates, conflicts, disable, and rollback

```sh
agent-relay integrations status --harness claude
agent-relay integrations upgrade --harness claude
agent-relay integrations repair --harness claude
agent-relay integrations disable --harness claude
agent-relay integrations enable --harness claude
agent-relay integrations rollback --harness claude
```

Every operation is ownership checked. Manual Agent Relay MCP, hook, command, or
skill material is reported before mutation. Unrelated Claude settings keys are
preserved. Install, disable, enable, and uninstall rewrite only Agent Relay's
marketplace enablement keys in `~/.claude/settings.json`.

## Uninstall

```sh
agent-relay integrations uninstall --harness claude
```

Only the owned plugin tree, local marketplace declaration, and lifecycle record
are removed. Relay data, delivery configuration, and other Claude plugins, MCP
servers, hooks, commands, skills, and settings remain.

Source contracts:
[plugin reference](https://code.claude.com/docs/en/plugins-reference),
[MCP](https://code.claude.com/docs/en/mcp), and
[hooks](https://code.claude.com/docs/en/hooks).
