import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  choiceCallbackData,
  parseChoiceCallbackData,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
} from "./choice.js";

describe("Telegram choice callback data", () => {
  it("round-trips only bounded opaque decision tokens", () => {
    const token = `decision_${"a".repeat(48)}`;
    const data = choiceCallbackData(token);

    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(parseChoiceCallbackData(data)).toBe(token);
    expect(data).not.toContain("Allow once");
  });

  it("rejects option text, unsupported prefixes, and oversized tokens", () => {
    expect(parseChoiceCallbackData("relay:Allow once")).toBeUndefined();
    expect(
      parseChoiceCallbackData("other:decision_opaque_12345678"),
    ).toBeUndefined();
    expect(() => choiceCallbackData(`decision_${"a".repeat(49)}`)).toThrow(
      "malformed",
    );
  });
});
