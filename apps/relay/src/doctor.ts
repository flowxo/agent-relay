import { spawnSync } from "node:child_process";

import {
  classifyObservedHarnessVersion,
  HARNESS_CAPABILITIES,
  HARNESS_COMPATIBILITY,
  isSupportedRuntimeObservation,
  VERIFIED_CLI_HARNESS_EVIDENCE,
} from "@agent-relay/harnesses";
import type { CompatibilityClassification } from "@agent-relay/harnesses";
import {
  FakeNotificationTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";
import type { Harness } from "@agent-relay/protocol";
import type { RelayMcpBindingState } from "@agent-relay/protocol";

import { inspectAgentRelayInstallation } from "./installer.js";
import type { InstallationCheck } from "./installer.js";
import { AGENT_RELAY_VERSION } from "./release.js";
import { inspectVendorIntegrations } from "./vendor-integration-lifecycle.js";
import type { TransportReadinessReport } from "./transport-config.js";

export function observeAppleSiliconHardware(): boolean {
  return (
    process.platform === "darwin" &&
    (process.arch === "arm64" ||
      spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        shell: false,
      }).stdout.trim() === "1")
  );
}

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
  transportReadiness?: TransportReadinessReport;
  webEnabled?: boolean;
  runtime?: {
    readonly platform: string;
    readonly architecture: string;
    readonly nodeVersion: string;
    readonly appleSiliconHardware?: boolean;
  };
  liveWhooshBang?: {
    readonly selectedTransport?: string;
    readonly runtime?: {
      readonly circuit: { readonly blocked: boolean };
      readonly delivery: {
        readonly lastSuccessfulSendAt: string | null;
      };
      readonly polling: {
        readonly committedCursorRef: string | null;
        readonly lastSuccessfulPollAt: string | null;
        readonly state: "active" | "error" | "not-started";
        readonly unacknowledgedEventCount: number;
      };
      readonly presentation: {
        readonly capability: "not-selected" | "supported" | "unsupported";
      };
    };
  };
  runnerBridge?: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly adapterAvailable: boolean;
  };
  mcp?: {
    readonly serverAvailable: boolean;
    readonly daemonAvailable: boolean;
    readonly correlationState?: RelayMcpBindingState | "missing";
  };
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
    const version = output.split("\n")[0]?.trim() ?? "";
    const recognizable =
      harness === "codex"
        ? /^codex(?:-cli)?\s+v?\d+\.\d+\.\d+/i.test(version)
        : harness === "claude"
          ? /^v?\d+\.\d+\.\d+.*\bClaude Code\b/i.test(version)
          : /^(?:cursor(?:-agent)?\s+)?(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}-[A-Za-z0-9._-]+)$/i.test(
              version,
            );
    if (!recognizable) {
      return {
        harness,
        executable,
        available: false,
        verifiedVersion,
        classification: "unsupported",
        evidenceId: evidence.evidence.id,
        drifted: false,
        detail: "version probe returned no recognizable harness version",
      };
    }
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
  if (!observation.available) {
    return "warn";
  }
  if (
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

function cursorHandshakeCheck(
  checks: readonly DoctorCheck[],
): DoctorCheck | undefined {
  const artifacts = checks.find(
    (check) => check.name === "integration-cursor-artifacts",
  );
  if (artifacts === undefined) {
    return undefined;
  }
  const selected = !artifacts.detail.includes("was not selected");
  if (!selected) {
    return {
      name: "cursor-handshake-hook",
      ok: true,
      level: "pass",
      detail:
        "Cursor sessionStart handshake hook is not required because the Cursor plugin was not selected",
    };
  }
  return {
    name: "cursor-handshake-hook",
    ok: artifacts.ok,
    level: artifacts.ok ? "pass" : "fail",
    detail: artifacts.ok
      ? "Cursor sessionStart handshake hook is installed for exact MCP binding"
      : "Cursor sessionStart handshake hook is missing or drifted; run integrations repair",
  };
}

function pushOperatorQuestionDoctorChecks(
  checks: DoctorCheck[],
  options: DoctorOptions,
): void {
  if (options.mcp !== undefined) {
    const mcpServer = checks.find((check) => check.name === "relay-mcp-server");
    const correlation = checks.find(
      (check) => check.name === "relay-mcp-correlation",
    );
    const productionFails = checks.filter(
      (check) =>
        check.level === "fail" &&
        (check.name === "relay-mcp-server" ||
          check.name === "relay-mcp-correlation" ||
          check.name.endsWith("-skill-presence") ||
          check.name.endsWith("-skill-version") ||
          check.name.endsWith("-skill-drift") ||
          check.name === "integration-skill-contract-compatibility" ||
          check.name === "integration-mcp-compatibility" ||
          (check.name.startsWith("integration-") &&
            check.name.endsWith("-artifacts"))),
    );
    const handshake = cursorHandshakeCheck(checks);
    if (handshake !== undefined) {
      checks.push(handshake);
      if (handshake.level === "fail") {
        productionFails.push(handshake);
      }
    }
    const inspected = options.rootDir !== undefined;
    const failed = productionFails.length > 0;
    const warned =
      !failed &&
      (correlation?.level === "warn" ||
        !inspected ||
        handshake === undefined ||
        handshake.level === "warn");
    checks.push({
      name: "interaction-production",
      ok: mcpServer?.ok !== false && !failed,
      level: failed ? "fail" : warned ? "warn" : "pass",
      detail: failed
        ? "operator questions cannot be produced: MCP, correlation, skill, plugin, or Cursor handshake is not ready"
        : handshake !== undefined && inspected
          ? "MCP, exact correlation, official skills, plugins, and Cursor sessionStart handshake are ready for operator questions"
          : inspected
            ? "MCP and official skills are ready; vendor plugin handshake was not inspected"
            : "MCP correlation is installed; official skills, plugins, and handshake were not inspected",
    });
  }

  if (
    options.transportReadiness !== undefined ||
    options.webEnabled !== undefined
  ) {
    const transport = checks.find(
      (check) => check.name === "selected-transport-readiness",
    );
    const failed = transport?.ok === false;
    const webKnown = options.webEnabled !== undefined;
    const warned =
      !failed && (transport === undefined || !webKnown || !options.webEnabled);
    checks.push({
      name: "configured-surfaces",
      ok: !failed,
      level: failed ? "fail" : warned ? "warn" : "pass",
      detail: failed
        ? "the selected delivery transport is not ready"
        : options.webEnabled === false
          ? "the selected delivery transport is ready; the local web companion is disabled"
          : webKnown
            ? "the selected delivery transport and local web companion are ready"
            : "the selected delivery transport is ready; local web companion state was not proven",
    });
  }
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  if (options.runtime !== undefined) {
    const expected = HARNESS_COMPATIBILITY.runtimeTarget;
    const runtimeMatches = isSupportedRuntimeObservation(options.runtime);
    checks.push({
      name: "runtime-target",
      ok: runtimeMatches,
      level: runtimeMatches ? "pass" : "fail",
      detail: runtimeMatches
        ? `${expected.operatingSystem} on Apple silicon (${options.runtime.architecture} Node), Node.js ${options.runtime.nodeVersion} is within the supported V1 runtime boundary`
        : `observed ${options.runtime.platform}/${options.runtime.architecture} with Node.js ${options.runtime.nodeVersion}; supported V1 runtime is Apple-silicon ${expected.platform} with native ${expected.architecture} or x64 Node through Rosetta and Node.js ${String(expected.minimumNodeMajor)} or newer`,
    });
  }
  if (options.runnerBridge !== undefined) {
    const runnerBridge = options.runnerBridge;
    const ready = !runnerBridge.enabled || runnerBridge.adapterAvailable;
    checks.push({
      name: "runner-bridge",
      ok: ready,
      level: ready ? "pass" : "fail",
      detail: runnerBridge.enabled
        ? runnerBridge.adapterAvailable
          ? "experimental runner bridge is explicitly enabled with an installed adapter"
          : "experimental runner bridge is enabled but no structured harness adapter is installed"
        : runnerBridge.configured
          ? "experimental runner bridge is explicitly disabled"
          : "experimental runner bridge is disabled by default",
    });
  }
  if (options.mcp !== undefined) {
    checks.push({
      name: "relay-mcp-server",
      ok: options.mcp.serverAvailable,
      level: options.mcp.serverAvailable ? "pass" : "fail",
      detail: options.mcp.serverAvailable
        ? "versioned local stdio MCP entrypoint is available"
        : "local stdio MCP entrypoint is unavailable",
    });
    const state = options.mcp.correlationState;
    const failed = state === "ambiguous" || state === "revoked";
    const bound = state === "bound";
    checks.push({
      name: "relay-mcp-correlation",
      ok: !failed,
      level: failed ? "fail" : bound ? "pass" : "warn",
      detail: failed
        ? "exact MCP/native-session correlation failed closed"
        : bound
          ? "one exact native session is bound without exposing its authority"
          : options.mcp.daemonAvailable
            ? "MCP correlation handshake is ready; no exact active native session is bound"
            : "MCP correlation handshake is installed; live daemon readiness was not proven",
    });
  }
  if (options.transportReadiness !== undefined) {
    const readiness = options.transportReadiness;
    checks.push({
      name: "transport-selection",
      ok: true,
      level: "pass",
      detail: `${readiness.selectedTransport} selected from ${readiness.selection.source} configuration`,
    });

    const selectedReadiness = readiness.transports[readiness.selectedTransport];
    checks.push({
      name: "selected-transport-readiness",
      ok: selectedReadiness.ready,
      level: selectedReadiness.ready ? "pass" : "fail",
      detail: selectedReadiness.ready
        ? `${readiness.selectedTransport} transport is ready`
        : `${readiness.selectedTransport} transport is not ready${
            "issueCodes" in selectedReadiness &&
            selectedReadiness.issueCodes.length > 0
              ? ` (${selectedReadiness.issueCodes.join(", ")})`
              : ""
          }`,
    });

    const whooshbang = readiness.transports.whooshbang;
    if (whooshbang.configured || readiness.selectedTransport === "whooshbang") {
      checks.push({
        name: "whooshbang-transport",
        ok: whooshbang.ready,
        level: whooshbang.ready
          ? "pass"
          : readiness.selectedTransport === "whooshbang"
            ? "fail"
            : "warn",
        detail: JSON.stringify({
          apiOrigin: whooshbang.apiOrigin ?? null,
          binding: whooshbang.binding,
          contractVersion: whooshbang.contractVersion ?? null,
          credentialPermissions: whooshbang.credentialPermissions,
          credentialPresent: whooshbang.credentialPresent,
          issueCodes: whooshbang.issueCodes,
          machineClientRef: whooshbang.machineClientRef ?? null,
          resolutionPresentation: whooshbang.resolutionPresentation,
        }),
      });
    }

    const telegram = readiness.transports.telegram;
    if (
      telegram.configured !== "none" ||
      readiness.selectedTransport === "telegram"
    ) {
      checks.push({
        name: "telegram-transport",
        ok: telegram.ready,
        level: telegram.ready
          ? "pass"
          : readiness.selectedTransport === "telegram"
            ? "fail"
            : "warn",
        detail: JSON.stringify({
          configured: telegram.configured,
          deliveryReady: telegram.deliveryReady,
          issueCodes: telegram.issueCodes,
          replyReady: telegram.replyReady,
          updateMode: telegram.updateMode,
        }),
      });
    }

    const webhook = readiness.transports.webhook;
    if (webhook.configured || readiness.selectedTransport === "webhook") {
      checks.push({
        name: "webhook-transport",
        ok: webhook.ready,
        level: webhook.ready
          ? "pass"
          : readiness.selectedTransport === "webhook"
            ? "fail"
            : "warn",
        detail: JSON.stringify({
          endpointOrigin: webhook.endpointOrigin ?? null,
          issueCodes: webhook.issueCodes,
          secretPresent: webhook.secretPresent,
          source: webhook.source,
          timeoutMs: webhook.timeoutMs ?? null,
        }),
      });
    }
  }
  if (options.liveWhooshBang !== undefined) {
    const selected = options.liveWhooshBang.selectedTransport === "whooshbang";
    const runtime = options.liveWhooshBang.runtime;
    checks.push({
      name: "whooshbang-live-selection",
      ok: selected,
      level: selected ? "pass" : "fail",
      detail: selected
        ? "the running daemon selected WhooshBang"
        : "the running daemon did not select WhooshBang",
    });

    const readiness = options.transportReadiness?.transports.whooshbang;
    const evidence = readiness?.canaryEvidence;
    const canaryRecorded =
      readiness?.canaryRef !== undefined &&
      evidence !== undefined &&
      readiness.credentialGeneration === evidence.credentialGeneration;
    checks.push({
      name: "whooshbang-hosted-canary",
      ok: canaryRecorded,
      level: canaryRecorded ? "pass" : "fail",
      detail: canaryRecorded
        ? JSON.stringify({
            completedAt: evidence?.completedAt,
            credentialGeneration: evidence?.credentialGeneration,
          })
        : "no canary correlated to the current hosted credential is recorded",
    });

    const deliveryReady =
      canaryRecorded &&
      evidence !== undefined &&
      runtime !== undefined &&
      !runtime.circuit.blocked &&
      runtime.delivery.lastSuccessfulSendAt !== null &&
      Date.parse(runtime.delivery.lastSuccessfulSendAt) >=
        Date.parse(evidence.lastSuccessfulSendAt);
    checks.push({
      name: "whooshbang-live-send",
      ok: deliveryReady,
      level: deliveryReady ? "pass" : "fail",
      detail: JSON.stringify({
        circuitBlocked: runtime?.circuit.blocked ?? null,
        lastSuccessfulSendAt: runtime?.delivery.lastSuccessfulSendAt ?? null,
      }),
    });

    const pollingReady =
      canaryRecorded &&
      evidence !== undefined &&
      runtime?.polling.state === "active" &&
      runtime.polling.lastSuccessfulPollAt !== null &&
      Date.parse(runtime.polling.lastSuccessfulPollAt) >=
        Date.parse(evidence.lastSuccessfulPollAt);
    checks.push({
      name: "whooshbang-live-poll",
      ok: pollingReady,
      level: pollingReady ? "pass" : "fail",
      detail: JSON.stringify({
        lastSuccessfulPollAt: runtime?.polling.lastSuccessfulPollAt ?? null,
        state: runtime?.polling.state ?? "unavailable",
      }),
    });

    const ackReady =
      canaryRecorded &&
      runtime?.polling.committedCursorRef !== null &&
      runtime?.polling.committedCursorRef !== undefined &&
      runtime.polling.unacknowledgedEventCount === 0;
    checks.push({
      name: "whooshbang-live-ack",
      ok: ackReady,
      level: ackReady ? "pass" : "fail",
      detail: JSON.stringify({
        committedCursorRef: runtime?.polling.committedCursorRef ?? null,
        unacknowledgedEventCount:
          runtime?.polling.unacknowledgedEventCount ?? null,
      }),
    });

    const presentationReady =
      runtime !== undefined &&
      runtime.presentation.capability !== "not-selected";
    checks.push({
      name: "whooshbang-resolution-presentation",
      ok: presentationReady,
      level: presentationReady ? "pass" : "fail",
      detail: JSON.stringify({
        capability: runtime?.presentation.capability ?? "unavailable",
      }),
    });
  }
  let store: RelayStore | undefined;
  try {
    store = new RelayStore(options.databasePath ?? ":memory:");
    const service = new RelayService(store, new FakeNotificationTransport());
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

  const harnessObservations = observeHarnessVersions(options.executables);
  for (const observation of harnessObservations) {
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
  const availableHarnesses = harnessObservations.filter(
    (observation) =>
      observation.available &&
      observation.classification !== "unsupported" &&
      observation.classification !== "disabled",
  );
  checks.push({
    name: "harness-availability",
    ok: availableHarnesses.length > 0,
    level: availableHarnesses.length > 0 ? "pass" : "fail",
    detail:
      availableHarnesses.length > 0
        ? `${availableHarnesses.map((observation) => observation.harness).join(", ")} available within the compatibility boundary`
        : "no supported harness executable is available; install at least one supported harness",
  });
  checks.push({
    name: "capability-matrix",
    ok: new Set(HARNESS_CAPABILITIES.map((entry) => entry.harness)).size === 3,
    level: "pass",
    detail: `${HARNESS_COMPATIBILITY.schema}: ${HARNESS_CAPABILITIES.length} runtime-validated harness/surface records loaded; evidence rechecked ${HARNESS_COMPATIBILITY.evidenceRecheckedAt}`,
  });

  if (options.rootDir !== undefined) {
    try {
      const harnessVersions = Object.fromEntries(
        harnessObservations
          .filter(
            (
              observation,
            ): observation is HarnessVersionObservation & {
              version: string;
            } => observation.version !== undefined,
          )
          .map((observation) => [observation.harness, observation.version]),
      );
      const harnessClassifications = Object.fromEntries(
        harnessObservations.map((observation) => [
          observation.harness,
          observation.classification,
        ]),
      );
      const integrations = await inspectVendorIntegrations(options.rootDir, {
        harnessVersions,
        harnessClassifications,
      });
      const installation = integrations.installed
        ? integrations
        : await inspectAgentRelayInstallation(options.rootDir, {
            packageVersion: options.packageVersion ?? AGENT_RELAY_VERSION,
            ...(options.runtimeEntryPath === undefined
              ? {}
              : { runtimeEntryPath: options.runtimeEntryPath }),
            ...(options.runtimeNodePath === undefined
              ? {}
              : { runtimeNodePath: options.runtimeNodePath }),
            harnessVersions,
          });
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
  pushOperatorQuestionDoctorChecks(checks, options);
  return {
    healthy: checks.every((check) => check.level !== "fail"),
    checks,
  };
}
