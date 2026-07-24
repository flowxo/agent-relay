import type {
  DeliveryContext,
  DeliveryMessage,
  DeliveryReceipt,
  InteractiveNotificationTransport,
} from "./transport.js";
import { TransportError } from "./transport.js";

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

export class FakeTelegramTransport implements InteractiveNotificationTransport {
  public readonly name = "fake-telegram";
  public readonly attempts: Array<{
    eventId: string;
    outcome: "delivered" | "failed" | "deduplicated";
  }> = [];
  private readonly deliveriesByKey = new Map<string, FakeDelivery>();
  private readonly failures: PlannedFailure[] = [];
  private nextMessageId = 1;
  private online = true;
  public readonly callbackAcknowledgements: Array<{
    callbackId: string;
    text: string;
  }> = [];
  public readonly messageEdits: Array<{ messageId: string; text: string }> = [];

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

  public get deliveries(): readonly FakeDelivery[] {
    return [...this.deliveriesByKey.values()];
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
      });
      return existing.receipt;
    }
    if (!this.online) {
      this.attempts.push({ eventId: message.eventId, outcome: "failed" });
      throw new TransportError(
        "fake Telegram is offline",
        "fake-offline",
        true,
      );
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      this.attempts.push({ eventId: message.eventId, outcome: "failed" });
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
    this.attempts.push({ eventId: message.eventId, outcome: "delivered" });
    return receipt;
  }

  public async acknowledgeCallback(
    callbackId: string,
    text: string,
  ): Promise<void> {
    this.callbackAcknowledgements.push({ callbackId, text });
  }

  public async editResolvedMessage(
    messageId: string,
    text: string,
  ): Promise<void> {
    this.messageEdits.push({ messageId, text });
  }
}
