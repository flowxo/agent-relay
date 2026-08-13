# Claude Code integration

Agent Relay installs the official Claude Code plugin shape under
`~/.agent-relay/vendor/claude/agent-relay`: `.claude-plugin/plugin.json`,
`.mcp.json`, `hooks/hooks.json`, the canonical skill, commands, and one
executable wrapper. The frozen CLI supports the official `--plugin-dir`
development and local-test mechanism, so no marketplace or implicit
personal-plugin claim is needed.

## Install and trust

```sh
agent-relay integrations install --harness claude
agent-relay run claude -- claude --plugin-dir "$HOME/.agent-relay/vendor/claude/agent-relay"
```

Inspect the plugin and approve its hooks through Claude's native trust path. The
frozen `2.1.219 (Claude Code)` executable also exposes native plugin install,
update, enable, disable, and uninstall commands for marketplace-backed plugins;
this local bundle deliberately uses the smaller documented `--plugin-dir`
mechanism.

The Relay supervisor supplies one opaque exact binding to the Claude process and
its MCP subprocess. Running the MCP entry point without that binding fails
closed rather than correlating by path, process, timing, or session metadata.

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
skill material is reported before mutation. Unrelated Claude settings and their
formatting remain byte-for-byte unchanged. Omit `--plugin-dir` after disable or
uninstall, and use it again after enable.

## Uninstall

```sh
agent-relay integrations uninstall --harness claude
```

Only the owned plugin tree and its lifecycle record are removed. Relay data,
delivery configuration, and other Claude plugins, MCP servers, hooks, commands,
skills, and settings remain.

Source contracts:
[plugin reference](https://code.claude.com/docs/en/plugins-reference),
[MCP](https://code.claude.com/docs/en/mcp), and
[hooks](https://code.claude.com/docs/en/hooks).
