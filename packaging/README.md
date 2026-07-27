# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. This package contains the supported
`agent-relay` command-line application; it does not expose a public JavaScript
library API.

> This is the unpublished `0.1.0-alpha.1` candidate. The package remains marked
> `private` while the checked-in owner publication approval is false. The Flow
> XO npm scope, public repository, protected environment, trusted publisher, and
> first prerelease still require explicit approval.

## Supported target

- macOS on Apple silicon
- Node.js 22 or newer

Start with the credential-free local proof:

```sh
agent-relay --help
agent-relay --version
agent-relay capabilities
agent-relay daemon
```

In another terminal:

```sh
agent-relay canary
agent-relay status
```

The daemon should report the `fake-telegram` transport and the canary should
report one durable delivery with no retry or dead letter. No hosted service or
Telegram credential is required. The capability record is safe to inspect and
contains classifications, exact verified versions, and evidence IDs without
transcripts or machine paths.

Before changing user-level harness configuration, inspect the exact plan:

```sh
agent-relay install --dry-run
agent-relay install
agent-relay doctor
```

Uninstall owned hooks and the launcher before removing the package:

```sh
agent-relay uninstall --dry-run
agent-relay uninstall
```

Uninstall preserves local state, logs, credentials, backups, and unrelated
harness settings by default.

Full documentation, support boundaries, security reporting, privacy behavior,
and source are maintained at
[github.com/flowxo/agent-relay](https://github.com/flowxo/agent-relay). Do not
install the unrelated unscoped `agent-relay` package from npm.
