import type { Harness, Surface } from "@agent-relay/protocol";

import { capabilityFor } from "./capabilities.js";
import type { ResumeInvocation } from "./types.js";

export type LateResumePolicy =
  | {
      harness: "codex";
      sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
      dangerouslyBypassApprovalsAndSandbox: boolean;
      dangerouslyBypassHookTrust: boolean;
    }
  | {
      harness: "claude";
      permissionMode:
        | "acceptEdits"
        | "auto"
        | "bypassPermissions"
        | "manual"
        | "dontAsk"
        | "plan";
      dangerouslySkipPermissions: boolean;
    }
  | {
      harness: "cursor";
      force: boolean;
    };

function optionValue(args: string[], names: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    for (const name of names) {
      if (argument === name) {
        return args[index + 1];
      }
      if (argument?.startsWith(`${name}=`)) {
        return argument.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function codexSandboxConfig(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") {
      continue;
    }
    const config = args[index + 1];
    const match = config?.match(
      /^sandbox_mode\s*=\s*["']?(read-only|workspace-write|danger-full-access)["']?$/,
    );
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

export function deriveLateResumePolicy(
  harness: Harness,
  initialArgs: string[],
): LateResumePolicy {
  if (harness === "codex") {
    const configured =
      optionValue(initialArgs, ["--sandbox", "-s"]) ??
      codexSandboxConfig(initialArgs) ??
      "read-only";
    if (
      configured !== "read-only" &&
      configured !== "workspace-write" &&
      configured !== "danger-full-access"
    ) {
      throw new Error(`unsupported Codex sandbox mode: ${configured}`);
    }
    return {
      harness,
      sandboxMode: configured,
      dangerouslyBypassApprovalsAndSandbox: initialArgs.includes(
        "--dangerously-bypass-approvals-and-sandbox",
      ),
      dangerouslyBypassHookTrust: initialArgs.includes(
        "--dangerously-bypass-hook-trust",
      ),
    };
  }
  if (harness === "claude") {
    const configured =
      optionValue(initialArgs, ["--permission-mode"]) ?? "plan";
    if (
      configured !== "acceptEdits" &&
      configured !== "auto" &&
      configured !== "bypassPermissions" &&
      configured !== "manual" &&
      configured !== "dontAsk" &&
      configured !== "plan"
    ) {
      throw new Error(`unsupported Claude permission mode: ${configured}`);
    }
    return {
      harness,
      permissionMode: configured,
      dangerouslySkipPermissions: initialArgs.includes(
        "--dangerously-skip-permissions",
      ),
    };
  }
  return {
    harness,
    force: initialArgs.includes("--force") || initialArgs.includes("-f"),
  };
}

export function buildLateResumeInvocation(
  harness: Harness,
  surface: Surface,
  sessionId: string,
  answer: string,
  policy: LateResumePolicy = deriveLateResumePolicy(harness, []),
): ResumeInvocation {
  const capability = capabilityFor(harness, surface);
  if (capability?.detail.lateResume !== true) {
    throw new Error(`late resume is unsupported for ${harness}/${surface}`);
  }
  if (surface === "app-server" || surface === "sdk") {
    throw new Error(
      `${harness}/${surface} continuation requires its structured API`,
    );
  }
  const prompt = answer.trim();
  if (prompt.length === 0) {
    throw new Error("resume answer cannot be empty");
  }
  if (policy.harness !== harness) {
    throw new Error(
      `resume policy for ${policy.harness} cannot be used with ${harness}`,
    );
  }

  switch (harness) {
    case "codex": {
      const codexPolicy = policy as Extract<
        LateResumePolicy,
        { harness: "codex" }
      >;
      return {
        executable: "codex",
        args: [
          "exec",
          "resume",
          ...(codexPolicy.dangerouslyBypassHookTrust
            ? ["--dangerously-bypass-hook-trust"]
            : []),
          ...(codexPolicy.dangerouslyBypassApprovalsAndSandbox
            ? ["--dangerously-bypass-approvals-and-sandbox"]
            : ["-c", `sandbox_mode="${codexPolicy.sandboxMode}"`]),
          sessionId,
          prompt,
        ],
      };
    }
    case "claude": {
      const claudePolicy = policy as Extract<
        LateResumePolicy,
        { harness: "claude" }
      >;
      return {
        executable: "claude",
        args: [
          "--resume",
          sessionId,
          "--print",
          ...(claudePolicy.dangerouslySkipPermissions
            ? ["--dangerously-skip-permissions"]
            : ["--permission-mode", claudePolicy.permissionMode]),
          prompt,
        ],
      };
    }
    case "cursor": {
      const cursorPolicy = policy as Extract<
        LateResumePolicy,
        { harness: "cursor" }
      >;
      return {
        executable: "cursor-agent",
        args: [
          `--resume=${sessionId}`,
          "--print",
          ...(cursorPolicy.force ? ["--force"] : []),
          prompt,
        ],
      };
    }
    default:
      throw new Error(`unsupported harness: ${String(harness)}`);
  }
}
