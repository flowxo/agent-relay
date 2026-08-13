import { createHash } from "node:crypto";
import { basename } from "node:path";

import { z } from "zod";

export * from "./interaction.js";
export * from "./mcp.js";
export * from "./skill.js";
import { OperatorInteractionRequestV1Schema } from "./interaction.js";

const boundedId = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must be an opaque identifier without whitespace",
  );
const isoTimestamp = z.iso.datetime({ offset: true });

export const HarnessSchema = z.enum(["codex", "claude", "cursor"]);
export const SurfaceSchema = z.enum(["cli", "ide", "app-server", "sdk"]);
export const EventTypeSchema = z.enum([
  "session.started",
  "turn.started",
  "turn.activity",
  "turn.stopped",
  "turn.failed",
  "input.required",
  "permission.required",
  "process.exited",
  "process.stale",
  "session.ended",
]);

export const CapabilitySetSchema = z
  .object({
    inlineContinue: z.boolean(),
    lateResume: z.boolean(),
    activeSteer: z.boolean(),
    permissionDecision: z.boolean(),
  })
  .strict();

export const ProjectRefSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    cwdHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    worktree: z.string().min(1).max(120).optional(),
    branch: z.string().min(1).max(240).optional(),
  })
  .strict();

export const ProcessExitEvidenceSchema = z
  .object({
    source: z.literal("owned-child"),
    supervisorId: boundedId,
    startedAt: isoTimestamp,
    exitedAt: isoTimestamp,
    pid: z.number().int().positive().optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    signal: z
      .string()
      .min(4)
      .max(32)
      .regex(/^SIG[A-Z0-9]+$/)
      .optional(),
    classification: z.enum([
      "clean-exit",
      "nonzero-exit",
      "signal",
      "spawn-error",
      "unknown",
    ]),
    expected: z.boolean(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (Date.parse(evidence.exitedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "process exit cannot precede process start",
        path: ["exitedAt"],
      });
    }
    if (
      evidence.classification === "clean-exit" &&
      (evidence.exitCode !== 0 || !evidence.expected)
    ) {
      context.addIssue({
        code: "custom",
        message: "clean exits require exit code 0 and expected=true",
        path: ["classification"],
      });
    }
    if (
      evidence.classification === "nonzero-exit" &&
      (evidence.exitCode === undefined || evidence.exitCode === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "nonzero exits require a non-zero exit code",
        path: ["exitCode"],
      });
    }
    if (evidence.classification === "signal" && evidence.signal === undefined) {
      context.addIssue({
        code: "custom",
        message: "signal exits require a signal",
        path: ["signal"],
      });
    }
  });

export const BackgroundWorkObservationSchema = z
  .object({
    inFlightCount: z.number().int().nonnegative().max(1_000),
    scheduledCount: z.number().int().nonnegative().max(1_000),
  })
  .strict()
  .refine(
    ({ inFlightCount, scheduledCount }) => inFlightCount + scheduledCount > 0,
    "background work requires at least one in-flight or scheduled item",
  );

