# Project specification: Open Source Release Readiness

- **Status:** Complete; FXO-1141 through FXO-1149 are Done
- **Product:** Agent Relay
- **Initiative:**
  [Agent Relay — Open Source V1](https://linear.app/flowxo/initiative/agent-relay-open-source-v1-664f633c9408)
- **Wave:** `wave:1-independent-alpha`
- **Priority:** High
- **Linear project:**
  [AR1 — Agent Relay Open Source Release Readiness](https://linear.app/flowxo/project/ar1-agent-relay-open-source-release-readiness-b2b3bf7d5fe3)
- **Owning repository:** `agent-relay`
- **Last reviewed:** 2026-07-28

## 1. Why this project exists

Agent Relay's prototype already proves its local event, delivery, decision,
resume, privacy, installer, and diagnostic architecture. The next risk is not
whether the code can work; it is whether another developer can safely install,
understand, operate, update, remove, and contribute to it without access to the
original implementation conversation.

This project turns a successful private prototype into a release-quality
open-source product boundary.

It does not publish the final V1 release. It makes the repository, package,
governance, compatibility policy, and release pipeline ready so the
Notifications adapter and hosted dogfood can complete before the stable release
is cut.

## 2. Outcome

At project completion:

1. the project includes the approved MIT license and copyright notice;
2. users can understand data flow, privacy, security, support, and limitations
   from the repository;
3. a clean macOS machine with a supported Node.js version can install a packed
   release artifact, run doctor, install hooks, complete a local canary, and
   uninstall safely;
4. the package boundary contains no repository-relative runtime assumptions;
5. maintainers can produce a versioned prerelease through a protected,
   reproducible release workflow;
6. published artifacts have provenance and checksums;
7. harness compatibility is generated from code and tied to explicit evidence;
8. vulnerability and contribution paths are clear; and
9. the optional hosted-service boundary is documented without making hosted use
   a condition of local operation.

## 3. Existing evidence

This project begins from completed evidence, not an architectural rewrite:

- all requested prototype milestones pass;
- direct Telegram send/reply is credentialed and proven;
- Codex, Claude Code, and Cursor CLI stop/reply/resume canaries are proven;
- local SQLite is authoritative;
- terminal/phone decisions are atomic;
- installer operations are transactional and reversible;
- fallback, retry, dead-letter, retention, and redaction paths are tested;
- compiled-distribution install/doctor/uninstall is proven in an isolated home;
  and
- `pnpm check` passes the repository's full test and build gate.

Canonical details:

- `docs/progress.md`
- `docs/harness-evidence.md`
- `docs/capability-matrix.md`
- `docs/implementation-brief.md`

The Open Source V1 candidate preserves the completed multi-session MVP and
descends through the coherent Agent Relay C0 consumer/compatibility history.
[PR #2](https://github.com/flowxo/agent-relay/pull/2) integrated the approved
`1.0.0-rc.1` contract candidate, and PRs #3 and #4 integrated the release
baseline and AR1 evidence. C0-09 recorded `go`; none of those actions
constitutes a public Agent Relay package release or a production Notifications
deployment.

Cursor permission automation remains disabled until a current sanitized live
payload is captured. This is an explicit limitation, not unfinished V1 work.

## 4. Users and jobs

- **New user:** decide whether Agent Relay is safe, install it, receive a
  notification, and remove it if unsatisfied.
- **Existing user:** upgrade without losing configuration, local state, or
  unrelated hooks.
- **Security reviewer:** understand execution authority, data leaving the
  machine, stored secrets, and vulnerability reporting.
- **Contributor:** set up development, find an appropriate extension point, run
  the same checks as CI, and propose a bounded change.
- **Maintainer:** classify compatibility, review changes, create a reproducible
  release, and support a documented surface.
- **Hosted-service evaluator:** understand that FlowXO Notifications is optional
  and replaceable.

## 5. Scope

### 5.1 Included

- Open-source license and copyright notices.
- Public product README structure.
- User-facing architecture document.
- Privacy, security, support, compatibility, and hosted-boundary documents.
- Contribution guide, code of conduct, issue/PR templates, and maintainer
  expectations.
- Changelog and versioning policy.
- Package naming and public/private workspace decisions.
- Reproducible packed artifact.
- macOS installation and upgrade path for the Node-based V1.
- Release-candidate versioning.
- CI gates for package contents, install smoke, clean-home canary, and secret
  scanning.
- Dependency audit and lockfile policy.
- Artifact checksums, software bill of materials, and build provenance.
- Protected release workflow with least-privilege credentials.
- GitHub release notes and rollback/yank procedure.
- Generated harness compatibility and evidence policy.
- Documentation of direct Telegram and future hosted Notifications as
  replaceable transports.

### 5.2 Explicitly excluded

- Rewriting local protocol, SQLite, daemon, installer, or supervisor
  architecture.
- Enabling Cursor permission automation without evidence.
- Windows or Linux support claims.
- Native macOS application packaging.
- Automatic background service installation unless separately specified.
- Hosted account, fleet dashboard, or telemetry service.
- FlowXO Notifications adapter implementation.
- Public stable V1 release; that occurs after hosted dogfood.
- Guaranteed support for untested future harness versions.
- Code signing/notarization for a native binary that does not exist.

### 5.3 Follow-on projects

- AR2 implements the FlowXO Notifications transport.
- AR3 runs sustained hosted dogfood and resolves defects.
- AR4 publishes stable Open Source V1.

## 6. Product behavior

### 6.1 Evaluate

The repository landing experience must answer, before installation:

- what problem Agent Relay solves;
- which harnesses/surfaces are supported;
- what it can and cannot resume;
- what runs locally;
- what leaves the machine;
- whether hosted services are required;
- what hook/config files change;
- which operating systems and runtimes are supported;
- how to remove it; and
- where to report a security issue.

The first page should not require reading the long control-plane design.

### 6.2 Install from a release artifact

The supported prerelease flow is:

1. install the published Node package or a locally packed equivalent;
2. run `agent-relay install --dry-run`;
3. inspect exact planned paths and changes;
4. run `agent-relay install`;
5. run `agent-relay doctor`;
6. configure one chosen notification transport; and
7. run a bounded canary.

The package must expose the `agent-relay` executable.

The package name `agent-relay` is already occupied on npm by another project.
The recommended package name is `@flowxo/agent-relay`, subject to maintainer
control of the npm scope.

### 6.3 Upgrade

An upgrade:

- installs a new package version through the package manager;
- runs an explicit `agent-relay install --dry-run` and `install` to reconcile
  owned hook entries;
- migrates SQLite forward when the daemon next opens it;
- preserves local state, credentials, logs, and unrelated hook configuration;
- refuses unsafe schema downgrade;
- updates the install manifest and launcher target idempotently; and
- lets doctor identify a package/runtime/manifest mismatch.

The release documentation must say when an install reconciliation is required.

### 6.4 Uninstall

Uninstall:

- removes only launcher and hook entries bearing Agent Relay ownership;
- preserves unrelated config;
- preserves SQLite, logs, credentials, backups, and retained answers by default;
- states the exact optional paths a user may remove manually to erase retained
  state; and
- never treats package-manager removal alone as hook cleanup.

The docs must put `agent-relay uninstall` before package removal.

### 6.5 Compatibility

Compatibility is evidence-based:

- `verified`: exact harness surface/version has current fixture and canary
  evidence;
- `compatible-unverified`: contract parses and version drift is only a doctor
  warning, but no compatibility claim is made;
- `unsupported`: required binary/surface/capability is absent or known
  incompatible; and
- `disabled`: code may understand a contract, but the capability is
  intentionally off pending evidence.

The generated capability matrix is authoritative for features. A hand-written
README table may summarize it but must fail CI if it drifts.

### 6.6 Failure and support

Users should be able to provide:

- version;
- operating system and architecture;
- redacted doctor output;
- harness version;
- capability record;
- redacted diagnostic IDs; and
- reproduction steps

without attaching the SQLite database, transcript, token, username, hostname,
working path, or private message.

Bug templates explicitly warn against uploading secrets or private databases.

## 7. Package and repository architecture

### 7.1 Workspace publication boundary

The monorepo keeps:

- `@agent-relay/protocol`
- `@agent-relay/harnesses`
- `@agent-relay/core`
- `@agent-relay/relay`

as internal workspace boundaries during V1.

One public package, recommended as `@flowxo/agent-relay`, contains the compiled
CLI and all required runtime code. Publishing several internal packages adds
version coordination and support surface without current user value.

Implementation may either:

- bundle internal workspace code into the public CLI artifact; or
- publish it as private implementation files inside one npm package.

It must not rely on `workspace:*`, repository paths, TypeScript source, test
fixtures, or root dev dependencies at runtime.

### 7.2 Package contents

The public artifact includes only:

- compiled runtime JavaScript;
- required type declarations for supported programmatic exports;
- executable entry point;
- package metadata;
- README, LICENSE, CHANGELOG, and necessary notices; and
- small runtime assets explicitly required by the product.

It excludes:

- activation environment files;
- tests and private test data;
- repository-only design material not intended for package users;
- source maps if their disclosure/security/cost tradeoff is not accepted;
- build caches;
- local databases/logs;
- git metadata; and
- unused workspace packages.

A package-content snapshot and maximum unpacked-size budget fail CI on
unexpected expansion.

### 7.3 Local data remains local

The installed package uses the existing `~/.agent-relay` state boundary and
interface-driven storage/transport model.

Release work may not:

- move local authority to FlowXO;
- add default telemetry;
- upload transcripts or code;
- require a Cloudflare service;
- put executable commands into notification payloads; or
- make Notifications credentials necessary for direct Telegram.

### 7.4 No Cloudflare runtime assumption

Agent Relay is an open-source local Node application. Hosted adapters may call
Cloudflare-hosted services, but protocol, SQLite, hook, installer, daemon, and
continuation packages remain ordinary Node/macOS code behind interfaces.

## 8. Documentation set

Required root/public documents:

| Document             | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `README.md`          | Product, support matrix, quick start, architecture summary, privacy summary, links |
| `LICENSE`            | Approved license text                                                              |
| `NOTICE` if required | Attribution and notices                                                            |
| `SECURITY.md`        | Supported versions, private report path, response expectations                     |
| `PRIVACY.md`         | Local data, outbound payloads, retention, credentials, telemetry                   |
| `SUPPORT.md`         | Supported OS/runtime/harnesses, issue information, non-goals                       |
| `CONTRIBUTING.md`    | Setup, checks, architecture boundaries, fixtures, review expectations              |
| `CODE_OF_CONDUCT.md` | Contributor behavior                                                               |
| `CHANGELOG.md`       | Versioned user-visible changes and compatibility notes                             |

Required focused docs:

- public architecture and threat-boundary overview;
- installation, upgrade, and uninstall;
- direct Telegram setup;
- transport-contributor guide;
- harness-adapter contributor guide;
- safe fixture and provenance guide;
- compatibility/evidence policy;
- release process;
- hosted Notifications boundary; and
- troubleshooting/doctor interpretation.

Long existing design/evidence documents stay available but are not substitutes
for the user-facing versions.

## 9. Security, privacy, and governance

### 9.1 License

Agent Relay uses the MIT license. The repository includes the standard license
text and an accurate copyright notice. Published packages and release artifacts
declare the same license consistently.

### 9.2 Vulnerability reporting

Recommended initial path:

- enable GitHub private vulnerability reporting;
- point `SECURITY.md` to that private path;
- document which versions receive fixes;
- prohibit public issues containing exploit details or secrets; and
- avoid inventing a security email address until an owned monitored address
  exists.

### 9.3 Telemetry

Open Source V1 sends no product analytics or crash reports by default.

Local redacted logs and doctor output are user-controlled. Any future opt-in
telemetry requires a separate specification covering payload, consent,
retention, endpoint, and disablement.

### 9.4 Dependency and release security

- Lockfile is committed.
- Production audit runs in CI/release.
- Automated dependency updates are reviewed, not auto-released.
- Release workflow has contents/package permissions only where required.
- npm publication uses trusted publishing/OIDC if supported by the chosen scope
  and registry at implementation time.
- Build provenance and checksums are attached to the GitHub release.
- An SBOM covers the distributed artifact.
- Release jobs build from the tagged commit, not an uncommitted workspace.
- No long-lived registry token is stored when trusted publishing is available.

### 9.5 Contribution boundaries

Changes to the following require maintainer/security review:

- protocol schemas;
- hook continuation output;
- execution-authority, sandbox, or trust propagation;
- resume claim ownership and session correlation;
- installer paths, merge behavior, rollback, or uninstall ownership;
- secret redaction, local web authentication, or CSRF;
- SQLite migrations/retention;
- transport authentication or callback validation;
- default outbound payload; and
- supported capability, operating-system, harness-version, or runtime claims;
  and
- package contents, dependencies, provenance, or release workflows.

Ordinary docs, fixtures, provider adapters behind interfaces, and diagnostics
may use normal review after tests pass. Every ordinary JSON fixture follows
`docs/fixtures.md`, stays at or below 64 KiB, and appears in an exact manifest
with source, version, date, evidence class, and privacy metadata. Vendored
artifacts remain governed by immutable contract locks rather than fixture
manifests.

## 10. Versioning and release model

### 10.1 Version scheme

Use semantic versioning for the public package.

Recommended progression:

- `0.1.0-alpha.N`: package/release pipeline and clean-machine testing;
- `0.1.0-beta.N`: Notifications transport and hosted dogfood;
- `1.0.0`: supported Open Source V1 after AR3 exit evidence.

Before 1.0, breaking changes are still documented explicitly and migration paths
protect installed state.

### 10.2 Changelog

Each release records:

- user-visible features/fixes;
- security changes;
- supported harness evidence changes;
- config/installer changes;
- SQLite migrations;
- payload/privacy changes;
- breaking changes and required action; and
- known limitations.

Generated commit lists do not replace curated release notes.

### 10.3 Rollback and yanking

- A bad prerelease may be deprecated in npm and its GitHub release marked.
- Do not delete a published version as the normal correction path.
- Publish a fixed version and clear upgrade guidance.
- Database migrations are forward-only; rollback uses the last compatible binary
  only when its schema support is explicit.
- A compromised release triggers credential/provenance review and a security
  advisory.

## 11. Test and release evidence

### 11.1 Existing quality gate

`pnpm check` remains required and covers formatting, lint, types, tests,
capability drift, and distribution build.

### 11.2 New packaging checks

- build from clean checkout;
- `pnpm install --frozen-lockfile`;
- create the exact publish artifact;
- inspect file list and size;
- install artifact in an isolated temporary prefix/home;
- invoke `agent-relay --help` or equivalent command surface;
- dry-run install;
- install;
- doctor;
- fake-transport canary;
- idempotent reinstall;
- upgrade from the prior prerelease fixture;
- ownership-safe uninstall;
- package removal leaves no owned hook entry; and
- source/workspace paths are absent from generated launcher/runtime imports.

### 11.3 macOS clean-machine matrix

Required before AR1 exit:

- current supported macOS arm64;
- current supported Node 22 line;
- clean user home;
- at least one installed supported harness for the full doctor/install canary;
  and
- no globally linked repository packages.

Node 24 CI may be additive, but the documented minimum must have a real
packaging canary.

Intel macOS is not claimed until tested.

### 11.4 Security checks

- production dependency audit;
- secret scan;
- package file review;
- no activation values or private fixtures;
- malicious/malformed config installer regression;
- path quoting and ownership regression;
- no transcript/message in canary output; and
- SBOM/provenance validation.

## 12. Rollout

1. Prepare all documentation and packaging changes without publishing.
2. Produce local pack artifact and clean-home evidence.
3. Produce GitHub Actions artifact from an untagged/release-candidate commit.
4. Confirm npm scope and trusted publisher configuration.
5. Publish restricted prerelease tag.
6. Install prerelease on internal FlowXO machines.
7. Re-run existing real harness/Telegram canaries where risk justifies it.
8. Begin AR2/AR3 using prerelease versions.
9. Publish stable 1.0 only in AR4.

Release publication is an external mutation and requires explicit maintainer
approval at execution time.

## 13. Decisions already made

- Agent Relay is open source.
- Local state and continuation authority remain local.
- SQLite is the default durable store.
- Direct Telegram remains supported.
- Hosted Notifications is optional and replaceable.
- Open Source V1 is macOS/Node-based and does not claim Windows/Linux.
- Cursor IDE late resume is unsupported.
- Cursor permission automation remains disabled pending live evidence.
- Agent Relay uses the MIT license.
- One public package is preferable to publishing all internal workspaces.
- Default telemetry is off.
- Stable 1.0 follows hosted dogfood rather than preceding it.

## 14. Decisions deliberately left to implementation

Implementation agents may decide:

- bundler/build implementation that meets the single-package contract;
- documentation information architecture within the required set;
- package-content snapshot format;
- SBOM generator;
- checksum file format;
- issue form layout; and
- internal release script/module organization.

They may not choose npm owner/scope credentials, security contact, stable
release date, or supported OS claim.

## 15. Open decisions

### 15.1 npm scope and package name

`agent-relay` is occupied. `@flowxo/agent-relay` returned no package on
2026-07-25 and is the recommended name, subject to verified FlowXO npm scope
control.

- **Decision owner:** repository/npm scope owner.
- **Required before:** trusted-publisher setup and first prerelease.

### 15.2 Security reporting contact

**Recommended:** GitHub private vulnerability reporting first; add a monitored
email only when one is operationally owned.

- **Decision owner:** maintainer.
- **Required before:** public repository promotion.

### 15.3 Source maps in the public artifact

**Recommended:** include source maps only if they contain no local paths or
private source material and materially improve support; otherwise retain them in
CI artifacts rather than npm.

- **Decision owner:** maintainer/security review.
- **Required before:** package-content freeze.

## 16. Delivery slices

1. **Governance baseline** — MIT license, security reporting, support,
   contribution, conduct, and privacy policies.
2. **Public product documentation** — concise architecture, install, transport,
   compatibility, troubleshooting, and hosted boundary.
3. **Single-package distribution** — clean packed artifact with stable CLI.
4. **Safe install/upgrade lifecycle** — released artifact survives install,
   reconciliation, doctor, upgrade, and uninstall.
5. **Protected release pipeline** — provenance, SBOM, checksums, prerelease, and
   rollback procedure.
6. **Release-readiness evidence** — clean macOS/Node minimum canary and
   documentation walkthrough by a non-implementer.

## 17. Story map

Linear is authoritative for execution status and relationships. Material
implementation stories receive a companion file under:

`docs/projects/open-source-release-readiness/stories/`

| Order | Linear story                                                                                                                              | Purpose                              | Primary prerequisite                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| 0     | [FXO-1141 — Establish one authoritative V1 roadmap and release-candidate baseline](https://linear.app/flowxo/issue/FXO-1141)              | Remove branch/source-of-truth drift  | Green Agent Relay C0 candidate        |
| 1     | [FXO-1142 — Add the MIT license, security-reporting path, and maintainer policy](https://linear.app/flowxo/issue/FXO-1142)                | Establish legal/trust boundary       | Owner contact decisions               |
| 2     | [FXO-1143 — Explain architecture, privacy, execution authority, and hosted boundaries publicly](https://linear.app/flowxo/issue/FXO-1143) | Let users evaluate safely            | Charter and evidence baseline         |
| 3     | [FXO-1144 — Make one Agent Relay release artifact installable without the monorepo](https://linear.app/flowxo/issue/FXO-1144)             | Establish distribution boundary      | Package identity candidate            |
| 4     | [FXO-1145 — Prove install, doctor, upgrade, and uninstall from packed artifacts](https://linear.app/flowxo/issue/FXO-1145)                | Protect user configuration and state | FXO-1144                              |
| 5     | [FXO-1146 — Publish compatibility and support policy from generated evidence](https://linear.app/flowxo/issue/FXO-1146)                   | Prevent unsupported claims           | Existing capability generator         |
| 6     | [FXO-1147 — Add contributor workflow, issue forms, review gates, and safe fixture guidance](https://linear.app/flowxo/issue/FXO-1147)     | Enable bounded contributions         | Governance and public boundary        |
| 7     | [FXO-1148 — Build a least-privilege prerelease pipeline with provenance, SBOM, and checksums](https://linear.app/flowxo/issue/FXO-1148)   | Produce reproducible prereleases     | FXO-1142 and FXO-1144                 |
| 8     | [FXO-1149 — Complete clean-machine minimum-runtime and package-content release evidence](https://linear.app/flowxo/issue/FXO-1149)        | AR1 exit gate                        | FXO-1142 through FXO-1148 as relevant |

## 18. Acceptance evidence

- MIT license/copyright and security path are present and consistent.
- All required public documents exist and agree.
- A user can understand default outbound data without reading code.
- Packed package contains only approved files and runs without workspace
  symlinks.
- Clean-home install/doctor/canary/reinstall/uninstall passes.
- Upgrade from the preceding prerelease preserves SQLite and hook ownership.
- Documented minimum Node version is exercised in CI or a recorded canary.
- Capability matrix and support summary cannot drift.
- CI release artifact has SBOM, checksum, and provenance evidence.
- No long-lived registry credential is needed when trusted publishing is used.
- Public issue templates warn against secrets/private databases.
- Direct Telegram and no-hosted-service paths remain clear.

## 19. Definition of done

- Repository is legally and operationally ready for public contributors.
- One prerelease artifact can be built reproducibly.
- Publishing the artifact requires only explicit owner approval and registry
  configuration, not new architecture.
- User installation and removal are documented and tested from the artifact.
- Support and compatibility claims match actual evidence.
- Security/privacy boundaries are reviewable.
- Deferred hosted transport and stable release work remain in AR2–AR4.

## 20. References

- `docs/product/open-source-v1-charter.md`
- `docs/progress.md`
- `docs/harness-evidence.md`
- `docs/capability-matrix.md`
- `docs/implementation-brief.md`
- `docs/agent-attention-control-plane-design.md`
