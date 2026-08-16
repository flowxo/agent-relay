import { createHash } from "node:crypto";

import { HarnessSchema } from "@agent-relay/protocol";
import type { Harness } from "@agent-relay/protocol";

export const UNSUPERVISED_BRIDGE_SESSION_ID = "bridge_local_hooks" as const;
export const EXACT_SESSION_BINDING =
  "harness-stated native session; supervisor token optional" as const;

const MCP_BINDING_TOKEN_PATTERN = /^mcpbind_[A-Za-z0-9_-]{32,96}$/u;
const NATIVE_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const UNRESOLVED_PLACEHOLDER = /\$\{[A-Z0-9_]+\}/u;

const NATIVE_SESSION_ENV_KEYS = [
  "AGENT_RELAY_NATIVE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_SESSION_ID",
] as const;

export function deriveNativeMcpBindingToken(input: {
  machineId: string;
  harness: Harness;
  sessionId: string;
}): string {
  const digest = createHash("sha256")
    .update("agent-relay-mcp-native.v1")
    .update("\0")
    .update(input.machineId)
    .update("\0")
    .update(input.harness)
    .update("\0")
    .update(input.sessionId)
    .digest("base64url");
  return `mcpbind_${digest}`;
}

export function isMcpBindingToken(value: string | undefined): value is string {
  return value !== undefined && MCP_BINDING_TOKEN_PATTERN.test(value);
}

export function resolvedNativeSessionId(
  value: string | undefined,
): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    UNRESOLVED_PLACEHOLDER.test(value) ||
    !NATIVE_SESSION_PATTERN.test(value)
  ) {
    return undefined;
  }
  return value;
}

const MCP_META_SESSION_KEYS = [
  "threadId",
  "conversationId",
  "sessionId",
  "composerId",
  "cursor/composerId",
] as const;

export function nativeSessionIdFromMcpParams(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const meta = params?.["_meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const record = meta as Record<string, unknown>;
  for (const key of MCP_META_SESSION_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const resolved = resolvedNativeSessionId(value);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
}

export function resolveNativeSessionId(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  for (const key of NATIVE_SESSION_ENV_KEYS) {
    const resolved = resolvedNativeSessionId(environment[key]);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

export function resolveMcpHarness(
  environment: NodeJS.ProcessEnv,
): Harness | undefined {
  const parsed = HarnessSchema.safeParse(
    environment["AGENT_RELAY_MCP_HARNESS"],
  );
  return parsed.success ? parsed.data : undefined;
}

export function pluginMcpEnvironment(harness: Harness): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_RELAY_MCP_HARNESS: harness,
  };
  if (harness === "claude") {
    env["AGENT_RELAY_NATIVE_SESSION_ID"] = "${CLAUDE_SESSION_ID}";
  }
  return env;
}
