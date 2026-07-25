import type {
  AgentAttentionEventV1,
  RelayDiagnosticV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
} from "@agent-relay/protocol";
import { sha256 } from "@agent-relay/protocol";

import type { RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import { renderDeliveryMessage } from "./message.js";
import { redactText } from "./redaction.js";
import type {
  DiagnosticIngestResult,
  IngestResult,
  PendingRequestRecord,
  RelayStore,
  RetentionResult,
  ResumeClaimResult,
  ResumeCommandRecord,
  ResolutionResult,
  RetryPolicy,
  ResolveRequestInput,
} from "./store.js";
import { DEFAULT_RETRY_POLICY } from "./store.js";
import { sessionTopicMetadata } from "./topic.js";
import type {
  DeliveryContext,
  NotificationTransport,
  TopicNotificationTransport,
} from "./transport.js";
import {
  asTransportError,
  isInteractiveTransport,
  isTopicTransport,
  TopicUnavailableError,
  TransportError,
} from "./transport.js";

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
  coalescingWindowMs?: number;
}

export interface RetentionOptions {
  deliveredDays?: number;
  deadLetterDays?: number;
  requestDays?: number;
  diagnosticDays?: number;
  telegramUpdateDays?: number;
  sessionDays?: number;
  limit?: number;
}

function retentionDays(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const days = value ?? fallback;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
    throw new Error(`${name} must be between 1 and 3650 days`);
  }
  return days;
}

function notificationFingerprint(
  event: AgentAttentionEventV1,
): string | undefined {
  if (
    event.request !== undefined ||
    !["turn.started", "turn.activity", "turn.stopped"].includes(event.type)
  ) {
    return undefined;
  }
  return sha256(
    JSON.stringify([
      event.type,
      event.summary ?? null,
      event.lastAssistantMessage ?? null,
    ]),
  );
}

export class RelayService {
  private readonly retryPolicy: RetryPolicy;
  private readonly logger: RelayLogger;
  private readonly now: () => Date;
  private readonly coalescingWindowMs: number;

