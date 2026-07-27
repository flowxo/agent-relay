# Progress ledger

## Proven

- GitHub PR #5 integrated the completed multi-session root `codex/initial-mvp`
  at `a4a6b5b` to `main` as merge commit `157006a`. The ordered C0,
  release-baseline, and AR1 heads remain reviewable draft PRs #2, #3, and #4;
  AR2 development starts from exact AR1 head `7624eb5` on
  `codex/ar2-notifications-adapter`. No package has been published.
- Linear initiative `Agent Relay — Open Source V1` owns four ordered
  implementation projects. AR1 is Completed with FXO-1141 through FXO-1149 and
  all five milestones at 100%. AR2 is In Progress and may use executable mocks;
  AR3 is blocked on AR2 and C0-09; AR4 follows dogfood evidence. Post-V1 hosted
  fleet explorations remain separate.
- C0-07 (FXO-1048) and C0-08 (FXO-1049) are Done. Agent Relay pins and verifies
  the exact three Notifications `1.0.0-draft.1` artifacts, runs a
  scripts-disabled clean consumer install, and proves mapping, retry,
  crash-before-ack replay, acknowledgement, quarantine, identity isolation,
  first-writer-wins local authority, and direct-Telegram parity.
- FXO-1150 implements the mock-backed Notifications setup lifecycle. A bounded
  administration client creates/reads/revokes machine clients and registers only
  locally generated credential digests. `agent-relay notifications` connects
  through a subscriber authorization link, proves exact binding/scope, zero-wait
  polls the narrow stream, sends a fixed canary, writes strict private `0600`
  configuration/credential files atomically, reports hashed safe status, rotates
  after replacement smoke-test, retains failed old-client revocations, and
  supports idempotent hosted revocation plus explicit local erasure.
  Twenty-eight focused tests cover environment/stdin/prompt secret input,
  positional rejection, pending authorization, HTTP/redirect/body bounds,
  redaction, complete and incomplete provisional cleanup, symlink/permission/
  mismatch/preflight failures, cross-machine isolation, new-client and
  same-client rotation, cross-origin refusal, bounded retained cleanup state,
  local-commit cleanup, revocation, and retained-state erasure. Production
  daemon selection is implemented by FXO-1151 and durable hosted polling by
  FXO-1152.
- FXO-1151 makes transport choice explicit and credential-independent. A strict
  private `transport.json`, `AGENT_RELAY_TRANSPORT`, and daemon-only
  `--transport` resolve with documented precedence across exactly `fake`,
  `telegram`, and `notifications`; default remains fake. Daemon fixtures prove
  that unselected Telegram credentials cause zero Telegram calls and that a
  selected hosted adapter alone delivers through the pinned Notifications mock.
  Switching retains the database and provider setup. Safe transport status and
  doctor output report selection, Telegram readiness, hashed hosted readiness,
  last send, local queue/retry/dead-letter counts, classified hosted error, and
  a terminal circuit without secrets, provider identities, message content, or
  raw session records. FXO-1152 replaces the former honest `not-started` polling
  placeholder with durable runtime evidence.
  Authentication/scope/binding/contract configuration failures suppress repeated
  remote calls while every affected local event remains durably diagnosed;
  transient failures keep the stable event identity and bounded SQLite retry
  policy. The final local gate passed `pnpm check`, including 46 Vitest
  files/358 tests, contract/distribution/package/lifecycle proof; the
  independent packed lifecycle rerun, all three Chromium scenarios, and
  `pnpm audit --prod` with no known vulnerabilities also passed.
- FXO-1152 implements the selected hosted interaction loop against the exact
  pinned `1.0.0-draft.1` client and mock. Interactive delivery commits hosted
  message/interaction/type identity to SQLite. Schema `2` adds hashed machine
  poll state, immutable hosted event claims, acknowledgement retry state, and
  message-update retry state. The daemon drains oldest acknowledgement work
  before bounded long polling, validates cursor continuity plus exact
  binding/message/request/machine/harness/session/turn/type/option/expiry
  identity, resolves through the existing first-writer-wins transition in the
  same transaction as the safe claim, and advances the cursor only after an
  identity-matching idempotent provider acknowledgement. Event payload digests
  detect mutation without retaining raw hosted responses. Retryable poll/ack
  failures back off; crash-before/after-ack recovery cannot duplicate a
  decision; poison is explicitly quarantined; integrity failures stop without
  acknowledgement or cursor skip. Focused SQLite, source, validator, poller,
  status, and running-daemon tests cover confirm/select/input, invalid option,
  stale/expired/duplicate/terminal races, wrong binding/session/turn, concurrent
  isolation, bounded timeout, shutdown, retry, restart, and the real mock-backed
  answer round trip. C0 does not expose a detached poll-response signature, and
  the implementation records authenticated schema/contract evidence without
  claiming one. Hosted terminal-message reflection remains FXO-1153. The final
  local gate passed 49 Vitest files/374 tests, 17 contract-lock and supply-chain
  tests, the six-test isolated Notifications consumer, the 187,517-byte
  packed/1,202,168-byte unpacked artifact proof, and the complete
  schema-1-to-schema-2 packed lifecycle. The focused hosted matrix passed 9
  files/73 tests, all three Chromium scenarios passed, and `pnpm audit --prod`
  found no known vulnerability.
