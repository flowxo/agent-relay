import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertFrozenEvidenceProvenance } from "./lib/v1-release-boundary.mjs";

const root = resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`V1 release-boundary drift: ${message}`);
  }
}

async function source(path) {
  return await readFile(resolve(root, path), "utf8");
}

async function json(path) {
  return JSON.parse(await source(path));
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(resolve(root, path)))
    .digest("hex");
}

function requireText(text, pattern, message) {
  assert(pattern.test(text), message);
}

const boundary = await json("packaging/v1-release-boundary.json");
const release = await json("packaging/release.json");
const rootPackage = await json("package.json");
const contractLock = await json("contracts/contract-lock.json");
const capabilitySource = await source("packages/harnesses/src/capabilities.ts");
const installerSource = await source("apps/relay/src/installer.ts");
const doctorSource = await source("apps/relay/src/doctor.ts");
const storeSource = await source("packages/core/src/store.ts");
const fallbackSpoolSource = await source("apps/relay/src/fallback-spool.ts");
const serviceSource = await source("packages/core/src/service.ts");
const transportConfigSource = await source(
  "apps/relay/src/transport-config.ts",
);
const webhookConfigSource = await source("apps/relay/src/webhook-config.ts");
const whooshBangConfigSource = await source(
  "apps/relay/src/whooshbang-config.ts",
);
const whooshBangMappingSource = await source(
  "packages/whooshbang-transport/src/mapping.ts",
);
const whooshBangTransportSource = await source(
  "packages/whooshbang-transport/src/transport.ts",
);
const relayCliSource = await source("apps/relay/src/cli.ts");
const runnerBridgeConfigSource = await source(
  "apps/relay/src/runner-bridge-config.ts",
);
const runnerBridgeStoreSource = await source(
  "packages/runner-bridge/src/store.ts",
);
const packageCheckSource = await source("scripts/check-package.mjs");
const hostedPackageCheckSource = await source(
  "scripts/check-hosted-package.mjs",
);
const lifecycleCheckSource = await source(
  "scripts/check-package-lifecycle.mjs",
);

