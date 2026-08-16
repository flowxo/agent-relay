import { randomUUID } from "node:crypto";

import type {
  AgentAttentionEventV1,
  InteractionQuestion,
  OperatorInteractionAnswerV1,
  RelayDiagnosticV1,
  RelayMcpAskV1,
  RelayMcpQuestionnaireV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
} from "@agent-relay/protocol";
import {
  AgentAttentionEventV1Schema,
  InteractionQuestionSchema,
  InteractionProviderObservationV1Schema,
  OperatorInteractionAnswerV1Schema,
  OperatorInteractionRequestV1Schema,
  RelayMcpAskV1Schema,
  RelayMcpQuestionnaireV1Schema,
  sha256,
} from "@agent-relay/protocol";
import type {
  CardActionKind,
  DeliveryContext,
  DeliveryMode,
  NotificationTransport,
  OperatorControlMessage,
  TopicNotificationTransport,
} from "@agent-relay/notification-contracts";
import {
  asTransportError,
  isInteractionCapabilityTransport,
  isInteractiveTransport,
  isOperatorControlTransport,
  isTopicDeletionTransport,
  isTopicEditingTransport,
  isTopicTransport,
  supportsDeliveryMode,
  TopicUnavailableError,
  TransportError,
} from "@agent-relay/notification-contracts";

