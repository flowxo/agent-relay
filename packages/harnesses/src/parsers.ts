import {
  AgentAttentionEventV1Schema,
  makeProjectRef,
  makeStableEventId,
} from "@agent-relay/protocol";
import type { AgentAttentionEventV1, Harness } from "@agent-relay/protocol";
import { z } from "zod";

import { capabilityFor } from "./capabilities.js";
import type {
  AdapterContext,
  AdapterEvent,
  HarnessParseResult,
  ParseDiagnostic,
} from "./types.js";

const common = {
  session_id: z.string().min(1),
  cwd: z.string().min(1),
};

const codexSessionStartSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .passthrough();

const codexUserPromptSubmitSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("UserPromptSubmit"),
    turn_id: z.string().min(1),
    prompt: z
      .string()
      .min(1)
      .max(256 * 1_024),
  })
  .passthrough();

const codexStopSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("Stop"),
    turn_id: z.string().min(1),
    stop_hook_active: z.boolean(),
    last_assistant_message: z.string().nullable(),
  })
  .passthrough();

const codexPermissionSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("PermissionRequest"),
    turn_id: z.string().min(1),
    tool_name: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_input: z.unknown(),
  })
  .passthrough();

const claudeStopSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("Stop"),
    stop_hook_active: z.boolean(),
    last_assistant_message: z.string().nullable(),
    background_tasks: z.array(z.unknown()).max(1_000).optional(),
    session_crons: z.array(z.unknown()).max(1_000).optional(),
  })
  .passthrough();

const claudeSessionStartSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact", "fork"]),
  })
  .passthrough();

const claudeUserPromptSubmitSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z
      .string()
      .min(1)
      .max(256 * 1_024),
  })
  .passthrough();

const claudeStopFailureSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("StopFailure"),
    error: z.string().min(1),
    error_details: z.string().optional(),
    last_assistant_message: z.string().optional(),
  })
  .passthrough();

const claudePermissionSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("PermissionRequest"),
    tool_name: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_input: z.unknown(),
  })
  .passthrough();

const claudeNotificationSchema = z
  .object({
    ...common,
    hook_event_name: z.literal("Notification"),
    notification_type: z.enum([
      "permission_prompt",
      "idle_prompt",
      "agent_needs_input",
      "agent_completed",
    ]),
    message: z.string().min(1),
    title: z.string().optional(),
  })
  .passthrough();