assert(
  boundary.schema === "agent-relay-v1-release-boundary.v1",
  "schema differs",
);
assert(
  boundary.package.name === release.name && release.name === rootPackage.name,
  "package name differs",
);
assert(
  boundary.package.version === "0.1.0-alpha.2" &&
    release.version === "0.1.0-alpha.3" &&
    release.version === rootPackage.version &&
    release.priorFixtureVersion === boundary.package.version,
  "published and successor package versions differ from the immutable boundary",
);
assert(
  boundary.package.intendedTag === "v0.1.0-alpha.2" &&
    release.gitTag === "v0.1.0-alpha.3",
  "published or successor intended tag differs",
);
assert(
  boundary.package.tagStatus === "published-immutable" &&
    boundary.package.publicationCompleted === true,
  "published tag boundary differs",
);
assert(
  boundary.package.publicationApproved === true &&
    release.publication.approved === false &&
    release.publication.registryAction === "blocked",
  "published approval or successor publication block differs",
);
assert(
  boundary.releaseAuthorization.decision ===
    "go-with-named-nonblocking-residuals" &&
    /^https:\/\/linear\.app\/flowxo\/issue\/FXO-1574\//.test(
      boundary.releaseAuthorization.decisionReference,
    ) &&
    /^https:\/\/linear\.app\/flowxo\/issue\/FXO-1164\//.test(
      boundary.releaseAuthorization.executionIssue,
    ) &&
    release.publication.decision === "not-authorized-for-alpha.3" &&
    release.publication.decisionReference === null &&
    release.publication.executionIssue === null,
  "owner decision binding differs",
);
assert(
  JSON.stringify(boundary.releaseAuthorization.authorizedOperations) ===
    JSON.stringify([
      "verify-the-agent-relay-repository-remains-public",
      "verify-github-private-vulnerability-reporting-and-available-security-controls-remain-enabled",
      "protect-the-npm-prerelease-environment-for-the-exact-alpha2-tag",
      "create-the-immutable-v0.1.0-alpha.2-tag-on-the-recorded-exact-candidate",
      "run-the-protected-tagged-build-upload-and-build-and-sbom-attestations",
      "publish-flowxo-agent-relay-0.1.0-alpha.2-to-the-npm-alpha-channel-with-the-interactive-2fa-bootstrap",
      "configure-and-verify-the-exact-npm-trusted-publisher-immediately-after-first-publish",
      "require-oidc-for-every-later-publish",
      "create-the-github-prerelease-and-attach-verified-artifacts-checksums-sbom-notes-and-attestations",
    ]),
  "authorized operation list differs",
);
assert(
  JSON.stringify(boundary.releaseAuthorization.excludedOperations) ===
    JSON.stringify([
      "production-deployment-or-mutation",
      "central-workspace-release",
      "live-provider-traffic",
      "credential-disclosure-or-retention",
      "live-card-authorization",
      "publication-beyond-the-exact-agent-relay-alpha-candidate",
    ]),
  "excluded operation list differs",
);
assert(
  boundary.releaseAuthorization.candidateBinding ===
    "Record the exact green post-merge alpha.2 source commit and regenerated artifact digests in FXO-1574 before any tag or FXO-1164 publication execution; substantive drift requires renewed owner approval.",
  "final candidate binding differs",
);
assert(
  JSON.stringify(boundary.publishedRelease) ===
    JSON.stringify({
      sourceCommit: "5649087a5789785737011fab49151287761fb276",
      tag: "v0.1.0-alpha.2",
      tagImmutable: true,
      npmPackage: "@flowxo/agent-relay@0.1.0-alpha.2",
      npmTarballSha256:
        "d3f5e6dbf33755d7630bd1884ed1ee8286055c0c129e23ddd139e1617875a0c7",
      npmTarballIntegrity:
        "sha512-OI0sAhwZ192kagxFv2okysdLxZI4AmRyllmVpLnhB8H3CF6p/38BZTIfVspkz3zo5zw0QmFg3pIoY9q9FrsT8A==",
      npmDistTags: {
        alpha: "0.1.0-alpha.2",
        latest: "0.1.0-alpha.2",
      },
      githubRelease:
        "https://github.com/flowxo/agent-relay/releases/tag/v0.1.0-alpha.2",
      workflowRun:
        "https://github.com/flowxo/agent-relay/actions/runs/31549946869",
      buildAttestation:
        "https://github.com/flowxo/agent-relay/attestations/40157521",
      sbomAttestation:
        "https://github.com/flowxo/agent-relay/attestations/40157525",
      oidcRequiredForFuturePublication: true,
      registryCredentialRetained: false,
      liveProviderTested: false,
    }),
  "published alpha.2 evidence differs",
);
assert(
  JSON.stringify(boundary.preservedFailedPublicationEvidence) ===
    JSON.stringify({
      package: "@flowxo/agent-relay@0.1.0-alpha.1",
      sourceCommit: "cda92d179e76c00eac848a3d496fa298115cce45",
      tag: "v0.1.0-alpha.1",
      tagObject: "31fcdc9f19071bd0a73a90acc710f87255018980",
      tagImmutable: true,
      completedOperations: [
        "made-the-agent-relay-repository-public",
        "enabled-and-verified-github-private-vulnerability-reporting-and-available-security-controls",
        "protected-the-npm-prerelease-environment-for-the-exact-alpha1-tag",
        "created-the-immutable-v0.1.0-alpha.1-tag",
        "ran-the-protected-tagged-build-and-produced-build-and-sbom-attestations",
      ],
      workflowRun:
        "https://github.com/flowxo/agent-relay/actions/runs/31541234262",
      linuxArtifactSha256:
        "4e6dca3e14767444c4125c72a7d0f124b7818d45f585784a59f01d24a47b1e89",
      authorizedMacosArtifactSha256:
        "eaead1f9011b8968a76dadb5e37ed3bcd020f6f477484b24db1e259e88ebeaa2",
      uncompressedTarSha256:
        "504c991da1a6a9cf43db8658eb9b83917fbd054738a4a4a9c281fd1cd4a3b211",
      buildAttestation:
        "https://github.com/flowxo/agent-relay/attestations/40141535",
      sbomAttestation:
        "https://github.com/flowxo/agent-relay/attestations/40141561",
      npmPublished: false,
      githubReleaseCreated: false,
      failure:
        "cross-platform-gzip-operating-system-header-byte-changed-the-artifact-digest",
    }),
  "preserved alpha.1 failed-publication evidence differs",
);
assert(
  release.bundledComponentLicenseReview.status === "owner-approved" &&
    release.bundledComponentLicenseReview.ownerApproved === true &&
    release.bundledComponentLicenseReview.noticeApproved === true &&
    release.bundledComponents.every(
      (component) =>
        component.licenseDeclared === "MIT" &&
        component.copyrightText === "Copyright (c) 2026 Flow XO, LLC",
    ),
  "bundled WhooshBang license and notice approval differs",
);
assert(
  boundary.sourceInputs.packageManager === rootPackage.packageManager,
  "package-manager pin differs",
);
assert(
  boundary.sourceInputs.lockfile.path === "pnpm-lock.yaml",
  "lockfile path differs",
);
assert(
  boundary.sourceInputs.lockfile.sha256 === (await sha256("pnpm-lock.yaml")),
  "lockfile digest differs",
);
assert(
  JSON.stringify(boundary.sourceInputs.developmentSecurityOverrides) ===
    JSON.stringify([
      {
        name: "brace-expansion",
        version: "5.0.9",
        advisory: "GHSA-rgw5-rvv9-x895",
        scope: "development-only",
      },
      {
        name: "fast-uri",
        version: "3.1.5",
        advisory: "GHSA-7p8r-x3mc-p8w7",
        scope: "development-only",
      },
      {
        name: "postcss",
        version: "8.5.26",
        advisory: "GHSA-fxqj-rqcc-2cmp",
        scope: "development-only",
      },
    ]),
  "development security override boundary differs",
);
assertFrozenEvidenceProvenance(boundary);

