import { describe, expect, it } from "vitest";

import {
  asTransportError,
  isInteractionCapabilityTransport,
  isInteractiveTransport,
  isOperatorControlTransport,
  isTopicDeletionTransport,
  isTopicTransport,
  TopicUnavailableError,
  TransportError,
  type NotificationTransport,
} from "./transport.js";

const requiredTransport: NotificationTransport = {
  name: "required-only",
  async deliver() {
    return { transport: "required-only", messageId: "message-1" };
  },
};

describe("notification transport contracts", () => {
  it("detects only capabilities a provider implements", () => {
    expect(isTopicTransport(requiredTransport)).toBe(false);
    expect(isInteractiveTransport(requiredTransport)).toBe(false);
    expect(isInteractionCapabilityTransport(requiredTransport)).toBe(false);
    expect(isTopicDeletionTransport(requiredTransport)).toBe(false);
    expect(isOperatorControlTransport(requiredTransport)).toBe(false);

    const capableTransport = {
      ...requiredTransport,
      topicScope: "example:scope",
      async createTopic() {
        return { transport: "example", topicId: "topic-1" };
      },
      async acknowledgeCallback() {},
      async editDeliveryMessage() {},
      async editResolvedMessage() {},
      observeInteractionCapabilities() {
        throw new Error("not invoked by capability detection");
      },
    };

    expect(isTopicTransport(capableTransport)).toBe(true);
    expect(isInteractiveTransport(capableTransport)).toBe(true);
    expect(isInteractionCapabilityTransport(capableTransport)).toBe(true);
    expect(isTopicDeletionTransport(capableTransport)).toBe(false);
    expect(isOperatorControlTransport(capableTransport)).toBe(false);
  });

  it("detects optional topic deletion and operator controls", () => {
    const capableTransport = {
      ...requiredTransport,
      topicScope: "example:scope",
      async createTopic() {
        return { transport: "example", topicId: "topic-1" };
      },
      async deleteTopic() {
        return { transport: "example", outcome: "deleted" as const };
      },
      async deliverOperatorControl() {
        return { transport: "example", messageId: "message-2" };
      },
      async editOperatorControl() {},
    };

    expect(isTopicDeletionTransport(capableTransport)).toBe(true);
    expect(isOperatorControlTransport(capableTransport)).toBe(true);
  });

  it("preserves classified transport failures", () => {
    const classified = new TransportError("rate limited", "rate-limit", true);
    expect(asTransportError(classified)).toBe(classified);

    const unavailable = new TopicUnavailableError(
      "topic closed",
      "topic-unavailable",
      400,
    );
    expect(asTransportError(unavailable)).toBe(unavailable);
    expect(unavailable.retryable).toBe(true);
    expect(unavailable.status).toBe(400);
  });

  it("normalizes unknown failures into a visible retryable error", () => {
    expect(asTransportError(new Error("socket closed"))).toMatchObject({
      message: "socket closed",
      code: "transport-unknown",
      retryable: true,
    });
    expect(asTransportError("private provider response")).toMatchObject({
      message: "unknown transport failure",
      code: "transport-unknown",
      retryable: true,
    });
  });
});
