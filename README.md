# Agent Relay

Agent Relay is a local-first attention and control layer for concurrent Codex,
Claude Code, and Cursor sessions. It normalizes deterministic harness events,
durably spools them, routes them through replaceable notification transports,
and keeps continuation capabilities explicit.

The implementation follows
[`docs/implementation-brief.md`](docs/implementation-brief.md). Current
evidence, risks, and the next action are tracked in
[`docs/progress.md`](docs/progress.md).

## Development

Requirements: Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm check
pnpm build
```

The checked-in capability matrix is generated from code and verified by
`pnpm capabilities:check`. Sanitized harness fixtures and their provenance live
under `packages/harnesses/fixtures`.

No bot token, transcript, credential, hostname, username, or raw working path is
required for the contract test suite.
