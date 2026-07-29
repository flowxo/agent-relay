import { sha256 } from "@agent-relay/protocol";
import { describe, expect, it } from "vitest";

import {
  whooshbangResolutionOperationId,
  PinnedWhooshBangResolutionPresenter,
} from "./presentation-source.js";

describe("WhooshBang resolution presentation boundary", () => {
  it("derives one stable operation identity without exposing the event id", () => {
    const eventId = "event_resolution_presentation_12345678";
    expect(whooshbangResolutionOperationId(eventId)).toBe(
      `resolution_${sha256(eventId)}`,
    );
    expect(whooshbangResolutionOperationId(eventId)).not.toContain(eventId);
    expect(() => whooshbangResolutionOperationId("../unsafe")).toThrow(
      "safe opaque",
    );
  });

  it("reports the exact pinned draft as unsupported without making a hosted call", async () => {
    const presenter = new PinnedWhooshBangResolutionPresenter();
    expect(presenter.capability).toBe("unsupported");
    await expect(
      presenter.reflect({
        operationId: `resolution_${sha256("event_pinned_12345678")}`,
        messageId: "message_pinned_12345678",
        interactionId: "interaction_pinned_12345678",
        presentation: "answered",
        resolutionSource: "whooshbang",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: "unsupported",
      reasonCode: "whooshbang-resolution-update-unsupported",
    });
  });
});
