import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import {
  CLAUDE_LOCAL_MARKETPLACE_NAME,
  CLAUDE_LOCAL_PLUGIN_ID,
} from "./claude-user-settings.js";
import { CODEX_LOCAL_PLUGIN_ID } from "./codex-user-config.js";

const execFileAsync = promisify(execFile);

export type NativePluginActivationMode = "enable" | "disable" | "uninstall";

export interface NativePluginActivationRequest {
  rootDir: string;
  mode: NativePluginActivationMode;
  /** Absolute Agent Relay-owned Claude marketplace root. */
  claudeMarketplaceRoot?: string;
}

async function resolveCommand(
  name: "claude" | "codex",
): Promise<string | undefined> {
  try {
    // Use the current process PATH. A login shell (`-lc`) can rewrite PATH and
    // pick an ambient harness instead of the frozen qualification binary.
    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-c", `command -v ${name}`],
      {
        timeout: 5_000,
        env: process.env,
      },
    );
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function claudeInstallArgs(options: { yes?: boolean } = {}): string[] {
  // Frozen Claude Code 2.1.219 rejects `-y` on `plugin install`. Newer Claude
  // may require `--yes` when stdin/stdout is not a TTY for marketplace installs.
  const yes = options.yes === true ? (["-y"] as const) : [];
  return ["plugin", "install", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user", ...yes];
}

/** Exported for unit tests of the frozen Claude argv surface. */
export function claudeActivationArgsForTest(
  mode: NativePluginActivationMode,
  options: { yes?: boolean } = {},
): string[] {
  if (mode === "uninstall") {
    return ["plugin", "uninstall", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user"];
  }
  if (mode === "disable") {
    return ["plugin", "disable", CLAUDE_LOCAL_PLUGIN_ID, "-s", "user"];
  }
  return claudeInstallArgs(options);
}

export function claudeMarketplaceAddArgsForTest(
  marketplaceRoot: string,
): string[] {
  return ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"];
}

export function claudeMarketplaceRemoveArgsForTest(): string[] {
  return ["plugin", "marketplace", "remove", CLAUDE_LOCAL_MARKETPLACE_NAME];
}

function activationFailureMessage(
  harness: "claude" | "codex",
  mode: NativePluginActivationMode,
  detail?: string,
): string {
  const suffix =
    detail !== undefined && detail.trim().length > 0
      ? ` (${detail.trim().replaceAll(/\s+/g, " ").slice(0, 240)})`
      : "";
  if (harness === "claude") {
    if (mode === "enable") {
      return `Claude Code refused to snapshot the Agent Relay plugin; run claude plugin marketplace add <marketplace> then claude plugin install agent-relay@agent-relay-local${suffix}`;
    }
    if (mode === "disable") {
      return `Claude Code refused to disable the Agent Relay plugin; run claude plugin disable agent-relay@agent-relay-local${suffix}`;
    }
    return `Claude Code refused to remove the Agent Relay plugin snapshot; run claude plugin uninstall agent-relay@agent-relay-local${suffix}`;
  }
  if (mode === "enable") {
    return `Codex refused to snapshot the Agent Relay plugin; run codex plugin add agent-relay@agent-relay-local${suffix}`;
  }
  return `Codex refused to remove the Agent Relay plugin snapshot; run codex plugin remove agent-relay@agent-relay-local${suffix}`;
}

function execErrorDetail(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const combined = `${stderr}\n${stdout}`.trim();
  if (combined.length > 0) return combined;
  return typeof record.message === "string" ? record.message : undefined;
}

function shouldRetryClaudeWithYes(detail: string | undefined): boolean {
  if (detail === undefined) return false;
  if (/unknown option ['"]?-y['"]?/i.test(detail)) return false;
  return /(--yes|\byes\b|not a TTY|confirmation prompt|confirmation)/i.test(
    detail,
  );
}

function isBenignClaudeActivationDetail(
  mode: NativePluginActivationMode,
  detail: string | undefined,
): boolean {
  if (detail === undefined) return false;
  if (mode === "disable") {
    return /already disabled/i.test(detail);
  }
  if (mode === "enable") {
    return /already installed|already enabled/i.test(detail);
  }
  return /not (installed|found)|is not installed/i.test(detail);
}

async function runClaude(
  claude: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync(claude, args, {
    timeout: 60_000,
    env,
  });
}

async function runClaudeInstall(
  claude: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await runClaude(claude, claudeInstallArgs(), env);
  } catch (error) {
    const detail = execErrorDetail(error);
    if (isBenignClaudeActivationDetail("enable", detail)) return;
    if (!shouldRetryClaudeWithYes(detail)) throw error;
    try {
      await runClaude(claude, claudeInstallArgs({ yes: true }), env);
    } catch (retryError) {
      const retryDetail = execErrorDetail(retryError);
      if (isBenignClaudeActivationDetail("enable", retryDetail)) return;
      throw retryError;
    }
  }
}

export async function activateClaudeNativePlugin(
  request: NativePluginActivationRequest,
): Promise<void> {
  const claude = await resolveCommand("claude");
  if (claude === undefined) return;
  const marketplaceRoot =
    request.claudeMarketplaceRoot ??
    join(request.rootDir, ".agent-relay", "vendor", "claude-marketplace");
  const env = {
    ...process.env,
    HOME: request.rootDir,
    CLAUDE_CONFIG_DIR: join(request.rootDir, ".claude"),
  };
  try {
    if (request.mode === "enable") {
      // Frozen Claude 2.1.219 does not treat settings.json alone as a loaded
      // marketplace; register the owned directory before installing.
      await runClaude(
        claude,
        claudeMarketplaceAddArgsForTest(marketplaceRoot),
        env,
      );
      await runClaudeInstall(claude, env);
      return;
    }
    if (request.mode === "disable") {
      try {
        await runClaude(claude, claudeActivationArgsForTest("disable"), env);
      } catch (error) {
        if (isBenignClaudeActivationDetail("disable", execErrorDetail(error))) {
          return;
        }
        throw error;
      }
      return;
    }
    try {
      await runClaude(claude, claudeActivationArgsForTest("uninstall"), env);
    } catch (error) {
      if (
        !isBenignClaudeActivationDetail("uninstall", execErrorDetail(error))
      ) {
        throw error;
      }
    }
    try {
      await runClaude(claude, claudeMarketplaceRemoveArgsForTest(), env);
    } catch {
      // Marketplace may already be absent after plugin removal.
    }
  } catch (error) {
    throw new Error(
      activationFailureMessage("claude", request.mode, execErrorDetail(error)),
      { cause: error },
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
  } catch (error) {
    throw new Error(
      activationFailureMessage("codex", request.mode, execErrorDetail(error)),
      { cause: error },
    );
  }
}
