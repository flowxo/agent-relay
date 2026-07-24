export interface DeliveryChoice {
  token: string;
  label: string;
}

export interface DeliveryMessage {
  eventId: string;
  title: string;
  text: string;
  correlationId?: string;
  choices?: DeliveryChoice[];
}

export interface DeliveryContext {
  idempotencyKey: string;
}

export interface DeliveryReceipt {
  transport: string;
  messageId: string;
}

export interface NotificationTransport {
  readonly name: string;
  deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt>;
}

export interface InteractiveNotificationTransport extends NotificationTransport {
  acknowledgeCallback(callbackId: string, text: string): Promise<void>;
  editResolvedMessage(messageId: string, text: string): Promise<void>;
}

export function isInteractiveTransport(
  transport: NotificationTransport,
): transport is InteractiveNotificationTransport {
  return (
    "acknowledgeCallback" in transport &&
    typeof transport.acknowledgeCallback === "function" &&
    "editResolvedMessage" in transport &&
    typeof transport.editResolvedMessage === "function"
  );
}

export class TransportError extends Error {
  public override readonly name = "TransportError";

  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function asTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  return new TransportError(
    error instanceof Error ? error.message : "unknown transport failure",
    "transport-unknown",
    true,
  );
}
