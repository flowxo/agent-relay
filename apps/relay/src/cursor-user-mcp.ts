export const CURSOR_OWNED_MCP_SERVER_NAME = "agent-relay" as const;

export type CursorEnablementMode = "enable" | "disable" | "uninstall";

interface CursorMcpObject {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function cursorOwnedMcpServer(launcherPath: string): {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    type: "stdio",
    command: launcherPath,
    args: ["mcp"],
    env: {
      AGENT_RELAY_MCP_HARNESS: "cursor",
    },
  };
}

export function parseCursorUserMcp(raw: string | undefined): {
  config: CursorMcpObject;
  created: boolean;
} {
  if (raw === undefined || raw.trim().length === 0) {
    return { config: {}, created: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "Cursor user MCP configuration is not valid JSON; preserve the file and reconcile it before retrying",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Cursor user MCP configuration must be a JSON object; preserve the file and reconcile it before retrying",
    );
  }
  return { config: parsed as CursorMcpObject, created: false };
}

function mcpServersObject(
  config: CursorMcpObject,
): Record<string, unknown> | undefined {
  if (config.mcpServers === undefined) return undefined;
  if (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    throw new Error(
      "Cursor MCP servers are not an object; preserve the file and reconcile it before retrying",
    );
  }
  return { ...config.mcpServers };
}

export function applyCursorPluginEnablement(
  raw: string | undefined,
  launcherPath: string,
  mode: CursorEnablementMode,
): string | undefined {
  const { config } = parseCursorUserMcp(raw);
  const servers = mcpServersObject(config) ?? {};

  if (mode === "enable") {
    servers[CURSOR_OWNED_MCP_SERVER_NAME] = cursorOwnedMcpServer(launcherPath);
  } else {
    delete servers[CURSOR_OWNED_MCP_SERVER_NAME];
  }

  const next: CursorMcpObject = { ...config };
  if (Object.keys(servers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = servers;
  }

  if (Object.keys(next).length === 0) {
    return undefined;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function cursorPluginEnablementHealthy(
  raw: string | undefined,
  launcherPath: string,
  expected: "enabled" | "disabled" | "absent",
): boolean {
  if (raw === undefined) {
    return expected !== "enabled";
  }
  const { config } = parseCursorUserMcp(raw);
  const servers = mcpServersObject(config) ?? {};
  const owned = servers[CURSOR_OWNED_MCP_SERVER_NAME];
  if (expected === "enabled") {
    return (
      JSON.stringify(owned) === JSON.stringify(cursorOwnedMcpServer(launcherPath))
    );
  }
  return owned === undefined;
}

function isOwnedCompatibleCursorMcp(
  server: unknown,
  launcherPath: string,
): boolean {
  if (server === null || typeof server !== "object" || Array.isArray(server)) {
    return false;
  }
  const value = server as Record<string, unknown>;
  if (value["command"] !== launcherPath) return false;
  if (JSON.stringify(value["args"]) !== JSON.stringify(["mcp"])) return false;
  const env = value["env"];
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return false;
  }
  return (
    (env as Record<string, unknown>)["AGENT_RELAY_MCP_HARNESS"] === "cursor"
  );
}

export function cursorUserMcpHasForeignAgentRelay(
  raw: string | undefined,
  launcherPath: string,
): boolean {
  if (raw === undefined) return false;
  const { config } = parseCursorUserMcp(raw);
  const servers = mcpServersObject(config);
  if (servers === undefined) {
    return containsAgentRelayMcp(config);
  }
  for (const [name, server] of Object.entries(servers)) {
    if (name === CURSOR_OWNED_MCP_SERVER_NAME) {
      if (!isOwnedCompatibleCursorMcp(server, launcherPath)) return true;
      continue;
    }
    if (
      /agent[-_]relay/i.test(name) ||
      /agent[-_]relay/i.test(JSON.stringify(server))
    ) {
      return true;
    }
  }
  const rest = { ...config };
  delete rest.mcpServers;
  return containsAgentRelayMcp(rest);
}

function containsAgentRelayMcp(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAgentRelayMcp);
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "mcpServers" &&
      child !== null &&
      typeof child === "object" &&
      Object.entries(child).some(
        ([serverName, config]) =>
          /agent[-_]relay/i.test(serverName) ||
          /agent[-_]relay/i.test(JSON.stringify(config)),
      )
    ) {
      return true;
    }
    if (containsAgentRelayMcp(child)) return true;
  }
  return false;
}
