import type { Harness, Surface } from "@agent-relay/protocol";
import { z } from "zod";

import type {
  CapabilityLookup,
  CompatibilityClassification,
  HarnessCapability,
} from "./types.js";

export const COMPATIBILITY_CLASSIFICATIONS = {
  verified:
    "Exact surface/version has a current sanitized fixture and bounded canary evidence.",
  "compatible-unverified":
    "The official contract or local help supports the shape, but the complete path is not verified.",
  unsupported:
    "The required surface or capability is absent or known incompatible.",
  disabled:
    "The contract is understood, but Agent Relay intentionally keeps the capability off.",
} as const satisfies Record<CompatibilityClassification, string>;

const CompatibilityClassificationSchema = z.enum([
  "verified",
  "compatible-unverified",
  "unsupported",
  "disabled",
]);

const CapabilityClassificationsSchema = z
  .object({
    deterministicStop: CompatibilityClassificationSchema,
    inlineContinue: CompatibilityClassificationSchema,
    permissionDecision: CompatibilityClassificationSchema,
    lateResume: CompatibilityClassificationSchema,
    activeSteer: CompatibilityClassificationSchema,
    stopFailureSignal: CompatibilityClassificationSchema,
    processExitObservation: CompatibilityClassificationSchema,
  })
  .strict();

const EvidenceSchema = z
  .object({
    id: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9.-]+$/),
    verifiedAt: z.iso.date().optional(),
    fixturePaths: z.array(z.string().min(1).max(240)).max(6),
    record: z.string().min(1).max(240),
    officialSources: z.array(z.url().max(500)).min(1).max(4),
  })
  .strict();

const HarnessCompatibilitySchema = z
  .object({
    harness: z.enum(["codex", "claude", "cursor"]),
    surface: z.enum(["cli", "app-server", "sdk", "ide"]),
    label: z.string().min(1).max(60),
    classification: CompatibilityClassificationSchema,
    verifiedVersion: z.string().min(1).max(120).optional(),
    executable: z.string().min(1).max(80).optional(),
    knownIncompatibleVersions: z.array(z.string().min(1).max(120)).max(20),
    capabilities: CapabilityClassificationsSchema,
    evidenceKind: z.enum(["official-docs+local-help", "official-docs"]),
    evidence: EvidenceSchema,
    note: z.string().min(1).max(240),
  })
  .strict()
  .superRefine((entry, context) => {
    const verifiedCapabilities = Object.values(entry.capabilities).filter(
      (classification) => classification === "verified",
    );
    if (
      entry.classification === "verified" &&
      (entry.verifiedVersion === undefined ||
        entry.executable === undefined ||
        entry.evidence.verifiedAt === undefined ||
        entry.evidence.fixturePaths.length === 0 ||
        verifiedCapabilities.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "verified surfaces require an exact version, executable, dated fixture, evidence record, and verified capability",
      });
    }
    if (
      entry.verifiedVersion !== undefined &&
      entry.knownIncompatibleVersions.includes(entry.verifiedVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "a verified version cannot also be known incompatible",
      });
    }
  });

const CompatibilityRegistrySchema = z
  .object({
    schema: z.literal("agent-relay-compatibility.v1"),
    evidenceRecheckedAt: z.iso.date(),
    runtimeTarget: z
      .object({
        operatingSystem: z.literal("macOS"),
        platform: z.literal("darwin"),
        architecture: z.literal("arm64"),
        minimumNodeMajor: z.literal(22),
        evidenceRecord: z.string().min(1).max(240),
        note: z.string().min(1).max(240),
      })
      .strict(),
    unsupportedRuntimeClaims: z.array(z.string().min(1).max(80)).min(1).max(12),
    records: z.array(HarnessCompatibilitySchema).length(6),
  })
  .strict()
  .superRefine((registry, context) => {
    const identities = registry.records.map(
      (entry) => `${entry.harness}/${entry.surface}`,
    );
    const expectedIdentities = [
      "codex/cli",
      "codex/app-server",
      "claude/cli",
      "claude/sdk",
      "cursor/cli",
      "cursor/ide",
    ];
    if (
      identities.length !== expectedIdentities.length ||
      expectedIdentities.some((identity) => !identities.includes(identity))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "compatibility registry must contain every supported harness/surface exactly once",
      });
    }
    if (
      new Set(registry.records.map((entry) => entry.evidence.id)).size !==
      registry.records.length
    ) {
      context.addIssue({
        code: "custom",
        message: "compatibility evidence IDs must be unique",
      });
    }
    for (const harness of ["codex", "claude", "cursor"] as const) {
      if (
        !registry.records.some(
          (entry) =>
            entry.harness === harness &&
            entry.surface === "cli" &&
            entry.classification === "verified",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `${harness} requires one exact verified CLI record for doctor`,
        });
      }
    }
  });

