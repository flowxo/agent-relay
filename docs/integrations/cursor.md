# Cursor integration

Agent Relay does **not** install into Cursor. `cursor-agent` tells hooks and
shell children which conversation is running. It does not give that id to MCP.
An install would show `relay_ask` and then fail closed: the question would never
reach the dashboard.

```sh
agent-relay integrations install --harness cursor
# refused: Cursor is not offered
```

`integrations install` (Claude and Codex) removes a leftover owned Agent Relay
Cursor plugin tree and the owned `agent-relay` server from `~/.cursor/mcp.json`.
Unrelated Cursor MCP servers stay. To clean only Cursor:

```sh
agent-relay integrations uninstall --harness cursor
```

Restart Cursor or `cursor-agent` after that cleanup. Native `AskQuestion` stays
in the terminal. Use `claude` or `codex` for everyday Relay ask.

When Cursor states a conversation id on MCP stdio or `tools/call` `_meta`, this
integration can be offered again. Relay will not guess from project, path,
process, timing, or the most recent session.

Source contracts: [plugins](https://cursor.com/docs/plugins) and
[plugin reference](https://cursor.com/docs/reference/plugins).
