# AR2.2: Select and diagnose one transport explicitly

- **Status:** Complete
- **Linear issue:** [FXO-1151](https://linear.app/flowxo/issue/FXO-1151)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Safe setup and explicit transport selection
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-draft.1`
- **Last reviewed:** 2026-07-26

## Outcome

Agent Relay resolves exactly one outbound transport—`fake`, `telegram`, or
`notifications`—from an explicit operator choice. Credentials affect readiness
only. They never activate a provider, trigger dual delivery, or cause automatic
failover.

## Selection model

Selection precedence is:

1. daemon-only `--transport`;
2. `AGENT_RELAY_TRANSPORT`;
3. private durable `transport.json`; then
4. the credential-free `fake` default.

`agent-relay transport select <mode>` writes the durable choice and reports that
a daemon restart is required. The file is strict runtime-validated JSON, bounded
to 16 KiB, written atomically as mode `0600`, and refuses symlinks, non-regular
files, and a parent directory accessible by group/others. It contains no
credential or provider identity. Selection changes do not edit or remove SQLite,
pending requests, answers, resume commands, or provider configuration.

`web-demo` is intentionally fixed to fake and rejects a transport override.

## Runtime isolation

Daemon construction uses a closed three-way switch:

- `fake` constructs only the in-memory fake transport;
- `telegram` requires token/chat configuration, performs the existing preflight,
  and starts only its selected reply intake; and
- `notifications` requires an active retained narrow connection and constructs
  only the pinned hosted adapter.

Unselected credentials are not parsed into runtime clients and cannot trigger a
network call. A selected transport failure remains within the existing durable
retry/dead-letter policy; no second provider receives the event.

The Notifications client additionally forces manual redirect handling and
refuses remote HTTP. Authentication, authorization, subscriber binding, and
pinned-contract configuration failures open an in-process terminal circuit.
Later events remain durably diagnosed but make no repeated credential-bearing
request until corrective setup and restart. Transient failures keep the stable
event ID and existing bounded SQLite retry policy.

## Safe readiness and status

`agent-relay transport status` reports:

- selected mode and selection source;
- fake readiness;
- direct Telegram delivery/reply/update-mode readiness as booleans and stable
  issue codes;
- Notifications API origin, contract/environment, hashed machine/canary
  references, credential presence, exact pinned-scope readiness, and binding
  state; and
- no credential value or full provider identity.

`doctor` fails when the selected transport is not ready. An unselected but
partially configured provider is a warning, while the absent optional providers
do not make the default fake installation unhealthy.

Daemon `status` adds selected mode/source, last successful hosted send, local
pending/retry/dead-letter counts, terminal-circuit state, suppressed hosted-call
count, and the last hosted error code/classification. It no longer returns raw
session, topic, or session-control records. It never includes a provider error
message, secret, full provider identity, prompt, answer, transcript, or raw
session identity.

FXO-1152 owns inbound hosted polling. Until that slice lands, status explicitly
reports `polling.state = "not-started"`, null last-poll/cursor values, and zero
locally claimed unacknowledged hosted events. Those placeholders are an honest
capability boundary, not an inbound readiness claim.

## Acceptance evidence

| Acceptance criterion                   | Evidence                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Exactly three explicit modes           | Strict Zod selection schema and CLI command tests                                             |
| Credentials never select               | Default-fake test with both Telegram and hosted credentials                                   |
| Override precedence and durable switch | command-line/environment/durable/default tests plus mode-`0600` inspection                    |
| No dual send/failover                  | Daemon tests prove fake and Notifications delivery with an unselected Telegram fetch at zero  |
| Hosted outbound path                   | Daemon drains one event through the executable pinned Notifications mock                      |
| State retained while switching         | Sentinel database survives durable selection changes byte-for-byte                            |
| Safe status and doctor                 | redaction/readiness/classification tests; raw status identities removed                       |
| Terminal versus transient behavior     | terminal circuit suppresses a second fetch; transient calls retain the stable idempotency key |
| Safe configuration filesystem boundary | permissive file and symlink referent tests fail closed                                        |

Focused checks:

```sh
pnpm exec vitest run \
  apps/relay/src/transport-command.test.ts \
  apps/relay/src/transport-status.test.ts \
  apps/relay/src/daemon.test.ts \
  apps/relay/src/doctor.test.ts \
  packages/notifications-transport/src/transport.test.ts \
  --no-file-parallelism
pnpm --filter @agent-relay/core typecheck
pnpm --filter @agent-relay/notifications-transport typecheck
pnpm --filter @agent-relay/relay typecheck
```

Final local gate on 2026-07-26:

- `pnpm check`: all policy, formatting, documentation, fixture, secret,
  release-policy, lint, typecheck, 46-file/358-test Vitest, generated
  capability, pinned Notifications contract, distribution, packaged install, and
  prior-version lifecycle checks passed;
- `pnpm package:lifecycle:check`: the isolated `0.1.0-alpha.0 -> 0.1.0-alpha.1`
  install/doctor/migration/state/upgrade/ uninstall lifecycle passed again
  independently;
- `pnpm test:e2e`: all three packaged Chromium scenarios passed; and
- `pnpm audit --prod`: no known vulnerabilities.

## Proven versus deferred

### Proven locally

- Selection and readiness are credential-independent and runtime validated.
- Only the selected outbound adapter is constructed/contacted.
- Hosted outbound delivery uses the exact pinned mock contract and stable local
  event identity.
- Selection, readiness, doctor, and runtime status omit retained secret/full
  identity/message content.
- Known hosted configuration failures stop repeated remote calls; transient
  delivery stays bounded by the durable local retry policy.
- Direct Telegram startup/preflight/poll/webhook behavior remains green under
  explicit selection.

### Deferred

- durable hosted poll/cursor/claim/resolve/ack state (FXO-1152);
- hosted resolution reflection and extended diagnosis (FXO-1153);
- common three-transport behavior suite (FXO-1154);
- packed end-to-end hosted proof and release handoff (FXO-1155); and
- production dogfood, still gated by C0-09 and AR3.

## References

- [`project-spec.md`](../project-spec.md)
- [`ar2-1-narrow-machine-client.md`](ar2-1-narrow-machine-client.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`docs/troubleshooting.md`](../../../troubleshooting.md)
