const FROZEN_SOURCE_CANDIDATE = {
  pullRequest: 40,
  reviewedHead: "9a5e6a68609e3764ba5198c350528254bd37da62",
  mergeCommit: "eb5ae1316949f5053c6ae64fdf6d624243e2b2ee",
};

const CURRENT_FROZEN_SOURCE = {
  pullRequest: 41,
  reviewedHead: "875e5631ad45bbeb86c377e73dabe4d616b46413",
  mergeCommit: "0adb7288483df331fbaaefb9b392ee2f4f3c7d84",
};

const FROZEN_RETAINED_EVIDENCE = {
  package: "@flowxo/agent-relay@0.1.0-alpha.1",
  sha256: "654d6137233088905824f7960538b4d2e5911b9d100dcd1b825f79a15d84b198",
  pullRequest: 39,
  reviewedHead: "4ba4b1fbd832c34f465cd40f199e5c1dac7ed890",
  mergeCommit: "85d2d0a1f8649bf4359031227d1b9b844208cc15",
  containsPullRequest40: false,
  containsPullRequest41: false,
  liveTested: true,
  retained: true,
};

const FROZEN_PULL_REQUEST_40_PROOF = {
  sha256: "8f68350f3dda8a18d64e865a58e66029ed16a050edcf2631408a35534ab2f543",
  containsPullRequest40: true,
  liveTested: false,
  retained: false,
};

const FROZEN_PULL_REQUEST_41_PROOF = {
  sha256: "3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106",
  bytes: 277069,
  files: 11,
  spdxPackages: 6,
  containsPullRequest40: true,
  containsPullRequest41: true,
  liveTested: false,
  nativeReleaseExitGreen: false,
};

function exact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`V1 release-boundary drift: ${label} differs`);
  }
}

export function assertFrozenEvidenceProvenance(boundary) {
  exact(
    boundary.sourceCandidateEnteringFreeze,
    FROZEN_SOURCE_CANDIDATE,
    "source candidate entering the freeze",
  );
  exact(
    boundary.currentFrozenSourceAfterFXO1161,
    CURRENT_FROZEN_SOURCE,
    "current frozen source after FXO-1161",
  );
  exact(
    boundary.evidenceArtifacts?.retainedLiveReviewed,
    FROZEN_RETAINED_EVIDENCE,
    "retained PR #39 evidence",
  );
  exact(
    boundary.evidenceArtifacts?.pullRequest40CredentialFreePackedProof,
    FROZEN_PULL_REQUEST_40_PROOF,
    "PR #40 ephemeral evidence",
  );
  exact(
    boundary.evidenceArtifacts?.pullRequest41CredentialFreeReleaseBundleProof,
    FROZEN_PULL_REQUEST_41_PROOF,
    "PR #41 credential-free release-bundle evidence",
  );
}