- FXO-1153 makes hosted presentation a separate durable concern after local
  authority and provider acknowledgement. A supported presenter projects
  answered, duplicate, expired, cancelled, and unsupported states with one
  deterministic SHA-256 operation identity; response loss retries only that
  identity, and explicit provider ambiguity blocks without creating a second
  message or decision. Interrupted update leases recover from SQLite, while
  update failure cannot invoke resolution or continuation. The exact pinned
  draft.1 client has no resolved-message update method, so the shipped presenter
  records `notifications-resolution-update-unsupported` without HTTP or misusing
  cancellation. Hosted failures now map to retry, terminal-configuration,
  dead-letter/security, quarantine, or operator-action categories. Status/doctor
  expose only capability, counts, safe codes, categories, and hashed references.
  Repeated hosted failures are rate-limited in logs while every event/update
  remains durable. A runtime connection guard stops new send/poll/ack calls
  after disconnect, revocation, erase, or rotation; a running-daemon test proves
  local decisions/mappings survive and explicit reconnect plus restart resumes
  delivery. The focused matrix passed 10 files/93 tests. The final local gate
  passed 50 Vitest files/395 tests, 17 contract-lock and supply-chain tests, the
  six-test isolated Notifications consumer, the 190,583-byte
  packed/1,220,612-byte unpacked artifact proof, and the complete packed
  lifecycle. All three Chromium scenarios passed, and `pnpm audit --prod` found
  no known vulnerability.
- FXO-1154 adds one transport-neutral matrix that runs unchanged against the
  in-memory fake, the real direct `TelegramBotTransport`/reply router with a
  synthetic Bot API, and the exact Notifications transport/mock/poller. Twelve
  shared scenarios cover bounded delivery, duplicate ingestion, retry with the
  same event identity, confirm/select/input, local identity rejection, expiry,
  duplicate answers, both terminal/phone race orders, restart, and exactly one
  resume claim. All three transports reach equivalent local request/answer/
  resume outcomes within declared capability: fake/direct Telegram advertise
  message updates, while the pinned hosted observation advertises only proven
  confirm, single-select, and free-text with one question/six options. The
  matrix exposed a contract bug where local duplicate/expired reasons were sent
  on `processed` acknowledgements; they now remain in SQLite but are omitted
  from the provider request, as draft.1 requires. The 16-file focused parity,
  Telegram, hosted-safety, structured-interaction, resume, and canary matrix
  passed 146 tests. The final local gate passed 51 Vitest files/408 tests, 17
  contract-lock and supply-chain tests, the six-test isolated Notifications
  consumer, the 190,951-byte packed/1,221,519-byte unpacked artifact proof, and
  the complete packed lifecycle. All three Chromium scenarios passed, and
  `pnpm audit --prod` found no known vulnerability.
- Agent Relay PR #2 was open, draft, clean, and green at exact head `76240c4`
  when the V1 baseline was selected: CI, packaged Chromium E2E, and GitGuardian
  all passed. Central C0-09 (FXO-1050) remains In Progress and is still the gate
  for `1.0.0-rc.1`; this repository does not claim a cross-product go decision.
- The FXO-1141 baseline passed the release-candidate matrix locally on
  2026-07-26: frozen scripts-disabled install, Notifications artifact preflight,
  approved native rebuild, `pnpm check` (40 Vitest files/305 tests plus 17
  contract-lock/supply-chain tests and the six-test separate-process consumer
  proof), three packaged Chromium scenarios, and `pnpm audit --prod` with no
  known vulnerability. Repository scans found no tracked activation file,
  database, log, actual machine path, Telegram-token shape, or credential value;
  the local `.env.activation` remained gitignored and mode `0600`.
- FXO-1142 establishes the public governance boundary. The standard MIT license
  names Flow XO, LLC; all six workspace manifests declare `MIT`; security,
  privacy, support, conduct, and maintainer policies agree with implemented
  local state, outbound payload, retention, uninstall, and review behavior; and
  the issue chooser prevents blank or unsanitized bug reports.
  `pnpm governance:check` is part of the full quality gate. On 2026-07-26 the
  slice passed `pnpm check` (40 Vitest files/305 tests, 17 contract and
  supply-chain tests, and the six-test isolated Notifications consumer proof),
  all three Chromium end-to-end scenarios, `pnpm audit --prod`, YAML parsing,
  diff checks, and a credential/path scan.
- FXO-1143 adds a public landing path plus nine focused guides for architecture,
  lifecycle installation, Telegram, local web, troubleshooting, compatibility,
  transport extensions, harness extensions, and the optional hosted
  Notifications boundary. The guides distinguish native hook evidence,
  supervised exit proof, inline continuation, late CLI resume, and unsupported
  Cursor IDE resume; route new users through the fake canary before credentialed
  Telegram; and keep local operation independent of hosted accounts and
  Cloudflare. Primary Codex, Claude Code, Cursor, and Telegram sources were
  rechecked on 2026-07-26 without widening support beyond exact fixture/canary
  evidence. `pnpm docs:check` validates the guide set, local links, required
  boundary statements, onboarding order, and private-data patterns as part of
  `pnpm check`. The full 305-test/contract/distribution gate, all three Chromium
  scenarios, production audit, and an isolated compiled fake-daemon canary all
  passed.
- FXO-1144 establishes one standalone, private
  `@flowxo/agent-relay@0.1.0-alpha.0` CLI artifact without publishing it.
  Internal workspace code is bundled; exact `better-sqlite3@13.0.1` and
  `zod@4.4.3` remain external runtime dependencies; no programmatic export or
  declaration surface is claimed; and source maps are omitted after an explicit
  disclosure review. `pnpm package:check`, now part of the full gate, matched
  all 11 files to the allowlist, measured 100,883 packed and 474,271 unpacked
  bytes, rejected source/workspace/private-path leakage, installed with scripts
  disabled into an isolated prefix, explicitly rebuilt SQLite, and proved CLI
  help, one clean fake delivery, five static web assets, and the authenticated
  web API from an isolated home. The check caught and resolved Apple-silicon
  Rosetta Node metadata before acceptance. Registry scope ownership, trusted
  publishing, and actual publication remain owner-controlled gates.