export type HarnessCompatibilityRecord = z.infer<
  typeof HarnessCompatibilitySchema
>;

export const HARNESS_COMPATIBILITY = CompatibilityRegistrySchema.parse({
  schema: "agent-relay-compatibility.v1",
  evidenceRecheckedAt: "2026-07-29",
  runtimeTarget: {
    operatingSystem: "macOS",
    platform: "darwin",
    architecture: "arm64",
    minimumNodeMajor: 22,
    evidenceRecord: "docs/harness-evidence.md#evidence-boundary",
    note: "Native Node 22.23.1 clean-home package evidence is complete on this target; exact harness claims remain versioned snapshots.",
  },
  unsupportedRuntimeClaims: [
    "Windows",
    "Linux end-user runtime",
    "Intel macOS",
    "Cursor IDE late resume",
    "native-hook crash proof",
    "Cursor permission automation",
  ],
  records: [
    {
      harness: "codex",
      surface: "cli",
      label: "Codex CLI",
      classification: "verified",
      verifiedVersion: "codex-cli 0.145.0",
      executable: "codex",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "verified",
        inlineContinue: "compatible-unverified",
        permissionDecision: "compatible-unverified",
        lateResume: "verified",
        activeSteer: "unsupported",
        stopFailureSignal: "unsupported",
        processExitObservation: "unsupported",
      },
      evidenceKind: "official-docs+local-help",
      evidence: {
        id: "codex-cli-0.145.0-2026-07-25",
        verifiedAt: "2026-07-25",
        fixturePaths: [
          "packages/harnesses/fixtures/codex/session-start.json",
          "packages/harnesses/fixtures/codex/user-prompt-submit.json",
          "packages/harnesses/fixtures/codex/stop.json",
        ],
        record: "docs/harness-evidence.md#live-harness-activation",
        officialSources: [
          "https://learn.chatgpt.com/docs/hooks",
          "https://developers.openai.com/codex/noninteractive",
        ],
      },
      note: "Stop and read-only late resume are live-proven; privacy-safe session and prompt lifecycle cards are fixture-proven.",
    },
    {
      harness: "codex",
      surface: "app-server",
      label: "Codex App Server",
      classification: "verified",
      verifiedVersion: "codex-cli 0.145.0",
      executable: "codex",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "verified",
        inlineContinue: "verified",
        permissionDecision: "verified",
        lateResume: "verified",
        activeSteer: "verified",
        stopFailureSignal: "verified",
        processExitObservation: "verified",
      },
      evidenceKind: "official-docs+local-help",
      evidence: {
        id: "codex-app-server-0.145.0-2026-07-27",
        verifiedAt: "2026-07-27",
        fixturePaths: [
          "packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/contract.json",
          "packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/transcript.json",
          "packages/codex-app-server-driver/fixtures/codex-app-server-0.145.0/live-canary.json",
        ],
        record: "docs/harness-evidence.md#codex-app-server-structured-profile",
        officialSources: ["https://developers.openai.com/codex/app-server"],
      },
      note: "The owned stdio driver, durable correlation, and local adoption recovery are exact-version proven behind the default-off bridge.",
    },
    {
      harness: "claude",
      surface: "cli",
      label: "Claude Code CLI",
      classification: "verified",
      verifiedVersion: "2.1.219 (Claude Code)",
      executable: "claude",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "verified",
        inlineContinue: "compatible-unverified",
        permissionDecision: "compatible-unverified",
        lateResume: "verified",
        activeSteer: "unsupported",
        stopFailureSignal: "compatible-unverified",
        processExitObservation: "unsupported",
      },
      evidenceKind: "official-docs+local-help",
      evidence: {
        id: "claude-cli-2.1.219-2026-07-25",
        verifiedAt: "2026-07-25",
        fixturePaths: [
          "packages/harnesses/fixtures/claude/session-start.json",
          "packages/harnesses/fixtures/claude/user-prompt-submit.json",
          "packages/harnesses/fixtures/claude/stop.json",
          "packages/harnesses/fixtures/claude/stop-background-work.json",
          "packages/harnesses/fixtures/claude/stop-failure.json",
        ],
        record: "docs/harness-evidence.md#live-harness-activation",
        officialSources: ["https://code.claude.com/docs/en/hooks"],
      },
      note: "Stop and plan-mode late resume are live-proven; quiet lifecycle, structured background work, and StopFailure are fixture-proven.",
    },
    {
      harness: "claude",
      surface: "sdk",
      label: "Claude Agent SDK",
      classification: "compatible-unverified",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "compatible-unverified",
        inlineContinue: "compatible-unverified",
        permissionDecision: "compatible-unverified",
        lateResume: "compatible-unverified",
        activeSteer: "compatible-unverified",
        stopFailureSignal: "compatible-unverified",
        processExitObservation: "unsupported",
      },
      evidenceKind: "official-docs",
      evidence: {
        id: "claude-sdk-contract-2026-07-26",
        fixturePaths: [],
        record: "docs/harness-evidence.md#official-contract-sources",
        officialSources: [
          "https://platform.claude.com/docs/en/agent-sdk/overview",
        ],
      },
      note: "The streaming SDK contract is understood but is not the installed V1 user path.",
    },
    {
      harness: "cursor",
      surface: "cli",
      label: "Cursor CLI",
      classification: "verified",
      verifiedVersion: "2026.07.23-e383d2b",
      executable: "cursor-agent",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "verified",
        inlineContinue: "compatible-unverified",
        permissionDecision: "disabled",
        lateResume: "verified",
        activeSteer: "unsupported",
        stopFailureSignal: "compatible-unverified",
        processExitObservation: "unsupported",
      },
      evidenceKind: "official-docs+local-help",
      evidence: {
        id: "cursor-cli-2026.07.23-e383d2b-2026-07-25",
        verifiedAt: "2026-07-25",
        fixturePaths: ["packages/harnesses/fixtures/cursor/stop.json"],
        record: "docs/harness-evidence.md#live-harness-activation",
        officialSources: [
          "https://cursor.com/docs/hooks",
          "https://docs.cursor.com/en/cli/using",
        ],
      },
      note: "Interactive Stop and trusted late resume are live-proven; --print did not emit initial Stop.",
    },
    {
      harness: "cursor",
      surface: "ide",
      label: "Cursor IDE",
      classification: "compatible-unverified",
      knownIncompatibleVersions: [],
      capabilities: {
        deterministicStop: "compatible-unverified",
        inlineContinue: "compatible-unverified",
        permissionDecision: "disabled",
        lateResume: "unsupported",
        activeSteer: "unsupported",
        stopFailureSignal: "compatible-unverified",
        processExitObservation: "unsupported",
      },
      evidenceKind: "official-docs",
      evidence: {
        id: "cursor-ide-contract-2026-07-26",
        fixturePaths: [],
        record: "docs/harness-evidence.md#official-contract-sources",
        officialSources: ["https://cursor.com/docs/hooks"],
      },
      note: "Stop hooks are contract-backed; an IDE session cannot be safely resumed as a new CLI process.",
    },
  ],
});

