import type { CardActionKind } from "./card-action.js";
import type {
  InteractionPresentationMode,
  InteractionProviderObservationV1,
} from "@agent-relay/protocol";

export interface DeliveryChoice {
  value: string;
  label: string;
}

export interface DeliveryInteraction {
  type: "confirm" | "select" | "input";
  correlationId: string;
  prompt: string;
  expiresAt: string;
  options?: DeliveryChoice[];
}

export interface DeliveryMultiSelect {
  options: Array<DeliveryChoice & { selected: boolean }>;
  minSelections: number;
  maxSelections: number;
  submitToken: string;
  cancelToken: string;
}

export interface DeliveryQuestionSet {
  requestId: string;
  questionId: string;
  kind: "confirm" | "single-select" | "multi-select" | "free-text";
  presentationMode: InteractionPresentationMode;
  requestTitle: string;
  prompt: string;
  position: number;
  total: number;
  options: Array<DeliveryChoice & { selected: boolean }>;
  backToken?: string;
  nextToken?: string;
  submitToken: string;
  cancelToken: string;
  textInput?: {
    minLength: number;
    maxLength: number;
    multiline: boolean;
    hasDraft: boolean;
  };
}

export interface DeliveryAction {
  kind: CardActionKind;
  token: string;
  label: string;
}

export interface DeliveryMessage {
  eventId: string;
  title: string;
  text: string;
  interaction?: DeliveryInteraction;
  multiSelect?: DeliveryMultiSelect;
  questionSet?: DeliveryQuestionSet;
  actions?: DeliveryAction[];
}

export interface DeliveryContext {
  idempotencyKey: string;
  topicId?: string;
}

export interface DeliveryReceipt {
  transport: string;
  messageId: string;
  hostedInteraction?: {
    id: string;
    streamKey: string;
    type: "confirm" | "select" | "input";
  };
}

export interface TopicCreation {
  name: string;
}

export interface TopicCreationContext {
  idempotencyKey: string;
}

export interface TopicReceipt {
  transport: string;
  topicId: string;
}

export interface NotificationTransport {
  readonly name: string;
  deliver(
    message: DeliveryMessage,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt>;
}

export interface InteractionCapabilityTransport extends NotificationTransport {
  observeInteractionCapabilities(
    observedAt: string,
  ): InteractionProviderObservationV1;
}

export interface TopicNotificationTransport extends NotificationTransport {
  readonly topicScope: string;
  createTopic(
    topic: TopicCreation,
    context: TopicCreationContext,
  ): Promise<TopicReceipt>;
}

export interface InteractiveNotificationTransport extends NotificationTransport {
  acknowledgeCallback(callbackId: string, text: string): Promise<void>;
  editDeliveryMessage(
    messageId: string,
    message: DeliveryMessage,
  ): Promise<void>;
  editResolvedMessage(messageId: string, text: string): Promise<void>;
}

export function isTopicTransport(
  transport: NotificationTransport,
): transport is TopicNotificationTransport {
  return (
    "topicScope" in transport &&
    typeof transport.topicScope === "string" &&
    "createTopic" in transport &&
    typeof transport.createTopic === "function"
  );
}

export function isInteractiveTransport(
  transport: NotificationTransport,
): transport is InteractiveNotificationTransport {
  return (
    "acknowledgeCallback" in transport &&
    typeof transport.acknowledgeCallback === "function" &&
    "editDeliveryMessage" in transport &&
    typeof transport.editDeliveryMessage === "function" &&
    "editResolvedMessage" in transport &&
    typeof transport.editResolvedMessage === "function"
  );
}

export function isInteractionCapabilityTransport(
  transport: NotificationTransport,
): transport is InteractionCapabilityTransport {
  return (
    "observeInteractionCapabilities" in transport &&
    typeof transport.observeInteractionCapabilities === "function"
  );
}

export class TransportError extends Error {
  public override readonly name: string = "TransportError";

  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class TopicUnavailableError extends TransportError {
  public override readonly name = "TopicUnavailableError";

  public constructor(message: string, code: string, status?: number) {
    super(message, code, true, status);
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
