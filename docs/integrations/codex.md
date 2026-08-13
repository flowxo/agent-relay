# Codex integration

Agent Relay uses the official Codex plugin format at
`.codex-plugin/plugin.json`. Its Agent Relay-owned local marketplace contains
the plugin, default-discovered `hooks/hooks.json`, `.mcp.json`, the canonical
skill, three command-like auxiliary skills, and one executable wrapper.

## Install and trust

```sh
agent-relay integrations install --harness codex
codex plugin marketplace add ~/.agent-relay/vendor/codex-marketplace
codex plugin add agent-relay@agent-relay-local
```

The first command never edits Codex configuration. The next two are Codex's
native marketplace and install actions for the frozen `codex-cli 0.145.0`
surface. Review the local marketplace source, MCP server, skills, and hooks in
Codex before enabling them, then start a new thread. Codex may withhold hooks
until native trust is granted; Agent Relay does not bypass that decision.

For exact MCP/native-session binding, launch the installed plugin in a
supervised Codex process:

```sh
agent-relay run codex -- codex
```

Without the supervisor-issued opaque binding, the MCP server fails closed.

## Data and permissions

The plugin runs a local stdio MCP server and sends only selected native hook
payloads to Relay core. Relay's existing privacy filters, exact binding,
interaction store, and loopback boundary apply. Native Codex permissions,
approvals, sandboxing, authentication, and security confirmations remain native.

## Updates, conflicts, and recovery

Run `agent-relay integrations upgrade --harness codex`, review the new owned
bundle, and repeat `codex plugin add agent-relay@agent-relay-local` to refresh
Codex's installed snapshot. `status` detects drift; `repair` restores only owned
files; `rollback` swaps the last owned bundle snapshot back. A manually declared
Agent Relay MCP server, hook, skill, marketplace, or unowned target is reported
as a conflict before any write. Remove or disable exactly one declaration rather
than running duplicate servers or hooks.

## Disable and uninstall

```sh
agent-relay integrations disable --harness codex
codex plugin remove agent-relay@agent-relay-local
agent-relay integrations enable --harness codex
```

Disable removes the owned source bundle from discovery but cannot silently
change an already installed Codex snapshot; use the native removal action too.
To uninstall permanently, run
`codex plugin remove agent-relay@agent-relay-local` first, then
`codex plugin marketplace remove agent-relay-local`, then:

```sh
agent-relay integrations uninstall --harness codex
```

Relay data and unrelated Codex material are preserved.

Source contracts: [plugins](https://developers.openai.com/codex/plugins),
[MCP](https://developers.openai.com/codex/mcp), and
[hooks](https://developers.openai.com/codex/hooks).