function isEnabled(classification: CompatibilityClassification): boolean {
  return (
    classification === "verified" || classification === "compatible-unverified"
  );
}

export const HARNESS_CAPABILITIES: readonly HarnessCapability[] =
  HARNESS_COMPATIBILITY.records.map((entry) => ({
    harness: entry.harness,
    surface: entry.surface,
    classification: entry.classification,
    ...(entry.verifiedVersion === undefined
      ? {}
      : { verifiedVersion: entry.verifiedVersion }),
    evidenceId: entry.evidence.id,
    capabilityClassifications: entry.capabilities,
    deterministicStop: isEnabled(entry.capabilities.deterministicStop),
    inlineContinue: isEnabled(entry.capabilities.inlineContinue),
    permissionDecision: isEnabled(entry.capabilities.permissionDecision),
    lateResume: isEnabled(entry.capabilities.lateResume),
    activeSteer: isEnabled(entry.capabilities.activeSteer),
    stopFailureSignal: isEnabled(entry.capabilities.stopFailureSignal),
    processExitObservation: isEnabled(
      entry.capabilities.processExitObservation,
    ),
    evidence: entry.evidenceKind,
    note: entry.note,
  }));

export const VERIFIED_CLI_HARNESS_EVIDENCE = Object.fromEntries(
  HARNESS_COMPATIBILITY.records
    .filter(
      (
        entry,
      ): entry is HarnessCompatibilityRecord & {
        surface: "cli";
        verifiedVersion: string;
        executable: string;
      } =>
        entry.surface === "cli" &&
        entry.classification === "verified" &&
        entry.verifiedVersion !== undefined &&
        entry.executable !== undefined,
    )
    .map((entry) => [entry.harness, entry]),
) as Readonly<Record<Harness, HarnessCompatibilityRecord>>;