- FXO-1145 advances the private candidate to `0.1.0-alpha.1` and proves the
  complete packed lifecycle against a deterministic sanitized `0.1.0-alpha.0`
  fixture. A quoted-path isolated home/prefix passes install dry run, install,
  healthy doctor, fake canary, stale package/entry diagnosis, upgrade dry run,
  reconciliation, unchanged repeat install, post-upgrade doctor/canary, owned
  uninstall, and package removal. The durable answered request, SQLite state,
  web credential, prior relay log, explicit retained credential/log fixtures,
  installer backups, and unrelated harness settings survive. Install manifests
  now record package version; doctor validates package/runtime/manifest and
  launcher agreement; owned paths reject symlinks; SQLite now migrates prior
  stores to schema `2`; and schema `3` is refused without modification. The
  lifecycle checker is part of `pnpm check` and publishes nothing. The final
  local gate passed 41 Vitest files/309 tests, 17 contract and supply-chain
  tests, the six-test isolated Notifications consumer, the 102,408-byte
  packed/479,554-byte unpacked artifact proof, all three Chromium scenarios, and
  a production audit with no known vulnerability.
- FXO-1146 replaces the manual two-source support interpretation with one
  runtime-validated `agent-relay-compatibility.v1` registry. It drives protocol
  flags, exact doctor expectations/evidence IDs, safe `agent-relay capabilities`
  output, the classified matrix, and identical generated README/SUPPORT
  summaries. The generator validates fixture files and evidence anchors and
  fails on drift. `verified`, `compatible-unverified`, `unsupported`, and
  `disabled` are explicit per capability; Cursor permission automation is now
  false at runtime. A non-model local check classified installed Claude Code
  `2.1.220` as drift from live-proven `2.1.219` without advancing the claim;
  Codex `0.145.0` and Cursor `2026.07.23-e383d2b` remained exact matches. The
  public bug form requests redacted doctor classifications, the safe capability
  record, evidence/diagnostic IDs, versions, environment, and a synthetic
  reproduction while prohibiting databases, logs, transcripts, secrets, and
  paths. The final local gate passed 41 Vitest files/311 tests, 17 contract and
  supply-chain tests, the six-test isolated Notifications consumer, the
  104,988-byte packed/491,088-byte unpacked artifact proof, the full packed
  lifecycle, all three Chromium scenarios, and a production audit with no known
  vulnerability.
- FXO-1147 establishes the bounded public contribution path. Node 22 and exact
  pnpm 11.17.0 setup, scripts-disabled frozen installation, focused checks, CI
  parity, browser/package proof, architecture ownership, commit expectations,
  security routing, and change-specific maintainer gates now live in
  `CONTRIBUTING.md`. Dedicated public forms distinguish bugs, compatibility
  evidence, transports, harness adapters, documentation, and planned
  security-sensitive design while steering actual vulnerabilities to private
  reporting and prohibiting credentials, databases, logs/configs, payloads,
  transcripts, identities, and machine paths. The PR template makes protocol,
  hook continuation, authority/resume, installer, redaction/web, migration/
  retention, transport authentication/outbound data, support, and release gates
  explicit. A new fixture policy plus `pnpm fixtures:check` enforces three exact
  manifests, 12 sanitized JSON fixtures, source/version/date/evidence/privacy
  metadata, a 64 KiB bound, regular-file/no-symlink rules, and common secret and
  private-path patterns. Seven Node tests cover malformed JSON, oversize,
  symlinks, non-JSON files, sensitive values, duplicate inventory, and missing
  provenance. All six issue forms parse as YAML. The final local gate passed 41
  Vitest files/311 tests, seven fixture tests, 17 contract and supply-chain
  tests, the six-test isolated Notifications consumer, the 105,127-byte
  packed/491,406-byte unpacked artifact proof, the full packed lifecycle, all
  three Chromium scenarios, and a production audit with no known vulnerability.
- FXO-1148 establishes a credential-free, least-privilege prerelease pipeline
  without authorizing publication. A clean checkout now produces exactly four
  reviewable files: the private `0.1.0-alpha.1` tarball, `SHA256SUMS`, an exact
  source/reproducibility manifest, and an SPDX 2.3 SBOM covering all 11 packed
  files plus the frozen three-package runtime dependency closure. The builder
  packs twice from the same commit timestamp and rejects different SHA-256
  digests; the verifier rejects changed artifacts, duplicate checksums,
  duplicate SBOM records, inventory drift, and source-commit mismatch. CI and
  prerelease actions are immutable-SHA pinned, install scripts remain disabled
  until the approved native rebuild, and production audit/browser/package gates
  are mandatory. Build and SBOM attestations have a separate minimal permission
  job; any future npm OIDC job requires that successful provenance job, an exact
  tag/workflow identity, a public canonical repository, manual input, and the
  protected `npm-prerelease` environment. Checked-in publication approval and
  registry action remain `false`/`blocked`, so neither the package nor the
  workflow can contact npm. On clean implementation commit `a331ab5`, two
  105,388-byte tarballs matched at SHA-256, the independent verifier reported
  four SPDX packages and 11 files, and all bundle checksums passed. The full
  local gate passed 41 Vitest files/311 tests, 15 release/secret-policy tests,
  seven fixture tests, 17 contract and supply-chain tests, the six-test isolated
  Notifications consumer, a 105,388-byte packed/492,013-byte unpacked artifact,
  the complete lifecycle, all three Chromium scenarios, and a production audit
  with no known vulnerability.
- FXO-1149 completes the AR1 native minimum-runtime exit gate. The exact
  clean-commit bundle was installed under the official hash-pinned and
  code-signature-checked Node.js 22.23.1 `darwin/arm64` runtime with npm 10.9.8
  on Apple-silicon macOS 26.5.2. A quoted temporary home and prefix received no
  credential variables and no linked workspace package. The reviewed SQLite
  lifecycle selected its arm64 prebuild and passed a real in-memory query.
  Doctor was healthy: Codex `0.145.0` and Cursor `2026.07.23-e383d2b` matched
  exact evidence, while Claude Code `2.1.220` remained an honest
  `compatible-unverified` warning against `2.1.219`. Install dry-run, install,
  unchanged reinstall, one fake delivery with zero retry/dead-letter, uninstall
  dry-run, owned uninstall, retained SQLite, npm removal, and zero remaining
  owned hooks passed. The ignored path-free evidence file was mode `0600` and
  contained only safe versions, hashes, evidence IDs, counts, booleans, and
  limitations. The enforced non-implementer guide answers what runs locally,
  what leaves, what changes, how to diagnose, and how to remove the product, and
  records the no-architecture-change AR2 handoff. No real home, credential, tag,
  release, attestation, registry, or production service was changed.