const cursorStopSchema = z
  .object({
    hook_event_name: z.literal("stop"),
    conversation_id: z.string().min(1),
    status: z.enum(["completed", "aborted", "error"]),
    loop_count: z.number().int().nonnegative(),
    workspace_roots: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

const cursorPermissionSchema = z
  .object({
    hook_event_name: z.enum(["beforeShellExecution", "preToolUse"]),
    conversation_id: z.string().min(1),
    workspace_roots: z.array(z.string().min(1)).min(1),
    command: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    generation_id: z.string().optional(),
  })
  .passthrough();

function summarizeTool(name: string, input: unknown): string {
  void input;
  const toolClass = name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  return `Permission requested for ${toolClass || "tool"}`;
}

const CLAUDE_STOP_FAILURE_CLASSES = new Set([
  "authentication",
  "context_limit",
  "permission",
  "rate_limit",
  "timeout",
]);

function claudeStopFailureClass(value: string): string {
  return CLAUDE_STOP_FAILURE_CLASSES.has(value) ? value : "stop-failure";
}

function issuesFor(error: z.ZodError): NonNullable<ParseDiagnostic["issues"]> {
  return error.issues.slice(0, 8).map((issue) => ({
    path: issue.path.join(".") || "<root>",
    message: issue.message,
  }));
}

function malformed(
  harness: Harness,
  message: string,
  error?: z.ZodError,
): HarnessParseResult {
  return {
    ok: false,
    diagnostic: {
      code: "malformed-payload",
      harness,
      message,
      ...(error === undefined ? {} : { issues: issuesFor(error) }),
      safeBehavior: "native-prompt",
    },
  };
}

function eventFromAdapter(
  harness: Harness,
  adapter: AdapterEvent,
  context: AdapterContext,
): HarnessParseResult {
  const capability = capabilityFor(harness, context.surface);
  if (capability === undefined) {
    return {
      ok: false,
      diagnostic: {
        code: "unsupported-surface",
        harness,
        message: `${harness} does not have a declared ${context.surface} adapter`,
        safeBehavior: "native-prompt",
      },
    };
  }

  const {
    cwd,
    stopHookActive = false,
    sessionId,
    turnId,
    toolUseId,
    ...eventFields
  } = adapter;
  const identity = {
    machineId: context.machineId,
    harness,
    sessionId,
    ...(turnId === undefined ? {} : { turnId }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    type: eventFields["type"],
    sequence: context.sequence,
    ...(context.sourceFingerprint === undefined
      ? {}
      : { sourceFingerprint: context.sourceFingerprint }),
  };
  const candidate: AgentAttentionEventV1 = {
    schema: "agent-attention.v1",
    eventId: makeStableEventId(identity),
    occurredAt: context.occurredAt,
    sequence: context.sequence,
    machineId: context.machineId,
    bridgeSessionId: context.bridgeSessionId,
    harness,
    surface: context.surface,
    harnessVersion: context.harnessVersion,
    sessionId,
    ...(turnId === undefined ? {} : { turnId }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    project: makeProjectRef(cwd),
    ...eventFields,
    capabilities: capability.protocol,
  };
  const parsed = AgentAttentionEventV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return malformed(
      harness,
      "adapter produced an invalid normalized event",
      parsed.error,
    );
  }
  return { ok: true, event: parsed.data, stopHookActive };
}

function parseCodex(
  payload: unknown,
  context: AdapterContext,
): HarnessParseResult {
  const eventName =
    typeof payload === "object" &&
    payload !== null &&
    "hook_event_name" in payload
      ? payload.hook_event_name
      : undefined;

  if (eventName === "SessionStart") {
    const parsed = codexSessionStartSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "codex",
        "invalid Codex SessionStart payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "codex",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type:
          parsed.data.source === "compact"
            ? "turn.activity"
            : "session.started",
        summary:
          parsed.data.source === "compact"
            ? "Context compacted; the session remains active."
            : `Session opened (${parsed.data.source}).`,
      },
      context,
    );
  }

  if (eventName === "UserPromptSubmit") {
    const parsed = codexUserPromptSubmitSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "codex",
        "invalid Codex UserPromptSubmit payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "codex",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        turnId: parsed.data.turn_id,
        type: "turn.started",
        summary: "Operator submitted a prompt; the agent is working.",
      },
      context,
    );
  }

  if (eventName === "Stop") {
    const parsed = codexStopSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed("codex", "invalid Codex Stop payload", parsed.error);
    }
    return eventFromAdapter(
      "codex",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        turnId: parsed.data.turn_id,
        type: "turn.stopped",
        summary: "Foreground work stopped.",
        stopHookActive: parsed.data.stop_hook_active,
      },
      context,
    );
  }

  if (eventName === "PermissionRequest") {
    const parsed = codexPermissionSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "codex",
        "invalid Codex PermissionRequest payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "codex",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        turnId: parsed.data.turn_id,
        toolUseId: parsed.data.tool_use_id,
        type: "permission.required",
        summary: summarizeTool(parsed.data.tool_name, parsed.data.tool_input),
        request: {
          correlationId: `req_${parsed.data.tool_use_id}`,
          kind: "permission",
          question: summarizeTool(
            parsed.data.tool_name,
            parsed.data.tool_input,
          ),
          expiresAt: new Date(
            Date.parse(context.occurredAt) + 5 * 60_000,
          ).toISOString(),
        },
      },
      context,
    );
  }

  return unsupported("codex", eventName);
}

