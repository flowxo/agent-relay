import type { Harness, Surface } from "@agent-relay/protocol";

import { capabilityFor } from "./capabilities.js";
import type { ResumeInvocation } from "./types.js";

export function buildLateResumeInvocation(
  harness: Harness,
  surface: Surface,
  sessionId: string,
  answer: string,
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

  switch (harness) {
    case "codex":
      return {
        executable: "codex",
        args: ["exec", "resume", sessionId, prompt],
      };
    case "claude":
      return {
        executable: "claude",
        args: ["--resume", sessionId, "--print", prompt],
      };
    case "cursor":
      return {
        executable: "cursor-agent",
        args: [`--resume=${sessionId}`, "--print", prompt],
      };
    default:
      throw new Error(`unsupported harness: ${String(harness)}`);
  }
}
