import type { Harness, Surface } from "@agent-relay/protocol";

import type { CapabilityLookup, HarnessCapability } from "./types.js";

export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  {
    harness: "codex",
    surface: "cli",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: true,
    activeSteer: false,
    stopFailureSignal: false,
    processExitObservation: false,
    evidence: "official-docs+local-help",
    note: "Late resume uses codex exec resume; crash proof requires supervision.",
  },
  {
    harness: "codex",
    surface: "app-server",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: true,
    activeSteer: true,
    stopFailureSignal: true,
    processExitObservation: false,
    evidence: "official-docs+local-help",
    note: "App Server exposes thread resume, turn start, steer, and completion.",
  },
  {
    harness: "claude",
    surface: "cli",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: true,
    activeSteer: false,
    stopFailureSignal: true,
    processExitObservation: false,
    evidence: "official-docs+local-help",
    note: "StopFailure is observable; process crashes still require supervision.",
  },
  {
    harness: "claude",
    surface: "sdk",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: true,
    activeSteer: true,
    stopFailureSignal: true,
    processExitObservation: false,
    evidence: "official-docs",
    note: "Streaming SDK input can steer an owned active session.",
  },
  {
    harness: "cursor",
    surface: "cli",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: true,
    activeSteer: false,
    stopFailureSignal: true,
    processExitObservation: false,
    evidence: "official-docs+local-help",
    note: "Late resume uses --resume; no documented active-turn steering API.",
  },
  {
    harness: "cursor",
    surface: "ide",
    deterministicStop: true,
    inlineContinue: true,
    permissionDecision: true,
    lateResume: false,
    activeSteer: false,
    stopFailureSignal: true,
    processExitObservation: false,
    evidence: "official-docs",
    note: "Returned IDE stop hooks cannot be resumed safely through Cursor CLI.",
  },
] as const;

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

export function renderCapabilityMatrix(): string {
  const headers = [
    "Harness",
    "Surface",
    "Stop",
    "Inline continue",
    "Permission decision",
    "Late resume",
    "Active steer",
    "Failure signal",
    "Process exit proof",
    "Notes",
  ];
  const rows = HARNESS_CAPABILITIES.map((entry) => {
    const mark = (value: boolean) => (value ? "Yes" : "No");
    return [
      entry.harness,
      entry.surface,
      mark(entry.deterministicStop),
      mark(entry.inlineContinue),
      mark(entry.permissionDecision),
      mark(entry.lateResume),
      mark(entry.activeSteer),
      mark(entry.stopFailureSignal),
      mark(entry.processExitObservation),
      entry.note,
    ];
  });
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const tableLine = (cells: readonly string[]) =>
    `| ${cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join(" | ")} |`;

  return [
    "# Generated Harness Capability Matrix",
    "",
    "<!-- Generated from packages/harnesses/src/capabilities.ts. -->",
    "",
    tableLine(headers),
    tableLine(widths.map((width) => "-".repeat(width))),
    ...rows.map(tableLine),
    "",
    "A `No` for process exit proof is intentional: native hooks cannot prove a crash.",
    "That capability becomes true only for sessions owned by the Milestone 3",
    "supervisor.",
    "",
  ].join("\n");
}