assert(
  JSON.stringify(release.os) === JSON.stringify(["darwin"]),
  "release OS must be darwin only",
);
assert(
  JSON.stringify(release.cpu) === JSON.stringify(["arm64", "x64"]),
  "release CPU must retain native arm64 and Rosetta x64 Node",
);
assert(
  release.node === boundary.runtime.nodeRange,
  "Node support range differs",
);
assert(
  boundary.runtime.nativeReleaseExitNode === "22.23.1",
  "native Node evidence pin differs",
);
assert(
  JSON.stringify(boundary.runtime.nativeReleaseExit) ===
    JSON.stringify({
      targetReached: true,
      exactFrozenHarnessSnapshotAvailable: true,
      status: "verified-exact-harness-clean-native-lifecycle",
      green: true,
      credited: true,
      liveTrafficRun: false,
    }),
  "native release-exit boundary differs",
);
assert(
  boundary.runtime.hardware === "Apple silicon" &&
    JSON.stringify(boundary.runtime.nodeArchitectures) ===
      JSON.stringify(["arm64", "x64 through Rosetta"]) &&
    boundary.runtime.unsupportedEndUserClaims.includes("Intel macOS"),
  "Apple-silicon and Rosetta support boundary differs",
);
requireText(
  doctorSource,
  /isSupportedRuntimeObservation\(options\.runtime\)/,
  "doctor no longer consumes the shared runtime-support predicate",
);
requireText(
  relayCliSource,
  /appleSiliconHardware: observeAppleSiliconHardware\(\)/,
  "CLI no longer consumes the shared hardware observation",
);
for (const [label, checkSource] of [
  ["package", packageCheckSource],
  ["hosted package", hostedPackageCheckSource],
  ["package lifecycle", lifecycleCheckSource],
]) {
  requireText(
    checkSource,
    /isSupportedReleaseRuntime\(\s*release,\s*currentReleaseRuntime\(\)\s*,?\s*\)/,
    `${label} proof does not enforce the shared OS, CPU, and Node support boundary`,
  );
}
requireText(
  storeSource,
  /RELAY_STORE_SCHEMA_VERSION = 11;/,
  "SQLite schema is not 11",
);
requireText(
  installerSource,
  /INSTALL_SCHEMA = "agent-relay-install\.v1";/,
  "install schema differs",
);
requireText(
  installerSource,
  /INSTALL_VERSION = "1";/,
  "install version differs",
);