  public constructor(
    public readonly store: RelayStore,
    public readonly transport: NotificationTransport,
    options: RelayServiceOptions = {},
  ) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.coalescingWindowMs = options.coalescingWindowMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.coalescingWindowMs) ||
      this.coalescingWindowMs < 0 ||
      this.coalescingWindowMs > 3_600_000
    ) {
      throw new Error(
        "notification coalescing window must be between 0 and 3600000 ms",
      );
    }
  }

  public recover(): number {
    const now = this.now().toISOString();
    const recovered = this.store.recoverInterruptedDeliveries(now);
    const recoveredTopics = this.store.recoverInterruptedTopics(now);
    if (recovered > 0) {
      this.logger.log({
        level: "warn",
        code: "delivery.recovered",
        message: `recovered ${recovered} interrupted delivery attempts`,
        at: this.now().toISOString(),
        details: { recovered },
      });
    }
    if (recoveredTopics > 0) {
      this.logger.log({
        level: "warn",
        code: "topic.recovered",
        message: `recovered ${recoveredTopics} interrupted topic creation attempts`,
        at: now,
        details: { recovered: recoveredTopics },
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

  public reportDiagnostic(
    diagnostic: RelayDiagnosticV1,
  ): DiagnosticIngestResult {
    const safeDiagnostic = {
      ...diagnostic,
      message: redactText(diagnostic.message, 2_000),
    };
    const result = this.store.recordDiagnostic(safeDiagnostic);
    this.logger.log({
      level: safeDiagnostic.level,
      code: result.inserted ? "diagnostic.recorded" : "diagnostic.duplicate",
      message: safeDiagnostic.message,
      at: this.now().toISOString(),
      details: {
        diagnosticId: safeDiagnostic.diagnosticId,
        source: safeDiagnostic.source,
        diagnosticCode: safeDiagnostic.code,
      },
    });
    return result;
  }

  public maintainRetention(options: RetentionOptions = {}): RetentionResult {
    const now = this.now();
    const before = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
    const requestsExpired = this.store.expireRequests(now.toISOString());
    const result = this.store.pruneRetention({
      deliveredBefore: before(
        retentionDays(options.deliveredDays, 30, "deliveredDays"),
      ),
      deadLetterBefore: before(
        retentionDays(options.deadLetterDays, 90, "deadLetterDays"),
      ),
      requestBefore: before(
        retentionDays(options.requestDays, 30, "requestDays"),
      ),
      diagnosticBefore: before(
        retentionDays(options.diagnosticDays, 90, "diagnosticDays"),
      ),
      telegramUpdateBefore: before(
        retentionDays(options.telegramUpdateDays, 30, "telegramUpdateDays"),
      ),
      sessionBefore: before(
        retentionDays(options.sessionDays, 90, "sessionDays"),
      ),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    result.requestsExpired = requestsExpired;
    this.logger.log({
      level: "info",
      code: "retention.completed",
      message: "durable retention maintenance completed",
      at: now.toISOString(),
      details: { ...result },
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

  public claimNextResume(input: {
    machineId: string;
    bridgeSessionId: string;
    harness: AgentAttentionEventV1["harness"];
    ownerId: string;
  }): ResumeClaimResult {
    const result = this.store.claimNextResume({
      ...input,
      now: this.now().toISOString(),
    });
    if (result.outcome !== "waiting") {
      this.logger.log({
        level: result.outcome === "unsupported" ? "warn" : "info",
        code: `resume.${result.outcome}`,
        message: `late resume claim: ${result.outcome}`,
        at: this.now().toISOString(),
        details: {
          machineId: input.machineId,
          bridgeSessionId: input.bridgeSessionId,
          harness: input.harness,
          ownerId: input.ownerId,
          ...(result.outcome === "claimed"
            ? { correlationId: result.command.correlationId }
            : {}),
        },
      });
    }
    return result;
  }

  public markResumeStarted(
    correlationId: string,
    ownerId: string,
  ): ResumeCommandRecord {
    const command = this.store.markResumeStarted(
      correlationId,
      ownerId,
      this.now().toISOString(),
    );
    this.logger.log({
      level: "info",
      code: "resume.started",
      message: "late resume process started",
      at: this.now().toISOString(),
      details: { correlationId, ownerId },
    });
    return command;
  }

  public markResumeFinished(input: {
    correlationId: string;
    ownerId: string;
    succeeded: boolean;
    exitCode?: number;
    signal?: string;
    errorCode?: string;
    errorMessage?: string;
  }): ResumeCommandRecord {
    const command = this.store.markResumeFinished({
      ...input,
      now: this.now().toISOString(),
    });
    this.logger.log({
      level: input.succeeded ? "info" : "error",
      code: input.succeeded ? "resume.succeeded" : "resume.failed",
      message: input.succeeded
        ? "late resume process completed"
        : "late resume process failed",
      at: this.now().toISOString(),
      details: {
        correlationId: input.correlationId,
        ownerId: input.ownerId,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.errorCode === undefined
          ? {}
          : { errorCode: input.errorCode }),
      },
    });
    return command;
  }

  private sessionTopicIdentity(
    event: AgentAttentionEventV1,
    transport: TopicNotificationTransport,
  ) {
    const metadata = sessionTopicMetadata(event);
    return {
      machineId: event.machineId,
      harness: event.harness,
      sessionId: event.sessionId,
      transportName: transport.name,
      transportScope: transport.topicScope,
      ...metadata,
    };
  }

  private async deliveryContext(
    event: AgentAttentionEventV1,
  ): Promise<DeliveryContext> {
    const context = { idempotencyKey: event.eventId };
    const topicTransport = this.transport;
    if (!isTopicTransport(topicTransport)) {
      return context;
    }

    const identity = this.sessionTopicIdentity(event, topicTransport);
    const claim = this.store.claimSessionTopic({
      ...identity,
      now: this.now().toISOString(),
    });
    if (claim.outcome === "ready") {
      if (claim.topic.topicId === undefined) {
        throw new Error("ready session topic is missing its topic id");
      }
      return {
        ...context,
        topicId: claim.topic.topicId,
      };
    }
    if (claim.outcome === "busy" || claim.outcome === "deferred") {
      throw new TransportError(
        claim.outcome === "busy"
          ? "session topic creation is already in progress"
          : "session topic creation is waiting for its retry deadline",
        `topic-provisioning-${claim.outcome}`,
        true,
      );
    }
    if (claim.outcome === "failed") {
      throw new TransportError(
        claim.topic.lastErrorMessage ?? "session topic creation failed",
        claim.topic.lastErrorCode ?? "topic-provisioning-failed",
        false,
      );
    }

    const topicKey = `topic_${sha256(
      [
        identity.machineId,
        identity.harness,
        identity.sessionId,
        identity.transportName,
        identity.transportScope,
      ].join("\u001f"),
    ).slice(0, 40)}`;
    const ready = await (async () => {
      try {
        const receipt = await topicTransport.createTopic(
          { name: claim.topic.topicName },
          { idempotencyKey: topicKey },
        );
        return this.store.markSessionTopicReady({
          machineId: identity.machineId,
          harness: identity.harness,
          sessionId: identity.sessionId,
          transportName: identity.transportName,
          transportScope: identity.transportScope,
          attemptNumber: claim.attemptNumber,
          topicId: receipt.topicId,
          now: this.now().toISOString(),
        });
      } catch (error) {
        const transportError = asTransportError(error);
        const failedAt = this.now().toISOString();
        const safeMessage = redactText(transportError.message, 2_000);
        const failed = this.store.markSessionTopicFailed(
          {
            machineId: identity.machineId,
            harness: identity.harness,
            sessionId: identity.sessionId,
            transportName: identity.transportName,
            transportScope: identity.transportScope,
            attemptNumber: claim.attemptNumber,
            errorCode: transportError.code,
            errorMessage: safeMessage,
            retryable: transportError.retryable,
            now: failedAt,
          },
          this.retryPolicy,
        );
        this.reportDiagnostic({
          schema: "agent-relay-diagnostic.v1",
          diagnosticId: `diag_topic_${sha256(
            `${topicKey}\u001f${String(claim.attemptNumber)}`,
          ).slice(0, 40)}`,
          recordedAt: failedAt,
          source: "daemon",
          level: failed.provisioningStatus === "retry" ? "warn" : "error",
          code: "topic.create-failed",
          message: `session topic creation failed: ${safeMessage}`,
        });
        throw new TransportError(
          safeMessage,
          transportError.code,
          failed.provisioningStatus === "retry",
          transportError.status,
        );
      }
    })();
    if (ready.topicId === undefined) {
      throw new Error("created session topic is missing its topic id");
    }
    this.logger.log({
      level: "info",
      code: "topic.created",
      message: "session topic created",
      at: this.now().toISOString(),
      details: {
        harness: ready.harness,
        repository: ready.repository,
        shortSessionId: ready.shortSessionId,
        transport: ready.transportName,
        topicId: ready.topicId,
      },
    });
    return {
      ...context,
      topicId: ready.topicId,
    };
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
      let deliveryTopicId: string | undefined;
      try {
        const suppressionReason = this.store.suppressionReason(item.event);
        if (suppressionReason !== undefined) {
          this.store.markDeliverySuppressed(
            item.event.eventId,
            item.attemptNumber,
            suppressionReason,
            this.now().toISOString(),
          );
          result.delivered += 1;
          this.logger.log({
            level: "info",
            code: "delivery.suppressed",
            message: "routine notification suppressed by session control",
            at: this.now().toISOString(),
            details: {
              eventId: item.event.eventId,
              reason: suppressionReason,
            },
          });
          continue;
        }
        const interactiveTransport = isInteractiveTransport(this.transport)
          ? this.transport
          : undefined;
        const fingerprint =
          this.coalescingWindowMs === 0 || interactiveTransport === undefined
            ? undefined
            : notificationFingerprint(item.event);
        if (
          fingerprint !== undefined &&
          interactiveTransport !== undefined &&
          item.attemptNumber === 1
        ) {
          const coalescingTarget = this.store.findNotificationCoalescingTarget({
            event: item.event,
            fingerprint,
            windowMs: this.coalescingWindowMs,
            now: this.now().toISOString(),
          });
          if (coalescingTarget !== undefined) {
            const anchor = this.store.getEvent(
              coalescingTarget.anchorEventId,
            )?.event;
            if (anchor === undefined) {
              throw new Error(
                "notification coalescing anchor event is missing",
              );
            }
            const latestAt =
              item.event.occurredAt > coalescingTarget.latestOccurredAt
                ? item.event.occurredAt
                : coalescingTarget.latestOccurredAt;
            const coalescedMessage = renderDeliveryMessage(anchor, {
              now: this.now(),
              forceDetails: true,
              coalesced: {
                count: coalescingTarget.eventCount + 1,
                latestAt,
              },
            });
            if (coalescedMessage.actions !== undefined) {
              this.store.registerCardActions(
                anchor.eventId,
                coalescedMessage.actions.map((action) => ({
                  token: action.token,
                  kind: action.kind,
                })),
                this.now().toISOString(),
              );
            }
            try {
              await interactiveTransport.editDeliveryMessage(
                coalescingTarget.transportMessageId,
                coalescedMessage,
              );
            } catch (error) {
              const editError = asTransportError(error);
              const failedAt = this.now().toISOString();
              const safeMessage = redactText(editError.message, 1_000);
              this.reportDiagnostic({
                schema: "agent-relay-diagnostic.v1",
                diagnosticId: `diag_coalesce_edit_${sha256(
                  `${item.event.eventId}\u001f${String(item.attemptNumber)}`,
                ).slice(0, 36)}`,
                recordedAt: failedAt,
                source: "daemon",
                level: "warn",
                code: "notification.coalescing-edit-failed",
                message:
                  "coalesced card edit failed; the event will retry as a visible card",
              });
              throw new TransportError(
                safeMessage,
                "notification-coalescing-edit-failed",
                true,
                editError.status,
              );
            }
            const group = (() => {
              try {
                return this.store.markNotificationCoalesced({
                  event: item.event,
                  attemptNumber: item.attemptNumber,
                  anchorEventId: coalescingTarget.anchorEventId,
                  expectedEventCount: coalescingTarget.eventCount,
                  now: this.now().toISOString(),
                });
              } catch {
                const racedAt = this.now().toISOString();
                this.reportDiagnostic({
                  schema: "agent-relay-diagnostic.v1",
                  diagnosticId: `diag_coalesce_race_${sha256(
                    `${item.event.eventId}\u001f${String(item.attemptNumber)}`,
                  ).slice(0, 36)}`,
                  recordedAt: racedAt,
                  source: "daemon",
                  level: "warn",
                  code: "notification.coalescing-commit-raced",
                  message:
                    "coalescing anchor changed concurrently; the event will retry as a visible card",
                });
                throw new TransportError(
                  "coalescing anchor changed concurrently",
                  "notification-coalescing-commit-raced",
                  true,
                );
              }
            })();
            result.delivered += 1;
            this.logger.log({
              level: "info",
              code: "notification.coalesced",
              message:
                "equivalent routine notification coalesced into an existing card",
              at: this.now().toISOString(),
              details: {
                eventId: item.event.eventId,
                anchorEventId: group.anchorEventId,
                eventCount: group.eventCount,
              },
            });
            continue;
          }
        }
        const rendered = renderDeliveryMessage(item.event, {
          now: this.now(),
        });
        if (rendered.actions !== undefined) {
          this.store.registerCardActions(
            item.event.eventId,
            rendered.actions.map((action) => ({
              token: action.token,
              kind: action.kind,
            })),
            this.now().toISOString(),
          );
        }
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
        const deliveryContext = await this.deliveryContext(item.event);
        deliveryTopicId = deliveryContext.topicId;
        const receipt = await this.transport.deliver(message, deliveryContext);
        if (fingerprint === undefined) {
          this.store.markDelivered(
            item.event.eventId,
            item.attemptNumber,
            receipt.transport,
            receipt.messageId,
            this.now().toISOString(),
          );
        } else {
          this.store.markNotificationAnchorDelivered({
            event: item.event,
            attemptNumber: item.attemptNumber,
            fingerprint,
            transportName: receipt.transport,
            messageId: receipt.messageId,
            ...(deliveryContext.topicId === undefined
              ? {}
              : { topicId: deliveryContext.topicId }),
            now: this.now().toISOString(),
          });
        }
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
        if (
          error instanceof TopicUnavailableError &&
          deliveryTopicId !== undefined &&
          isTopicTransport(this.transport)
        ) {
          const reconciledAt = this.now().toISOString();
          const identity = this.sessionTopicIdentity(
            item.event,
            this.transport,
          );
          const safeMessage = redactText(transportError.message, 2_000);
          const reconciled = this.store.reconcileUnavailableSessionTopic({
            machineId: identity.machineId,
            harness: identity.harness,
            sessionId: identity.sessionId,
            transportName: identity.transportName,
            transportScope: identity.transportScope,
            topicId: deliveryTopicId,
            errorCode: transportError.code,
            errorMessage: safeMessage,
            now: reconciledAt,
          });
          this.reportDiagnostic({
            schema: "agent-relay-diagnostic.v1",
            diagnosticId: `diag_topic_reconcile_${sha256(
              [
                identity.machineId,
                identity.harness,
                identity.sessionId,
                identity.transportName,
                identity.transportScope,
                deliveryTopicId,
                item.event.eventId,
                String(item.attemptNumber),
              ].join("\u001f"),
            ).slice(0, 36)}`,
            recordedAt: reconciledAt,
            source: "daemon",
            level: "warn",
            code: "topic.reconciliation-required",
            message: `persisted session topic became unavailable: ${safeMessage}`,
          });
          this.logger.log({
            level: "warn",
            code: "topic.reconciliation-scheduled",
            message: "session topic mapping was invalidated for recreation",
            at: reconciledAt,
            details: {
              harness: reconciled.harness,
              repository: reconciled.repository,
              shortSessionId: reconciled.shortSessionId,
              transport: reconciled.transportName,
              unavailableTopicId: deliveryTopicId,
            },
          });
        }
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