- AR1 closed in Linear on 2026-07-26 after all nine stories reached Done and all
  five milestones reached 100%. Draft PR #4 was clean at implementation head
  `345448e5a7293dacfe9c92d1400ec22c6351cd2e`; CI, packaged Chromium E2E, and
  GitGuardian all passed. The parent `Agent Relay — Open Source V1` initiative
  and its other projects were not changed during project reconciliation.
- Linear project `Agent Relay — Multi-Session Operator Experience` is marked
  Completed after all Phase 1-3 milestones reached 100%. Phase 4 hosted, Mini
  App, and multi-operator stories remain explicit deferred backlog outside the
  V1 acceptance boundary.
- Local harness versions and CLI resume help were observed on 2026-07-24 and
  2026-07-25, then recorded in `docs/harness-evidence.md`.
- Official stop, permission, failure, and resume contracts are represented as
  runtime-validated protocol types and sanitized synthetic fixtures.
- Capability differences are generated from code, including the explicit lack of
  Cursor IDE late resume and native process-crash proof.
- Milestone 0 is green locally: protocol and adapter contract tests cover all
  three harnesses, malformed and unknown inputs produce actionable diagnostics,
  native continuation JSON is exact, CLI resume invocations use argv arrays, and
  format, lint, typecheck, tests, capability drift check, and build pass.
- Milestone 1 is green locally. SQLite is the source of truth for sessions,
  events, leases, attempts, retries, dead letters, pending requests, and
  Telegram update claims. The fake transport completes the local
  ingest-to-delivery loop, while the Bot API adapter covers success, rate-limit,
  timeout, callback acknowledgement, and resolved-message edits.
- Milestone 2 is green locally. Opaque choice tokens and replied-to transport
  message IDs correlate answers to the expected machine, harness, session, and
  turn. Terminal and Telegram answers use one atomic first-writer-wins
  transition; duplicates, stale answers, unauthorized senders, timeouts, and
  concurrent sessions are covered.
- Milestone 3 is green locally. The opt-in CLI supervisor owns the child PID,
  classifies real exit codes, signals, forwarded termination, and startup
  failure, and requires runtime-validated `owned-child` evidence for every
  `process.exited` event. SQLite resume commands provide atomic ownership and an
  audited claimed/running/succeeded/failed lifecycle. A fake Telegram end-to-end
  test resumes the exact stopped Codex session once.
- Milestone 4 is green locally. The fallback spool applies deep secret redaction
  and bounded lossless rotation, atomically isolates replay workers, retains
  failed records, and durably reports malformed input. The daemon replays at
  startup and reconnect intervals.
- Installation is idempotent and transactional across the exact Codex, Claude,
  and Cursor user config paths. Clean install, repeated install, upgrade,
  uninstall preservation, malformed-config preflight, partial rollback, and path
  quoting are covered. Private backups and atomic writes protect existing
  configuration; uninstall leaves state, logs, credentials, and unrelated hooks
  untouched.
- Doctor checks the launcher, installed hook counts, SQLite and capability
  records, harness availability, and the exact locally tested versions. Version
  drift is a warning and a missing executable is a failure.
- Retention expires stale requests and prunes only terminal/proven-inactive
  records in bounded batches. Redacted rotating logs have fixed size/count
  limits and surface file-write failures through a fallback logger.
- Telegram reply intake defaults to local Bot API long polling. It validates
  update arrays, routes updates in order, advances offsets only after handling,
  retries diagnosed failures, and shuts down active polls cleanly. Webhook mode
  uses Telegram's secret independently of daemon bearer authentication.
- FXO-1051 is green against the fake transport and the Telegram Bot API 10.2
  contract. SQLite now owns one topic record per logical
  machine/harness/session/transport scope. Topic creation is lazy, atomically
  claimed before the transport call, retried through the owning event spool,
  durably diagnosed, and reused after database reopen. The fake transport proves
  repeated-event reuse, competing first deliveries, concurrent-session
  isolation, restart persistence, retryable and terminal failures, and
  path/secret-safe topic metadata. The real adapter fixtures prove
  `createForumTopic` parsing and `message_thread_id` delivery; live
  private-topic creation is not yet claimed.
- FXO-1052 is green locally. Every event uses the persisted topic ID on every
  delivery attempt. Retryable delivery failures preserve the mapping; duplicate,
  delayed, out-of-order, and interleaved events remain isolated. A
  transport-level missing-topic signal now invalidates only the stale mapping,
  emits a durable `topic.reconciliation-required` diagnostic, retries the owning
  event, and creates a replacement topic without falling back to the general
  chat. Telegram's missing-thread response and the full recreation path are
  covered by deterministic HTTP and fake-transport fixtures.
- FXO-1054 is green locally. Telegram output is now a compact, plain-text card
  containing sanitized session identity, event kind and age, a 480-character
  summary, and context-specific Continue, Details, Mute, and End actions. Action
  callback data is fixed, versioned, opaque, under Telegram's 64-byte boundary,
  and durably mapped back to the full local event; model text cannot supply it.
  Resolved requests are edited into answered, expired, superseded, or failed
  card states without echoing private answer text. Snapshots cover all ten event
  kinds plus all terminal states, and malformed/oversized rendering is bounded.
  The durable action registration is consumed by FXO-1053.
