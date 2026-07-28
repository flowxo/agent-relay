# AR2.6: Prove the hosted adapter from the packed artifact

- **Status:** Complete
- **Linear issue:** [FXO-1155](https://linear.app/flowxo/issue/FXO-1155)
- **Project:** AR2 — FlowXO Notifications Transport Adapter
- **Milestone:** Transport parity and packed handoff
- **Branch:** `codex/ar2-notifications-adapter`
- **Contract:** exact pinned `@flowxo/notifications*` `1.0.0-rc.1`
- **Last reviewed:** 2026-07-28

## Outcome

The unpublished `@flowxo/agent-relay@0.1.0-alpha.1` release candidate now proves
the complete mock-backed hosted lifecycle from its installed public executable,
not a workspace import. The same proof also runs direct Telegram through the
real adapter, so the optional hosted path cannot replace or silently break the
independent transport.

This is the AR2 handoff to AR3. It proves the local adapter against exact
executable contracts and a loopback provider. It does not claim a production
Notifications account, real subscriber activation, real provider retention
terms, production deployment, or public package release. C0-09's separately
recorded `go` decision approves the exact RC contract but does not supply the
service environment AR3 needs.

## Clean-home proof

Run:

```sh
pnpm package:hosted:check
```

On the supported macOS runtime the command:

1. packs the exact current release staging directory;
2. installs the tarball with lifecycle scripts disabled into a temporary clean
   prefix and home;
3. explicitly rebuilds the approved `better-sqlite3` native dependency;
4. resolves the installed package by real path and rejects workspace/sibling
   runtime resolution;
5. verifies package version, public hosted commands, and absence of the
   verifier-only mock from the bundled CLI;
6. starts an adaptive loopback wrapper around the exact pinned contract mock;
7. runs `notifications connect` through the installed executable using
   credential stdin;
8. proves the generated narrow bearer matches the registered digest, while the
   broad bootstrap credential is neither retained nor returned;
9. verifies separate private mode-`0600` configuration and credential files;
10. selects Notifications explicitly and starts the installed daemon;
11. sends and resolves bounded confirm, single-select, and input requests;
12. blocks one provider acknowledgement after local commit, kills the daemon,
    restarts it, and proves one replayed acknowledgement and cursor commit;
13. verifies the exact rc.1 presentation capability is honestly `unsupported`
    without changing local resolution;
14. revokes the hosted machine client and erases local hosted configuration and
    credential material;
15. starts the same retained SQLite store under the fake transport and verifies
    all three local answers;
16. selects direct Telegram and runs the installed `telegram-canary` through the
    real transport/reply router against a bounded synthetic Bot API;
17. installs and uninstalls owned harness integration, proving owned launcher
    and manifest removal with SQLite retention;
18. removes the package and proves its executable is gone; and
19. emits a safe machine-readable proof record.

Unsupported operating systems explicitly skip only the installed native-runtime
portion. Contract-lock, package-content, release-policy, and supply-chain checks
remain required by the complete repository gate.

## Crash and authority boundary

The select answer is committed to SQLite before the mock acknowledgement socket
is dropped. The proof observes the retained local answer, sends `SIGKILL`, and
asserts that the provider cursor has not advanced. After restart, the daemon
drains the same durable acknowledgement before polling again. Exactly one cursor
commit appears and the existing local resume command remains the sole
continuation authority.

Disconnect and uninstall do not delete events, pending-request history, answers,
hosted mappings, diagnostics, or the SQLite spool. Revocation and hosted
credential/configuration erasure are separate explicit operations. Transport
fallback is also explicit; there is no dual send or automatic failover.

## Exact contract supply chain

`contracts/contract-lock.json` is the source of truth. Its SHA-256 at this
handoff is:

`ec17c566723032e04a4c58fc367ba4c0c9b0b2e161bc5cd286fe0789ec59f30e`

| Artifact                              | Version      | Archive SHA-256                                                    | Source commit                              |
| ------------------------------------- | ------------ | ------------------------------------------------------------------ | ------------------------------------------ |
| `@flowxo/notifications-contracts`     | `1.0.0-rc.1` | `02814c4ce1a963dbd8362eb270e42d9a42383f9257671a02f9f791bddfb00dc2` | `0e0198fc248468ec9f0cd8e06997faee55a2cb25` |
| `@flowxo/notifications`               | `1.0.0-rc.1` | `82d2136c35e0f9e5aa0ea3d67f1bae9c535f871c2bb13aa2e4cadcdbcb612c44` | `0e0198fc248468ec9f0cd8e06997faee55a2cb25` |
| `@flowxo/notifications-contract-mock` | `1.0.0-rc.1` | `9868dc62363b8119e001362c9c95be94dcadec370410f2a04bc86e9b49312e5e` | `0e0198fc248468ec9f0cd8e06997faee55a2cb25` |

The verifier imports those exact artifacts only from the pinned consumer
installation. The product tarball contains the client/contract code required by
the adapter but not the test-only mock. Existing gates reject version drift,
digest/source-commit drift, copied owner contracts, mutable references,
workspace links, and sibling runtime dependencies.

The package tarball digest is intentionally emitted by each proof run rather
than frozen here: packed source and documentation changes must change that
digest. Release evidence should record the digest from the exact clean commit
being reviewed.

## Privacy proof and defect found

Synthetic sentinels represent:

- broad and narrow credentials;
- subscriber, machine-client, binding, message, and cursor identities;
- question and answer text;
- hidden transcript content;
- an absolute worktree path; and
- an executable value.

The proof inspects bounded provider content, CLI setup/status output, daemon
stdout/stderr, the retained NDJSON diagnostic log, and bundled CLI source. None
may contain an inappropriate sentinel. The provider-content assertion also
requires the configured truncation marker.

This boundary test exposed that `delivery.succeeded` diagnostics logged the raw
local event ID and provider receipt message ID. The service now emits only
12-hex SHA-256 references derived from those identities, and a permanent unit
test excludes both raw values.

## Acceptance evidence

| Acceptance criterion                                | Evidence                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Installed artifact; no workspace/sibling dependency | Real-path assertion plus packed manifest/content gates                         |
| Setup and narrow credential                         | Public CLI connect, digest verification, private split files                   |
| Confirm/select/input                                | Three installed-daemon round trips through exact mock                          |
| Crash-before-ack replay                             | Dropped ack, `SIGKILL`, restart, one cursor commit                             |
| Explicit disconnect/uninstall and retention         | Remote revoke, local erase, fake-store readback, owned uninstall               |
| Direct Telegram unchanged                           | Real transport/reply router against synthetic Bot API                          |
| Safe diagnosis and payload                          | Provider/output/log/package sentinel scan and hashed delivery-log regression   |
| Exact immutable contract                            | Three version/digest/commit pins plus contract and isolated-consumer gates     |
| Release workflow enforcement                        | `package:hosted:check` is required by `pnpm check` and release-policy checking |

Final verification commands:

```sh
pnpm package:hosted:check
pnpm check
pnpm test:e2e
pnpm audit --prod
```

Final RC integration gate on 2026-07-28:

- `pnpm check`: 51 Vitest files / 409 tests, 17 contract-lock and supply-chain
  tests, six isolated Notifications consumer tests, the 192,228-byte packed /
  1,225,124-byte unpacked artifact, the hosted clean-home proof, and the
  complete prior-version lifecycle;
- `pnpm package:hosted:check`: confirm/select/input, crash-before-ack replay,
  safe unsupported presentation, revocation/erasure, retained authority, direct
  Telegram, owned uninstall, and privacy scan passed; the final tarball SHA-256
  was `a97ee80dc12ebe08f5e03e0e64738994258efaba891162a02effd829d1ec97f5`;
- `pnpm test:e2e`: all three packaged Chromium scenarios passed; and
- `pnpm audit --prod`: no known vulnerabilities.

## Proven versus deferred

### Proven locally

- The packed CLI contains and can operate the complete hosted adapter.
- The verifier-only mock is not bundled into the product.
- Setup, transport selection, delivery, interaction, local authority,
  acknowledgement replay, diagnosis, disconnect, retention, uninstall, and
  package removal work from an isolated installation.
- Direct Telegram remains an executable release path.
- The inspected artifact/output/log boundaries exclude the private proof data.

### AR3 and service-environment work

- C0-09 approved the exact release candidate. Public package publication and any
  production deployment remain separately controlled actions.
- AR3 must prove real human subscription activation, registered-digest bearer
  verification, hosted delivery/reply/recovery, and production retention/privacy
  terms.
- A real resolved-message update remains an optional future exact Notifications
  capability; rc.1 safely reports it as unsupported.

## References

- [`project-spec.md`](../project-spec.md)
- [`ar2-5-transport-parity.md`](ar2-5-transport-parity.md)
- [`docs/hosted-notifications.md`](../../../hosted-notifications.md)
- [`docs/packaging.md`](../../../packaging.md)
- [`packages/notifications-transport/README.md`](../../../../packages/notifications-transport/README.md)
