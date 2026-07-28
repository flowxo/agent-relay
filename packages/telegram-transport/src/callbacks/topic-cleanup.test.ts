import { describe, expect, it } from "vitest";

import {
  parseTopicCleanupCallbackData,
  topicCleanupCallbackData,
} from "./topic-cleanup.js";

describe("topic cleanup callback data", () => {
  const operationId = "cleanup_0123456789abcdef0123456789abcdef";

  it("round-trips confirm and cancel actions within Telegram's byte limit", () => {
    const confirm = topicCleanupCallbackData("confirm", operationId);
    const cancel = topicCleanupCallbackData("cancel", operationId);

    expect(Buffer.byteLength(confirm, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(cancel, "utf8")).toBeLessThanOrEqual(64);
    expect(parseTopicCleanupCallbackData(confirm)).toEqual({
      action: "confirm",
      operationId,
    });
    expect(parseTopicCleanupCallbackData(cancel)).toEqual({
      action: "cancel",
      operationId,
    });
  });

  it("rejects malformed, unknown-version, and non-opaque callbacks", () => {
    expect(parseTopicCleanupCallbackData("relay-c:v2:y:" + operationId)).toBe(
      undefined,
    );
    expect(parseTopicCleanupCallbackData("relay-c:v1:x:" + operationId)).toBe(
      undefined,
    );
    expect(parseTopicCleanupCallbackData("relay-c:v1:y:cleanup_readable")).toBe(
      undefined,
    );
    expect(() =>
      topicCleanupCallbackData("confirm", "cleanup_readable"),
    ).toThrow("topic cleanup operation id is invalid");
  });
});
