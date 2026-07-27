import {
  NOOP_LOGGER,
  type HostedAcknowledgementRecord,
  type RecordHostedClaimInput,
  type RelayLogger,
  type RelayStore,
} from "@agent-relay/core";
import { sha256 } from "@agent-relay/protocol";
import {
  notificationsMachineStreamKey,
  validateHostedAnswer,
  type HostedAnswerValidation,
  type HostedInteractionEvent,
  type NotificationsInteractionSource,
} from "@agent-relay/notifications-transport";

export interface NotificationsPollerOptions {
  store: RelayStore;
  source: NotificationsInteractionSource;
  streamKey: string;
  machineId: string;
  bindingId: string;
  logger?: RelayLogger;
  waitSeconds?: number;
  limit?: number;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export function notificationsStreamKey(
  baseUrl: string | URL,
  machineClientId: string,
): string {
  return notificationsMachineStreamKey(baseUrl, machineClientId);
}

function safeRef(value: string): string {
  return sha256(value).slice(0, 12);
}

function hostedEventPayloadHash(event: HostedInteractionEvent): string {
  return sha256(
    JSON.stringify([
      event.schema,
      event.id,
      event.cursor,
      event.type,
      event.message_id,
      event.interaction_id,
      event.correlation_id ?? null,
      event.response.type,
      event.response.value,
      event.channel_context.binding_id,
      event.channel_context.channel,
      event.channel_context.conversation_kind,
      event.channel_context.display_name ?? null,
      event.occurred_at,
      event.expires_at,
    ]),
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "notifications-unclassified";
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class NotificationsInteractionPoller {
  private readonly logger: RelayLogger;
  private readonly waitSeconds: number;
  private readonly limit: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => Date;
  private readonly sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  public constructor(private readonly options: NotificationsPollerOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.waitSeconds = options.waitSeconds ?? 30;
    this.limit = options.limit ?? 20;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? this.waitSeconds * 1_000 + 5_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    if (
      !Number.isSafeInteger(this.waitSeconds) ||
      this.waitSeconds < 0 ||
      this.waitSeconds > 30
    ) {
      throw new Error("Notifications poll wait must be between 0 and 30");
    }
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 1 ||
      this.limit > 50
    ) {
      throw new Error("Notifications poll limit must be between 1 and 50");
    }
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 100 ||
      this.requestTimeoutMs > 120_000 ||
      !Number.isSafeInteger(this.retryBaseMs) ||
      this.retryBaseMs < 1 ||
      !Number.isSafeInteger(this.retryMaxMs) ||
      this.retryMaxMs < this.retryBaseMs
    ) {
      throw new Error("Notifications poll timeout or retry bounds are invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(options.streamKey)) {
      throw new Error("Notifications stream key must be a SHA-256 digest");
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(Math.max(0, attempt - 1), 20),
    );
  }

  private boundedSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([
      parent,
      AbortSignal.timeout(this.requestTimeoutMs),
    ]);
  }

  private validationFor(event: HostedInteractionEvent): HostedAnswerValidation {
    const delivery = this.options.store.getHostedDeliveryForMessage(
      this.options.streamKey,
      event.message_id,
    );
    if (delivery === undefined) {
      return {
        outcome: "stop",
        acknowledgement: "none",
        reasonCode: "request_not_found",
      };
    }
    return validateHostedAnswer({
      event,
      localRequest: delivery.request,
      expected: {
        correlationId: delivery.request.correlationId,
        eventId: delivery.eventId,
        hostedMessageId: delivery.messageId,
        hostedInteractionId: delivery.interactionId,
        machineId: delivery.request.machineId,
        harness: delivery.request.harness,
        sessionId: delivery.request.sessionId,
        ...(delivery.request.turnId === undefined
          ? {}
          : { turnId: delivery.request.turnId }),
        interactionType: delivery.interactionType,
        expiresAt: delivery.request.expiresAt,
        bindingId: this.options.bindingId,
        ...(delivery.event.request?.interaction === undefined
          ? {}
          : { structuredRequest: delivery.event.request.interaction }),
      },
      stream: {
        authenticatedMachineId: this.options.machineId,
        configuredMachineId: this.options.machineId,
        schemaValidated: true,
        // The pinned client validated this authenticated response contract.
        // C0 does not expose or require a detached poll-response signature.
        responseContractVerified: true,
        streamIdentityVerified: true,
      },
    });
  }

  private recordEvent(
    event: HostedInteractionEvent,
  ): ReturnType<RelayStore["recordHostedEventClaim"]> {
    const validation = this.validationFor(event);
    const input: RecordHostedClaimInput = {
      streamKey: this.options.streamKey,
      eventId: event.id,
      cursor: event.cursor,
      payloadHash: hostedEventPayloadHash(event),
      messageId: event.message_id,
      interactionId: event.interaction_id,
      occurredAt: new Date(Date.parse(event.occurred_at)).toISOString(),
      handledAt: this.now().toISOString(),
      validation,
    };
    return this.options.store.recordHostedEventClaim(input);
  }

  private async acknowledge(
    work: HostedAcknowledgementRecord,
    signal: AbortSignal,
  ): Promise<"acknowledged" | "retry" | "stop"> {
    try {
      const response = await this.options.source.acknowledge({
        eventId: work.eventId,
        cursor: work.cursor,
        disposition: work.disposition,
        ...(work.reasonCode === undefined
          ? {}
          : { reasonCode: work.reasonCode }),
        signal: this.boundedSignal(signal),
      });
      if (
        response.event_id !== work.eventId ||
        response.cursor !== work.cursor ||
        response.disposition !== work.disposition ||
        response.reason_code !== work.reasonCode ||
        response.committed_cursor === null
      ) {
        throw Object.assign(
          new Error(
            "Notifications acknowledgement response changed durable identity",
          ),
          {
            code: "notifications-acknowledgement-identity-mismatch",
            retryable: false,
          },
        );
      }
      this.options.store.markHostedAcknowledgementSucceeded({
        streamKey: this.options.streamKey,
        eventId: work.eventId,
        cursor: work.cursor,
        disposition: work.disposition,
        committedCursor: response.committed_cursor,
        now: this.now().toISOString(),
      });
      return "acknowledged";
    } catch (error) {
      if (signal.aborted) {
        return "stop";
      }
      const retryable = isRetryable(error);
      const now = this.now();
      this.options.store.markHostedAcknowledgementFailed({
        streamKey: this.options.streamKey,
        eventId: work.eventId,
        errorCode: errorCode(error),
        retryable,
        now: now.toISOString(),
        retryAt: new Date(
          now.getTime() + this.retryDelay(work.attemptCount),
        ).toISOString(),
      });
      this.logger.log({
        level: "error",
        code: retryable
          ? "notifications.ack-retry"
          : "notifications.ack-blocked",
        message: retryable
          ? "Notifications acknowledgement will retry from durable state"
          : "Notifications acknowledgement stopped on a terminal failure",
        at: now.toISOString(),
        details: {
          eventRef: safeRef(work.eventId),
          errorCode: errorCode(error),
          attempt: work.attemptCount,
        },
      });
      return retryable ? "retry" : "stop";
    }
  }

  private validateBatch(events: HostedInteractionEvent[]): boolean {
    const eventIds = new Set<string>();
    const cursors = new Set<string>();
    for (const event of events) {
      if (eventIds.has(event.id) || cursors.has(event.cursor)) {
        return false;
      }
      eventIds.add(event.id);
      cursors.add(event.cursor);
    }
    return true;
  }

  public async run(signal: AbortSignal): Promise<void> {
    this.options.store.recoverHostedInteractionWork(this.now().toISOString());
    let failedPolls = 0;
    this.logger.log({
      level: "info",
      code: "notifications.poll-started",
      message: "Notifications interaction polling started",
      at: this.now().toISOString(),
    });
    try {
      while (!signal.aborted) {
        const barrier = this.options.store.getHostedAcknowledgementBarrier(
          this.options.streamKey,
        );
        if (barrier !== undefined) {
          if (barrier.state === "blocked") {
            break;
          }
          const claimed = this.options.store.claimHostedAcknowledgement(
            this.options.streamKey,
            this.now().toISOString(),
          );
          if (claimed !== undefined) {
            const result = await this.acknowledge(claimed, signal);
            if (result === "stop") {
              break;
            }
            if (result === "acknowledged") {
              failedPolls = 0;
              continue;
            }
          }
          const current = this.options.store.getHostedAcknowledgementBarrier(
            this.options.streamKey,
          );
          const delayMs =
            current === undefined
              ? 1
              : Math.max(
                  1,
                  Math.min(
                    this.retryMaxMs,
                    Date.parse(current.nextAttemptAt) - this.now().getTime(),
                  ),
                );
          await this.sleep(delayMs, signal);
          continue;
        }

        const pollState = this.options.store.hostedPollStatus(
          this.options.streamKey,
        );
        try {
          const batch = await this.options.source.poll({
            ...(pollState.committedCursor === undefined
              ? {}
              : { after: pollState.committedCursor }),
            limit: this.limit,
            waitSeconds: this.waitSeconds,
            signal: this.boundedSignal(signal),
          });
          if (signal.aborted) {
            break;
          }
          this.options.store.recordHostedPollSucceeded({
            streamKey: this.options.streamKey,
            ...(pollState.committedCursor === undefined
              ? {}
              : { committedCursor: pollState.committedCursor }),
            ...(batch.committed_cursor === null
              ? {}
              : { observedCommittedCursor: batch.committed_cursor }),
            now: this.now().toISOString(),
          });
          if (!this.validateBatch(batch.events)) {
            throw Object.assign(
              new Error("Notifications returned duplicate event identities"),
              {
                code: "notifications-stream-order-invalid",
                retryable: false,
              },
            );
          }
          failedPolls = 0;
          const event = batch.events[0];
          if (event === undefined) {
            await this.sleep(this.waitSeconds === 0 ? 1 : 10, signal);
            continue;
          }
          const claim = this.recordEvent(event);
          if (claim.outcome === "stopped") {
            this.options.store.recordHostedPollFailure(
              this.options.streamKey,
              `notifications-${(
                claim.reasonCode ?? "stream-stopped"
              ).replaceAll("_", "-")}`,
              this.now().toISOString(),
            );
            this.logger.log({
              level: "error",
              code: "notifications.poll-stopped-on-integrity",
              message:
                "Notifications polling stopped before acknowledgement because local correlation failed",
              at: this.now().toISOString(),
              details: {
                eventRef: safeRef(event.id),
                reasonCode: claim.reasonCode,
              },
            });
            break;
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }
          const retryable = isRetryable(error);
          const now = this.now();
          const code = errorCode(error);
          this.options.store.recordHostedPollFailure(
            this.options.streamKey,
            code,
            now.toISOString(),
          );
          this.logger.log({
            level: "error",
            code: retryable
              ? "notifications.poll-retry"
              : "notifications.poll-blocked",
            message: retryable
              ? "Notifications interaction polling will retry"
              : "Notifications interaction polling stopped on a terminal failure",
            at: now.toISOString(),
            details: {
              errorCode: code,
              retryDelayMs: retryable ? this.retryDelay(failedPolls + 1) : 0,
            },
          });
          if (!retryable) {
            break;
          }
          failedPolls += 1;
          await this.sleep(this.retryDelay(failedPolls), signal);
        }
      }
    } finally {
      this.logger.log({
        level: "info",
        code: "notifications.poll-stopped",
        message: "Notifications interaction polling stopped",
        at: this.now().toISOString(),
      });
    }
  }
}