function parseClaude(
  payload: unknown,
  context: AdapterContext,
): HarnessParseResult {
  const eventName =
    typeof payload === "object" &&
    payload !== null &&
    "hook_event_name" in payload
      ? payload.hook_event_name
      : undefined;

  if (eventName === "SessionStart") {
    const parsed = claudeSessionStartSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "claude",
        "invalid Claude SessionStart payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type:
          parsed.data.source === "compact"
            ? "turn.activity"
            : "session.started",
        summary:
          parsed.data.source === "compact"
            ? "Context compacted; the session remains active."
            : `Session opened (${parsed.data.source}).`,
      },
      context,
    );
  }

  if (eventName === "UserPromptSubmit") {
    const parsed = claudeUserPromptSubmitSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "claude",
        "invalid Claude UserPromptSubmit payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type: "turn.started",
        summary: "Operator submitted a prompt; the agent is working.",
      },
      context,
    );
  }

  if (eventName === "Stop") {
    const parsed = claudeStopSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed("claude", "invalid Claude Stop payload", parsed.error);
    }
    const inFlightCount = parsed.data.background_tasks?.length ?? 0;
    const scheduledCount = parsed.data.session_crons?.length ?? 0;
    const backgroundWorkContinues = inFlightCount + scheduledCount > 0;
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type: backgroundWorkContinues ? "turn.activity" : "turn.stopped",
        ...(backgroundWorkContinues
          ? {
              summary: `Background work continues: ${String(
                inFlightCount,
              )} in flight, ${String(scheduledCount)} scheduled`,
              backgroundWork: {
                inFlightCount,
                scheduledCount,
              },
            }
          : {
              summary: "Foreground work stopped.",
            }),
        stopHookActive: parsed.data.stop_hook_active,
      },
      context,
    );
  }

  if (eventName === "StopFailure") {
    const parsed = claudeStopFailureSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "claude",
        "invalid Claude StopFailure payload",
        parsed.error,
      );
    }
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type: "turn.failed",
        summary: "The harness reported a terminal turn failure.",
        failure: {
          class: claudeStopFailureClass(parsed.data.error),
          message: "The harness reported a terminal turn failure.",
        },
      },
      context,
    );
  }

  if (eventName === "PermissionRequest") {
    const parsed = claudePermissionSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "claude",
        "invalid Claude PermissionRequest payload",
        parsed.error,
      );
    }
    const question = summarizeTool(
      parsed.data.tool_name,
      parsed.data.tool_input,
    );
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        toolUseId: parsed.data.tool_use_id,
        type: "permission.required",
        summary: question,
        request: {
          correlationId: `req_${parsed.data.tool_use_id}`,
          kind: "permission",
          question,
          expiresAt: new Date(
            Date.parse(context.occurredAt) + 5 * 60_000,
          ).toISOString(),
        },
      },
      context,
    );
  }

  if (eventName === "Notification") {
    const parsed = claudeNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "claude",
        "invalid Claude Notification payload",
        parsed.error,
      );
    }
    const requiresInput =
      parsed.data.notification_type === "agent_needs_input" ||
      parsed.data.notification_type === "permission_prompt";
    return eventFromAdapter(
      "claude",
      {
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
        type: requiresInput ? "input.required" : "turn.activity",
        summary: requiresInput
          ? "The harness reported that operator input may be required."
          : "The harness reported a bounded activity notification.",
        ...(requiresInput
          ? {
              request: {
                correlationId: `req_notification_${context.sequence}`,
                kind: "input" as const,
                question:
                  "The harness reported that operator input may be required.",
                expiresAt: new Date(
                  Date.parse(context.occurredAt) + 10 * 60_000,
                ).toISOString(),
              },
            }
          : {}),
      },
      context,
    );
  }

  return unsupported("claude", eventName);
}

