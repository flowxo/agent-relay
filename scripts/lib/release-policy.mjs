import { spawnSync } from "node:child_process";
import process from "node:process";

const prereleasePattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;
const exactVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const approvedBundledLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release policy violation: ${message}`);
  }
}

function parseNumericVersion(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  assert(match !== null, `${label} must begin with a semantic version`);
  return match.slice(1, 4).map(Number);
}

function versionAtLeast(actual, minimum) {
  const left = parseNumericVersion(actual, "npm version");
  const right = parseNumericVersion(minimum, "minimum npm version");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) {
      return true;
    }
    if (left[index] < right[index]) {
      return false;
    }
  }
  return true;
}

export function registryCredentialEnvironmentPresent(environment) {
  return Object.entries(environment).some(([name, value]) => {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
    const normalizedName = name.toUpperCase();
    return (
      normalizedName === "NPM_TOKEN" ||
      normalizedName === "NODE_AUTH_TOKEN" ||
      (normalizedName.startsWith("NPM_CONFIG_") &&
        /AUTH|TOKEN/u.test(normalizedName))
    );
  });
}

export function isSupportedReleaseRuntime(
  release,
  { platform, architecture, nodeVersion, appleSiliconHardware },
) {
  const minimumNode = /^>=(\d+)$/.exec(release.node)?.[1];
  const observedNode = /^(\d+)(?:\.|$)/.exec(nodeVersion)?.[1];
  return (
    release.os.includes(platform) &&
    release.cpu.includes(architecture) &&
    (architecture !== "x64" || appleSiliconHardware === true) &&
    minimumNode !== undefined &&
    observedNode !== undefined &&
    Number(observedNode) >= Number(minimumNode)
  );
}

export function currentReleaseRuntime() {
  const appleSiliconHardware =
    process.platform === "darwin" &&
    (process.arch === "arm64" ||
      spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        shell: false,
      }).stdout.trim() === "1");
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    appleSiliconHardware,
  };
}

export function assertExactVersion(version, label) {
  assert(
    typeof version === "string" && exactVersionPattern.test(version),
    `${label} must be one exact semantic version`,
  );
  const prerelease = version.split("-", 2)[1];
  if (prerelease !== undefined) {
    for (const identifier of prerelease.split(".")) {
      assert(
        !/^\d+$/.test(identifier) ||
          identifier === "0" ||
          !identifier.startsWith("0"),
        `${label} contains a numeric prerelease identifier with a leading zero`,
      );
    }
  }
}

export function assertReleaseConfiguration(release, rootPackage) {
  assert(
    release?.schema === "agent-relay-release-candidate.v1",
    "packaging/release.json has an unknown schema",
  );
  assert(
    typeof release.name === "string" && release.name === rootPackage.name,
    "release and root package names must agree",
  );
  assertExactVersion(release.version, "release version");
  assert(
    prereleasePattern.test(release.version),
    "the release-candidate version must include a semantic prerelease",
  );
  assert(
    rootPackage.version === release.version,
    "release and root package versions must agree",
  );
  assert(
    rootPackage.private === true,
    "the workspace root must remain private to prevent accidental publication",
  );
  assert(
    release.gitTag === `v${release.version}`,
    "release gitTag must be v followed by the exact version",
  );
  const prereleaseName = release.version.split("-", 2)[1]?.split(".", 1)[0];
  assert(
    release.distTag === prereleaseName,
    "npm distTag must equal the first prerelease identifier",
  );
  assert(
    Array.isArray(release.os) &&
      release.os.length > 0 &&
      release.os.every((value) => typeof value === "string"),
    "release operating-system list is missing",
  );
  assert(
    Array.isArray(release.cpu) &&
      JSON.stringify(release.cpu) === JSON.stringify(["arm64", "x64"]),
    "V1 release CPU list must retain native arm64 and Rosetta x64 Node",
  );
  assert(
    typeof release.node === "string" && /^>=\d+$/.test(release.node),
    "release Node requirement must be an explicit minimum major",
  );
  assert(
    release.dependencies !== null &&
      typeof release.dependencies === "object" &&
      Object.keys(release.dependencies).length > 0,
    "release runtime dependencies are missing",
  );
  for (const [name, version] of Object.entries(release.dependencies)) {
    assertExactVersion(version, `${name} runtime dependency`);
  }
  assert(
    Array.isArray(release.bundledComponents) &&
      release.bundledComponents.length === 2,
    "release must inventory both bundled WhooshBang runtime components",
  );
  for (const component of release.bundledComponents) {
    assert(
      typeof component.name === "string" &&
        component.name.startsWith("@whooshbang/"),
      "bundled component name differs",
    );
    assertExactVersion(
      component.version,
      `${component.name} bundled component`,
    );
    assert(
      component.sourceRepository === "https://github.com/flowxo/whooshbang" &&
        /^[a-f0-9]{40}$/.test(component.sourceCommit) &&
        /^[a-f0-9]{64}$/.test(component.artifactSha256),
      `${component.name} bundled provenance is incomplete`,
    );
    assert(
      typeof component.licenseDeclared === "string",
      `${component.name} bundled license state is missing`,
    );
    if (component.licenseDeclared !== "NOASSERTION") {
      assert(
        component.copyrightText === "Copyright (c) 2026 Flow XO, LLC",
        `${component.name} bundled copyright notice differs`,
      );
    }
  }
  const licenseReview = release.bundledComponentLicenseReview;
  assert(
    licenseReview?.status === "required-before-publication" ||
      licenseReview?.status === "owner-approved",
    "bundled WhooshBang license review state is invalid",
  );
  if (licenseReview.status === "required-before-publication") {
    assert(
      licenseReview.ownerApproved === false &&
        licenseReview.noticeApproved === false &&
        licenseReview.decisionReference === null,
      "unresolved bundled license review must not imply owner or notice approval",
    );
  } else {
    assert(
      licenseReview.ownerApproved === true &&
        licenseReview.noticeApproved === true &&
        typeof licenseReview.decisionReference === "string" &&
        /^https:\/\//.test(licenseReview.decisionReference) &&
        release.bundledComponents.every((component) =>
          approvedBundledLicenses.has(component.licenseDeclared),
        ),
      "approved bundled license review requires owner evidence, notices, and allowed SPDX identifiers",
    );
  }

  const publication = release.publication;
  assert(
    publication !== null && typeof publication === "object",
    "publication policy is missing",
  );
  assert(
    typeof publication.approved === "boolean",
    "publication approval must be explicit",
  );
  assert(
    ["blocked", "publish", "stage"].includes(publication.registryAction),
    "registry action must be blocked, publish, or stage",
  );
  if (publication.approved) {
    assert(
      licenseReview.status === "owner-approved",
      "publication cannot be approved while the bundled component license review is unresolved",
    );
    assert(
      publication.registryAction === "publish" ||
        publication.registryAction === "stage",
      "an approved publication must name one registry action",
    );
    assert(
      publication.decision === "go-with-named-nonblocking-residuals" &&
        publication.decisionReference === licenseReview.decisionReference &&
        /^https:\/\/linear\.app\/flowxo\/issue\/FXO-1568\//.test(
          publication.decisionReference,
        ) &&
        /^https:\/\/linear\.app\/flowxo\/issue\/FXO-1164\//.test(
          publication.executionIssue,
        ),
      "approved publication must preserve the bounded owner decision and execution issue",
    );
    assert(
      publication.initialPublish?.mode === "interactive-2fa-bootstrap" &&
        publication.initialPublish?.nodeVersion === "22.23.1" &&
        publication.initialPublish?.minimumNpmVersion === "11.15.0" &&
        publication.initialPublish?.packageMustBeAbsent === true &&
        publication.initialPublish?.credentialPersistence ===
          "forbidden-after-bootstrap" &&
        publication.initialPublish?.trustedPublisherSetup ===
          "immediate-after-publish",
      "initial publication must retain the approved interactive 2FA bootstrap boundary",
    );
    assert(
      publication.trustedPublisher?.provider === "github-actions" &&
        publication.trustedPublisher?.repository === "flowxo/agent-relay" &&
        publication.trustedPublisher?.workflow === publication.workflow &&
        publication.trustedPublisher?.environment === publication.environment &&
        publication.trustedPublisher?.permission ===
          publication.registryAction &&
        publication.trustedPublisher?.requiredForSubsequentPublishes === true,
      "subsequent publication must retain the exact GitHub Actions OIDC identity",
    );
  } else {
    assert(
      publication.registryAction === "blocked",
      "an unapproved publication must remain blocked",
    );
  }
  assert(
    publication.registry === "https://registry.npmjs.org/",
    "the approved registry must be npmjs",
  );
  assert(
    publication.workflow === "prerelease.yml",
    "trusted publishing must bind to prerelease.yml",
  );
  assert(
    publication.environment === "npm-prerelease",
    "trusted publishing must bind to the protected npm-prerelease environment",
  );
  assert(
    publication.requiresPublicRepository === true,
    "npm provenance must require a public repository",
  );
}

export function stagedPackageIsPrivate(release) {
  return release.publication.approved !== true;
}

export function assertPublishContext(release, context) {
  assert(
    release.publication.approved === true,
    "owner publication approval is false",
  );
  assert(
    release.publication.registryAction !== "blocked",
    "registry action remains blocked",
  );
  assert(
    release.bundledComponentLicenseReview.status === "owner-approved",
    "bundled component license review is unresolved",
  );
  assert(
    context.trustedPublisherConfigured === "true",
    "trusted publisher has not been confirmed after the initial bootstrap",
  );
  assert(
    context.githubActions === "true",
    "registry mutation is allowed only inside GitHub Actions",
  );
  assert(
    context.eventName === "workflow_dispatch",
    "registry mutation requires an explicit workflow dispatch",
  );
  assert(context.publishInput === "true", "manual publish input is not true");
  assert(context.refType === "tag", "registry mutation requires a tag ref");
  assert(
    context.refName === release.gitTag,
    "workflow tag differs from packaging/release.json",
  );
  assert(
    context.repositoryVisibility === "public",
    "npm provenance requires a public source repository",
  );
  assert(
    context.repository === "flowxo/agent-relay",
    "registry mutation requires the canonical GitHub repository",
  );
  assert(
    context.workflow === release.publication.workflow,
    "workflow filename differs from the trusted-publisher policy",
  );
  assert(
    context.workflowRef ===
      `flowxo/agent-relay/.github/workflows/${release.publication.workflow}@refs/tags/${release.gitTag}`,
    "GitHub workflow identity differs from the trusted-publisher policy",
  );
  assert(
    context.environment === release.publication.environment,
    "deployment environment differs from the trusted-publisher policy",
  );

  const minimumNpm =
    release.publication.registryAction === "stage" ? "11.15.0" : "11.5.1";
  assert(
    versionAtLeast(context.npmVersion, minimumNpm),
    `${release.publication.registryAction} requires npm ${minimumNpm} or newer`,
  );

  return release.publication.registryAction;
}

export function assertBootstrapPublishContext(release, context) {
  assert(
    release.publication.approved === true &&
      release.publication.registryAction === "publish",
    "initial bootstrap publish is not owner-approved",
  );
  assert(
    release.bundledComponentLicenseReview.status === "owner-approved",
    "bundled component license review is unresolved",
  );
  assert(
    release.publication.initialPublish?.mode === "interactive-2fa-bootstrap",
    "initial bootstrap mode differs",
  );
  assert(
    context.githubActions !== "true" && context.interactive === true,
    "initial bootstrap requires a local interactive owner session",
  );
  assert(
    context.confirmation === `${release.name}@${release.version}`,
    "initial bootstrap confirmation differs from the exact package",
  );
  assert(
    context.repositoryVisibility === "public",
    "initial bootstrap requires the public source repository",
  );
  assert(
    context.tagStatus === "verified-at-head",
    "initial bootstrap requires the immutable intended tag at HEAD",
  );
  assert(
    context.nodeVersion === release.publication.initialPublish.nodeVersion,
    "initial bootstrap requires exact Node 22.23.1",
  );
  assert(
    versionAtLeast(
      context.npmVersion,
      release.publication.initialPublish.minimumNpmVersion,
    ),
    `initial bootstrap requires npm ${release.publication.initialPublish.minimumNpmVersion} or newer`,
  );
  assert(
    context.credentialEnvironmentPresent === false,
    "initial bootstrap refuses registry credentials supplied through the environment",
  );
  assert(
    context.packageVersionState === "absent" ||
      (context.resumeAfterPublish === true &&
        context.packageVersionState === "exact-artifact-present"),
    "initial bootstrap requires an absent version or an exact-artifact recovery",
  );

  return context.packageVersionState === "absent"
    ? "publish-and-trust"
    : "trust-only";
}
