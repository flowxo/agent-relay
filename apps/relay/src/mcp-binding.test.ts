import { describe, expect, it } from "vitest";

import {
  deriveNativeMcpBindingToken,
  isMcpBindingToken,
  nativeSessionIdFromMcpParams,
  pluginMcpEnvironment,
  resolveMcpHarness,
  resolveNativeSessionId,
  resolvedNativeSessionId,
} from "./mcp-binding.js";

describe("unsupervised MCP binding identity", () => {
  it("derives a stable token from the exact native session and not from project or path", () => {
    const first = deriveNativeMcpBindingToken({
      machineId: "machine_native_12345678",
      harness: "claude",
      sessionId: "claude-session-alpha-0001",
    });
    const again = deriveNativeMcpBindingToken({
      machineId: "machine_native_12345678",
      harness: "claude",
      sessionId: "claude-session-alpha-0001",
    });
    const otherSession = deriveNativeMcpBindingToken({
      machineId: "machine_native_12345678",
      harness: "claude",
      sessionId: "claude-session-beta-0001",
    });
    expect(isMcpBindingToken(first)).toBe(true);
    expect(first).toBe(again);
    expect(first).not.toBe(otherSession);
  });

  it("rejects unsubstituted placeholders and accepts harness-stated session IDs", () => {
    expect(resolvedNativeSessionId("${CLAUDE_SESSION_ID}")).toBeUndefined();
    expect(resolvedNativeSessionId("")).toBeUndefined();
    expect(resolvedNativeSessionId("claude-session-0001")).toBe(
      "claude-session-0001",
    );
    expect(
      resolveNativeSessionId({
        AGENT_RELAY_NATIVE_SESSION_ID: "${CLAUDE_SESSION_ID}",
        CLAUDE_SESSION_ID: "claude-session-from-harness-0001",
      }),
    ).toBe("claude-session-from-harness-0001");
    expect(resolveMcpHarness({ AGENT_RELAY_MCP_HARNESS: "claude" })).toBe(
      "claude",
    );
  });

  it("reads only a harness-stated MCP tools/call thread id", () => {
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        _meta: { threadId: "019bbb20-bff6-7130-83aa-bf45ab33250e" },
      }),
    ).toBe("019bbb20-bff6-7130-83aa-bf45ab33250e");
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        _meta: { threadId: "${CODEX_THREAD_ID}" },
      }),
    ).toBeUndefined();
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        cwd: "/tmp/project",
        _meta: { project: "agent-relay" },
      }),
    ).toBeUndefined();
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        _meta: { conversationId: "cursor-conversation-handshake-0001" },
      }),
    ).toBe("cursor-conversation-handshake-0001");
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        _meta: { "cursor/composerId": "cursor-composer-handshake-0001" },
      }),
    ).toBe("cursor-composer-handshake-0001");
    expect(
      nativeSessionIdFromMcpParams({
        name: "relay_ask",
        _meta: { progressToken: 12 },
      }),
    ).toBeUndefined();
  });

  it("does not require supervisor binding env in plugin MCP manifests", () => {
    expect(pluginMcpEnvironment("claude")).toEqual({
      AGENT_RELAY_MCP_HARNESS: "claude",
      AGENT_RELAY_NATIVE_SESSION_ID: "${CLAUDE_SESSION_ID}",
    });
    expect(pluginMcpEnvironment("codex")).toEqual({
      AGENT_RELAY_MCP_HARNESS: "codex",
    });
    expect(pluginMcpEnvironment("cursor")).toEqual({
      AGENT_RELAY_MCP_HARNESS: "cursor",
    });
  });
});
