import { sha256 } from "@agent-relay/protocol";
import { describe, expect, it } from "vitest";

import {
  notificationsResolutionOperationId,
  PinnedNotificationsResolutionPresenter,
} from "./presentation-source.js";

describe("Notifications resolution presentation boundary", () => {
  it("derives one stable operation identity without exposing the event id", () => {
    const eventId = "event_resolution_presentation_12345678";
    expect(notificationsResolutionOperationId(eventId)).toBe(
      `resolution_${sha256(eventId)}`,
    );
    expect(notificationsResolutionOperationId(eventId)).not.toContain(eventId);
    expect(() => notificationsResolutionOperationId("../unsafe")).toThrow(
      "safe opaque",
    );
  });

  it("reports the exact pinned draft as unsupported without making a hosted call", async () => {
    const presenter = new PinnedNotificationsResolutionPresenter();
    expect(presenter.capability).toBe("unsupported");
    await expect(
      presenter.reflect({
        operationId: `resolution_${sha256("event_pinned_12345678")}`,
        messageId: "message_pinned_12345678",
        interactionId: "interaction_pinned_12345678",
        presentation: "answered",
        resolutionSource: "notifications",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: "unsupported",
      reasonCode: "notifications-resolution-update-unsupported",
    });
  });
});