export const AttentionRequestSchema = z
  .object({
    correlationId: boundedId,
    kind: z.enum([
      "confirm",
      "select",
      "multi-select",
      "question-set",
      "input",
      "permission",
      "continuation",
    ]),
    question: z.string().min(1).max(1_000),
    options: z
      .array(
        z
          .object({
            id: boundedId,
            label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(2)
      .max(20)
      .optional(),
    minSelections: z.number().int().min(0).max(20).optional(),
    maxSelections: z.number().int().min(1).max(20).optional(),
    interaction: OperatorInteractionRequestV1Schema.optional(),
    expiresAt: isoTimestamp,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.kind === "select" || request.kind === "multi-select") &&
      request.options === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "select requests require options",
        path: ["options"],
      });
    }
    if (
      request.kind !== "select" &&
      request.kind !== "multi-select" &&
      request.options !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "options are only valid for select requests",
        path: ["options"],
      });
    }
    if (request.options !== undefined) {
      const optionIds = request.options.map((option) => option.id);
      if (new Set(optionIds).size !== optionIds.length) {
        context.addIssue({
          code: "custom",
          message: "option IDs must be unique",
          path: ["options"],
        });
      }
    }
    if (request.kind === "multi-select") {
      if (
        request.minSelections === undefined ||
        request.maxSelections === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "multi-select requests require selection bounds",
          path: ["minSelections"],
        });
      } else if (request.minSelections > request.maxSelections) {
        context.addIssue({
          code: "custom",
          message: "minimum selections cannot exceed maximum selections",
          path: ["minSelections"],
        });
      } else if (
        request.options !== undefined &&
        request.maxSelections > request.options.length
      ) {
        context.addIssue({
          code: "custom",
          message: "maximum selections cannot exceed the option count",
          path: ["maxSelections"],
        });
      }
    } else if (
      request.minSelections !== undefined ||
      request.maxSelections !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "selection bounds are only valid for multi-select requests",
        path: ["minSelections"],
      });
    }
    if (request.kind === "question-set") {
      if (request.interaction === undefined) {
        context.addIssue({
          code: "custom",
          message: "question-set requests require an interaction",
          path: ["interaction"],
        });
      } else {
        if (request.correlationId !== request.interaction.requestId) {
          context.addIssue({
            code: "custom",
            message: "question-set request IDs must match",
            path: ["interaction", "requestId"],
          });
        }
        if (request.expiresAt !== request.interaction.expiresAt) {
          context.addIssue({
            code: "custom",
            message: "question-set expiry must match its interaction",
            path: ["interaction", "expiresAt"],
          });
        }
      }
    } else if (request.interaction !== undefined) {
      context.addIssue({
        code: "custom",
        message: "interaction is only valid for question-set requests",
        path: ["interaction"],
      });
    }
  });

export const AgentAttentionEventV1Schema = z
  .object({
    schema: z.literal("agent-attention.v1"),
    eventId: boundedId,
    occurredAt: isoTimestamp,
    sequence: z.number().int().nonnegative(),
    accountId: boundedId.optional(),
    machineId: boundedId,
    bridgeSessionId: boundedId,
    harness: HarnessSchema,
    surface: SurfaceSchema,
    harnessVersion: z.string().min(1).max(120),
    sessionId: boundedId,
    turnId: boundedId.optional(),
    toolUseId: boundedId.optional(),
    pid: z.number().int().positive().optional(),
    project: ProjectRefSchema,
    type: EventTypeSchema,
    summary: z.string().max(2_000).optional(),
    lastAssistantMessage: z.string().max(4_000).optional(),
    failure: z
      .object({
        class: z.string().min(1).max(120),
        message: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
    processExit: ProcessExitEvidenceSchema.optional(),
    backgroundWork: BackgroundWorkObservationSchema.optional(),
    request: AttentionRequestSchema.optional(),
    capabilities: CapabilitySetSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      (event.type === "input.required" ||
        event.type === "permission.required") &&
      event.request === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: `${event.type} events require a request`,
        path: ["request"],
      });
    }

    if (event.type === "turn.failed" && event.failure === undefined) {
      context.addIssue({
        code: "custom",
        message: "turn.failed events require failure details",
        path: ["failure"],
      });
    }

    if (
      event.type === "process.exited" &&
      (event.failure === undefined || event.processExit === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "process.exited events require failure details and owned-child evidence",
        path: ["processExit"],
      });
    }

    if (
      event.type === "process.exited" &&
      event.processExit?.expected === true
    ) {
      context.addIssue({
        code: "custom",
        message: "process.exited cannot describe an expected exit",
        path: ["processExit", "expected"],
      });
    }

    if (
      event.type !== "process.exited" &&
      event.type !== "session.ended" &&
      event.processExit !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "owned-child exit evidence is only valid for process.exited or session.ended",
        path: ["processExit"],
      });
    }

    if (event.backgroundWork !== undefined && event.type !== "turn.activity") {
      context.addIssue({
        code: "custom",
        message: "background work is only valid for turn.activity events",
        path: ["backgroundWork"],
      });
    }

    if (
      event.request !== undefined &&
      Date.parse(event.request.expiresAt) <= Date.parse(event.occurredAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "request expiry must be after event occurrence",
        path: ["request", "expiresAt"],
      });
    }
  });

