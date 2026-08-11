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
      executable: string;
      force: boolean;
      trustWorkspace: boolean;
      mode?: "ask" | "plan";
      sandbox?: "disabled" | "enabled";
      workspace?: string;
      additionalDirectories: string[];
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

function uniqueCursorOptionValue(
  values: string[],
  label: string,
): string | undefined {
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length > 1) {
    throw new Error(`conflicting ${label} values`);
  }
  return uniqueValues[0];
}

interface CursorOptionSnapshot {
  additionalDirectories: string[];
  force: boolean;
  modeValues: string[];
  planMode: boolean;
  sandboxValues: string[];
  trustWorkspace: boolean;
  workspaceValues: string[];
}

const CURSOR_IGNORED_REQUIRED_OPTIONS = new Set([
  "--api-key",
  "--header",
  "--endpoint",
  "--output-format",
  "--model",
  "--plugin-dir",
  "--worktree-base",
]);
const CURSOR_IGNORED_OPTIONAL_OPTIONS = new Set(["--resume", "--worktree"]);
const CURSOR_IGNORED_BOOLEAN_OPTIONS = new Set([
  "--version",
  "--print",
  "--stream-partial-output",
  "--continue",
  "--list-models",
  "--auto-review",
  "--approve-mcps",
  "--skip-worktree-setup",
  "--help",
]);

function cursorOptionSnapshot(args: string[]): CursorOptionSnapshot {
  const snapshot: CursorOptionSnapshot = {
    additionalDirectories: [],
    force: false,
    modeValues: [],
    planMode: false,
    sandboxValues: [],
    trustWorkspace: false,
    workspaceValues: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      break;
    }
    if (argument.startsWith("--")) {
      const equalsIndex = argument.indexOf("=");
      const name =
        equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
      const attachedValue =
        equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
      const requiredValue = (label: string): string => {
        const value =
          attachedValue === undefined ? args[(index += 1)] : attachedValue;
        if (value === undefined || value.length === 0) {
          throw new Error(`${label} requires a value`);
        }
        return value;
      };
      const rejectAttachedBoolean = (): void => {
        if (attachedValue !== undefined) {
          throw new Error("unsupported Cursor option form");
        }
      };

      switch (name) {
        case "--mode":
          snapshot.modeValues.push(requiredValue("Cursor mode"));
          break;
        case "--sandbox":
          snapshot.sandboxValues.push(requiredValue("Cursor sandbox mode"));
          break;
        case "--workspace":
          snapshot.workspaceValues.push(requiredValue("Cursor workspace"));
          break;
        case "--add-dir":
          snapshot.additionalDirectories.push(
            requiredValue("Cursor additional directory"),
          );
          break;
        case "--plan":
          rejectAttachedBoolean();
          snapshot.planMode = true;
          break;
        case "--force":
        case "--yolo":
          rejectAttachedBoolean();
          snapshot.force = true;
          break;
        case "--trust":
          rejectAttachedBoolean();
          snapshot.trustWorkspace = true;
          break;
        default:
          if (CURSOR_IGNORED_REQUIRED_OPTIONS.has(name)) {
            requiredValue("Cursor option");
            break;
          }
          if (CURSOR_IGNORED_OPTIONAL_OPTIONS.has(name)) {
            if (
              attachedValue === undefined &&
              args[index + 1] !== undefined &&
              !args[index + 1]!.startsWith("-")
            ) {
              index += 1;
            }
            break;
          }
          if (CURSOR_IGNORED_BOOLEAN_OPTIONS.has(name)) {
            rejectAttachedBoolean();
            break;
          }
          throw new Error("unsupported Cursor option");
      }
      continue;
    }
    if (!argument.startsWith("-") || argument === "-") {
      continue;
    }

    for (let offset = 1; offset < argument.length; offset += 1) {
      const option = argument[offset];
      if (option === "f") {
        snapshot.force = true;
        continue;
      }
      if (option === "h" || option === "p" || option === "v") {
        continue;
      }
      if (option === "H" || option === "e") {
        if (offset === argument.length - 1) {
          index += 1;
          if (args[index] === undefined || args[index]?.length === 0) {
            throw new Error("Cursor option requires a value");
          }
        }
        break;
      }
      if (option === "w") {
        if (
          offset === argument.length - 1 &&
          args[index + 1] !== undefined &&
          !args[index + 1]!.startsWith("-")
        ) {
          index += 1;
        }
        break;
      }
      throw new Error("unsupported Cursor short option");
    }
  }

  return snapshot;
}

export function deriveLateResumePolicy(
  harness: Harness,
  initialArgs: string[],
  initialExecutable = "cursor-agent",
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
  const cursorOptions = cursorOptionSnapshot(initialArgs);
  const configuredMode = uniqueCursorOptionValue(
    cursorOptions.modeValues,
    "Cursor mode",
  );
  if (
    configuredMode !== undefined &&
    configuredMode !== "ask" &&
    configuredMode !== "plan"
  ) {
    throw new Error("unsupported Cursor mode");
  }
  if (cursorOptions.planMode && configuredMode === "ask") {
    throw new Error("conflicting Cursor mode values");
  }
  const configuredSandbox = uniqueCursorOptionValue(
    cursorOptions.sandboxValues,
    "Cursor sandbox mode",
  );
  if (
    configuredSandbox !== undefined &&
    configuredSandbox !== "disabled" &&
    configuredSandbox !== "enabled"
  ) {
    throw new Error("unsupported Cursor sandbox mode");
  }
  const workspace = uniqueCursorOptionValue(
    cursorOptions.workspaceValues,
    "Cursor workspace",
  );
  const additionalDirectories = [
    ...new Set(cursorOptions.additionalDirectories),
  ];
  const mode = cursorOptions.planMode ? "plan" : configuredMode;
  return {
    harness,
    executable: initialExecutable,
    force: cursorOptions.force,
    trustWorkspace: cursorOptions.trustWorkspace,
    ...(mode === undefined ? {} : { mode }),
    ...(configuredSandbox === undefined ? {} : { sandbox: configuredSandbox }),
    ...(workspace === undefined ? {} : { workspace }),
    additionalDirectories,
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
        executable: cursorPolicy.executable,
        args: [
          `--resume=${sessionId}`,
          "--print",
          ...(cursorPolicy.mode === undefined
            ? []
            : ["--mode", cursorPolicy.mode]),
          ...(cursorPolicy.sandbox === undefined
            ? []
            : ["--sandbox", cursorPolicy.sandbox]),
          ...(cursorPolicy.workspace === undefined
            ? []
            : ["--workspace", cursorPolicy.workspace]),
          ...cursorPolicy.additionalDirectories.flatMap((directory) => [
            "--add-dir",
            directory,
          ]),
          ...(cursorPolicy.force ? ["--force"] : []),
          ...(cursorPolicy.trustWorkspace ? ["--trust"] : []),
          "--",
          prompt,
        ],
      };
    }
    default:
      throw new Error(`unsupported harness: ${String(harness)}`);
  }
}
