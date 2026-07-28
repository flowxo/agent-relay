const exactVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const checksumPattern = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release exit violation: ${message}`);
  }
}

function sorted(value) {
  return [...value].sort();
}

export function assertReleaseExitConfiguration(exit, release) {
  assert(
    exit?.schema === "agent-relay-release-exit.v1",
    "packaging/release-exit.json has an unknown schema",
  );
  assert(
    typeof exit.recheckedAt === "string" &&
      !Number.isNaN(Date.parse(exit.recheckedAt)),
    "runtime evidence recheck date is invalid",
  );
  assert(
    exit.target?.platform === "darwin" && exit.target?.architecture === "arm64",
    "the exit target must remain native Apple-silicon macOS",
  );

  const node = exit.target.node;
  assert(
    typeof node?.version === "string" && exactVersionPattern.test(node.version),
    "Node must be one exact stable version",
  );
  const nodeMajor = Number(node.version.split(".", 1)[0]);
  assert(
    release.node === `>=${String(nodeMajor)}`,
    "the pinned Node major must equal the package minimum",
  );
  const expectedArchive = `node-v${node.version}-darwin-arm64.tar.gz`;
  assert(
    node.archive === expectedArchive,
    "Node archive must match the exact native target",
  );
  assert(
    node.url === `https://nodejs.org/dist/v${node.version}/${expectedArchive}`,
    "Node archive URL must be the exact official versioned URL",
  );
  assert(
    node.checksumSource ===
      `https://nodejs.org/dist/v${node.version}/SHASUMS256.txt`,
    "Node checksum source must be the exact official versioned manifest",
  );
  assert(
    typeof node.sha256 === "string" && checksumPattern.test(node.sha256),
    "Node archive SHA-256 is invalid",
  );
  assert(
    Number.isSafeInteger(node.maximumBytes) &&
      node.maximumBytes >= 20_000_000 &&
      node.maximumBytes <= 100_000_000,
    "Node archive byte limit is invalid",
  );

  assert(
    Array.isArray(exit.requiredHarnesses) &&
      JSON.stringify(sorted(exit.requiredHarnesses)) ===
        JSON.stringify(["claude", "codex", "cursor"]),
    "the exit matrix must observe all three supported CLI harnesses",
  );
  assert(
    Number.isSafeInteger(exit.minimumVerifiedHarnesses) &&
      exit.minimumVerifiedHarnesses >= 1 &&
      exit.minimumVerifiedHarnesses <= exit.requiredHarnesses.length,
    "minimum verified harness count is invalid",
  );
  assert(
    exit.evidenceOutput ===
      ".artifacts/release-exit/agent-relay-release-exit.json",
    "exit evidence must remain in the ignored artifacts boundary",
  );
}

export function assertNativeRuntimeObservation(exit, observation) {
  assert(
    observation?.platform === exit.target.platform,
    `Node reported ${String(observation?.platform)} instead of darwin`,
  );
  assert(
    observation?.architecture === exit.target.architecture,
    `Node reported ${String(observation?.architecture)} instead of arm64`,
  );
  assert(
    observation?.version === `v${exit.target.node.version}`,
    `Node reported ${String(observation?.version)} instead of the pinned version`,
  );
}

export function summarizeDoctorEvidence(exit, doctor) {
  assert(doctor?.healthy === true, "installed doctor report is unhealthy");
  assert(Array.isArray(doctor.checks), "doctor checks are missing");
  const harnessChecks = exit.requiredHarnesses.map((name) => {
    const check = doctor.checks.find((candidate) => candidate.name === name);
    assert(check !== undefined, `doctor is missing the ${name} harness`);
    assert(
      check.level === "pass" || check.level === "warn",
      `${name} is not available on the release target`,
    );
    assert(
      typeof check.observedVersion === "string" &&
        typeof check.verifiedVersion === "string" &&
        typeof check.classification === "string" &&
        typeof check.evidenceId === "string",
      `${name} lacks safe version and evidence metadata`,
    );
    return {
      name,
      level: check.level,
      observedVersion: check.observedVersion,
      verifiedVersion: check.verifiedVersion,
      classification: check.classification,
      evidenceId: check.evidenceId,
    };
  });
  assert(
    harnessChecks.filter((check) => check.classification === "verified")
      .length >= exit.minimumVerifiedHarnesses,
    "the target has too few exact verified harnesses",
  );
  return harnessChecks;
}