for (const harness of boundary.harnesses) {
  if (harness.verifiedVersion !== null) {
    requireText(
      capabilitySource,
      new RegExp(
        harness.verifiedVersion.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `${harness.harness}/${harness.surface} version differs from the compatibility registry`,
    );
  }
}
assert(
  JSON.stringify(
    boundary.harnesses.map((entry) => `${entry.harness}/${entry.surface}`),
  ) ===
    JSON.stringify([
      "codex/cli",
      "codex/app-server",
      "claude/cli",
      "claude/sdk",
      "cursor/cli",
      "cursor/ide",
    ]),
  "harness surface inventory differs",
);

for (const artifact of boundary.whooshbangArtifacts) {
  const locked = contractLock.dependencies.find(
    (entry) => entry.artifact === artifact.name,
  );
  assert(
    locked?.version === artifact.version && locked?.sha256 === artifact.sha256,
    `${artifact.name} lock differs`,
  );
  const bundled = release.bundledComponents.find(
    (entry) => entry.name === artifact.name,
  );
  if (artifact.runtimeBundled === false) {
    assert(bundled === undefined, `${artifact.name} must remain proof-only`);
  } else {
    assert(
      bundled?.version === artifact.version &&
        bundled?.artifactSha256 === artifact.sha256 &&
        bundled?.sourceCommit === locked.source_commit,
      `${artifact.name} bundled inventory differs`,
    );
  }
}

const boundaryDoc = await source("docs/v1-release-boundary.md");
const releaseReadiness = await source("docs/release-readiness.md");
const hosted = await source("docs/hosted-whooshbang.md");
const packagedReadme = await source("packaging/README.md");
const packaging = await source("docs/packaging.md");
const installation = await source("docs/install-upgrade-uninstall.md");
const privacy = await source("PRIVACY.md");
const changelog = await source("CHANGELOG.md");
const notices = await source("THIRD_PARTY_NOTICES.md");
const support = await source("SUPPORT.md");
const readme = await source("README.md");
const charter = await source("docs/product/open-source-v1-charter.md");
const releaseNotes = await source("packaging/release-notes.md");
const webhookDocumentation = await source("docs/outbound-webhooks.md");
const webhookFixture = await json(
  "packages/webhook-transport/fixtures/webhook/delivery-v1.json",
);
const combinedReleaseDocs = [
  boundaryDoc,
  releaseReadiness,
  hosted,
  packagedReadme,
  packaging,
  installation,
  changelog,
  charter,
  releaseNotes,
].join("\n");

for (const [pattern, message] of [
  [
    /does \*\*not\*\* contain PR #40/,
    "retained package distinction is missing",
  ],
  [
    /8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543/,
    "PR #40 proof digest is missing",
  ],
  [
    /0adb7288483df331fbaaefb9b392ee2f4f3c7d84/,
    "current frozen PR #41 merge is missing",
  ],
  [
    /3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106/,
    "PR #41 release-bundle proof digest is missing",
  ],
  [
    /native release-exit is (?:\*\*)?green/i,
    "native release-exit green status is missing",
  ],
  [/SQLite schema (?:is |version )`?10`?/, "current SQLite schema is missing"],
  [/Cursor IDE late resume is unsupported/i, "Cursor IDE limit is missing"],
  [
    /Cursor permission automation (?:is|remains) disabled/i,
    "Cursor permission limit is missing",
  ],
  [/Telegram delivery is at least once/i, "Telegram ambiguity is missing"],
  [/no automatic dual-send/i, "dual-send boundary is missing"],
  [/no hosted dashboard or team-policy/i, "hosted product boundary is missing"],
  [
    /automation cannot prove that the invoking shell or GUI/i,
    "accepted hook-isolation residual is missing",
  ],
]) {
  requireText(combinedReleaseDocs, pattern, message);
}

for (const [pattern, message] of [
  [/future hosted adapter/i, "future-adapter wording is stale"],
  [/This is the AR2 release handoff/i, "AR2 handoff wording is stale"],
  [/AR3 still owns/i, "AR3 ownership wording is stale"],
  [/later real-service dogfood phase/i, "pre-AR3 dogfood wording is stale"],
  [/Status:\*\* Planned; AR1, AR2/i, "planned AR3 wording is stale"],
  [/Status:\*\* Planned; follows AR3/i, "planned AR4 wording is stale"],
  [
    /schema (?:version )?`?[12]`? (?:to|through) `?3`?/i,
    "schema-3 lifecycle wording is stale",
  ],
]) {
  assert(!pattern.test(combinedReleaseDocs), message);
}

for (const [pattern, message] of [
  [/`transport\.json`/, "transport selection file is missing"],
  [/`whooshbang\.json`/, "WhooshBang configuration file is missing"],
  [/`whooshbang-credential\.json`/, "WhooshBang credential file is missing"],
  [
    /`whooshbang-oauth-provisioning\.json`/,
    "WhooshBang OAuth journal is missing",
  ],
  [
    /subscriber.*notifier.*title.*text.*correlation/is,
    "WhooshBang outbound fields are incomplete",
  ],
  [/no product\s+analytics/i, "telemetry-none statement is missing"],
]) {
  requireText(privacy, pattern, message);
}

assert(boundary.privacy.telemetry === "none", "telemetry boundary differs");
assert(
  JSON.stringify(boundary.privacy.localRetentionDays) ===
    JSON.stringify({
      delivered: 30,
      requests: 30,
      telegramUpdates: 30,
      deadLetters: 90,
      diagnostics: 90,
      sessions: 90,
    }),
  "local retention defaults differ",
);
assert(
  JSON.stringify(boundary.privacy.localStatePaths) ===
    JSON.stringify([
      "relay.sqlite",
      "relay.sqlite-wal",
      "relay.sqlite-shm",
      "fallback-spool.ndjson",
      "fallback-spool.ndjson.segment-*",
      "fallback-spool.ndjson.pending-*",
      "fallback-spool.ndjson.processing-*",
      "relay.ndjson",
      "relay.ndjson.*",
      "web-credential.json",
      "transport.json",
      "webhook.json",
      "whooshbang.json",
      "whooshbang-credential.json",
      "whooshbang-oauth-provisioning.json",
      "install.json",
      "bin/agent-relay",
      "runner-bridge.json",
      "runner-bridge.sqlite",
      "runner-bridge.sqlite-wal",
      "runner-bridge.sqlite-shm",
      "machine-id",
    ]),
  "local state-path inventory differs",
);
assert(
  JSON.stringify(boundary.privacy.outboundFields.whooshbang) ===
    JSON.stringify([
      "subscriber",
      "optional-notifier",
      "bounded-title-text",
      "opaque-event-correlation",
      "supported-prompt-labels-opaque-options",
      "expiry",
      "request-authentication",
    ]),
  "WhooshBang outbound field inventory differs",
);
for (const [sourceText, pattern, message] of [
  [transportConfigSource, /"transport\.json"/, "transport state path differs"],
  [webhookConfigSource, /"webhook\.json"/, "webhook state path differs"],
  [
    whooshBangConfigSource,
    /"whooshbang\.json"/,
    "WhooshBang state path differs",
  ],
  [
    whooshBangConfigSource,
    /"whooshbang-credential\.json"/,
    "WhooshBang credential path differs",
  ],
  [
    whooshBangConfigSource,
    /"whooshbang-oauth-provisioning\.json"/,
    "WhooshBang journal path differs",
  ],
  [
    webhookConfigSource,
    /return resolved\("environment"/,
    "webhook environment-only resolution differs",
  ],
  [
    whooshBangTransportSource,
    /credential: options\.credential/,
    "WhooshBang request-authentication boundary differs",
  ],
  [
    whooshBangMappingSource,
    /subscriberId[\s\S]*notifierId[\s\S]*correlation/i,
    "WhooshBang mapping field boundary differs",
  ],
  [relayCliSource, /"fallback-spool\.ndjson"/, "fallback spool path differs"],
  [relayCliSource, /"relay\.ndjson"/, "diagnostic log path differs"],
  [relayCliSource, /"machine-id"/, "machine identifier path differs"],
  [storeSource, /journal_mode = WAL/, "SQLite WAL sidecar behavior differs"],
  [
    fallbackSpoolSource,
    /\.segment-[\s\S]*\.pending-[\s\S]*\.processing-/,
    "fallback spool sibling paths differ",
  ],
  [
    runnerBridgeConfigSource,
    /"runner-bridge\.json"[\s\S]*"runner-bridge\.sqlite"/,
    "runner bridge state paths differ",
  ],
  [
    runnerBridgeStoreSource,
    /journal_mode = WAL/,
    "runner bridge SQLite sidecar behavior differs",
  ],
]) {
  requireText(sourceText, pattern, message);
}
for (const [label, days, pattern] of [
  ["delivered", 30, /retentionDays\(options\.deliveredDays, 30/],
  ["requests", 30, /retentionDays\(options\.requestDays, 30/],
  ["telegram updates", 30, /retentionDays\(options\.telegramUpdateDays, 30/],
  ["dead letters", 90, /retentionDays\(options\.deadLetterDays, 90/],
  ["diagnostics", 90, /retentionDays\(options\.diagnosticDays, 90/],
  ["sessions", 90, /retentionDays\(options\.sessionDays, 90/],
]) {
  requireText(
    serviceSource,
    pattern,
    `${label} retention default ${days} differs`,
  );
}

for (const [document, requirements] of [
  [
    support,
    [
      /Cursor IDE late resume/i,
      /no automatic\s+dual-send/i,
      /Accepted Low residual/i,
    ],
  ],
  [
    packagedReadme,
    [
      /Cursor IDE late resume/i,
      /Telegram delivery is at\s+least once/i,
      /does\s+(?:\*\*)?not(?:\*\*)?\s+contain PR #40/i,
    ],
  ],
  [
    changelog,
    [
      /Cursor IDE late resume/i,
      /no hosted dashboard or\s+team-policy/i,
      /does\s+(?:\*\*)?not(?:\*\*)?\s+contain PR #40/i,
    ],
  ],
  [
    releaseReadiness,
    [
      /Telegram delivery is at\s+least once/i,
      /No live-card authorization carries forward/i,
    ],
  ],
  [readme, [/V1 release boundary/i, /no automatic\s+dual-send/i]],
]) {
  for (const requirement of requirements) {
    requireText(document, requirement, `public document lost ${requirement}`);
  }
}

for (const component of release.bundledComponents) {
  requireText(
    notices,
    new RegExp(component.name.replace("/", "\\/")),
    `${component.name} notice is missing`,
  );
}
requireText(
  notices,
  /owner-approved[\s\S]*MIT[\s\S]*Copyright \(c\) 2026 Flow XO, LLC/i,
  "bundled license approval and notice are missing",
);

const documentedWebhookFixture = [
  ...webhookDocumentation.matchAll(/```json\n([\s\S]*?)\n```/g),
]
  .map((match) => {
    try {
      return JSON.parse(match[1]);
    } catch {
      return undefined;
    }
  })
  .find((candidate) => candidate?.deliveryId === webhookFixture.deliveryId);
assert(
  JSON.stringify(documentedWebhookFixture) === JSON.stringify(webhookFixture),
  "documented webhook envelope differs from the checked fixture",
);

process.stdout.write(
  "V1 release support, privacy, compatibility, and provenance boundary verified.\n",
);
