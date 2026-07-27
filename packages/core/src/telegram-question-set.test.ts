import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  parseQuestionSetCallbackData,
  questionSetCallbackData,
} from "./telegram-question-set.js";

describe("Telegram question-set callback data", () => {
  it("round-trips bounded choice, navigation, submit, and cancel actions", () => {
    const cases = [
      {
        action: "choose" as const,
        token: "decision_00000000-0000-4000-8000-000000000001",
      },
      {
        action: "select" as const,
        token: "decision_00000000-0000-4000-8000-000000000002",
      },
      {
        action: "unselect" as const,
        token: "decision_00000000-0000-4000-8000-000000000003",
      },
      {
        action: "next" as const,
        token: "wizard_next_00000000-0000-4000-8000-000000000004",
      },
      {
        action: "back" as const,
        token: "wizard_back_00000000-0000-4000-8000-000000000005",
      },
      {
        action: "submit" as const,
        token: "wizard_submit_00000000-0000-4000-8000-000000000006",
      },
      {
        action: "cancel" as const,
        token: "wizard_cancel_00000000-0000-4000-8000-000000000007",
      },
    ];

    for (const item of cases) {
      const data = questionSetCallbackData(item.action, item.token);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(parseQuestionSetCallbackData(data)).toEqual(item);
    }
  });

  it("rejects labels, mismatched action tokens, and oversized data", () => {
    expect(parseQuestionSetCallbackData("relay-w:o:Proceed")).toBeUndefined();
    expect(
      parseQuestionSetCallbackData(
        "relay-w:n:decision_00000000-0000-4000-8000-000000000001",
      ),
    ).toBeUndefined();
    expect(
      parseQuestionSetCallbackData(
        "relay-w:x:wizard_next_00000000-0000-4000-8000-000000000004",
      ),
    ).toBeUndefined();
    expect(
      parseQuestionSetCallbackData(`relay-w:o:decision_${"a".repeat(80)}`),
    ).toBeUndefined();
  });
});
