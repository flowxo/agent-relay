# AR2.1: Configure a narrow Notifications machine client

- **Status:** Complete
- **Linear issue:** [FXO-1150](https://linear.app/flowxo/issue/FXO-1150)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Safe setup and explicit transport selection
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-rc.1`
- **Last reviewed:** 2026-07-26

## Outcome

One stable local Agent Relay machine can be connected to one authorized
Notifications notifier/subscriber binding without retaining a broad project
credential. The production daemon does not select the hosted transport yet;
FXO-1151 owns that explicit runtime decision.

## Implemented flow

`agent-relay notifications connect`:

1. accepts a project bootstrap credential only from environment injection,
   bounded stdin, or an interactive hidden prompt;
2. requires an explicit safe API base URL and subscriber ID;
3. creates a single-use Telegram subscription link and immediately exposes its
   bounded authorization URL;
4. reports `authorization_pending`/`authorization_incomplete` without creating
   credential material when activation is not proven;
5. verifies the activated project, environment, subscriber, notifier, and
   binding;
6. creates a destination-bound client for the stable local machine ID;
7. generates a canonical 16-byte credential ID and 32-byte secret locally;
8. registers only the credential ID and SHA-256 digest;
9. smoke-tests the narrow bearer with a zero-wait machine-event poll;
10. sends one fixed synthetic canary to the bound destination;
11. re-reads and verifies active client metadata and the exact four narrow
    scopes; and
12. atomically stores the narrow connection locally.

The broad credential remains only in process memory for that command. It is not
part of a returned result, diagnostic, local JSON file, SQLite record, or test
fixture.

## Contract client boundary

The pinned `NotificationsClient` exposes subscription, message, capability,
machine poll, and acknowledgement operations. It does not expose the C0 machine
administration routes. `NotificationsAdministrationClient` therefore adds only:

- create/get machine client;
- register a locally generated credential digest;
- revoke a machine credential; and
- revoke a machine client.

The client imports owner validators/types rather than hand-copying contract
shapes. It enforces exact expected statuses and media types, a 1 MiB success
limit, a 64 KiB problem limit, UTF-8 JSON, runtime contract validation, bounded
opaque path segments, and stable redacted local errors.

All setup clients require HTTPS except exact `localhost`, `127.0.0.1`, or `::1`
mock origins. Base URLs cannot contain user info, query, or fragment.
Credential-bearing Fetch calls force `redirect: "manual"`; a redirect is a
protocol failure and never receives a second request.

## Credential storage

Agent Relay writes two private files under the selected state directory:

| File                            | Contents                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `notifications.json`            | Non-secret connection identity, contract/environment, canary, safe state |
| `notifications-credential.json` | Current narrow bearer, credential ID, creation time, rotation lineage    |

Both files:

- must be regular files;
- must not be readable or writable by group/others;
- are bounded to 64 KiB;
- use strict Zod schemas;
- reject symlinks and non-private parent directories;
- are written through a mode-`0600` same-directory temporary file;
- sync file contents before atomic rename; and
- reject mismatched configuration/credential identities.

The credential file contains no API origin, project, machine, subscriber,
notifier, binding, message, or diagnostic identity. The configuration file
contains no bearer. If the second file write fails, the prior credential is
restored (or the newly written credential is removed) before the failure
returns.

Safe status hashes full machine-client and canary IDs to 12 hexadecimal
characters and omits full provider identities.

## Disconnect, revocation, and reconnect

- `notifications disconnect` disables the local connection and retains state and
  the narrow credential by default.
- `--erase-credential` explicitly removes only the local narrow secret.
- `--revoke` obtains the project credential through the same secret-safe input
  paths and idempotently revokes the hosted credential and client.
- `--erase-configuration` requires `--erase-credential` and is refused while a
  hosted credential may remain active unless revocation is requested.
- Re-running `connect` generates and smoke-tests a replacement before switching
  the local connection.
- The prior credential/client is revoked only after the new local connection
  commits.
- A same-client credential rotation revokes only the retired credential, not the
  still-active client.
- Failed old-client revocations remain as bounded non-secret
  `pendingRevocations`; later credentialed connect/disconnect retries them.
- Reconnect refuses to change API origin while any hosted state may remain. It
  also verifies the same project/environment before replacing a live connection,
  cleaning up the provisional replacement on mismatch. This keeps each compact
  pending-revocation record bound to one service authority.

A post-registration smoke/canary failure triggers bounded best-effort revocation
of both provisional resources. The surfaced error states whether cleanup may be
incomplete. A local storage failure likewise attempts remote cleanup and never
claims a usable connection.

## Acceptance evidence

| Acceptance criterion                       | Evidence                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Secret-safe bootstrap input                | Resolver/CLI tests cover environment, stdin, prompt provider, and redacted positional reject    |
| Local secret; digest-only registration     | Generated-material mock test inspects every HTTP authorization/body                             |
| Private atomic symlink-safe storage        | Storage tests cover `0600`, malformed/mismatch, symlink, exposed parent, preflight preservation |
| Least-privilege/cross-machine denial       | Generated client sees only its stream/message; foreign message/admin reads fail `404`/`403`     |
| Authorization, binding, canary, incomplete | Activated and non-activating mock scenarios                                                     |
| HTTPS, redirects, body bounds              | URL, redirect, declared-size, malformed JSON, media/status/contract tests                       |
| Disconnect/revoke/reconnect/erasure        | Two-generation command lifecycle with old/new client state inspection                           |
| Failure diagnosis and cleanup              | Forced poll, cleanup, and local-commit failures prove bounded complete/incomplete cleanup       |
| Rotation authority and retained bounds     | Cross-origin refusal and a 20-record overflow fixture prevent orphaning old or new clients      |

Focused checks:

```sh
pnpm exec vitest run \
  packages/notifications-transport/src/bootstrap.test.ts \
  apps/relay/src/notifications-config.test.ts \
  apps/relay/src/notifications-command.test.ts \
  --no-file-parallelism
pnpm --filter @agent-relay/notifications-transport typecheck
pnpm --filter @agent-relay/relay typecheck
```

Final local gate on 2026-07-26:

- `pnpm check`: 44 Vitest files / 339 tests, 17 contract-lock and supply-chain
  tests, six isolated Notifications consumer tests, build, packaged
  install/canary/web API, and full prior-version lifecycle;
- `pnpm test:e2e`: three packaged Chromium scenarios;
- `pnpm audit --prod`: no known vulnerabilities; and
- compiled `notifications --help` plus isolated `notifications status`.

## Proven versus assumed

### Proven

- Exact C0 request/response validators and executable mock behavior.
- Locally generated bearer syntax and digest registration body.
- Narrow poll/send/read boundaries and machine-admin denial.
- Safe pending authorization behavior.
- Local file mode, schema, symlink, size, mismatch, erasure, and safe-summary
  behavior.
- Rotation and revocation order against the executable mock.
- Redirect and response-size controls in the Agent Relay boundary.

### Contract-backed but not production-dogfooded

- A real Notifications service verifies a newly generated bearer from the
  registered digest.
- A real Telegram subscription link transitions through human authorization.
- Hosted canary delivery beyond API acceptance.

The pinned C0 mock authenticates machine tokens from startup fixtures and does
not dynamically add a readable bearer when only its digest is registered. The
test therefore generates the real bearer locally, supplies it only to the mock's
in-memory authentication fixture, and independently asserts that the
registration request sends only `credential_id` and `secret_sha256`. This is a
test-harness accommodation, not a production credential path.

Production dogfood remains owned by AR3 and awaits an approved Notifications
environment and machine-client implementation. No production account or
credential is required for this story.

## Explicitly deferred

- daemon transport selection and readiness/doctor integration (FXO-1151);
- durable hosted poll/claim/resolve/ack state (FXO-1152);
- hosted resolution reflection and ongoing error policy (FXO-1153);
- three-transport parity suite (FXO-1154); and
- final packed mock end-to-end/release handoff (FXO-1155).

## References

- [`project-spec.md`](../project-spec.md)
- [`c0-07-prove-notifications-contract-consumer.md`](c0-07-prove-notifications-contract-consumer.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`packages/notifications-transport/README.md`](../../../../packages/notifications-transport/README.md)