- FXO-1053 is green locally. Versioned card callbacks are runtime-validated
  against the configured operator/chat, original delivery message, session, and
  topic. SQLite commits first-writer-wins action state before Telegram
  acknowledgement. Continue resolves only an eligible durable continuation;
  Details posts once; Mute suppresses routine events but not questions or
  critical failures; End is blocked by open questions and explicitly closes only
  the relay lane. Duplicate taps never repeat an action. Malformed, unknown,
  unauthorized, stale, cross-message/topic, blocked, and failed callbacks emit
  useful responses and durable diagnostics.
- FXO-1055 is green locally. Authorized plain text inside a persisted session
  topic resolves only when exactly one open, unexpired free-text or continuation
  request is eligible there. Zero candidates produce `reply not used` guidance;
  multiple candidates require replying to the specific card; and button-only
  requests cannot be answered by ordinary chatter. Explicit replies bind the
  delivery message and the session topic. Cross-topic, unauthorized, stale,
  duplicate, concurrent, and guidance-delivery-failure paths are deterministic.
  Correlation diagnostics store the decision but never the rejected message
  text. The behavior is fake-transport proven; a credentialed direct-topic-text
  canary remains part of the Phase 1 live proof.
- FXO-1056 is green locally. Topic names preserve sanitized
  harness/repository/branch identity plus a readable session suffix and a
  collision-resistant digest, even at Telegram's 128-character bound. Durable
  topic status exposes running, waiting, muted, crashed, ended, and stale
  without renaming on every event. Missing and closed-topic fixtures invalidate
  only the stale mapping and create a replacement through the event retry spool.
  Interrupted creation is recovered in bounded restart batches, including an
  on-open migration/backfill for existing SQLite stores. Native session end and
  the End button are terminal relay-lane tombstones: delayed events are
  suppressed and delayed requests are canceled instead of resurrecting the lane.
  The private Telegram adapter does not claim the supergroup-only
  `closeForumTopic` contract.
- FXO-1057 is green locally. A configurable, rolling coalescing window updates
  one durable card only for exact-equivalent request-free stop/activity/start
  noise, with a visible count and latest timestamp. Questions, crashes, stale
  warnings, process/session events, and previously failed delivery attempts
  bypass coalescing. Edit failure is durably diagnosed and retries as a separate
  visible card. Mute/end suppression and every successful coalescing decision
  emit transcript-free diagnostics. Details now page a maximum-size event,
  expose the latest ten grouped events with the true count, and stop after eight
  Telegram-safe pages while retaining complete evidence in SQLite.
- FXO-1058 is green locally. Real-Telegram daemon startup now verifies
  `getMe.has_topics_enabled`, private-chat scope, and update-mode/webhook
  agreement before opening the service. Disabled topics and non-private chats
  fail closed instead of pretending General provides session isolation. Invalid
  tokens/chats, blocked bots, topic permission/mode failures, deleted/closed
  topics, webhook mismatch, concurrent polling, and transient failures have
  stable actionable codes. The living guide covers BotFather enablement, ID
  discovery, private environment activation, preflight, verification, recovery,
  and the explicit fake-only credential-free fallback.
- FXO-1059's fake acceptance matrix is green. The SQLite-backed fake transport
  suite proves two-session isolation, event and update deduplication, retry,
  daemon lease/restart recovery, malformed callbacks, timeout, stale-answer
  rejection, deleted-topic replacement without General fallback, and
  supervisor-proven crash delivery. The evidence is spread across the focused
  service, topic registry, card action, reply router, canary, and supervisor
  tests so each failure boundary can be reproduced independently.
- A credentialed Phase 1 Codex acceptance run on 2026-07-25 used the installed
  `codex-cli 0.145.0` Stop hook and Telegram Bot API 10.2. It proved lazy
  private topic creation, separate topics for concurrent supervised sessions,
  compact cards, direct topic-text correlation, Continue-button correlation,
  exact-session read-only resume, and durable SQLite answered/succeeded state
  with exit code zero for both interaction paths. Identifiers, prompts, answers,
  topic IDs, message IDs, credentials, and machine paths were not retained in
  git.
- The live Phase 1 run exposed two reliability defects before acceptance.
  Telegram can attach reply metadata that does not identify a request to
  ordinary topic text; the router now falls back only to the same topic's single
  eligible request while retaining strict stale, ambiguous, cross-topic, and
  button-only rejection. A daemon restart also caused a waiting supervisor to
  abandon its claim loop; claim failures now emit one durable diagnostic, retry
  with bounded backoff through the configured wait window, and log recovery.
  Both defects have regression tests.
- FXO-1060 is green locally. The provider-neutral
  `agent-interaction-request.v1`, answer, lifecycle, and capability schemas
  cover confirm, single-select, multi-select, free-text, and ordered question
  sets with stable IDs and bounded payloads. Runtime compatibility validation
  diagnoses duplicate/unknown IDs, empty options, invalid bounds, incompatible
  kinds, missing/reordered answers, unknown selections, text limits, and expiry.
  Canonical answers stay within the existing 4,000-byte durable continuation
  boundary, and a SQLite close/reopen test proves the first valid terminal
  answer remains authoritative. Sanitized fixtures and
  `docs/structured-interactions.md` document the lifecycle, privacy boundary,
  provider fallback vocabulary, and non-duplicating projection to the blocked
  FXO-1048 Notifications contract consumer.
- FXO-1062 is green locally. Single-choice requests with up to ten options use
  opaque bounded Telegram callback tokens; callbacks are bound to the retained
  request, delivered message, transport, session, topic, chat, and operator.
  SQLite commits before callback acknowledgement, and resolved cards show the
  selected label with their keyboards removed. Eleven through twenty options use
  a correlated numbered-text fallback without truncation. Fake-transport tests
  prove success, same-update and repeated-tap duplicates, expiry, malformed and
  unknown tokens, wrong operator, wrong topic, cross-session rejection, invalid
  numbers, and first-writer-wins behavior. The Telegram Bot API 10.2 request
  shape is retained as a sanitized fixture; current official documentation
  confirms the 64-byte callback-data boundary.
