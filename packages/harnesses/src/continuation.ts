import type { Harness } from "@agent-relay/protocol";

import type { HarnessContinuation } from "./types.js";

export function renderStopContinuation(
  harness: Harness,
  answer: string,
): HarnessContinuation {
  const boundedAnswer = answer.trim().slice(0, 4_000);
  if (boundedAnswer.length === 0) {
    throw new Error("continuation answer cannot be empty");
  }
  if (harness === "cursor") {
    return { stdout: { followup_message: boundedAnswer } };
  }
  return {
    stdout: {
      decision: "block",
      reason: boundedAnswer,
    },
  };
}

export function renderSafeNoop(): HarnessContinuation {
  return { stdout: {} };
}