export interface RuntimeSupportObservation {
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly appleSiliconHardware?: boolean;
}

export function isSupportedRuntimeObservation(
  observation: RuntimeSupportObservation,
): boolean {
  const expected = HARNESS_COMPATIBILITY.runtimeTarget;
  const nodeVersion = /^(\d+)(?:\.|$)/.exec(observation.nodeVersion);
  const nodeMajor = nodeVersion === null ? Number.NaN : Number(nodeVersion[1]);
  return (
    observation.platform === expected.platform &&
    (observation.architecture === expected.architecture ||
      (observation.architecture === "x64" &&
        observation.appleSiliconHardware === true)) &&
    Number.isInteger(nodeMajor) &&
    nodeMajor >= expected.minimumNodeMajor
  );
}

export function classifyObservedHarnessVersion(
  evidence: Pick<
    HarnessCompatibilityRecord,
    "verifiedVersion" | "knownIncompatibleVersions"
  >,
  observedVersion: string,
): CompatibilityClassification {
  if (evidence.knownIncompatibleVersions.includes(observedVersion)) {
    return "unsupported";
  }
  return observedVersion === evidence.verifiedVersion
    ? "verified"
    : "compatible-unverified";
}

export const PUBLIC_COMPATIBILITY_RECORD = {
  schema: HARNESS_COMPATIBILITY.schema,
  evidenceRecheckedAt: HARNESS_COMPATIBILITY.evidenceRecheckedAt,
  runtimeTarget: HARNESS_COMPATIBILITY.runtimeTarget,
  unsupportedRuntimeClaims: HARNESS_COMPATIBILITY.unsupportedRuntimeClaims,
  classifications: COMPATIBILITY_CLASSIFICATIONS,
  records: HARNESS_COMPATIBILITY.records.map((entry) => ({
    harness: entry.harness,
    surface: entry.surface,
    label: entry.label,
    classification: entry.classification,
    ...(entry.verifiedVersion === undefined
      ? {}
      : { verifiedVersion: entry.verifiedVersion }),
    capabilities: entry.capabilities,
    evidenceId: entry.evidence.id,
    evidenceRecord: entry.evidence.record,
    note: entry.note,
  })),
} as const;

