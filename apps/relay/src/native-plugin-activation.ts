import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { CLAUDE_LOCAL_PLUGIN_ID } from "./claude-user-settings.js";
import { CODEX_LOCAL_PLUGIN_ID } from "./codex-user-config.js";

const execFileAsync = promisify(execFile);

export type NativePluginActivationMode = "enable" | "disable" | "uninstall";

export interface NativePluginActivationRequest {
  rootDir: string;
  mode: NativePluginActivationMode;
}

async function resolveCommand(
  name: "claude" | "codex",
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-lc", `command -v ${name}`],
      {
        timeout: 5_000,
      },
    );
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function activateClaudeNativePlugin(
  request: NativePluginActivationRequest,
): Promise<void> {
  const claude = await resolveCommand("claude");
  if (claude === undefined) return;
  const args =
    request.mode === "uninstall"
      ? ["plugin", "uninstall", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user", "-y"]
      : request.mode === "disable"
        ? ["plugin", "disable", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user"]
        : ["plugin", "install", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user", "-y"];
  try {
    await execFileAsync(claude, args, {
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: request.rootDir,
        CLAUDE_CONFIG_DIR: join(request.rootDir, ".claude"),
      },
    });
  } catch {
    throw new Error(
      request.mode === "enable"
        ? "Claude Code refused to snapshot the Agent Relay plugin; run claude plugin install agent-relay@agent-relay-local"
        : request.mode === "disable"
          ? "Claude Code refused to disable the Agent Relay plugin; run claude plugin disable agent-relay@agent-relay-local"
          : "Claude Code refused to remove the Agent Relay plugin snapshot; run claude plugin uninstall agent-relay@agent-relay-local",
    );
  }
}

export async function activateCodexNativePlugin(
  request: NativePluginActivationRequest,
): Promise<void> {
  const codex = await resolveCommand("codex");
  if (codex === undefined) return;
  const args =
    request.mode === "uninstall" || request.mode === "disable"
      ? ["plugin", "remove", CODEX_LOCAL_PLUGIN_ID]
      : ["plugin", "add", CODEX_LOCAL_PLUGIN_ID];
  try {
    await execFileAsync(codex, args, {
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: request.rootDir,
        CODEX_HOME: join(request.rootDir, ".codex"),
      },
    });
  } catch {
    throw new Error(
      request.mode === "enable"
        ? "Codex refused to snapshot the Agent Relay plugin; run codex plugin add agent-relay@agent-relay-local"
        : "Codex refused to remove the Agent Relay plugin snapshot; run codex plugin remove agent-relay@agent-relay-local",
    );
  }
}
