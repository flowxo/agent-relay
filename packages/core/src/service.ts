import type {
  AgentAttentionEventV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
} from "@agent-relay/protocol";

import type { RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import { renderDeliveryMessage } from "./message.js";
import type {
  IngestResult,
  PendingRequestRecord,
  RelayStore,
  ResolutionResult,
  RetryPolicy,
  ResolveRequestInput,
} from "./store.js";
import { DEFAULT_RETRY_POLICY } from "./store.js";
import type { NotificationTransport } from "./transport.js";
import { asTransportError } from "./transport.js";

export interface DrainResult {
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
}

export interface RelayServiceOptions {
  retryPolicy?: RetryPolicy;
  logger?: RelayLogger;
  now?: () => Date;
}

export class RelayService {
  private readonly retryPolicy: RetryPolicy;
  private readonly logger: RelayLogger;
  private readonly now: () => Date;

  public constructor(
    public readonly store: RelayStore,
    public readonly transport: NotificationTransport,
    options: RelayServiceOptions = {},
  ) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
  }

  public recover(): number {
    const recovered = this.store.recoverInterruptedDeliveries(
      this.now().toISOString(),
    );
    if (recovered > 0) {
      this.logger.log({
        level: "warn",
        code: "delivery.recovered",
        message: `recovered ${recovered} interrupted delivery attempts`,
        at: this.now().toISOString(),
        details: { recovered },
      });
    }
    return recovered;
  }

  public registerSession(session: SessionRegistrationV1): void {
    this.store.registerSession(session);
    this.logger.log({
      level: "info",
      code: "session.registered",
      message: "session registered",
      at: this.now().toISOString(),
      details: {
        machineId: session.machineId,
        harness: session.harness,
        sessionId: session.sessionId,
      },
    });
  }

  public heartbeat(heartbeat: SessionHeartbeatV1): boolean {
    const updated = this.store.heartbeat(heartbeat);
    if (!updated) {
      this.logger.log({
        level: "warn",
        code: "heartbeat.unknown-session",
        message: "heartbeat did not match a registered session",
        at: this.now().toISOString(),
        details: {
          machineId: heartbeat.machineId,
          harness: heartbeat.harness,
          sessionId: heartbeat.sessionId,
        },
      });
    }
    return updated;
  }

  public ingest(event: AgentAttentionEventV1): IngestResult {
    const result = this.store.ingestEvent(event);
    this.logger.log({
      level: "info",
      code: result.inserted ? "event.ingested" : "event.duplicate",
      message: result.inserted
        ? "attention event queued"
        : "duplicate attention event ignored",
      at: this.now().toISOString(),
      details: {
        eventId: event.eventId,
        harness: event.harness,
        sessionId: event.sessionId,
        type: event.type,
      },
    });
    return result;
  }

  public getRequest(correlationId: string): PendingRequestRecord | undefined {
    this.store.expireRequests(this.now().toISOString());
    return this.store.getPendingRequest(correlationId);
  }

  public resolveTerminal(
    input: Omit<ResolveRequestInput, "resolvedBy" | "now">,
  ): ResolutionResult {
    const result = this.store.resolveRequest({
      ...input,
      resolvedBy: "terminal",
      now: this.now().toISOString(),
    });
    this.logger.log({
      level: result.outcome === "answered" ? "info" : "warn",
      code: `request.${result.outcome}`,
      message: `terminal request resolution: ${result.outcome}`,
      at: this.now().toISOString(),
      details: {
        correlationId: input.correlationId,
        resolvedBy: "terminal",
      },
    });
    return result;
  }

  public async drain(limit = 50): Promise<DrainResult> {
    const claimTime = this.now().toISOString();
    const claimed = this.store.claimDueEvents(claimTime, limit);
    const result: DrainResult = {
      claimed: claimed.length,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
    };

    for (const item of claimed) {
      try {
        const rendered = renderDeliveryMessage(item.event);
        const pending = this.store.getPendingForEvent(item.event.eventId);
        const message =
          pending === undefined || pending.options.length === 0
            ? rendered
            : {
                ...rendered,
                choices: pending.options.map((option) => ({
                  token: option.token,
                  label: option.label,
                })),
              };
        const receipt = await this.transport.deliver(message, {
          idempotencyKey: item.event.eventId,
        });
        this.store.markDelivered(
          item.event.eventId,
          item.attemptNumber,
          receipt.transport,
          receipt.messageId,
          this.now().toISOString(),
        );
        result.delivered += 1;
        this.logger.log({
          level: "info",
          code: "delivery.succeeded",
          message: "attention event delivered",
          at: this.now().toISOString(),
          details: {
            eventId: item.event.eventId,
            transport: receipt.transport,
            messageId: receipt.messageId,
          },
        });
      } catch (error) {
        const transportError = asTransportError(error);
        const status = this.store.markDeliveryFailed(
          item.event.eventId,
          item.attemptNumber,
          transportError.code,
          transportError.message,
          transportError.retryable,
          this.now().toISOString(),
          this.retryPolicy,
        );
        if (status === "retry") {
          result.retrying += 1;
        } else {
          result.deadLettered += 1;
        }
        this.logger.log({
          level: status === "retry" ? "warn" : "error",
          code:
            status === "retry"
              ? "delivery.retry-scheduled"
              : "delivery.dead-lettered",
          message: transportError.message,
          at: this.now().toISOString(),
          details: {
            eventId: item.event.eventId,
            errorCode: transportError.code,
            attemptNumber: item.attemptNumber,
            retryable: transportError.retryable,
          },
        });
      }
    }
    return result;
  }
}
