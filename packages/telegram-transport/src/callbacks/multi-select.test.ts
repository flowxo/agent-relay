import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  multiSelectCallbackData,
  parseMultiSelectCallbackData,
} from "./multi-select.js";

describe("Telegram multi-select callback data", () => {
  it("round-trips bounded set, unset, submit, and cancel actions", () => {
    const cases = [
      {
        action: "select" as const,
        token: "decision_00000000-0000-4000-8000-000000000001",
      },
      {
        action: "unselect" as const,
        token: "decision_00000000-0000-4000-8000-000000000002",
      },
      {
        action: "submit" as const,
        token: "draft_submit_00000000-0000-4000-8000-000000000003",
      },
      {
        action: "cancel" as const,
        token: "draft_cancel_00000000-0000-4000-8000-000000000004",
      },
    ];

    for (const item of cases) {
      const data = multiSelectCallbackData(item.action, item.token);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(parseMultiSelectCallbackData(data)).toEqual(item);
    }
  });

  it("rejects labels, mismatched action tokens, and oversized data", () => {
    expect(parseMultiSelectCallbackData("relay-m:s:Unit one")).toBeUndefined();
    expect(
      parseMultiSelectCallbackData(
        "relay-m:x:decision_00000000-0000-4000-8000-000000000001",
      ),
    ).toBeUndefined();
    expect(
      parseMultiSelectCallbackData(`relay-m:s:decision_${"a".repeat(80)}`),
    ).toBeUndefined();
  });
});