- FXO-1061 is green locally. Single-question multi-select requests now create a
  durable SQLite draft before delivery and render set/unset option buttons plus
  Submit and Cancel. Desired-state callbacks are idempotent, independent
  concurrent selections compose, selection bounds are enforced, and Submit
  atomically commits the ordered option-ID array through the existing
  first-writer authority before acknowledgement. Cancel leaves the answer null.
  Restart, retry, stale keyboard, timeout, terminal-first and Telegram-first
  races, final selected-label rendering, and bounded observable retention are
  covered against the fake Telegram transport.
- FXO-1063 is green locally. Ordered provider-neutral question sets now project
  to one durable Telegram wizard card with step-specific Back/Next controls,
  review and revision of prior answers, set-style multi-selects, final Submit,
  and Cancel. Partial answers and the exact current step survive SQLite restart.
  Submit validates and atomically commits one ordered
  `agent-interaction-answer.v1` before callback acknowledgement; stale
  navigation, incomplete steps, selection limits, expiry, terminal supersession,
  duplicate submit, and cross-topic/session callbacks are explicit and tested.
  Retention reports `questionSetDrafts`, and a sanitized Bot API 10.2 keyboard
  fixture records the tested projection. Telegram free-text capture is supplied
  by FXO-1064.
- FXO-1064 is green locally. Active structured free-text steps show the request,
  question order, prompt, bounds, multiline policy, and saved-draft state.
  Ordinary topic text is accepted only for one compatible active request;
  explicit card replies disambiguate simultaneous requests. SQLite-normalized
  text survives restart and can be replaced without resolving the parent before
  Submit. Empty, short, oversized, disallowed multiline, duplicate-update, late,
  and out-of-order text paths are explicit and tested. Private content is absent
  from diagnostics and Telegram card edits, final cards expose only a character
  count, and durable draft/final text follows the documented bounded request
  retention window.
- FXO-1065 is green locally. Runtime-validated provider observations record
  proven versus assumed status, evidence class, observed version, sanitized
  fixture, and official documentation. Every structured delivery now gates on
  the event-scoped harness continuation contract and the transport's advertised
  features, limits, and presentation modes. The request's ordered fallback is
  deterministic and persisted with the draft: compact buttons, mixed topic-bound
  direct text, or numbered confirm/single-select steps. Numbered structured
  replies retain exact request/card/session/topic correlation and update only
  the draft before Submit. Missing, malformed, assumed, or incapable providers
  and undeclared/unimplemented modes dead-letter visibly before transport
  delivery. Telegram Bot API 10.2 and the fake transport do not advertise local
  web handoff; that remains a Phase 3 assumption.
- FXO-1066 is green locally. The Phase 2 safety matrix is mapped in
  `docs/phase-2-safety-matrix.md` to protocol, store, transport, and fake
  Telegram tests. A structured delivery timeout now proves durable retry without
  losing the selected mode or draft. Callback acknowledgements retry immediately
  within a bounded two-attempt budget after SQLite commits; a recovered retry is
  logged, while exhaustion preserves the committed answer and emits a durable
  diagnostic instead of being swallowed. The matrix covers every required
  interaction kind, duplicate input, malformed/oversized payloads, partial
  restart, timeout and stale states, Cancel, supersession, first-writer races,
  same-topic ambiguity, cross-topic isolation, and unsupported capability
  fallback without live credentials.
- FXO-1068 is green locally. Daemon startup generates and reuses an independent
  mode-`0600` local-web bearer/CSRF credential and fails closed on symlinks,
  malformed content, or permissive file modes. Authenticated, bounded session,
  attention, and event-detail read models omit assistant transcripts, working
  paths, machine/session identifiers, callback tokens, stored answers, and
  process arguments. SQLite triggers produce a monotonically ordered,
  transcript-free change ledger; JSON cursor reads and SSE support replay by
  query cursor or `Last-Event-ID`, live delivery after connection, and explicit
  reset after retained-history gaps or database replacement. Browser mutations
  require loopback, exact same-origin, CSRF, bounded runtime-validated bodies,
  and an idempotency operation ID. They use the same expiry, identity, option,
  and first-writer authority as Telegram and terminal answers. Tests cover
  missing/wrong credentials, cross-origin requests, absent CSRF, oversized
  bodies, replay conflict, expired answers, safe response projection,
  concurrent-session isolation, live/reconnected streams, credential
  permissions, and restart cursor durability.
- FXO-1067 is green locally. The daemon serves a no-dependency, responsive local
  session board whose static shell contains no credential or relay data and is
  locked down by same-origin Content Security Policy, frame denial, no-referrer,
  and no-store headers. The bearer credential stays only in page memory.
  Authenticated snapshots render a stable key and the same readable,
  collision-resistant display identity as Telegram, plus harness, repository,
  branch, real lane state, last activity, and exact attention counts. Required
  state/repository/harness/search filters compose, while the global attention
  queue is expiry ordered and retains repository, branch, harness, and session
  identity. Deterministic reconciliation deduplicates sessions and requests,
  ignores regressive cursors, and remains stable across sixty interleaved
  sessions. The UI consumes the resumable authenticated stream through fetch,
  coalesces refreshes, and distinguishes empty, disconnected, reconnecting,
  credential-rotated, and heartbeat-stale states without presenting cached data
  as live. Source and compiled distributions both carry the four fixed static
  assets; no frontend runtime dependency was added.