import { negotiateInteraction } from "./notifications/interaction-negotiation.js";
import type { LogRecord, RelayLogger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import {
  renderDeliveryText,
  renderDeliveryInteraction,
  renderDeliveryMessage,
  renderMultiSelectDeliveryMessage,
  renderQuestionSetDeliveryMessage,
} from "./notifications/presentation.js";
import { cardActionToken } from "./notifications/action.js";
import { redactText } from "./redaction.js";
import type {
  DiagnosticIngestResult,
  BrowserRequestResponse,
  BrowserResolutionResult,
  BrowserSessionActionResult,
  IngestResult,
  McpBindingAuthority,
  McpSessionBindingMutationResult,
  McpSessionBindingRecord,
  PendingRequestRecord,
  RelayStore,
  RetentionResult,
  ResumeClaimResult,
  ResumeCommandRecord,
  ResolutionResult,
  RetryPolicy,
  ResolveRequestInput,
  SessionRecord,
  SessionTimelineRecord,
  TopicCleanupDecisionResult,
  TopicCleanupMode,
  TopicCleanupOperationRecord,
} from "./store.js";
import { DEFAULT_RETRY_POLICY } from "./store.js";
import { sessionPublicKey, sessionTopicMetadata } from "./topic.js";

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
  transportFailureLogIntervalMs?: number;
  interactionHandoff?: {
    baseUrl?: string;
    fallbackWhenTransportUnavailable?: boolean;
  };
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

export interface StaleBacklogQuarantineResult {
  enabled: boolean;
  maxAgeMs: number;
  quarantined: number;
  requestsExpired: number;
  cutoff?: string;
}

export type McpInteractionOpenResult =
  | {
      outcome: "opened" | "duplicate";
      request: PendingRequestRecord;
    }
  | {
      outcome:
        | "binding-missing"
        | "binding-pending"
        | "binding-ambiguous"
        | "binding-ended"
        | "binding-revoked"
        | "session-unavailable"
        | "request-conflict";
      binding?: McpSessionBindingRecord;
      request?: PendingRequestRecord;
    };

export type McpInteractionCancelResult =
  | ResolutionResult
  | {
      outcome:
        | "binding-missing"
        | "binding-pending"
        | "binding-ambiguous"
        | "binding-ended"
        | "binding-revoked"
        | "session-unavailable"
        | "request-not-owned";
      binding?: McpSessionBindingRecord;
      request?: PendingRequestRecord;
    };

export interface McpInteractionStatus {
  binding?: McpSessionBindingRecord;
  session?: SessionRecord;
  openRequestCount?: number;
  request?: PendingRequestRecord;
  answer?: OperatorInteractionAnswerV1;
  delivery: "available" | "degraded" | "unavailable";
}

export interface TopicCleanupDrainResult {
  supported: boolean;
  claimed: number;
  deleted: number;
  alreadyMissing: number;
  retrying: number;
  failed: number;
  skipped: number;
  completedOperations: number;
}

export interface TopicTitleDrainResult {
  supported: boolean;
  scheduled: number;
  claimed: number;
  updated: number;
  retrying: number;
  failed: number;
  unavailable: number;
}

export type BrowserSurfaceSyncResult =
  "updated" | "not-applicable" | "transport-unavailable" | "failed";

export type BrowserSessionCommandResult =
  | BrowserSessionActionResult
  | {
      outcome:
        | "session_not_found"
        | "event_not_found"
        | "identity_mismatch"
        | "stale_event"
        | "unavailable";
      replayed: false;
    };

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

function deliveryModeForEvent(event: AgentAttentionEventV1): DeliveryMode {
  switch (event.type) {
    case "session.started":
    case "turn.started":
    case "turn.activity":
    case "session.ended":
      return "silent";
    case "turn.stopped":
    case "turn.failed":
    case "input.required":
    case "permission.required":
    case "process.exited":
    case "process.stale":
      return "notify";
  }
}

export function transportDeliveryContext(
  event: AgentAttentionEventV1,
): DeliveryContext {
  const metadata = sessionTopicMetadata(event);
  return {
    idempotencyKey: event.eventId,
    deliveryMode: deliveryModeForEvent(event),
    source: {
      occurredAt: event.occurredAt,
      eventType: event.type,
      harness: event.harness,
      surface: event.surface,
      repository: metadata.repository,
      ...(metadata.branch === undefined ? {} : { branch: metadata.branch }),
      sessionKey: sessionPublicKey(event),
      shortSessionId: metadata.shortSessionId,
    },
  };
}

function safeLogRef(value: string): string {
  return sha256(value).slice(0, 12);
}

const MAX_STALE_BACKLOG_AGE_MS = 365 * 24 * 60 * 60_000;
const DEFAULT_TOPIC_CLEANUP_PREVIEW_TTL_MS = 10 * 60_000;
const DEFAULT_TOPIC_CLEANUP_PREVIEW_LIMIT = 20;
export const DEFAULT_TOPIC_PRUNE_INACTIVE_MS = 24 * 60 * 60_000;
export const MIN_TOPIC_PRUNE_INACTIVE_MS = 60 * 60_000;
export const MAX_TOPIC_PRUNE_INACTIVE_MS = 30 * 24 * 60 * 60_000;

function formatTopicInactivity(milliseconds: number): string {
  const hours = Math.max(1, Math.floor(milliseconds / (60 * 60_000)));
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${String(days)} day${days === 1 ? "" : "s"}`;
  }
  return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
}

function topicCleanupTitle(mode: TopicCleanupMode): string {
  return mode === "inactive"
    ? "Agent Relay inactive-topic purge"
    : "Agent Relay topic cleanup";
}

function topicCleanupCommand(mode: TopicCleanupMode): "/purge" | "/cleanup" {
  return mode === "inactive" ? "/purge" : "/cleanup";
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

export class RelayService {
  private readonly retryPolicy: RetryPolicy;
  private readonly logger: RelayLogger;
  private readonly now: () => Date;
  private readonly coalescingWindowMs: number;
  private readonly transportFailureLogIntervalMs: number;
  private readonly interactionHandoff:
    | {
        baseUrl?: string;
        fallbackWhenTransportUnavailable: boolean;
      }
    | undefined;
  private readonly transportFailureLogs = new Map<
    string,
    { loggedAt: number; suppressed: number }
  >();

  public constructor(
    public readonly store: RelayStore,
    public readonly transport: NotificationTransport,
    options: RelayServiceOptions = {},
  ) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.coalescingWindowMs = options.coalescingWindowMs ?? 60_000;
    this.transportFailureLogIntervalMs =
      options.transportFailureLogIntervalMs ?? 60_000;
    this.interactionHandoff =
      options.interactionHandoff === undefined
        ? undefined
        : {
            ...(options.interactionHandoff.baseUrl === undefined
              ? {}
              : {
                  baseUrl: trimTrailingSlashes(
                    options.interactionHandoff.baseUrl,
                  ),
                }),
            fallbackWhenTransportUnavailable:
              options.interactionHandoff.fallbackWhenTransportUnavailable ??
              false,
          };
    if (
      !Number.isSafeInteger(this.coalescingWindowMs) ||
      this.coalescingWindowMs < 0 ||
      this.coalescingWindowMs > 3_600_000
    ) {
      throw new Error(
        "notification coalescing window must be between 0 and 3600000 ms",
      );
    }
    if (
      !Number.isSafeInteger(this.transportFailureLogIntervalMs) ||
      this.transportFailureLogIntervalMs < 1_000 ||
      this.transportFailureLogIntervalMs > 60 * 60_000
    ) {
      throw new Error(
        "transport failure log interval must be between 1000 and 3600000 ms",
      );
    }
  }

  private logTransportFailure(record: LogRecord): void {
    const errorCode =
      record.details !== undefined &&
      typeof record.details["errorCode"] === "string"
        ? record.details["errorCode"]
        : undefined;
    if (
      this.transport.name !== "whooshbang" ||
      errorCode === undefined ||
      !errorCode.startsWith("whooshbang-")
    ) {
      this.logger.log(record);
      return;
    }
    const key = `${record.code}:${errorCode}`;
    const at = Date.parse(record.at);
    const prior = this.transportFailureLogs.get(key);
    if (
      prior !== undefined &&
      Number.isFinite(at) &&
      at - prior.loggedAt < this.transportFailureLogIntervalMs
    ) {
      prior.suppressed += 1;
      return;
    }
    const suppressed = prior?.suppressed ?? 0;
    this.transportFailureLogs.set(key, {
      loggedAt: Number.isFinite(at) ? at : this.now().getTime(),
      suppressed: 0,
    });
    this.logger.log({
      ...record,
      details: {
        ...record.details,
        ...(suppressed === 0 ? {} : { suppressedSinceLast: suppressed }),
      },
    });
  }

  public recover(): number {
    const now = this.now().toISOString();
    const recovered = this.store.recoverInterruptedDeliveries(now);
    const recoveredTopics = this.store.recoverInterruptedTopics(now);
    const recoveredTopicTitles =
      this.store.recoverInterruptedTopicTitleUpdates(now);
    const recoveredTopicCleanups =
      this.store.recoverInterruptedTopicCleanups(now);
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
    if (recoveredTopicCleanups > 0) {
      this.logger.log({
        level: "warn",
        code: "topic-cleanup.recovered",
        message: `recovered ${recoveredTopicCleanups} interrupted topic deletion attempts`,
        at: now,
        details: { recovered: recoveredTopicCleanups },
      });
    }
    if (recoveredTopicTitles > 0) {
      this.logger.log({
        level: "warn",
        code: "topic-title.recovered",
        message: `recovered ${recoveredTopicTitles} interrupted topic title update attempts`,
        at: now,
        details: { recovered: recoveredTopicTitles },
      });
    }
    return recovered;
  }

  public supportsTopicCleanup(): boolean {
    return (
      isTopicDeletionTransport(this.transport) &&
      isOperatorControlTransport(this.transport)
    );
  }

  public createTopicCleanupPreview(
    options: {
      ttlMs?: number;
      limit?: number;
      mode?: TopicCleanupMode;
      inactiveForMs?: number;
    } = {},
  ): TopicCleanupOperationRecord {
    if (
      !isTopicDeletionTransport(this.transport) ||
      !isOperatorControlTransport(this.transport)
    ) {
      throw new Error(
        "the active notification transport does not support topic cleanup",
      );
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TOPIC_CLEANUP_PREVIEW_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new Error(
        "topic cleanup preview ttl must be between 60000 and 3600000 ms",
      );
    }
    const now = this.now();
    const mode = options.mode ?? "proven-dead";
    let inactiveBefore: string | undefined;
    if (mode === "inactive") {
      const inactiveForMs =
        options.inactiveForMs ?? DEFAULT_TOPIC_PRUNE_INACTIVE_MS;
      if (
        !Number.isSafeInteger(inactiveForMs) ||
        inactiveForMs < MIN_TOPIC_PRUNE_INACTIVE_MS ||
        inactiveForMs > MAX_TOPIC_PRUNE_INACTIVE_MS
      ) {
        throw new Error(
          `topic prune inactivity must be between ${String(
            MIN_TOPIC_PRUNE_INACTIVE_MS,
          )} and ${String(MAX_TOPIC_PRUNE_INACTIVE_MS)} ms`,
        );
      }
      inactiveBefore = new Date(now.getTime() - inactiveForMs).toISOString();
    } else if (options.inactiveForMs !== undefined) {
      throw new Error(
        "proven-dead topic cleanup does not accept an inactivity duration",
      );
    }
    return this.store.createTopicCleanupPreview({
      operationId: `cleanup_${randomUUID().replaceAll("-", "")}`,
      transportName: this.transport.name,
      transportScope: this.transport.topicScope,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      mode,
      ...(inactiveBefore === undefined ? {} : { inactiveBefore }),
      limit: options.limit ?? DEFAULT_TOPIC_CLEANUP_PREVIEW_LIMIT,
    });
  }

  private renderTopicCleanupPreview(
    operation: TopicCleanupOperationRecord,
    confirmCallbackData: string,
    cancelCallbackData: string,
    pruneCallbackData?: string,
  ): OperatorControlMessage {
    const title = topicCleanupTitle(operation.mode);
    const threshold =
      operation.mode === "inactive" && operation.inactiveBefore !== undefined
        ? formatTopicInactivity(
            Date.parse(operation.createdAt) -
              Date.parse(operation.inactiveBefore),
          )
        : undefined;
    if (operation.candidates.length === 0) {
      if (operation.mode === "inactive") {
        return {
          text: `${title}\n\nNo safe session topics have been inactive for at least ${threshold ?? "the selected duration"}. Active sessions, open requests, running resumes, and pending deliveries are excluded.`,
          buttons: [],
        };
      }
      return {
        text: `${title}\n\nNo proven-dead session topics are ready for deletion. Only an explicit End action or native session-ended event qualifies.\n\nTo review inactive topics without marking their sessions ended, use /purge.`,
        buttons:
          pruneCallbackData === undefined
            ? []
            : [
                [
                  {
                    label: "Review topics inactive 24h",
                    callbackData: pruneCallbackData,
                  },
                ],
              ],
      };
    }
    const candidates = operation.candidates
      .map((candidate) => {
        const inactive =
          operation.mode === "inactive" &&
          candidate.lastActivityAt !== undefined
            ? ` · inactive ${formatTopicInactivity(
                Math.max(
                  0,
                  Date.parse(operation.createdAt) -
                    Date.parse(candidate.lastActivityAt),
                ),
              )}`
            : "";
        return `• ${candidate.harness} · ${redactText(
          candidate.repository,
          80,
        )} · ${redactText(candidate.shortSessionId, 24)}${inactive}`;
      })
      .join("\n");
    const remainder =
      operation.eligibleCount > operation.candidates.length
        ? `\n\n${String(
            operation.eligibleCount - operation.candidates.length,
          )} more eligible topic(s) will remain for a later ${topicCleanupCommand(
            operation.mode,
          )}.`
        : "";
    const expiryMinutes = Math.max(
      1,
      Math.ceil(
        (Date.parse(operation.expiresAt) - Date.parse(operation.createdAt)) /
          60_000,
      ),
    );
    const prompt =
      operation.mode === "inactive"
        ? `Purge ${String(
            operation.candidates.length,
          )} session topic(s) inactive for at least ${threshold ?? "the selected duration"}? Inactivity does not prove that a session ended. Your confirmation permanently removes each provider topic and its messages; a later event recreates a fresh topic.`
        : `Delete ${String(
            operation.candidates.length,
          )} proven-dead session topic(s)? This permanently removes each provider topic and its messages.`;
    return {
      text: `${title}\n\n${prompt}\n\n${candidates}${remainder}\n\nEligibility is rechecked immediately before every deletion. Confirmation expires in ${String(
        expiryMinutes,
      )} minute${expiryMinutes === 1 ? "" : "s"}.`,
      buttons: [
        [
          {
            label: `${
              operation.mode === "inactive" ? "Purge" : "Delete"
            } ${String(operation.candidates.length)} topic${
              operation.candidates.length === 1 ? "" : "s"
            }`,
            callbackData: confirmCallbackData,
          },
          { label: "Cancel", callbackData: cancelCallbackData },
        ],
      ],
    };
  }

  public async deliverTopicCleanupPreview(input: {
    operationId: string;
    confirmCallbackData: string;
    cancelCallbackData: string;
    pruneCallbackData?: string;
    topicId?: string;
  }): Promise<TopicCleanupOperationRecord> {
    if (!isOperatorControlTransport(this.transport)) {
      throw new Error(
        "the active notification transport cannot deliver cleanup controls",
      );
    }
    const operation = this.store.getTopicCleanupOperation(input.operationId);
    if (operation === undefined) {
      throw new Error("topic cleanup preview does not exist");
    }
    try {
      const receipt = await this.transport.deliverOperatorControl(
        this.renderTopicCleanupPreview(
          operation,
          input.confirmCallbackData,
          input.cancelCallbackData,
          input.pruneCallbackData,
        ),
        {
          idempotencyKey: `topic_cleanup_preview:${operation.operationId}`,
          ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
        },
      );
      const attached = this.store.attachTopicCleanupPreview({
        operationId: operation.operationId,
        messageId: receipt.messageId,
        now: this.now().toISOString(),
      });
      const superseded = this.store
        .listTopicCleanupOperations()
        .filter(
          (candidate) =>
            candidate.operationId !== operation.operationId &&
            candidate.state === "superseded" &&
            candidate.updatedAt === operation.createdAt,
        );
      for (const prior of superseded) {
        await this.syncTopicCleanupPresentation(prior);
      }
      return attached;
    } catch (error) {
      const transportError = asTransportError(error);
      const failedAt = this.now().toISOString();
      this.store.failTopicCleanupPreview({
        operationId: operation.operationId,
        errorCode: transportError.code,
        errorMessage: transportError.message,
        now: failedAt,
      });
      this.reportDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_topic_cleanup_preview_${sha256(
          operation.operationId,
        ).slice(0, 36)}`,
        recordedAt: failedAt,
        source: "daemon",
        level: "error",
        code: "topic-cleanup.preview-delivery-failed",
        message: `Topic cleanup preview delivery failed: ${transportError.code}`,
      });
      throw transportError;
    }
  }

  public decideTopicCleanup(input: {
    operationId: string;
    action: "confirm" | "cancel";
    messageId: string;
    updateId: number;
  }): TopicCleanupDecisionResult {
    const result = this.store.decideTopicCleanup({
      ...input,
      now: this.now().toISOString(),
    });
    this.logger.log({
      level:
        result.outcome === "claimed" || result.outcome === "cancelled"
          ? "info"
          : "warn",
      code: `topic-cleanup.decision-${result.outcome}`,
      message: `topic cleanup decision outcome: ${result.outcome}`,
      at: this.now().toISOString(),
      details: {
        operationRef: safeLogRef(input.operationId),
        action: input.action,
        updateId: input.updateId,
      },
    });
    return result;
  }

  private renderTopicCleanupStatus(
    operation: TopicCleanupOperationRecord,
  ): OperatorControlMessage {
    const title = topicCleanupTitle(operation.mode);
    const command = topicCleanupCommand(operation.mode);
    const counts = {
      deleted: operation.candidates.filter(
        (candidate) => candidate.state === "deleted",
      ).length,
      alreadyMissing: operation.candidates.filter(
        (candidate) => candidate.state === "already-missing",
      ).length,
      skipped: operation.candidates.filter(
        (candidate) => candidate.state === "skipped",
      ).length,
      failed: operation.candidates.filter(
        (candidate) => candidate.state === "failed",
      ).length,
      remaining: operation.candidates.filter((candidate) =>
        ["pending", "deleting", "retry"].includes(candidate.state),
      ).length,
    };
    const text = (() => {
      switch (operation.state) {
        case "claimed":
          return `${title}\n\nDeletion is running. ${String(
            counts.deleted + counts.alreadyMissing,
          )} removed, ${String(counts.skipped)} skipped after revalidation, ${String(
            counts.remaining,
          )} remaining.`;
        case "completed":
        case "completed-with-errors":
          return `${title} complete\n\n${String(
            counts.deleted,
          )} deleted, ${String(
            counts.alreadyMissing,
          )} already absent, ${String(counts.skipped)} skipped because session state changed, ${String(
            counts.failed,
          )} failed.${counts.failed > 0 ? `\n\nFailures were recorded for diagnosis. Run ${command} again after correcting them.` : ""}`;
        case "cancelled":
          return `${title}\n\nCanceled. No topics were deleted.`;
        case "expired":
          return `${title}\n\nConfirmation expired. No topics were deleted; run ${command} for a fresh preview.`;
        case "superseded":
          return `${title}\n\nThis preview was replaced by a newer topic-deletion request.`;
        case "preview-failed":
          return `${title}\n\nThe preview could not be delivered. The failure was recorded for diagnosis.`;
        case "previewed":
          return `${title}\n\nWaiting for confirmation.`;
      }
    })();
    return { text, buttons: [] };
  }

  public async syncTopicCleanupPresentation(
    operation: TopicCleanupOperationRecord,
  ): Promise<boolean> {
    if (
      operation.previewMessageId === undefined ||
      !isOperatorControlTransport(this.transport)
    ) {
      return false;
    }
    try {
      await this.transport.editOperatorControl(
        operation.previewMessageId,
        this.renderTopicCleanupStatus(operation),
      );
      return true;
    } catch (error) {
      const transportError = asTransportError(error);
      const failedAt = this.now().toISOString();
      this.reportDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_topic_cleanup_edit_${sha256(
          `${operation.operationId}\u001f${operation.state}`,
        ).slice(0, 36)}`,
        recordedAt: failedAt,
        source: "daemon",
        level: "error",
        code: "topic-cleanup.presentation-update-failed",
        message: `Topic cleanup status update failed: ${transportError.code}`,
      });
      return false;
    }
  }

  public async drainTopicCleanups(
    limit = 10,
  ): Promise<TopicCleanupDrainResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("topic cleanup drain limit must be between 1 and 100");
    }
    const result: TopicCleanupDrainResult = {
      supported: isTopicDeletionTransport(this.transport),
      claimed: 0,
      deleted: 0,
      alreadyMissing: 0,
      retrying: 0,
      failed: 0,
      skipped: 0,
      completedOperations: 0,
    };
    if (!isTopicDeletionTransport(this.transport)) {
      return result;
    }
    for (let index = 0; index < limit; index += 1) {
      const claim = this.store.claimNextTopicCleanupCandidate(
        this.now().toISOString(),
      );
      if (claim.outcome === "none") {
        break;
      }
      result.skipped += claim.skipped;
      if (claim.outcome === "terminal") {
        result.completedOperations += 1;
        await this.syncTopicCleanupPresentation(claim.operation);
        continue;
      }
      result.claimed += 1;
      try {
        const receipt = await this.transport.deleteTopic(
          claim.candidate.topicId,
          {
            idempotencyKey: `topic_cleanup:${claim.operation.operationId}:${sha256(
              claim.candidate.topicId,
            ).slice(0, 20)}`,
          },
        );
        const completion = this.store.completeTopicCleanupCandidate({
          operationId: claim.operation.operationId,
          topicId: claim.candidate.topicId,
          attemptNumber: claim.candidate.attemptCount,
          outcome: receipt.outcome,
          now: this.now().toISOString(),
        });
        if (receipt.outcome === "deleted") {
          result.deleted += 1;
        } else {
          result.alreadyMissing += 1;
        }
        if (completion.becameTerminal) {
          result.completedOperations += 1;
          await this.syncTopicCleanupPresentation(completion.operation);
        }
      } catch (error) {
        const transportError = asTransportError(error);
        const failedAt = this.now().toISOString();
        const completion = this.store.failTopicCleanupCandidate(
          {
            operationId: claim.operation.operationId,
            topicId: claim.candidate.topicId,
            attemptNumber: claim.candidate.attemptCount,
            errorCode: transportError.code,
            errorMessage: transportError.message,
            retryable: transportError.retryable,
            now: failedAt,
          },
          this.retryPolicy,
        );
        const candidate = completion.operation.candidates.find(
          (entry) => entry.topicId === claim.candidate.topicId,
        );
        if (candidate?.state === "retry") {
          result.retrying += 1;
        } else {
          result.failed += 1;
        }
        this.logger.log({
          level: candidate?.state === "retry" ? "warn" : "error",
          code:
            candidate?.state === "retry"
              ? "topic-cleanup.retry-scheduled"
              : "topic-cleanup.delete-failed",
          message: transportError.message,
          at: failedAt,
          details: {
            operationRef: safeLogRef(claim.operation.operationId),
            topicRef: safeLogRef(claim.candidate.topicId),
            errorCode: transportError.code,
            attemptNumber: claim.candidate.attemptCount,
            retryable: transportError.retryable,
          },
        });
        if (candidate?.state !== "retry") {
          this.reportDiagnostic({
            schema: "agent-relay-diagnostic.v1",
            diagnosticId: `diag_topic_cleanup_delete_${sha256(
              `${claim.operation.operationId}\u001f${claim.candidate.topicId}`,
            ).slice(0, 36)}`,
            recordedAt: failedAt,
            source: "daemon",
            level: "error",
            code: "topic-cleanup.delete-failed",
            message: `Topic deletion failed permanently: ${transportError.code}`,
          });
        }
        if (completion.becameTerminal) {
          result.completedOperations += 1;
          await this.syncTopicCleanupPresentation(completion.operation);
        }
      }
    }
    return result;
  }

  public async drainTopicTitleUpdates(
    limit = 25,
  ): Promise<TopicTitleDrainResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("topic title drain limit must be between 1 and 100");
    }
    const result: TopicTitleDrainResult = {
      supported: isTopicEditingTransport(this.transport),
      scheduled: 0,
      claimed: 0,
      updated: 0,
      retrying: 0,
      failed: 0,
      unavailable: 0,
    };
    if (!isTopicEditingTransport(this.transport)) {
      return result;
    }
    result.scheduled = this.store.reconcileSessionTopicTitles({
      transportName: this.transport.name,
      transportScope: this.transport.topicScope,
      now: this.now().toISOString(),
    });
    for (let index = 0; index < limit; index += 1) {
      const claim = this.store.claimNextSessionTopicTitleUpdate({
        transportName: this.transport.name,
        transportScope: this.transport.topicScope,
        now: this.now().toISOString(),
      });
      if (claim === undefined) {
        break;
      }
      result.claimed += 1;
      const { topic, attemptNumber } = claim;
      if (topic.topicId === undefined) {
        throw new Error("claimed topic title update is missing its topic id");
      }
      const idempotencyKey = `topic_title_${sha256(
        [
          topic.machineId,
          topic.harness,
          topic.sessionId,
          topic.transportName,
          topic.transportScope,
          topic.topicId,
          topic.desiredTopicName,
        ].join("\u001f"),
      ).slice(0, 40)}`;
      try {
        await this.transport.editTopic(
          topic.topicId,
          { name: topic.desiredTopicName },
          { idempotencyKey },
        );
        this.store.markSessionTopicTitleUpdated({
          machineId: topic.machineId,
          harness: topic.harness,
          sessionId: topic.sessionId,
          transportName: topic.transportName,
          transportScope: topic.transportScope,
          topicId: topic.topicId,
          desiredTopicName: topic.desiredTopicName,
          attemptNumber,
          now: this.now().toISOString(),
        });
        result.updated += 1;
        this.logger.log({
          level: "info",
          code: "topic-title.updated",
          message: "session topic title updated",
          at: this.now().toISOString(),
          details: {
            harness: topic.harness,
            repository: topic.repository,
            shortSessionId: topic.shortSessionId,
            transport: topic.transportName,
            topicId: topic.topicId,
          },
        });
      } catch (error) {
        const transportError = asTransportError(error);
        const failedAt = this.now().toISOString();
        if (error instanceof TopicUnavailableError) {
          this.store.reconcileUnavailableSessionTopic({
            machineId: topic.machineId,
            harness: topic.harness,
            sessionId: topic.sessionId,
            transportName: topic.transportName,
            transportScope: topic.transportScope,
            topicId: topic.topicId,
            errorCode: transportError.code,
            errorMessage: redactText(transportError.message, 2_000),
            now: failedAt,
          });
          result.unavailable += 1;
          this.reportDiagnostic({
            schema: "agent-relay-diagnostic.v1",
            diagnosticId: `diag_topic_title_unavailable_${sha256(
              `${topic.topicId}\u001f${String(attemptNumber)}`,
            ).slice(0, 36)}`,
            recordedAt: failedAt,
            source: "daemon",
            level: "warn",
            code: "topic-title.topic-unavailable",
            message:
              "Topic title update found a missing or closed topic; the durable mapping was reset",
          });
          continue;
        }
        const failed = this.store.markSessionTopicTitleFailed(
          {
            machineId: topic.machineId,
            harness: topic.harness,
            sessionId: topic.sessionId,
            transportName: topic.transportName,
            transportScope: topic.transportScope,
            topicId: topic.topicId,
            desiredTopicName: topic.desiredTopicName,
            attemptNumber,
            errorCode: transportError.code,
            errorMessage: redactText(transportError.message, 2_000),
            retryable: transportError.retryable,
            now: failedAt,
          },
          this.retryPolicy,
        );
        this.reportDiagnostic({
          schema: "agent-relay-diagnostic.v1",
          diagnosticId: `diag_topic_title_attempt_${sha256(
            `${topic.topicId}\u001f${topic.desiredTopicName}\u001f${String(
              attemptNumber,
            )}`,
          ).slice(0, 36)}`,
          recordedAt: failedAt,
          source: "daemon",
          level: failed.titleUpdateStatus === "retry" ? "warn" : "error",
          code:
            failed.titleUpdateStatus === "retry"
              ? "topic-title.update-retrying"
              : "topic-title.update-failed",
          message:
            failed.titleUpdateStatus === "retry"
              ? `Topic title update will retry: ${transportError.code}`
              : `Topic title update failed permanently: ${transportError.code}`,
        });
        if (failed.titleUpdateStatus === "retry") {
          result.retrying += 1;
        } else {
          result.failed += 1;
        }
        this.logger.log({
          level: failed.titleUpdateStatus === "retry" ? "warn" : "error",
          code:
            failed.titleUpdateStatus === "retry"
              ? "topic-title.retry-scheduled"
              : "topic-title.update-failed",
          message: transportError.message,
          at: failedAt,
          details: {
            errorCode: transportError.code,
            attemptNumber,
            retryable: transportError.retryable,
            shortSessionId: topic.shortSessionId,
          },
        });
      }
    }
    return result;
  }

  public quarantineStaleBacklog(
    maxAgeMs: number,
  ): StaleBacklogQuarantineResult {
    if (
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 0 ||
      maxAgeMs > MAX_STALE_BACKLOG_AGE_MS
    ) {
      throw new Error(
        `stale backlog max age must be a safe integer between 0 and ${String(
          MAX_STALE_BACKLOG_AGE_MS,
        )} ms`,
      );
    }
    if (maxAgeMs === 0) {
      return {
        enabled: false,
        maxAgeMs,
        quarantined: 0,
        requestsExpired: 0,
      };
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const requestsExpired = this.store.expireRequests(nowIso);
    const quarantined = this.store.quarantineStaleBacklog({
      cutoff,
      now: nowIso,
    });
    if (quarantined > 0) {
      this.logger.log({
        level: "warn",
        code: "delivery.stale-backlog-quarantined",
        message:
          "stale queued events were quarantined before transport delivery",
        at: nowIso,
        details: { quarantined, maxAgeMs, requestsExpired },
      });
      this.reportDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_stale_backlog_${sha256(
          `${cutoff}\u001f${nowIso}\u001f${String(quarantined)}`,
        ).slice(0, 36)}`,
        recordedAt: nowIso,
        source: "daemon",
        level: "warn",
        code: "delivery.stale-backlog-quarantined",
        message: `${String(
          quarantined,
        )} stale queued events were quarantined before transport delivery`,
      });
    }
    return {
      enabled: true,
      maxAgeMs,
      quarantined,
      requestsExpired,
      cutoff,
    };
  }

  public registerSession(session: SessionRegistrationV1): void {
    const receivedAt = this.now().toISOString();
    this.store.registerSession({ ...session, registeredAt: receivedAt });
    this.logger.log({
      level: "info",
      code: "session.registered",
      message: "session registered",
      at: receivedAt,
      details: {
        machineId: session.machineId,
        harness: session.harness,
        sessionId: session.sessionId,
      },
    });
  }

  public heartbeat(heartbeat: SessionHeartbeatV1): boolean {
    const receivedAt = this.now().toISOString();
    const updated = this.store.heartbeat({
      ...heartbeat,
      observedAt: receivedAt,
    });
    if (!updated) {
      this.logger.log({
        level: "warn",
        code: "heartbeat.unknown-session",
        message: "heartbeat did not match a registered session",
        at: receivedAt,
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
    const receivedAt = this.now().toISOString();
    const result = this.store.ingestEvent(event, receivedAt);
    this.logger.log({
      level: "info",
      code: result.inserted ? "event.ingested" : "event.duplicate",
      message: result.inserted
        ? "attention event queued"
        : "duplicate attention event ignored",
      at: receivedAt,
      details: {
        eventId: event.eventId,
        harness: event.harness,
        sessionId: event.sessionId,
        type: event.type,
      },
    });
    return result;
  }

  public registerMcpSessionBinding(input: {
    token: string;
    machineId: string;
    bridgeSessionId: string;
    harness: AgentAttentionEventV1["harness"];
  }): McpSessionBindingMutationResult {
    return this.store.registerMcpSessionBinding({
      ...input,
      now: this.now().toISOString(),
    });
  }

  public claimMcpSessionBinding(input: {
    token: string;
    machineId: string;
    bridgeSessionId: string;
    harness: AgentAttentionEventV1["harness"];
    sessionId: string;
  }): McpSessionBindingMutationResult {
    return this.store.claimMcpSessionBinding({
      ...input,
      now: this.now().toISOString(),
    });
  }

  public endMcpSessionBinding(input: {
    token: string;
    machineId: string;
    bridgeSessionId: string;
    harness: AgentAttentionEventV1["harness"];
    sessionId?: string;
  }): McpSessionBindingMutationResult {
    return this.store.endMcpSessionBinding({
      ...input,
      now: this.now().toISOString(),
    });
  }

  public mcpInteractionStatus(
    authority: McpBindingAuthority,
    requestId?: string,
  ): McpInteractionStatus {
    const checkedAt = this.now().toISOString();
    this.store.expireRequests(checkedAt);
    const binding =
      typeof authority === "string"
        ? this.store.verifyMcpSessionBinding(authority, checkedAt)
        : this.store.verifyMcpSessionBindingByNativeSession(
            authority,
            checkedAt,
          );
    if (binding?.state !== "bound" || binding.sessionId === undefined) {
      return {
        ...(binding === undefined ? {} : { binding }),
        delivery: binding === undefined ? "unavailable" : "degraded",
      };
    }
    const session = this.store.getSession({
      machineId: binding.machineId,
      harness: binding.harness,
      sessionId: binding.sessionId,
    });
    if (session === undefined) {
      return { binding, delivery: "unavailable" };
    }
    const request =
      requestId === undefined
        ? undefined
        : this.store.getPendingRequest(requestId);
    const ownedRequest =
      request !== undefined &&
      request.machineId === binding.machineId &&
      request.harness === binding.harness &&
      request.sessionId === binding.sessionId
        ? request
        : undefined;
    const storedEvent =
      ownedRequest === undefined
        ? undefined
        : this.store.getEvent(ownedRequest.eventId);
    const delivery =
      storedEvent === undefined
        ? requestId === undefined
          ? "available"
          : "degraded"
        : storedEvent.status === "delivered"
          ? "available"
          : storedEvent.status === "dead_letter"
            ? "unavailable"
            : "degraded";
    let answer: OperatorInteractionAnswerV1 | undefined;
    if (
      ownedRequest?.state === "answered" &&
      ownedRequest.answer !== undefined
    ) {
      try {
        answer = OperatorInteractionAnswerV1Schema.parse(
          JSON.parse(ownedRequest.answer) as unknown,
        );
      } catch {
        // A malformed retained answer is reported as an explicit MCP failure by
        // the adapter. It is never logged or echoed as untrusted text here.
      }
    }
    return {
      binding,
      session,
      openRequestCount: this.store.countOpenRequests(session),
      ...(ownedRequest === undefined ? {} : { request: ownedRequest }),
      ...(answer === undefined ? {} : { answer }),
      delivery,
    };
  }

  public openMcpInteraction(
    authority: McpBindingAuthority,
    input: RelayMcpAskV1 | RelayMcpQuestionnaireV1,
  ): McpInteractionOpenResult {
    input =
      input.schema === "agent-relay-mcp-ask.v1"
        ? RelayMcpAskV1Schema.parse(input)
        : RelayMcpQuestionnaireV1Schema.parse(input);
    const status = this.mcpInteractionStatus(authority);
    const binding = status.binding;
    if (binding === undefined) {
      return { outcome: "binding-missing" };
    }
    if (binding.state !== "bound") {
      return {
        outcome: `binding-${binding.state}` as Exclude<
          McpInteractionOpenResult["outcome"],
          "opened" | "duplicate" | "session-unavailable" | "request-conflict"
        >,
        binding,
      };
    }
    const session = status.session;
    if (session === undefined || binding.sessionId === undefined) {
      return { outcome: "session-unavailable", binding };
    }
    const questions: InteractionQuestion[] =
      input.schema === "agent-relay-mcp-ask.v1"
        ? [InteractionQuestionSchema.parse(input.question)]
        : input.questions.map((question) =>
            InteractionQuestionSchema.parse(question),
          );
    const existing = this.store.getPendingRequest(input.requestId);
    if (existing !== undefined) {
      const stored = this.store.getEvent(existing.eventId)?.event.request
        ?.interaction;
      const sameOwner =
        existing.machineId === binding.machineId &&
        existing.harness === binding.harness &&
        existing.sessionId === binding.sessionId;
      const samePayload =
        stored !== undefined &&
        stored.title === input.title &&
        JSON.stringify(stored.questions) === JSON.stringify(questions) &&
        Date.parse(stored.expiresAt) - Date.parse(stored.createdAt) ===
          input.expiresInMs;
      return sameOwner && samePayload
        ? { outcome: "duplicate", request: existing }
        : {
            outcome: "request-conflict",
            binding,
            ...(sameOwner ? { request: existing } : {}),
          };
    }

    const now = this.now().toISOString();
    const expiresAt = new Date(
      Date.parse(now) + input.expiresInMs,
    ).toISOString();
    const interaction = OperatorInteractionRequestV1Schema.parse({
      schema: "agent-interaction-request.v1",
      requestId: input.requestId,
      createdAt: now,
      expiresAt,
      title: input.title,
      lifecycle: "pending",
      questions,
      fallback: {
        preferredMode: "buttons",
        alternativeModes: ["numbered-text", "web-handoff"],
        whenUnavailable: "use-alternative",
      },
    });
    const eventId = `event_mcp_${sha256(input.requestId).slice(0, 32)}`;
    let sequence: number;
    try {
      sequence = this.store.allocateNativeHookSequence({
        machineId: binding.machineId,
        harness: binding.harness,
        sessionId: binding.sessionId,
        eventId,
        sourceFingerprint: sha256(
          `agent-relay-mcp-request:v1:${input.requestId}`,
        ),
        allocatedAt: now,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("native hook event identity")
      ) {
        return { outcome: "request-conflict", binding };
      }
      throw error;
    }
    const latest = this.store.getLatestEventForSession(session)?.event;
    const event = AgentAttentionEventV1Schema.parse({
      schema: "agent-attention.v1",
      eventId,
      occurredAt: now,
      sequence,
      machineId: session.machineId,
      bridgeSessionId: session.bridgeSessionId,
      harness: session.harness,
      surface: session.surface,
      harnessVersion: session.harnessVersion,
      sessionId: session.sessionId,
      ...(latest?.turnId === undefined ? {} : { turnId: latest.turnId }),
      project: session.project,
      type: "input.required",
      request: {
        correlationId: input.requestId,
        kind: "question-set",
        question: input.title,
        interaction,
        expiresAt,
      },
      capabilities: session.capabilities,
    });
    let ingested: IngestResult;
    try {
      ingested = this.store.ingestEvent(event, now);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("event id collision:")
      ) {
        const racedRequest = this.store.getPendingRequest(input.requestId);
        return {
          outcome: "request-conflict",
          binding,
          ...(racedRequest === undefined ? {} : { request: racedRequest }),
        };
      }
      throw error;
    }
    const request = this.store.getPendingRequest(input.requestId);
    if (request === undefined) {
      throw new Error("MCP interaction disappeared after durable ingestion");
    }
    this.logger.log({
      level: "info",
      code: ingested.inserted
        ? "mcp.interaction-opened"
        : "mcp.interaction-duplicate",
      message: ingested.inserted
        ? "typed MCP interaction queued"
        : "duplicate typed MCP interaction retained",
      at: now,
      details: {
        harness: session.harness,
        questionCount: questions.length,
      },
    });
    return {
      outcome: ingested.inserted ? "opened" : "duplicate",
      request,
    };
  }

  public cancelMcpInteraction(
    authority: McpBindingAuthority,
    requestId: string,
  ): McpInteractionCancelResult {
    const status = this.mcpInteractionStatus(authority, requestId);
    const binding = status.binding;
    if (binding === undefined) {
      return { outcome: "binding-missing" };
    }
    if (binding.state !== "bound") {
      return {
        outcome: `binding-${binding.state}` as Exclude<
          McpInteractionCancelResult["outcome"],
          | ResolutionResult["outcome"]
          | "session-unavailable"
          | "request-not-owned"
        >,
        binding,
      };
    }
    if (status.session === undefined) {
      return { outcome: "session-unavailable", binding };
    }
    if (status.request === undefined) {
      const existing = this.store.getPendingRequest(requestId);
      return existing === undefined
        ? { outcome: "not_found" }
        : { outcome: "request-not-owned", binding };
    }
    return this.store.cancelRequest(requestId, this.now().toISOString());
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
      topicCleanupBefore: before(
        retentionDays(options.telegramUpdateDays, 30, "telegramUpdateDays"),
      ),
      sessionBefore: before(
        retentionDays(options.sessionDays, 90, "sessionDays"),
      ),
      webChangeBefore: before(
        retentionDays(options.deliveredDays, 30, "deliveredDays"),
      ),
      browserCommandBefore: before(
        retentionDays(options.requestDays, 30, "requestDays"),
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

  public listPendingRequests(limit = 100): PendingRequestRecord[] {
    this.store.expireRequests(this.now().toISOString());
    return this.store.listPendingRequests(limit);
  }

  public listSessionsWithAttention(limit = 100) {
    const now = this.now().toISOString();
    this.store.expireRequests(now);
    return this.store.listSessions(limit, now).map((session) => ({
      session,
      laneState: this.store.getSessionLaneState(session),
      activity: session.activity,
      attentionCount: this.store.countOpenRequests(session),
    }));
  }

  public findSessionByWebKey(key: string): SessionRecord | undefined {
    if (!/^[a-f0-9]{24}$/.test(key)) {
      return undefined;
    }
    return this.store
      .listSessions(undefined, this.now().toISOString())
      .find((session) => sessionPublicKey(session) === key);
  }

  public listSessionTimeline(
    key: string,
    limit = 100,
  ): SessionTimelineRecord[] | undefined {
    const session = this.findSessionByWebKey(key);
    return session === undefined
      ? undefined
      : this.store.listSessionTimeline(session, limit);
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

  public resolveBrowser(input: {
    operationId: string;
    correlationId: string;
    response: BrowserRequestResponse;
  }): BrowserResolutionResult {
    const result = this.store.resolveBrowserRequest({
      ...input,
      now: this.now().toISOString(),
    });
    this.logger.log({
      level: result.outcome === "answered" ? "info" : "warn",
      code: `browser.request-${result.outcome}`,
      message: `browser request resolution: ${result.outcome}`,
      at: this.now().toISOString(),
      details: {
        operationId: input.operationId,
        correlationId: input.correlationId,
        replayed: result.replayed,
      },
    });
    return result;
  }

  public executeBrowserSessionAction(input: {
    operationId: string;
    sessionKey: string;
    eventId: string;
    action: Exclude<CardActionKind, "details">;
  }): BrowserSessionCommandResult {
    const session = this.findSessionByWebKey(input.sessionKey);
    if (session === undefined) {
      return { outcome: "session_not_found", replayed: false };
    }
    const eventRecord = this.store.getEvent(input.eventId);
    if (eventRecord === undefined) {
      return { outcome: "event_not_found", replayed: false };
    }
    const event = eventRecord.event;
    if (
      event.machineId !== session.machineId ||
      event.harness !== session.harness ||
      event.sessionId !== session.sessionId
    ) {
      return { outcome: "identity_mismatch", replayed: false };
    }
    const token = cardActionToken(event.eventId, input.action);
    const replay = this.store.replayBrowserCardAction({
      operationId: input.operationId,
      eventId: event.eventId,
      token,
      kind: input.action,
    });
    if (replay !== undefined) {
      return replay;
    }
    if (
      this.store.getLatestEventForSession(session)?.event.eventId !==
      event.eventId
    ) {
      return { outcome: "stale_event", replayed: false };
    }
    const rendered = renderDeliveryMessage(event, {
      now: this.now(),
      forceDetails: true,
    });
    const action = rendered.actions?.find(
      (candidate) => candidate.kind === input.action,
    );
    if (action === undefined) {
      return { outcome: "unavailable", replayed: false };
    }
    this.store.registerCardActions(
      event.eventId,
      rendered.actions?.map(({ token, kind }) => ({ token, kind })) ?? [],
      this.now().toISOString(),
    );
    const result = this.store.executeBrowserCardAction({
      operationId: input.operationId,
      eventId: event.eventId,
      token,
      kind: input.action,
      now: this.now().toISOString(),
    });
    this.logger.log({
      level: result.outcome === "succeeded" ? "info" : "warn",
      code: `browser.session-action-${result.outcome}`,
      message: `browser session action: ${result.outcome}`,
      at: this.now().toISOString(),
      details: {
        operationId: input.operationId,
        eventId: input.eventId,
        action: input.action,
        replayed: result.replayed,
      },
    });
    return result;
  }

  public async synchronizeBrowserResolution(
    result: BrowserResolutionResult,
  ): Promise<BrowserSurfaceSyncResult> {
    if (
      result.outcome !== "answered" ||
      result.replayed ||
      result.request === undefined
    ) {
      return "not-applicable";
    }
    const messageId = result.request.transportMessageId;
    const event = this.store.getEvent(result.request.eventId)?.event;
    if (
      messageId === undefined ||
      event === undefined ||
      !isInteractiveTransport(this.transport)
    ) {
      return "transport-unavailable";
    }
    const rendered = renderDeliveryMessage(event, {
      now: this.now(),
      resolutionState: "answered",
    });
    const selected = result.request.options.find(
      (option) => option.optionId === result.request?.answer,
    );
    try {
      await this.transport.editResolvedMessage(
        messageId,
        renderDeliveryText(
          selected === undefined
            ? rendered
            : {
                ...rendered,
                text: `${rendered.text}\n\nSelected: ${selected.label}`,
              },
        ),
      );
      return "updated";
    } catch (error) {
      const transportError = asTransportError(error);
      this.reportDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_web_resolution_sync_${sha256(
          `${result.request.correlationId}\u001f${transportError.code}`,
        ).slice(0, 36)}`,
        recordedAt: this.now().toISOString(),
        source: "daemon",
        level: "warn",
        code: "web.resolution-surface-sync-failed",
        message:
          "The browser answer committed, but the notification surface could not be updated",
      });
      return "failed";
    }
  }

  public async synchronizeBrowserSessionAction(
    result: BrowserSessionCommandResult,
  ): Promise<BrowserSurfaceSyncResult> {
    if (
      result.outcome !== "succeeded" ||
      result.replayed ||
      result.action === undefined
    ) {
      return "not-applicable";
    }
    if (result.action.kind === "continue") {
      const request = this.store.getPendingForEvent(result.action.eventId);
      return request === undefined
        ? "not-applicable"
        : await this.synchronizeBrowserResolution({
            outcome: "answered",
            replayed: false,
            request,
          });
    }
    const receipt = this.store.getDeliveryReceiptForEvent(
      result.action.eventId,
    );
    const event = this.store.getEvent(result.action.eventId)?.event;
    if (
      receipt === undefined ||
      receipt.transportName !== this.transport.name ||
      event === undefined ||
      !isInteractiveTransport(this.transport)
    ) {
      return "transport-unavailable";
    }
    const note =
      result.action.kind === "mute"
        ? "routine whooshbang muted; questions and critical failures remain active"
        : "relay lane ended; the harness process is unchanged";
    try {
      await this.transport.editResolvedMessage(
        receipt.messageId,
        `${renderDeliveryText(
          renderDeliveryMessage(event, { now: this.now() }),
        )}\n\nAgent Relay: ${note}.`,
      );
      return "updated";
    } catch (error) {
      const transportError = asTransportError(error);
      this.reportDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_web_control_sync_${sha256(
          `${result.action.token}\u001f${transportError.code}`,
        ).slice(0, 36)}`,
        recordedAt: this.now().toISOString(),
        source: "daemon",
        level: "warn",
        code: "web.session-action-surface-sync-failed",
        message:
          "The browser session action committed, but the notification surface could not be updated",
      });
      return "failed";
    }
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
    pending?: PendingRequestRecord,
  ): Promise<DeliveryContext> {
    const context: DeliveryContext = {
      ...transportDeliveryContext(event),
      ...(pending === undefined ||
      this.interactionHandoff?.baseUrl === undefined
        ? {}
        : {
            handoff: {
              mode: "local-web",
              requestId: pending.correlationId,
              expiresAt: pending.expiresAt,
              url: `${this.interactionHandoff.baseUrl}/ui/?request=${encodeURIComponent(
                pending.correlationId,
              )}`,
            },
          }),
    };
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
    if (
      claim.outcome === "busy" ||
      claim.outcome === "deleting" ||
      claim.outcome === "deferred"
    ) {
      throw new TransportError(
        claim.outcome === "busy"
          ? "session topic creation is already in progress"
          : claim.outcome === "deleting"
            ? "session topic deletion is already in progress"
            : "session topic creation is waiting for its retry deadline",
        claim.outcome === "deleting"
          ? "topic-deletion-busy"
          : `topic-provisioning-${claim.outcome}`,
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
          { name: claim.topic.desiredTopicName },
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
          displayTopicName: claim.topic.desiredTopicName,
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
        const suppressionReason = this.store.suppressionReason(item.event, {
          allowBackgroundWorkDelivery: supportsDeliveryMode(
            this.transport,
            "silent",
          ),
        });
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
            message: "routine notification suppressed by delivery policy",
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
        if (
          pending !== undefined &&
          pending.requestKind !== "question-set" &&
          !item.event.capabilities.inlineContinue &&
          !item.event.capabilities.lateResume
        ) {
          const diagnosedAt = this.now().toISOString();
          this.reportDiagnostic({
            schema: "agent-relay-diagnostic.v1",
            diagnosticId: `diag_interaction_harness_unsupported_${sha256(
              item.event.eventId,
            ).slice(0, 36)}`,
            recordedAt: diagnosedAt,
            source: "daemon",
            level: "error",
            code: "interaction.harness-continuation-unsupported",
            message:
              "Operator input was not delivered because the harness cannot continue this session",
          });
          throw new TransportError(
            "operator input is unsupported because the harness cannot continue this session",
            "interaction-harness-continuation-unsupported",
            false,
          );
        }
        if (
          pending?.requestKind === "permission" &&
          !item.event.capabilities.permissionDecision
        ) {
          const diagnosedAt = this.now().toISOString();
          this.reportDiagnostic({
            schema: "agent-relay-diagnostic.v1",
            diagnosticId: `diag_interaction_permission_unsupported_${sha256(
              item.event.eventId,
            ).slice(0, 36)}`,
            recordedAt: diagnosedAt,
            source: "daemon",
            level: "error",
            code: "interaction.harness-permission-unsupported",
            message:
              "Permission controls were not delivered because the harness cannot apply the decision",
          });
          throw new TransportError(
            "permission controls are unsupported for this harness session",
            "interaction-harness-permission-unsupported",
            false,
          );
        }
        const multiSelectDraft =
          pending?.requestKind === "multi-select"
            ? this.store.getMultiSelectDraft(pending.correlationId)
            : undefined;
        let questionSetDraft =
          pending?.requestKind === "question-set"
            ? this.store.getQuestionSetDraft(pending.correlationId)
            : undefined;
        let questionSetAlertOnly = false;
        if (
          pending?.requestKind === "multi-select" &&
          multiSelectDraft === undefined
        ) {
          throw new Error(
            `multi-select draft ${pending.correlationId} disappeared`,
          );
        }
        if (
          pending?.requestKind === "question-set" &&
          questionSetDraft === undefined
        ) {
          throw new Error(
            `question-set draft ${pending.correlationId} disappeared`,
          );
        }
        if (
          pending?.requestKind === "question-set" &&
          questionSetDraft !== undefined
        ) {
          const interaction = item.event.request?.interaction;
          if (interaction === undefined) {
            throw new TransportError(
              "validated question-set request lost its interaction contract",
              "interaction-contract-missing",
              false,
            );
          }
          const observedAt = this.now().toISOString();
          const transportObservation = isInteractionCapabilityTransport(
            this.transport,
          )
            ? InteractionProviderObservationV1Schema.safeParse(
                this.transport.observeInteractionCapabilities(observedAt),
              )
            : undefined;
          if (
            transportObservation !== undefined &&
            !transportObservation.success
          ) {
            this.reportDiagnostic({
              schema: "agent-relay-diagnostic.v1",
              diagnosticId: `diag_interaction_capability_invalid_${sha256(
                item.event.eventId,
              ).slice(0, 36)}`,
              recordedAt: observedAt,
              source: "daemon",
              level: "error",
              code: "interaction.capability-record-invalid",
              message:
                "Notification transport returned an invalid interaction capability record",
            });
            throw new TransportError(
              "notification transport returned an invalid interaction capability record",
              "interaction-capability-record-invalid",
              false,
            );
          }
          const negotiation = negotiateInteraction({
            request: interaction,
            event: item.event,
            ...(transportObservation?.success === true
              ? { transport: transportObservation.data }
              : {}),
          });
          if (
            negotiation.outcome === "unsupported" &&
            this.interactionHandoff?.fallbackWhenTransportUnavailable ===
              true &&
            (negotiation.code === "transport-capabilities-unavailable" ||
              negotiation.code === "interaction-mode-unavailable")
          ) {
            if (this.interactionHandoff.baseUrl === undefined) {
              questionSetAlertOnly = true;
            } else {
              questionSetDraft = this.store.setQuestionSetPresentationMode(
                pending.correlationId,
                "web-handoff",
                observedAt,
              );
            }
            this.reportDiagnostic({
              schema: "agent-relay-diagnostic.v1",
              diagnosticId: `diag_interaction_web_handoff_${sha256(
                item.event.eventId,
              ).slice(0, 36)}`,
              recordedAt: observedAt,
              source: "daemon",
              level: "warn",
              code:
                this.interactionHandoff.baseUrl === undefined
                  ? "interaction.alert-only-selected"
                  : "interaction.web-handoff-selected",
              message:
                this.interactionHandoff.baseUrl === undefined
                  ? "Structured controls are unavailable in the selected notification transport; an alert was delivered without response controls because the local web companion is disabled"
                  : "Structured controls are unavailable in the selected notification transport; the local web companion remains authoritative for this request",
            });
          } else if (negotiation.outcome === "unsupported") {
            this.reportDiagnostic({
              schema: "agent-relay-diagnostic.v1",
              diagnosticId: `diag_interaction_unsupported_${sha256(
                `${item.event.eventId}\u001f${negotiation.code}`,
              ).slice(0, 36)}`,
              recordedAt: observedAt,
              source: "daemon",
              level: "error",
              code: `interaction.${negotiation.code}`,
              message: `Structured interaction was not delivered: ${negotiation.reason}`,
            });
            throw new TransportError(
              `structured interaction is unsupported: ${negotiation.reason}`,
              `interaction-${negotiation.code}`,
              false,
            );
          } else {
            questionSetDraft = this.store.setQuestionSetPresentationMode(
              pending.correlationId,
              negotiation.mode,
              observedAt,
            );
            this.logger.log({
              level: "info",
              code: "interaction.mode-selected",
              message: "structured interaction presentation mode selected",
              at: observedAt,
              details: {
                eventId: item.event.eventId,
                mode: negotiation.mode,
                transportProviderId: negotiation.transportProviderId,
                harnessProviderId: negotiation.harnessProviderId,
              },
            });
          }
        }
        const deliveryInteraction =
          pending === undefined
            ? undefined
            : renderDeliveryInteraction(item.event, pending);
        const message =
          pending !== undefined &&
          questionSetDraft !== undefined &&
          !questionSetAlertOnly
            ? renderQuestionSetDeliveryMessage(
                item.event,
                pending,
                questionSetDraft,
                { now: this.now() },
              )
            : pending !== undefined && multiSelectDraft !== undefined
              ? renderMultiSelectDeliveryMessage(
                  item.event,
                  pending,
                  multiSelectDraft,
                  { now: this.now() },
                )
              : pending === undefined
                ? rendered
                : {
                    ...rendered,
                    ...(deliveryInteraction === undefined
                      ? {}
                      : { interaction: deliveryInteraction }),
                  };
        const deliveryContext = await this.deliveryContext(item.event, pending);
        deliveryTopicId = deliveryContext.topicId;
        const receipt = await this.transport.deliver(message, deliveryContext);
        if (fingerprint === undefined) {
          this.store.markDelivered(
            item.event.eventId,
            item.attemptNumber,
            receipt.transport,
            receipt.messageId,
            this.now().toISOString(),
            receipt.hostedInteraction,
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
            eventRef: safeLogRef(item.event.eventId),
            transport: receipt.transport,
            messageRef: safeLogRef(
              `${receipt.transport}\u001f${receipt.messageId}`,
            ),
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
          transportError.retryAfterMs,
        );
        if (status === "retry") {
          result.retrying += 1;
        } else {
          result.deadLettered += 1;
        }
        this.logTransportFailure({
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
