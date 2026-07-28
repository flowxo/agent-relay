import { spawnSync } from "node:child_process";

import {
  classifyObservedHarnessVersion,
  HARNESS_CAPABILITIES,
  HARNESS_COMPATIBILITY,
  VERIFIED_CLI_HARNESS_EVIDENCE,
} from "@agent-relay/harnesses";
import type { CompatibilityClassification } from "@agent-relay/harnesses";
import {
  FakeTelegramTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";
import type { Harness } from "@agent-relay/protocol";

import { inspectAgentRelayInstallation } from "./installer.js";
import type { InstallationCheck } from "./installer.js";
import { AGENT_RELAY_VERSION } from "./release.js";

function requiredEvidenceValue(
  value: string | undefined,
  label: string,
): string {
  if (value === undefined) {
    throw new Error(`compatibility registry is missing ${label}`);
  }
  return value;
}

export const VERIFIED_HARNESS_VERSIONS: Record<Harness, string> = {
  codex: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.codex.verifiedVersion,
    "Codex CLI verifiedVersion",
  ),
  claude: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.claude.verifiedVersion,
    "Claude CLI verifiedVersion",
  ),
  cursor: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.cursor.verifiedVersion,
    "Cursor CLI verifiedVersion",
  ),
};

export const TESTED_HARNESS_VERSIONS = VERIFIED_HARNESS_VERSIONS;

export const DEFAULT_HARNESS_EXECUTABLES: Record<Harness, string> = {
  codex: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.codex.executable,
    "Codex CLI executable",
  ),
  claude: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.claude.executable,
    "Claude CLI executable",
  ),
  cursor: requiredEvidenceValue(
    VERIFIED_CLI_HARNESS_EVIDENCE.cursor.executable,
    "Cursor CLI executable",
  ),
};

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  detail: string;
  observedVersion?: string;
  verifiedVersion?: string;
  classification?: CompatibilityClassification;
  evidenceId?: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  databasePath?: string;
  rootDir?: string;
  executables?: Partial<Record<Harness, string>>;
  packageVersion?: string;
  runtimeEntryPath?: string;
  runtimeNodePath?: string;
}

export interface HarnessVersionObservation {
  harness: Harness;
  executable: string;
  available: boolean;
  version?: string;
  verifiedVersion: string;
  classification: CompatibilityClassification;
  evidenceId: string;
  drifted: boolean;
  detail: string;
}

export function observeHarnessVersions(
  executableOverrides: Partial<Record<Harness, string>> = {},
): HarnessVersionObservation[] {
  return (["codex", "claude", "cursor"] as const).map((harness) => {
    const executable =
      executableOverrides[harness] ?? DEFAULT_HARNESS_EXECUTABLES[harness];
    const evidence = VERIFIED_CLI_HARNESS_EVIDENCE[harness];
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      shell: false,
    });
    const verifiedVersion = VERIFIED_HARNESS_VERSIONS[harness];
    if (result.error !== undefined || result.status !== 0) {
      return {
        harness,
        executable,
        available: false,
        verifiedVersion,
        classification: "unsupported",
        evidenceId: evidence.evidence.id,
        drifted: false,
        detail:
          result.error?.message ??
          result.stderr.trim() ??
          `exited with status ${String(result.status)}`,
      };
    }
    const output = result.stdout.trim() || result.stderr.trim();
    const version = output.split("\n")[0] ?? "";
    const classification = classifyObservedHarnessVersion(evidence, version);
    const drifted = classification !== "verified";
    return {
      harness,
      executable,
      available: true,
      version,
      verifiedVersion,
      classification,
      evidenceId: evidence.evidence.id,
      drifted,
      detail:
        classification === "unsupported"
          ? `observed ${version}; this version is recorded as incompatible with required contracts`
          : drifted
            ? `observed ${version}; the exact verified version is ${verifiedVersion}`
            : `observed verified version ${version}`,
    };
  });
}

export function harnessObservationLevel(
  observation: Pick<HarnessVersionObservation, "available" | "classification">,
): DoctorCheck["level"] {
  if (
    !observation.available ||
    observation.classification === "unsupported" ||
    observation.classification === "disabled"
  ) {
    return "fail";
  }
  return observation.classification === "verified" ? "pass" : "warn";
}

function installationDoctorCheck(check: InstallationCheck): DoctorCheck {
  return {
    name: check.name,
    ok: check.ok,
    level: check.level,
    detail: check.detail,
  };
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let store: RelayStore | undefined;
  try {
    store = new RelayStore(options.databasePath ?? ":memory:");
    const service = new RelayService(store, new FakeTelegramTransport());
    service.recover();
    const status = store.status();
    checks.push({
      name: "sqlite-spool",
      ok: status.pendingDeliveryCount === 0,
      level: status.pendingDeliveryCount === 0 ? "pass" : "warn",
      detail:
        status.pendingDeliveryCount === 0
          ? "SQLite schema opened and durable delivery state is readable"
          : `${status.pendingDeliveryCount} deliveries remain pending`,
    });
  } catch (error) {
    checks.push({
      name: "sqlite-spool",
      ok: false,
      level: "fail",
      detail:
        error instanceof Error ? error.message : "SQLite spool check failed",
    });
  } finally {
    store?.close();
  }

  for (const observation of observeHarnessVersions(options.executables)) {
    const level = harnessObservationLevel(observation);
    checks.push({
      name: observation.harness,
      ok: level !== "fail",
      level,
      detail: observation.detail,
      ...(observation.version === undefined
        ? {}
        : { observedVersion: observation.version }),
      verifiedVersion: observation.verifiedVersion,
      classification: observation.classification,
      evidenceId: observation.evidenceId,
    });
  }
  checks.push({
    name: "capability-matrix",
    ok: new Set(HARNESS_CAPABILITIES.map((entry) => entry.harness)).size === 3,
    level: "pass",
    detail: `${HARNESS_COMPATIBILITY.schema}: ${HARNESS_CAPABILITIES.length} runtime-validated harness/surface records loaded; evidence rechecked ${HARNESS_COMPATIBILITY.evidenceRecheckedAt}`,
  });

  if (options.rootDir !== undefined) {
    try {
      const installation = await inspectAgentRelayInstallation(
        options.rootDir,
        {
          packageVersion: options.packageVersion ?? AGENT_RELAY_VERSION,
          ...(options.runtimeEntryPath === undefined
            ? {}
            : { runtimeEntryPath: options.runtimeEntryPath }),
          ...(options.runtimeNodePath === undefined
            ? {}
            : { runtimeNodePath: options.runtimeNodePath }),
        },
      );
      checks.push(...installation.checks.map(installationDoctorCheck));
    } catch (error) {
      checks.push({
        name: "installation-inspection",
        ok: false,
        level: "fail",
        detail:
          error instanceof Error
            ? error.message
            : "installation inspection failed",
      });
    }
  }
  return {
    healthy: checks.every((check) => check.level !== "fail"),
    checks,
  };
}
