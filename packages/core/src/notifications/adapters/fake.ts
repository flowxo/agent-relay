import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractiveNotificationTransport,
  TopicCreation,
  TopicCreationContext,
  TopicNotificationTransport,
  TopicReceipt,
} from "@agent-relay/notification-contracts";
import {
  TopicUnavailableError,
  TransportError,
} from "@agent-relay/notification-contracts";
import {
  InteractionProviderObservationV1Schema,
  MAX_INTERACTION_OPTIONS,
  MAX_INTERACTION_QUESTIONS,
  MAX_INTERACTION_REQUEST_BYTES,
  MAX_INTERACTION_TEXT_LENGTH,
  type InteractionProviderObservationV1,
} from "@agent-relay/protocol";

export interface FakeDelivery {
  message: DeliveryMessage;
  context: DeliveryContext;
  receipt: DeliveryReceipt;
}

interface PlannedFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FakeTopic {
  topic: TopicCreation;
  context: TopicCreationContext;
  receipt: TopicReceipt;
}

export class FakeNotificationTransport
  implements InteractiveNotificationTransport, TopicNotificationTransport
{
  // Retain the pre-refactor durable transport identity so existing local
  // delivery summaries remain continuous across this code-ownership change.
  public readonly name = "fake-telegram";
  public readonly topicScope = "fake:private-chat";

  public observeInteractionCapabilities(
    observedAt: string,
  ): InteractionProviderObservationV1 {
    return InteractionProviderObservationV1Schema.parse({
      schema: "agent-interaction-provider-observation.v1",
      capabilities: {
        schema: "agent-interaction-capabilities.v1",
        providerId: "transport_fake_telegram",
        providerKind: "transport",
        observedAt,
        features: [
          "confirm",
          "single-select",
          "multi-select",
          "free-text",
          "ordered-question-set",
          "durable-drafts",
          "message-updates",
        ],
        presentationModes: ["buttons", "direct-text", "numbered-text"],
        limits: {
          maxQuestions: MAX_INTERACTION_QUESTIONS,
          maxOptionsPerQuestion: MAX_INTERACTION_OPTIONS,
          maxTextLength: MAX_INTERACTION_TEXT_LENGTH,
          maxPayloadBytes: MAX_INTERACTION_REQUEST_BYTES,
        },
      },
      status: "proven",
      evidence: "fake",
      observedVersion: "fake-telegram.v1",
      fixture: "protocol-interaction-capabilities-v1",
      note: "In-memory transport used to prove routing, retries, correlation, and interaction state without a bot token.",
    });
  }
  public readonly attempts: Array<{
    eventId: string;
    outcome: "delivered" | "failed" | "deduplicated";
    topicId?: string;
  }> = [];
  public readonly topicAttempts: Array<{
    idempotencyKey: string;
    outcome: "created" | "failed" | "deduplicated";
  }> = [];
  private readonly deliveriesByKey = new Map<string, FakeDelivery>();
  private readonly topicsByKey = new Map<string, FakeTopic>();
  private readonly failures: PlannedFailure[] = [];
  private readonly topicFailures: PlannedFailure[] = [];
  private readonly closedTopicIds = new Set<string>();
  private nextMessageId = 1;
  private nextTopicId = 1_000;
  private online = true;
  public readonly callbackAcknowledgements: Array<{
    callbackId: string;
    text: string;
  }> = [];
  public readonly messageEdits: Array<{ messageId: string; text: string }> = [];
  public readonly deliveryMessageEdits: Array<{
    messageId: string;
    message: DeliveryMessage;
  }> = [];

  public setOnline(online: boolean): void {
    this.online = online;
  }

  public failNext(
    count: number,
    failure: PlannedFailure = {
      code: "fake-timeout",
      message: "fake transport timeout",
      retryable: true,
    },
  ): void {
    for (let index = 0; index < count; index += 1) {
      this.failures.push(failure);
    }
  }

  public failNextTopicCreation(
    count: number,
    failure: PlannedFailure = {
      code: "fake-topic-timeout",
      message: "fake topic creation timed out",
      retryable: true,
    },
  ): void {
    for (let index = 0; index < count; index += 1) {
      this.topicFailures.push(failure);
    }
  }

  public get deliveries(): readonly FakeDelivery[] {
    return [...this.deliveriesByKey.values()];
  }

  public get topics(): readonly FakeTopic[] {
    return [...this.topicsByKey.values()];
  }

  public deleteTopic(topicId: string): boolean {
    const entry = [...this.topicsByKey.entries()].find(
      ([, topic]) => topic.receipt.topicId === topicId,
    );
    return entry === undefined ? false : this.topicsByKey.delete(entry[0]);
  }

  public closeTopic(topicId: string): boolean {
    const entry = [...this.topicsByKey.entries()].find(
      ([, topic]) => topic.receipt.topicId === topicId,
    );
    if (entry === undefined) {
      return false;
    }
    this.closedTopicIds.add(topicId);
    this.topicsByKey.delete(entry[0]);
    return true;
  }

  public async createTopic(
    topic: TopicCreation,
    context: TopicCreationContext,
  ): Promise<TopicReceipt> {
    const existing = this.topicsByKey.get(context.idempotencyKey);
    if (existing !== undefined) {
      this.topicAttempts.push({
        idempotencyKey: context.idempotencyKey,
        outcome: "deduplicated",
      });
      return existing.receipt;
    }
    if (!this.online) {
      this.topicAttempts.push({
        idempotencyKey: context.idempotencyKey,
        outcome: "failed",
      });
      throw new TransportError(
        "fake Telegram is offline",
        "fake-offline",
        true,
      );
    }
    const failure = this.topicFailures.shift();
    if (failure !== undefined) {
      this.topicAttempts.push({
        idempotencyKey: context.idempotencyKey,
        outcome: "failed",
      });
      throw new TransportError(
        failure.message,
        failure.code,
        failure.retryable,
      );
    }
    const receipt = {
      transport: this.name,
      topicId: String(this.nextTopicId++),
    };
    this.topicsByKey.set(context.idempotencyKey, {
      topic,
      context,
      receipt,
    });
    this.topicAttempts.push({
      idempotencyKey: context.idempotencyKey,
      outcome: "created",
    });
    return receipt;
  }

  public async deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const existing = this.deliveriesByKey.get(context.idempotencyKey);
    if (existing !== undefined) {
      this.attempts.push({
        eventId: message.eventId,
        outcome: "deduplicated",
        ...(context.topicId === undefined ? {} : { topicId: context.topicId }),
      });
      return existing.receipt;
    }
    if (
      context.topicId !== undefined &&
      ![...this.topicsByKey.values()].some(
        (topic) => topic.receipt.topicId === context.topicId,
      )
    ) {
      this.attempts.push({
        eventId: message.eventId,
        outcome: "failed",
        topicId: context.topicId,
      });
      throw new TopicUnavailableError(
        this.closedTopicIds.has(context.topicId)
          ? "fake message thread is closed"
          : "fake message thread not found",
        this.closedTopicIds.has(context.topicId)
          ? "fake-topic-closed"
          : "fake-topic-unavailable",
      );
    }
    if (!this.online) {
      this.attempts.push({
        eventId: message.eventId,
        outcome: "failed",
        ...(context.topicId === undefined ? {} : { topicId: context.topicId }),
      });
      throw new TransportError(
        "fake Telegram is offline",
        "fake-offline",
        true,
      );
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      this.attempts.push({
        eventId: message.eventId,
        outcome: "failed",
        ...(context.topicId === undefined ? {} : { topicId: context.topicId }),
      });
      throw new TransportError(
        failure.message,
        failure.code,
        failure.retryable,
      );
    }
    const receipt = {
      transport: this.name,
      messageId: String(this.nextMessageId++),
    };
    this.deliveriesByKey.set(context.idempotencyKey, {
      message,
      context,
      receipt,
    });
    this.attempts.push({
      eventId: message.eventId,
      outcome: "delivered",
      ...(context.topicId === undefined ? {} : { topicId: context.topicId }),
    });
    return receipt;
  }

  public async acknowledgeCallback(
    callbackId: string,
    text: string,
  ): Promise<void> {
    this.callbackAcknowledgements.push({ callbackId, text });
  }

  public async editDeliveryMessage(
    messageId: string,
    message: DeliveryMessage,
  ): Promise<void> {
    if (!this.online) {
      throw new TransportError(
        "fake Telegram is offline",
        "fake-offline",
        true,
      );
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw new TransportError(
        failure.message,
        failure.code,
        failure.retryable,
      );
    }
    this.deliveryMessageEdits.push({ messageId, message });
  }

  public async editResolvedMessage(
    messageId: string,
    text: string,
  ): Promise<void> {
    this.messageEdits.push({ messageId, text });
  }
}
