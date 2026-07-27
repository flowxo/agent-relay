# Generated Harness Compatibility Matrix

<!-- Generated from the runtime-validated compatibility registry. Do not edit by hand. -->

Evidence rechecked: 2026-07-26.

- `verified`: Exact surface/version has a current sanitized fixture and bounded
  canary evidence.
- `compatible-unverified`: The official contract or local help supports the
  shape, but the complete path is not verified.
- `unsupported`: The required surface or capability is absent or known
  incompatible.
- `disabled`: The contract is understood, but Agent Relay intentionally keeps
  the capability off.

Runtime validation target: macOS arm64, Node.js 22 or newer. Native Node 22.23.1
clean-home package evidence is complete on this target; exact harness claims
remain versioned snapshots.

| Harness | Surface    | Exact verified version | Stop                  | Inline continue       | Permission decision   | Late resume           | Active steer          | Failure signal        | Native process exit | Evidence                                                                                                                                                                                  |
| ------- | ---------- | ---------------------- | --------------------- | --------------------- | --------------------- | --------------------- | --------------------- | --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex   | cli        | codex-cli 0.145.0      | verified              | compatible-unverified | compatible-unverified | verified              | unsupported           | unsupported           | unsupported         | [fixture](../packages/harnesses/fixtures/codex/stop.json), [record](harness-evidence.md#live-harness-activation)                                                                          |
| codex   | app-server | —                      | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | unsupported         | [record](harness-evidence.md#official-contract-sources)                                                                                                                                   |
| claude  | cli        | 2.1.219 (Claude Code)  | verified              | compatible-unverified | compatible-unverified | verified              | unsupported           | compatible-unverified | unsupported         | [fixture 1](../packages/harnesses/fixtures/claude/stop.json), [fixture 2](../packages/harnesses/fixtures/claude/stop-failure.json), [record](harness-evidence.md#live-harness-activation) |
| claude  | sdk        | —                      | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | compatible-unverified | unsupported         | [record](harness-evidence.md#official-contract-sources)                                                                                                                                   |
| cursor  | cli        | 2026.07.23-e383d2b     | verified              | compatible-unverified | disabled              | verified              | unsupported           | compatible-unverified | unsupported         | [fixture](../packages/harnesses/fixtures/cursor/stop.json), [record](harness-evidence.md#live-harness-activation)                                                                         |
| cursor  | ide        | —                      | compatible-unverified | compatible-unverified | disabled              | unsupported           | unsupported           | compatible-unverified | unsupported         | [record](harness-evidence.md#official-contract-sources)                                                                                                                                   |

Disabled and unsupported capabilities are emitted as `false` in runtime events
and therefore fail closed. Native hooks cannot prove a process crash; that
evidence exists only when Agent Relay owns the supervised child.

Not claimed: Windows, Linux end-user runtime, Intel macOS, Cursor IDE late
resume, native-hook crash proof, Cursor permission automation.