- FXO-1069 is green locally. A bounded per-session timeline unions retained hook
  events, delivery attempts and retries, request creation/resolution, Telegram
  card actions, and harness continuation state without copying answers,
  transcripts, error messages, process arguments, or draft content. Event and
  request correlation IDs connect the full chain, and deterministic ordering is
  stable at timestamp ties. Default detail remains transcript-free; a distinct
  operator click calls the explicit reveal route for a secret-redacted
  2,000-character assistant excerpt. The UI renders both paths as text rather
  than markup. Diagnostic export returns at most 500 retained records and
  re-applies current secret and machine-path redaction to legacy rows before
  download. Retention tests prove pruned terminal sessions lose their timeline
  rather than presenting invented history, while the living API/onboarding guide
  maps event, request, diagnostic, and session retention to visible empty
  states.
- FXO-1070 is green locally. The local companion projects free-text,
  single-select, bounded multi-select, and ordered mixed question-set forms from
  the retained provider-neutral contracts. Browser submissions carry the stable
  session key, use runtime-validated typed responses, canonicalize selection
  order, validate `agent-interaction-answer.v1`, and resolve the same immutable
  SQLite request row as Telegram and terminal answers. Page-memory-only drafts
  survive live re-renders without entering browser storage. Request change
  events remove stale controls and name the winning surface without returning
  its private answer. Continue, Details, Mute, and End target an exact retained
  event; unavailable actions stay disabled, End never claims to terminate the
  harness, and session command operation IDs reject changed replays. Browser
  wins update the Telegram card through the interactive transport; failed edits
  preserve the committed action and create a durable sanitized diagnostic. Tests
  cover typed contract projection, invalid/bounded answers, canonical
  multi-selects, ordered question sets, Telegram-first races, operation replay
  conflict, stale events, cross-session rejection, and losing-surface updates.
- FXO-1071 is green locally. `web-demo` starts a separate fake-transport daemon
  with four concurrent sanitized sessions and no external credential or
  assistant transcript. The packaged console now negotiates an explicit API and
  asset version; the compiled-output gate verifies all five assets and both
  mutation schemas. A real headless Chromium suite proves page-memory draft
  recovery through SSE reconnect and complete daemon restart, a stale browser
  form after a Telegram-first answer, and a synchronized fake-Telegram/browser
  race with one durable winner. `AGENT_RELAY_WEB_ENABLED=0` and
  `daemon --no-web` create no web credential and return diagnosed 404s for all
  UI/web routes while health, hook APIs, SQLite, and fake-Telegram delivery
  continue. CI installs Chromium using Playwright's supported command and runs
  the browser proof with one worker. The living onboarding/API guides cover
  development and packaged startup, demo use, disablement, compatibility, and
  security/privacy defaults.
- The clean-commit verification gate exposed and now covers a fallback-spool
  replay race: a completed worker may remove its processing segment after a
  second worker's directory scan. A missing segment during stale-claim
  inspection is treated as a successful concurrent handoff, while all other
  filesystem errors remain visible.
- A compiled-distribution canary in an isolated temporary home proved dry-run
  install, install, healthy doctor output against all three local harness
  versions, idempotent reinstall, and ownership-safe uninstall without touching
  the real user home.
- A bounded `telegram-canary` command now refuses the fake transport and proves
  the real send/reply path when credentials are present. Its daemon-level test
  exercises synthetic delivery, authorized Telegram HTTP reply intake,
  replied-to-message correlation, durable resolution, exact challenge matching,
  and transcript-free result output against the fake transport.
- A credentialed private-chat activation on 2026-07-24 proved real Bot API
  delivery and long polling. An intentionally late reply was correlated and
  rejected as expired; a fresh direct reply was accepted from the configured
  operator, matched the canary challenge, and persisted as `answered` with
  `resolvedBy: telegram`. No token or private message content was printed or
  committed.
- The live activation exposed a race in which the daemon background worker could
  deliver an event before the canary's explicit drain claimed it. The canary now
  waits for the durable delivery receipt instead of reporting a false delivery
  failure, with a regression test for that interleaving.
- The compiled installer is active in the real user configuration. A subsequent
  doctor run found the owned launcher, the expected hook counts, a healthy
  SQLite store, and the exact tested Codex, Claude Code, and Cursor versions.
- A model-backed Codex CLI canary proved the installed Stop hook, real Telegram
  delivery, stale-reply rejection, exact-session reply correlation, and
  successful `codex exec resume`. The first non-interactive attempt also proved
  that Codex skips an untrusted user hook; the vetted automation retry used the
  documented one-invocation hook-trust override.
- The Codex canary exposed execution-authority widening: a read-only initial
  process resumed with full filesystem access. Late-resume policy is now derived
  once from the initial argv, defaults to read-only, preserves explicit sandbox
  and dangerous-bypass choices, and preserves the one-invocation hook-trust
  override. A second live exact-session resume reported read-only mode.
- A model-backed Claude Code CLI canary proved the installed Stop hook, real
  Telegram delivery, exact-session reply correlation, and successful
  `claude --resume` under the initial `plan` permission mode. An invalid initial
  invocation exited non-zero first; the owning supervisor produced and delivered
  a durable `process.exited` notification from observed child evidence.
- A model-backed Cursor CLI canary proved the current `2026.07.23-e383d2b`
  interactive Stop hook, real Telegram delivery, exact-session reply
  correlation, and successful `cursor-agent --resume=<session>`. The login flow
  auto-updated the initially observed CLI. The live run proved that workspace
  trust is retained without widening to `--force`, while the current `--print`
  initial path exits without emitting Stop and is not claimed.
- Supervisors now have an explicit `--max-resumes` bound. The last allowed
  resumed child cannot create another late-resume request, which keeps bounded
  canaries from leaving orphan continuations. Expected empty resume polls are no
  longer logged every 250 ms; claims and exceptional outcomes remain visible.
- A Cursor cleanup exposed that terminal stop signals can be normalized to exit
  status 130 or 143. The supervisor now treats that status as expected only when
  it matches a signal the owning parent actually observed and forwarded;
  unrelated non-zero exits remain durable crash events. Supervised hook version
  metadata also now overrides stale install-time metadata.
