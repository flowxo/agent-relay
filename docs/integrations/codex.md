# Codex integration

Agent Relay uses the official Codex plugin format at
`.codex-plugin/plugin.json`. Its Agent Relay-owned local marketplace contains
the plugin, default-discovered `hooks/hooks.json`, `.mcp.json`, the canonical
skill, three command-like auxiliary skills, and one executable wrapper.

## Install and trust

```sh
agent-relay integrations install --harness codex
codex
```

Install writes only Agent Relay's marketplace and plugin enablement tables into
`~/.codex/config.toml`, then snapshots the plugin with Codex's native install
action. Launch `codex` as usual. Review the plugin and approve its hooks through
Codex's native trust path. Agent Relay does not bypass that decision. Plugin MCP
uses a plugin-root `cwd` of `.` because Codex does not expand `${PLUGIN_ROOT}`
in `.mcp.json`.

Exact binding uses Codex's harness-stated session ID when the vendor process
provides one. Missing session identity fails closed rather than correlating by
path, process, timing, or session metadata heuristics. `agent-relay run` remains
available for owned-child evidence and resume; it is not required to ask.

Operator questions in a supervised Codex session are produced by the official
skill calling `agent-relay-mcp.v1`. Codex's native `request_user_input` remains
a terminal prompt. Relay does not intercept it. Permission requests stay on
Codex's native approval path.

## Data and permissions

The plugin runs a local stdio MCP server and sends only selected native hook
payloads to Relay core. Relay's existing privacy filters, exact binding,
interaction store, and loopback boundary apply. Native Codex permissions,
approvals, sandboxing, authentication, and security confirmations remain native.

## Updates, conflicts, and recovery

Run `agent-relay integrations upgrade --harness codex` and review the new owned
bundle. `status` detects drift; `repair` restores only owned files; `rollback`
swaps the last owned bundle snapshot back. Unrelated Codex config tables are
preserved. Install, disable, enable, and uninstall rewrite only Agent Relay's
marketplace enablement tables in `~/.codex/config.toml`. A manually declared
Agent Relay MCP server, hook, skill, marketplace, or unowned target is reported
as a conflict before any write. Remove or disable exactly one declaration rather
than running duplicate servers or hooks.

## Disable and uninstall

```sh
agent-relay integrations disable --harness codex
agent-relay integrations enable --harness codex
agent-relay integrations uninstall --harness codex
```

Disable keeps the marketplace registered and sets the owned plugin table to
disabled. Uninstall removes only those owned tables. Relay data and unrelated
Codex material are preserved.

Source contracts: [plugins](https://developers.openai.com/codex/plugins),
[MCP](https://developers.openai.com/codex/mcp), and
[hooks](https://developers.openai.com/codex/hooks).