function parseCursor(
  payload: unknown,
  context: AdapterContext,
): HarnessParseResult {
  const eventName =
    typeof payload === "object" &&
    payload !== null &&
    "hook_event_name" in payload
      ? payload.hook_event_name
      : undefined;

  if (eventName === "stop") {
    const parsed = cursorStopSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed("cursor", "invalid Cursor stop payload", parsed.error);
    }
    const cwd = parsed.data.workspace_roots[0];
    if (cwd === undefined) {
      return malformed("cursor", "Cursor stop payload has no workspace root");
    }
    const isFailure = parsed.data.status === "error";
    const isAmbiguous = parsed.data.status === "aborted";
    return eventFromAdapter(
      "cursor",
      {
        cwd,
        sessionId: parsed.data.conversation_id,
        turnId: `cursor_loop_${parsed.data.loop_count}`,
        type: isFailure
          ? "turn.failed"
          : isAmbiguous
            ? "process.stale"
            : "turn.stopped",
        summary: `Cursor stopped with status ${parsed.data.status}`,
        ...(isFailure
          ? {
              failure: {
                class: "cursor-stop-error",
                message: "Cursor stop hook reported error status",
              },
            }
          : {}),
        stopHookActive: parsed.data.loop_count > 0,
      },
      context,
    );
  }

  if (eventName === "beforeShellExecution" || eventName === "preToolUse") {
    const parsed = cursorPermissionSchema.safeParse(payload);
    if (!parsed.success) {
      return malformed(
        "cursor",
        "invalid Cursor permission payload",
        parsed.error,
      );
    }
    const cwd = parsed.data.workspace_roots[0];
    if (cwd === undefined) {
      return malformed(
        "cursor",
        "Cursor permission payload has no workspace root",
      );
    }
    const toolName =
      parsed.data.tool_name ??
      (eventName === "beforeShellExecution" ? "shell" : "tool");
    const toolInput =
      parsed.data.tool_input ??
      (parsed.data.command === undefined
        ? {}
        : { command: parsed.data.command });
    const toolUseId =
      parsed.data.generation_id ??
      `${parsed.data.conversation_id}_${context.sequence}`;
    const question = summarizeTool(toolName, toolInput);
    return eventFromAdapter(
      "cursor",
      {
        cwd,
        sessionId: parsed.data.conversation_id,
        toolUseId,
        type: "permission.required",
        summary: question,
        request: {
          correlationId: `req_${toolUseId}`,
          kind: "permission",
          question,
          expiresAt: new Date(
            Date.parse(context.occurredAt) + 5 * 60_000,
          ).toISOString(),
        },
      },
      context,
    );
  }

  return unsupported("cursor", eventName);
}

function unsupported(harness: Harness, eventName: unknown): HarnessParseResult {
  return {
    ok: false,
    diagnostic: {
      code: "unsupported-event",
      harness,
      message: `unsupported ${harness} hook event: ${
        typeof eventName === "string" ? eventName : "<missing>"
      }`,
      safeBehavior: "native-prompt",
    },
  };
}

export function parseHarnessPayload(
  harness: Harness,
  payload: unknown,
  context: AdapterContext,
): HarnessParseResult {
  switch (harness) {
    case "codex":
      return parseCodex(payload, context);
    case "claude":
      return parseClaude(payload, context);
    case "cursor":
      return parseCursor(payload, context);
    default:
      throw new Error(`unsupported harness: ${String(harness)}`);
  }
}

export function parseHarnessJson(
  harness: Harness,
  raw: string,
  context: AdapterContext,
): HarnessParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        code: "invalid-json",
        harness,
        message: `hook stdin was not valid JSON: ${
          error instanceof Error ? error.message : "unknown parse error"
        }`,
        safeBehavior: "native-prompt",
      },
    };
  }
  return parseHarnessPayload(harness, payload, context);
}