export const CommandKindSchema = z.enum(["answer", "cancel", "resume"]);

export const AgentCommandV1Schema = z
  .object({
    schema: z.literal("agent-command.v1"),
    commandId: boundedId,
    issuedAt: isoTimestamp,
    expiresAt: isoTimestamp,
    machineId: boundedId,
    harness: HarnessSchema,
    sessionId: boundedId,
    turnId: boundedId.optional(),
    correlationId: boundedId,
    kind: CommandKindSchema,
    answer: z.string().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      (command.kind === "answer" || command.kind === "resume") &&
      command.answer === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: `${command.kind} commands require an answer`,
        path: ["answer"],
      });
    }
    if (command.kind === "cancel" && command.answer !== undefined) {
      context.addIssue({
        code: "custom",
        message: "cancel commands cannot include an answer",
        path: ["answer"],
      });
    }
    if (Date.parse(command.expiresAt) <= Date.parse(command.issuedAt)) {
      context.addIssue({
        code: "custom",
        message: "command expiry must be after issue time",
        path: ["expiresAt"],
      });
    }
  });

export const SessionRegistrationV1Schema = z
  .object({
    schema: z.literal("agent-session.v1"),
    machineId: boundedId,
    bridgeSessionId: boundedId,
    harness: HarnessSchema,
    surface: SurfaceSchema,
    harnessVersion: z.string().min(1).max(120),
    sessionId: boundedId,
    project: ProjectRefSchema,
    capabilities: CapabilitySetSchema,
    registeredAt: isoTimestamp,
  })
  .strict();

export const SessionHeartbeatV1Schema = z
  .object({
    schema: z.literal("agent-heartbeat.v1"),
    machineId: boundedId,
    harness: HarnessSchema,
    sessionId: boundedId,
    observedAt: isoTimestamp,
    state: z.enum([
      "active",
      "waiting",
      "stopped",
      "suspected_stalled",
      "exited",
    ]),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export const RelayDiagnosticV1Schema = z
  .object({
    schema: z.literal("agent-relay-diagnostic.v1"),
    diagnosticId: boundedId,
    recordedAt: isoTimestamp,
    source: z.enum([
      "hook",
      "supervisor",
      "fallback-spool",
      "installer",
      "daemon",
    ]),
    level: z.enum(["info", "warn", "error"]),
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/i),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export type Harness = z.infer<typeof HarnessSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
export type ProcessExitEvidence = z.infer<typeof ProcessExitEvidenceSchema>;
export type BackgroundWorkObservation = z.infer<
  typeof BackgroundWorkObservationSchema
>;
export type AttentionRequest = z.infer<typeof AttentionRequestSchema>;
export type AgentAttentionEventV1 = z.infer<typeof AgentAttentionEventV1Schema>;
export type AgentCommandV1 = z.infer<typeof AgentCommandV1Schema>;
export type SessionRegistrationV1 = z.infer<typeof SessionRegistrationV1Schema>;
export type SessionHeartbeatV1 = z.infer<typeof SessionHeartbeatV1Schema>;
export type RelayDiagnosticV1 = z.infer<typeof RelayDiagnosticV1Schema>;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeProjectRef(cwd: string): ProjectRef {
  const displayName = basename(cwd) || "workspace";
  return {
    displayName: displayName.slice(0, 120),
    cwdHash: `sha256:${sha256(cwd)}`,
  };
}

export interface StableEventIdentity {
  machineId: string;
  harness: Harness;
  sessionId: string;
  turnId?: string;
  toolUseId?: string;
  type: EventType;
  sequence: number;
  sourceFingerprint?: string;
}

export function makeStableEventId(identity: StableEventIdentity): string {
  const material = [
    identity.machineId,
    identity.harness,
    identity.sessionId,
    identity.turnId ?? "",
    identity.toolUseId ?? "",
    identity.type,
    identity.sourceFingerprint ?? String(identity.sequence),
  ].join("\u001f");
  return `evt_${sha256(material).slice(0, 40)}`;
}