export function capabilityFor(
  harness: Harness,
  surface: Surface,
): CapabilityLookup | undefined {
  const detail = HARNESS_CAPABILITIES.find(
    (entry) => entry.harness === harness && entry.surface === surface,
  );
  if (detail === undefined) {
    return undefined;
  }
  return {
    detail,
    protocol: {
      inlineContinue: detail.inlineContinue,
      lateResume: detail.lateResume,
      activeSteer: detail.activeSteer,
      permissionDecision: detail.permissionDecision,
    },
  };
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const tableLine = (cells: readonly string[]) =>
    `| ${cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join(" | ")} |`;
  return [
    tableLine(headers),
    tableLine(widths.map((width) => "-".repeat(width))),
    ...rows.map(tableLine),
  ];
}

export function renderCapabilityMatrix(): string {
  const headers = [
    "Harness",
    "Surface",
    "Exact verified version",
    "Stop",
    "Inline continue",
    "Permission decision",
    "Late resume",
    "Active steer",
    "Failure signal",
    "Native process exit",
    "Evidence",
  ];
  const rows = HARNESS_COMPATIBILITY.records.map((entry) => {
    const evidenceLinks = [
      ...entry.evidence.fixturePaths.map(
        (path, index) =>
          `[fixture${entry.evidence.fixturePaths.length === 1 ? "" : ` ${String(index + 1)}`}](../${path})`,
      ),
      `[record](${entry.evidence.record.replace(/^docs\//, "")})`,
    ];
    return [
      entry.harness,
      entry.surface,
      entry.verifiedVersion ?? "—",
      entry.capabilities.deterministicStop,
      entry.capabilities.inlineContinue,
      entry.capabilities.permissionDecision,
      entry.capabilities.lateResume,
      entry.capabilities.activeSteer,
      entry.capabilities.stopFailureSignal,
      entry.capabilities.processExitObservation,
      evidenceLinks.join(", "),
    ];
  });

  return [
    "# Generated Harness Compatibility Matrix",
    "",
    "<!-- Generated from the runtime-validated compatibility registry. Do not edit by hand. -->",
    "",
    `Evidence rechecked: ${HARNESS_COMPATIBILITY.evidenceRecheckedAt}.`,
    "",
    ...Object.entries(COMPATIBILITY_CLASSIFICATIONS).map(
      ([classification, meaning]) => `- \`${classification}\`: ${meaning}`,
    ),
    "",
    `Runtime validation target: ${HARNESS_COMPATIBILITY.runtimeTarget.operatingSystem} ${HARNESS_COMPATIBILITY.runtimeTarget.architecture}, Node.js ${String(HARNESS_COMPATIBILITY.runtimeTarget.minimumNodeMajor)} or newer. ${HARNESS_COMPATIBILITY.runtimeTarget.note}`,
    "",
    ...table(headers, rows),
    "",
    "Disabled and unsupported capabilities are emitted as `false` in runtime",
    "events and therefore fail closed. Native hooks cannot prove a process crash;",
    "that evidence exists only when Agent Relay owns the supervised child.",
    "",
    `Not claimed: ${HARNESS_COMPATIBILITY.unsupportedRuntimeClaims.join(", ")}.`,
    "",
  ].join("\n");
}

export function renderSupportSummaryBlock(): string {
  const headers = [
    "Harness / surface",
    "Exact verified version",
    "Classification",
    "Important boundary",
  ];
  const rows = HARNESS_COMPATIBILITY.records.map((entry) => [
    entry.label,
    entry.verifiedVersion === undefined ? "—" : `\`${entry.verifiedVersion}\``,
    `\`${entry.classification}\``,
    entry.note,
  ]);

  return [
    "<!-- BEGIN GENERATED HARNESS SUPPORT -->",
    ...table(headers, rows),
    "",
    `Supported runtime: ${HARNESS_COMPATIBILITY.runtimeTarget.operatingSystem} on Apple silicon with native arm64 Node or x64 Node through Rosetta, Node.js ${String(HARNESS_COMPATIBILITY.runtimeTarget.minimumNodeMajor)} or newer; the release-exit target is native Node.js 22.23.1 and the current gate is not green.`,
    `Not claimed: ${HARNESS_COMPATIBILITY.unsupportedRuntimeClaims.join(", ")}.`,
    "<!-- END GENERATED HARNESS SUPPORT -->",
  ].join("\n");
}