- The implementation gates pass all 311 unit/integration tests across 41 test
  files plus 3 Chromium end-to-end scenarios, including the SQLite-backed
  daemon, retries/dead letters, malformed ingress, hook fallback privacy, inline
  and late continuation, owned-child exit observation, stale answer rejection,
  concurrent-session isolation, installation rollback, retention, log rotation,
  Telegram poll/webhook intake, and the activation canary. The check also
  validates formatting, lint, types, capability drift, compiled package exports,
  static/API compatibility, web disablement, reconnect, stale forms, daemon
  restart, and cross-surface races. The exact committed tree is verified
  separately in a clean worktree. `pnpm audit --prod` reports no known
  vulnerabilities.

## Phase 1 reproduction

Run the deterministic acceptance matrix without credentials:

```sh
corepack pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
```

Run the credentialed boundary from a private, mode-`0600`, gitignored
`.env.activation` prepared as described in `docs/onboarding.md`:

```sh
pnpm build
set -a
. ./.env.activation
set +a

node apps/relay/dist/cli.js doctor
node apps/relay/dist/cli.js daemon
```

In a second terminal with the same environment, launch one bounded read-only
Codex continuation and keep the process open:

```sh
~/.agent-relay/bin/agent-relay run codex \
  --harness-version "$(codex --version)" \
  --max-resumes 1 \
  --resume-wait-ms 3600000 \
  -- exec --sandbox read-only \
  "Return a short sentinel and stop. If resumed, return the operator answer and stop."
```

In the new session topic, either tap **Continue** or type one direct answer
while exactly one request is open. Confirm the resumed child exits zero, then
inspect only state metadata:

```sh
sqlite3 "$HOME/.agent-relay/relay.sqlite" \
  "SELECT request_kind,state,resolved_by,COUNT(*) FROM pending_requests GROUP BY request_kind,state,resolved_by;"
sqlite3 "$HOME/.agent-relay/relay.sqlite" \
  "SELECT state,exit_code,COUNT(*) FROM resume_commands GROUP BY state,exit_code;"
```

The live proof is valid only when the Telegram topic/card appears, the
supervisor reports `resume.succeeded`, and SQLite shows a Telegram-resolved
request plus a succeeded exit-zero resume. The daemon and supervisor logs must
also remain free of silent delivery, hook, or correlation failures.

## Assumptions and open risks

- Cursor's permission payload evolves quickly; its fixture must be replaced by a
  sanitized live capture before permission automation is enabled by default.
- Cursor `--print` did not emit Stop on the tested build. The supported
  supervised initial path is interactive; the late-resume leg remains headless.
- Native hooks still cannot prove crashes. Crash reporting is supported only for
  processes launched through `agent-relay run`; the protocol rejects a
  `process.exited` event without owned-child evidence.
- Telegram's Bot API has no caller-supplied idempotency key. SQLite prevents
  normal duplicate messages and concurrent topic creators, but a process crash
  or ambiguous timeout after Telegram accepts a message or topic and before the
  receipt commits remains an at-least-once duplicate window.
- The real Telegram activation proves private-topic creation and direct
  private-chat interaction on the tested account. Rate limiting, network
  retries, webhook intake, and shutdown remain proven through deterministic HTTP
  fixtures rather than induced failures against the live account.
- Telegram retains unconfirmed Bot API updates for no longer than 24 hours.
  Local request retention cannot recover an upstream update after that window.
- Resume claims are deliberately at-most-once. A supervisor crash after the
  durable claim but before spawn leaves a visible `claimed` command for manual
  recovery instead of risking a duplicate resume.
- The supervisor never labels inactivity as a hang. `suspected_stalled` exists
  as a distinct state, but emission remains disabled until a harness-specific
  health probe supplies evidence.
- [PR #1](https://github.com/flowxo/agent-relay/pull/1) merged an earlier
  `codex/initial-mvp` slice to `main` on 2026-07-25. The later multi-session
  completion, Agent Relay C0 history, and FXO-1141 release-baseline work are not
  yet on `main`; branch and PR state must not be mistaken for a published
  release.
- Activation values remain only in a mode-`0600`, gitignored local environment
  file. Credential values, numeric account identifiers, private messages,
  harness session IDs, and machine-specific paths are not recorded in git.
- Browser end-to-end coverage currently uses current Chromium with the fake
  Telegram transport. Real Telegram activation remains proven separately, and
  Safari/Firefox compatibility is not yet claimed.
- GitHub private vulnerability reporting is unavailable while the repository
  remains private. The policy and exact private-report URL are ready, but
  enabling and verifying the feature is a mandatory part of the later,
  explicitly approved public-promotion step. No security email was invented.
- The pinned C0 mock authenticates readable machine tokens from startup
  fixtures; registering a digest does not dynamically add that bearer to its
  authentication map. FXO-1150 generates the real credential locally, supplies
  it only to the mock's in-memory auth fixture, and separately asserts that HTTP
  registration contains only the ID/digest. Real digest verification and human
  subscription activation remain contract-backed assumptions until C0-09/AR3
  production dogfood.
- The private pinned Notifications client/contract artifacts declare no
  distributable license metadata. They are bundled only into an unpublished
  local candidate today. C0 release promotion must resolve the final artifact
  license/notice boundary before public package publication.

## Next action

Complete FXO-1155 packed hosted proof and the AR3-ready operational handoff.
Production hosted dogfood must still wait for AR2 and a central C0-09 go
disposition. npm scope/publication and the monitored public security-contact
path remain owner-controlled promotion gates.

The former multi-session Phase 4 hosted fleet, Mini App, and multi-operator
explorations remain post-V1 backlog. They require separate product demand,
privacy, threat-model, cost, and hosting evidence rather than being folded into
AR2 or AR3.
