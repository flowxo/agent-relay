import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { z } from "zod";

import {
  AgentAttentionEventV1Schema,
  encodeInteractionAnswer,
  HarnessSchema,
  InteractionPresentationModeSchema,
  InteractionQuestionAnswerSchema,
  ProjectRefSchema,
  RelayDiagnosticV1Schema,
  SessionHeartbeatV1Schema,
  SessionRegistrationV1Schema,
  sha256,
  validateInteractionAnswer,
} from "@agent-relay/protocol";
import type {
  AgentAttentionEventV1,
  EventType,
  Harness,
  InteractionPresentationMode,
  InteractionQuestion,
  InteractionQuestionAnswer,
  OperatorInteractionRequestV1,
  RelayDiagnosticV1,
  SessionHeartbeatV1,
  SessionRegistrationV1,
  Surface,
} from "@agent-relay/protocol";
import {
  CardActionKindSchema,
  CardActionTokenSchema,
  type CardActionKind,
} from "@agent-relay/notification-contracts";

import { sessionTopicDisplayName } from "./topic.js";

export type DeliveryStatus =
  "queued" | "retry" | "delivering" | "delivered" | "dead_letter";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export const RELAY_STORE_SCHEMA_VERSION = 9;

// Schema 7 renamed the hosted transport identity from `notifications` to
// `whooshbang`. These columns retain that value, so an existing database is
// rewritten forward once instead of losing its hosted rows.
const HOSTED_TRANSPORT_IDENTITY_COLUMNS = [
  ["session_topics", "transport_name"],
  ["events", "transport_name"],
  ["topic_cleanup_operations", "transport_name"],
  ["notification_groups", "transport_name"],
  ["hosted_delivery_mappings", "transport_name"],
  ["pending_requests", "resolved_by"],
] as const;

const NativeHookSequenceAllocationInputSchema = z
  .object({
    machineId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    harness: HarnessSchema,
    sessionId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    eventId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    allocatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type NativeHookSequenceAllocationInput = z.infer<
  typeof NativeHookSequenceAllocationInputSchema
>;

export interface SessionProductOwnershipClaim {
  adoptionId: string;
  requestFingerprint: string;
  machineId: string;
  harness: "codex";
  surface: "cli";
  sessionId: string;
  bridgeSessionId: string;
  expectedSequence: number;
  projectAuthorityDigest: string;
  capabilityDigest: string;
  harnessVersion: string;
  productSessionId: string;
  claimedAt: string;
}

export interface SessionProductOwnershipReceipt {
  adoptionId: string;
  requestFingerprint: string;
  machineId: string;
  harness: "codex";
  sessionId: string;
  productSessionId: string;
  claimedAt: string;
}

export type SessionProductOwnershipResult =
  | {
      outcome: "claimed" | "duplicate";
      receipt: SessionProductOwnershipReceipt;
    }
  | { outcome: "rejected"; safeCode: string };

function boundedOwnershipIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

export interface IngestResult {
  eventId: string;
  inserted: boolean;
  status: DeliveryStatus;
}

export interface StaleBacklogQuarantineInput {
  cutoff: string;
  now: string;
}

export interface ClaimedEvent {
  event: AgentAttentionEventV1;
  attemptNumber: number;
}

export interface SessionRecord {
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  surface: Surface;
  harnessVersion: string;
  sessionId: string;
  project: AgentAttentionEventV1["project"];
  state: "active" | "waiting" | "stopped" | "suspected_stalled" | "exited";
  lastEventType?: EventType;
  lastSeenAt: string;
  lastSequence: number;
}

export interface SessionAdoptionCandidateCheckpoint {
  readonly machineId: string;
  readonly bridgeSessionId: string;
  readonly harness: "codex";
  readonly surface: "cli";
  readonly harnessVersion: string;
  readonly nativeSessionReference: string;
  readonly expectedSequence: number;
  readonly projectName: string;
  readonly projectCwdHash: string;
  readonly projectAuthorityDigest: string;
  readonly standaloneCapabilityDigest: string;
  readonly state: "active" | "waiting";
  readonly lastSeenAt: string;
}

export type SessionLaneState =
  "running" | "waiting" | "muted" | "crashed" | "ended" | "stale";

export type TopicProvisioningStatus =
  "pending" | "creating" | "ready" | "retry" | "failed";

export type TopicTitleUpdateStatus =
  "ready" | "pending" | "updating" | "retry" | "failed";

export interface SessionTopicRecord {
  machineId: string;
  harness: Harness;
  sessionId: string;
  transportName: string;
  transportScope: string;
  provider: Harness;
  repository: string;
  branch?: string;
  shortSessionId: string;
  lifecycleState: SessionRecord["state"];
  laneState: SessionLaneState;
  topicName: string;
  displayTopicName?: string;
  desiredTopicName: string;
  topicId?: string;
  provisioningStatus: TopicProvisioningStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  titleUpdateStatus: TopicTitleUpdateStatus;
  titleAttemptCount: number;
  titleNextAttemptAt: string;
  titleLastErrorCode?: string;
  titleLastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedTopicTitleUpdate {
  topic: SessionTopicRecord;
  attemptNumber: number;
}

export interface CardActionRecord {
  token: string;
  eventId: string;
  kind: CardActionKind;
  createdAt: string;
  state: "open" | "claimed" | "succeeded" | "failed";
  updateId?: number;
  claimedAt?: string;
  finishedAt?: string;
  outcome?: string;
  errorMessage?: string;
}

export interface NotificationGroupRecord {
  anchorEventId: string;
  eventCount: number;
  latestOccurredAt: string;
  transportName: string;
  transportMessageId: string;
  topicId?: string;
}

export interface NotificationDetails {
  events: AgentAttentionEventV1[];
  totalCount: number;
}

export interface SessionControlRecord {
  machineId: string;
  harness: Harness;
  sessionId: string;
  mutedAt?: string;
  endedAt?: string;
  updatedAt: string;
}

export type TopicCleanupCandidateState =
  | "pending"
  | "deleting"
  | "retry"
  | "deleted"
  | "already-missing"
  | "skipped"
  | "failed";

export type TopicCleanupMode = "proven-dead" | "inactive";

export interface TopicCleanupCandidateRecord {
  machineId: string;
  harness: Harness;
  sessionId: string;
  topicId: string;
  repository: string;
  shortSessionId: string;
  lastActivityAt?: string;
  state: TopicCleanupCandidateState;
  attemptCount: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
}

export type TopicCleanupOperationState =
  | "previewed"
  | "claimed"
  | "completed"
  | "completed-with-errors"
  | "cancelled"
  | "expired"
  | "superseded"
  | "preview-failed";

export interface TopicCleanupOperationRecord {
  operationId: string;
  transportName: string;
  transportScope: string;
  mode: TopicCleanupMode;
  inactiveBefore?: string;
  state: TopicCleanupOperationState;
  eligibleCount: number;
  candidates: TopicCleanupCandidateRecord[];
  previewMessageId?: string;
  decisionUpdateId?: number;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  lastErrorCode?: string;
}

export type TopicCleanupDecisionResult =
  | {
      outcome: "claimed" | "cancelled" | "duplicate";
      operation: TopicCleanupOperationRecord;
    }
  | {
      outcome: "not-found" | "message-mismatch" | "expired" | "not-ready";
      operation?: TopicCleanupOperationRecord;
    };

export type TopicCleanupClaimResult =
  | {
      outcome: "claimed";
      operation: TopicCleanupOperationRecord;
      candidate: TopicCleanupCandidateRecord;
      skipped: number;
    }
  | {
      outcome: "terminal";
      operation: TopicCleanupOperationRecord;
      skipped: number;
    }
  | { outcome: "none" };

export interface TopicCleanupCompletionResult {
  operation: TopicCleanupOperationRecord;
  becameTerminal: boolean;
}

export type CardActionExecutionResult =
  | { outcome: "not_found" | "kind_mismatch"; action?: CardActionRecord }
  | { outcome: "blocked"; action: CardActionRecord; reason: string }
  | {
      outcome: "claimed" | "succeeded" | "duplicate" | "stale";
      action: CardActionRecord;
    };

export type BrowserSessionActionOutcome =
  CardActionExecutionResult["outcome"] | "replay_conflict";

export interface BrowserSessionActionResult {
  outcome: BrowserSessionActionOutcome;
  replayed: boolean;
  action?: CardActionRecord;
  reason?: string;
}

export interface ClaimSessionTopicInput {
  machineId: string;
  harness: Harness;
  sessionId: string;
  transportName: string;
  transportScope: string;
  provider: Harness;
  repository: string;
  branch?: string;
  shortSessionId: string;
  lifecycleState: SessionRecord["state"];
  topicName: string;
  now: string;
}

export type SessionTopicClaimResult =
  | { outcome: "ready"; topic: SessionTopicRecord }
  | {
      outcome: "claimed";
      topic: SessionTopicRecord;
      attemptNumber: number;
    }
  | { outcome: "busy"; topic: SessionTopicRecord }
  | { outcome: "deleting"; topic: SessionTopicRecord }
  | { outcome: "deferred"; topic: SessionTopicRecord }
  | { outcome: "failed"; topic: SessionTopicRecord };

export interface StoreStatus {
  events: Record<DeliveryStatus, number>;
  eventActivity: {
    inserted: number;
    deleted: number;
  };
  sessions: Record<SessionRecord["state"], number>;
  topics: Record<TopicProvisioningStatus, number>;
  topicCleanups: Record<TopicCleanupOperationState, number>;
  resumeCommands: Record<ResumeCommandState, number>;
  diagnostics: Record<RelayDiagnosticV1["level"], number> & { total: number };
  pendingDeliveryCount: number;
}

export interface TransportDeliverySummary {
  lastError?: {
    at: string;
    code: string;
  };
  lastSuccessfulSendAt?: string;
}

export type HostedInteractionType = "confirm" | "select" | "input";
export type HostedAcknowledgementDisposition = "processed" | "quarantined";
export type HostedClaimOutcome =
  "answered" | "duplicate" | "terminal" | "quarantined" | "stopped";

export interface HostedDeliveryRecord {
  eventId: string;
  messageId: string;
  interactionId: string;
  interactionType: HostedInteractionType;
  request: PendingRequestRecord;
  event: AgentAttentionEventV1;
}

export interface HostedResolution {
  correlationId: string;
  answer: string;
  resolvedBy: "whooshbang";
  now: string;
  expected: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    turnId?: string;
  };
}

export interface RecordHostedClaimInput {
  streamKey: string;
  eventId: string;
  cursor: string;
  payloadHash: string;
  messageId: string;
  interactionId: string;
  occurredAt: string;
  handledAt: string;
  validation:
    | {
        outcome: "ready";
        acknowledgement: "processed";
        resolution: HostedResolution;
      }
    | {
        outcome: "duplicate" | "terminal";
        acknowledgement: "processed";
        reasonCode: string;
      }
    | {
        outcome: "quarantine";
        acknowledgement: "quarantined";
        reasonCode: string;
      }
    | {
        outcome: "stop";
        acknowledgement: "none";
        reasonCode: string;
      };
}

export interface HostedClaimRecord {
  streamKey: string;
  eventId: string;
  cursor: string;
  payloadHash: string;
  messageId: string;
  interactionId: string;
  outcome: HostedClaimOutcome;
  disposition?: HostedAcknowledgementDisposition;
  reasonCode?: string;
  replayed: boolean;
  handledAt: string;
}

export interface HostedAcknowledgementRecord {
  streamKey: string;
  eventId: string;
  cursor: string;
  disposition: HostedAcknowledgementDisposition;
  reasonCode?: string;
  state: "pending" | "acknowledging" | "retry" | "acknowledged" | "blocked";
  attemptCount: number;
  nextAttemptAt: string;
}

export type HostedPresentationOutcome =
  "answered" | "duplicate" | "expired" | "cancelled" | "unsupported";

export interface HostedMessageUpdateRecord {
  streamKey: string;
  eventId: string;
  messageId: string;
  interactionId: string;
  outcome: HostedPresentationOutcome;
  resolutionSource?: PendingRequestRecord["resolvedBy"];
  reasonCode?: string;
  state: "pending" | "updating" | "retry" | "updated" | "blocked";
  attemptCount: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
}

export interface HostedMessageUpdateSummary {
  pending: number;
  updating: number;
  retry: number;
  updated: number;
  blocked: number;
  lastError?: { at: string; code: string };
}

export interface HostedPollStatus {
  committedCursor?: string;
  lastSuccessfulPollAt?: string;
  lastError?: { at: string; code: string };
  unacknowledgedEventCount: number;
  messageUpdates: HostedMessageUpdateSummary;
}

export interface DiagnosticIngestResult {
  diagnosticId: string;
  inserted: boolean;
}

export interface RetentionCutoffs {
  deliveredBefore: string;
  deadLetterBefore: string;
  requestBefore: string;
  diagnosticBefore: string;
  telegramUpdateBefore: string;
  topicCleanupBefore: string;
  sessionBefore: string;
  webChangeBefore: string;
  browserCommandBefore: string;
  limit?: number;
}

export interface RetentionResult {
  requestsExpired: number;
  pendingRequests: number;
  interactionDrafts: number;
  questionSetDrafts: number;
  resumeCommands: number;
  events: number;
  deliveryAttempts: number;
  diagnostics: number;
  telegramUpdates: number;
  topicCleanupOperations: number;
  nativeHookSequenceAllocations: number;
  nativeHookSequenceCounters: number;
  sessions: number;
  webChanges: number;
  browserCommands: number;
}

export type WebChangeKind =
  "session" | "event" | "request" | "diagnostic" | "session-control";

export interface WebChangeRecord {
  cursor: number;
  kind: WebChangeKind;
  action: "insert" | "update" | "delete";
  entityId: string;
  sessionId?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface WebChangeBounds {
  firstCursor?: number;
  lastCursor?: number;
}

export type SessionTimelineKind =
  "hook-event" | "delivery" | "request" | "operator-action" | "continuation";

export interface SessionTimelineRecord {
  id: string;
  kind: SessionTimelineKind;
  at: string;
  status: string;
  label: string;
  eventId?: string;
  correlationId?: string;
  detailCode?: string;
}

export type PendingRequestState =
  "open" | "answered" | "expired" | "cancelled" | "failed";

export interface PendingOption {
  token: string;
  optionId: string;
  label: string;
}

export interface PendingRequestRecord {
  correlationId: string;
  eventId: string;
  machineId: string;
  harness: Harness;
  sessionId: string;
  turnId?: string;
  state: PendingRequestState;
  requestKind:
    | "confirm"
    | "select"
    | "multi-select"
    | "question-set"
    | "input"
    | "permission"
    | "continuation";
  question: string;
  expiresAt: string;
  resolvedBy?: "terminal" | "telegram" | "web" | "whooshbang";
  answer?: string;
  resolvedAt?: string;
  transportMessageId?: string;
  options: PendingOption[];
}

export type MultiSelectDraftState =
  | "pending"
  | "drafting"
  | "submitted"
  | "cancelled"
  | "expired"
  | "superseded"
  | "failed";

export interface MultiSelectDraftRecord {
  correlationId: string;
  state: MultiSelectDraftState;
  minSelections: number;
  maxSelections: number;
  submitToken: string;
  cancelToken: string;
  revision: number;
  selectedOptionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type MultiSelectDraftMutationResult =
  | {
      outcome: "updated" | "unchanged";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "selection_limit" | "stale" | "failed";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "expired";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "identity_mismatch";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "not_found";
      request?: PendingRequestRecord;
      draft?: MultiSelectDraftRecord;
    };

export type MultiSelectSubmitResult =
  | {
      outcome: "answered" | "cancelled";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome:
        "invalid_selection" | "duplicate" | "expired" | "stale" | "failed";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "identity_mismatch";
      request: PendingRequestRecord;
      draft: MultiSelectDraftRecord;
    }
  | {
      outcome: "not_found";
      request?: PendingRequestRecord;
      draft?: MultiSelectDraftRecord;
    };

export type QuestionSetDraftState =
  | "pending"
  | "drafting"
  | "submitted"
  | "cancelled"
  | "expired"
  | "superseded"
  | "failed";

export interface QuestionSetDraftRecord {
  correlationId: string;
  state: QuestionSetDraftState;
  currentIndex: number;
  revision: number;
  presentationMode?: InteractionPresentationMode;
  submitToken: string;
  cancelToken: string;
  backToken?: string;
  nextToken?: string;
  interaction: OperatorInteractionRequestV1;
  answers: InteractionQuestionAnswer[];
  createdAt: string;
  updatedAt: string;
}

export type QuestionSetMutationResult =
  | {
      outcome: "updated" | "unchanged" | "moved" | "cancelled" | "answered";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome:
        | "incomplete"
        | "invalid_transition"
        | "selection_limit"
        | "duplicate"
        | "expired"
        | "stale"
        | "failed"
        | "unsupported_question";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome: "identity_mismatch";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome: "not_found";
      request?: PendingRequestRecord;
      draft?: QuestionSetDraftRecord;
    };

export type QuestionSetTextRejectionReason =
  "empty" | "too_short" | "too_long" | "multiline";

export type QuestionSetTextMutationResult =
  | {
      outcome: "updated" | "unchanged";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome: "invalid_text";
      reason: QuestionSetTextRejectionReason;
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome:
        "invalid_transition" | "duplicate" | "expired" | "stale" | "failed";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome: "identity_mismatch";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    }
  | {
      outcome: "not_found";
      request?: PendingRequestRecord;
      draft?: QuestionSetDraftRecord;
    };

export type QuestionSetNumberedChoiceMutationResult =
  | QuestionSetMutationResult
  | {
      outcome: "invalid_choice";
      request: PendingRequestRecord;
      draft: QuestionSetDraftRecord;
    };

export type ResolutionOutcome =
  | "answered"
  | "duplicate"
  | "expired"
  | "cancelled"
  | "failed"
  | "not_found"
  | "identity_mismatch";

export interface ResolutionResult {
  outcome: ResolutionOutcome;
  request?: PendingRequestRecord;
}

export type NumberedChoiceResolutionResult =
  | ResolutionResult
  | {
      outcome: "invalid_choice";
      request: PendingRequestRecord;
    };

export interface ResolveRequestInput {
  correlationId: string;
  answer: string;
  resolvedBy: "terminal" | "telegram" | "web" | "whooshbang";
  now: string;
  expected?: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    turnId?: string;
  };
}

export type BrowserResolutionOutcome =
  | ResolutionOutcome
  | "invalid_answer"
  | "unsupported_request"
  | "replay_conflict";

export type BrowserRequestResponse =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "option";
      optionId: string;
    }
  | {
      kind: "multi-select";
      optionIds: string[];
    }
  | {
      kind: "question-set";
      answers: InteractionQuestionAnswer[];
    };

export interface BrowserResolutionResult {
  outcome: BrowserResolutionOutcome;
  replayed: boolean;
  request?: PendingRequestRecord;
}

export type TopicTextCorrelationResult =
  | {
      outcome: "topic_not_found";
      eligibleCount: 0;
    }
  | {
      outcome: "no_eligible_request";
      eligibleCount: 0;
    }
  | {
      outcome: "ambiguous_request";
      eligibleCount: number;
    }
  | {
      outcome: "invalid_text";
      eligibleCount: 1;
      request: PendingRequestRecord;
    }
  | {
      outcome: "resolved";
      eligibleCount: 1;
      request: PendingRequestRecord;
      resolution: NumberedChoiceResolutionResult;
    }
  | {
      outcome: "drafted";
      eligibleCount: 1;
      request: PendingRequestRecord;
      mutation: QuestionSetTextMutationResult;
    }
  | {
      outcome: "choice_drafted";
      eligibleCount: 1;
      request: PendingRequestRecord;
      mutation: QuestionSetNumberedChoiceMutationResult;
    };

export type ResumeCommandState =
  "claimed" | "running" | "succeeded" | "failed" | "unsupported";

export interface ResumeCommandRecord {
  correlationId: string;
  ownerId: string;
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  surface: Surface;
  sessionId: string;
  turnId?: string;
  answer: string;
  state: ResumeCommandState;
  claimedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type ResumeClaimResult =
  | { outcome: "none" }
  | {
      outcome: "waiting";
      correlationId: string;
      sessionId: string;
      expiresAt: string;
    }
  | { outcome: "claimed"; command: ResumeCommandRecord }
  | {
      outcome: "unsupported";
      correlationId: string;
      harness: Harness;
      surface: Surface;
      sessionId: string;
    };

export interface ClaimResumeInput {
  machineId: string;
  bridgeSessionId: string;
  harness: Harness;
  ownerId: string;
  now: string;
}

interface EventRow {
  event_id: string;
  payload_json: string;
  status: DeliveryStatus;
  attempt_count: number;
}

interface SessionRow {
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  harness_version: string;
  session_id: string;
  project_json: string;
  state: SessionRecord["state"];
  last_event_type: EventType | null;
  last_seen_at: string;
  last_sequence: number;
}

interface SessionAdoptionCandidateRow {
  machine_id: string;
  bridge_session_id: string;
  harness_version: string;
  session_id: string;
  project_json: string;
  capabilities_json: string;
  state: "active" | "waiting";
  last_seen_at: string;
  last_sequence: number;
}

interface SessionTopicRow {
  machine_id: string;
  harness: Harness;
  session_id: string;
  transport_name: string;
  transport_scope: string;
  provider: Harness;
  repository: string;
  branch: string | null;
  short_session_id: string;
  lifecycle_state: SessionRecord["state"];
  topic_name: string;
  display_topic_name: string | null;
  desired_topic_name: string;
  topic_id: string | null;
  provisioning_status: TopicProvisioningStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  title_update_status: TopicTitleUpdateStatus;
  title_attempt_count: number;
  title_next_attempt_at: string;
  title_last_error_code: string | null;
  title_last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CardActionRow {
  action_token: string;
  event_id: string;
  action_kind: CardActionKind;
  created_at: string;
  execution_state: "claimed" | "succeeded" | "failed" | null;
  update_id: number | null;
  claimed_at: string | null;
  finished_at: string | null;
  outcome: string | null;
  error_message: string | null;
}

interface SessionControlRow {
  machine_id: string;
  harness: Harness;
  session_id: string;
  muted_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

interface TopicCleanupOperationRow {
  operation_id: string;
  transport_name: string;
  transport_scope: string;
  selection_mode: string;
  inactive_before: string | null;
  state: TopicCleanupOperationState;
  eligible_count: number;
  candidates_json: string;
  preview_message_id: string | null;
  decision_update_id: number | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  updated_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface CountRow {
  key: string;
  count: number;
}

interface PendingRow {
  correlation_id: string;
  event_id: string;
  machine_id: string;
  harness: Harness;
  session_id: string;
  turn_id: string | null;
  state: PendingRequestState;
  request_kind: PendingRequestRecord["requestKind"];
  question: string;
  expires_at: string;
  resolved_by: "terminal" | "telegram" | "web" | "whooshbang" | null;
  answer: string | null;
  resolved_at: string | null;
  transport_message_id: string | null;
}

interface PendingOptionRow {
  option_token: string;
  option_id: string;
  label: string;
}

interface MultiSelectDraftRow {
  correlation_id: string;
  state: MultiSelectDraftState;
  min_selections: number;
  max_selections: number;
  submit_token: string;
  cancel_token: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface QuestionSetDraftRow {
  correlation_id: string;
  state: QuestionSetDraftState;
  current_index: number;
  revision: number;
  presentation_mode: InteractionPresentationMode | null;
  submit_token: string;
  cancel_token: string;
  created_at: string;
  updated_at: string;
}

interface QuestionSetStepRow {
  correlation_id: string;
  question_id: string;
  ordinal: number;
  next_token: string | null;
  back_token: string | null;
}

interface ResumeCommandRow {
  correlation_id: string;
  owner_id: string;
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  session_id: string;
  turn_id: string | null;
  answer: string;
  state: ResumeCommandState;
  claimed_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ResumeCandidateRow {
  correlation_id: string;
  machine_id: string;
  bridge_session_id: string;
  harness: Harness;
  surface: Surface;
  session_id: string;
  turn_id: string | null;
  answer: string | null;
  state: PendingRequestState;
  expires_at: string;
  capabilities_json: string;
}

interface WebChangeRow {
  change_id: number;
  kind: WebChangeKind;
  action: WebChangeRecord["action"];
  entity_id: string;
  session_id: string | null;
  occurred_at: string;
  payload_json: string;
}

interface SessionTimelineRow {
  id: string;
  kind: SessionTimelineKind;
  at: string;
  status: string;
  label: string;
  event_id: string | null;
  correlation_id: string | null;
  detail_code: string | null;
}

const TopicCleanupCandidateSchema = z
  .object({
    machineId: z.string().min(1).max(512),
    harness: HarnessSchema,
    sessionId: z.string().min(1).max(512),
    topicId: z.string().min(1).max(128),
    repository: z.string().min(1).max(120),
    shortSessionId: z.string().min(1).max(120),
    lastActivityAt: z.iso.datetime({ offset: true }).optional(),
    state: z.enum([
      "pending",
      "deleting",
      "retry",
      "deleted",
      "already-missing",
      "skipped",
      "failed",
    ]),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: z.iso.datetime({ offset: true }),
    lastErrorCode: z.string().min(1).max(160).optional(),
  })
  .strict();

const TopicCleanupCandidatesSchema = z
  .array(TopicCleanupCandidateSchema)
  .max(100);

const TopicCleanupModeSchema = z.enum(["proven-dead", "inactive"]);

function topicCleanupIsTerminal(state: TopicCleanupCandidateState): boolean {
  return (
    state === "deleted" ||
    state === "already-missing" ||
    state === "skipped" ||
    state === "failed"
  );
}

function stateForEvent(
  type: AgentAttentionEventV1["type"],
): SessionRecord["state"] {
  switch (type) {
    case "session.started":
    case "turn.started":
    case "turn.activity":
      return "active";
    case "turn.stopped":
    case "input.required":
    case "permission.required":
      return "waiting";
    case "turn.failed":
      return "stopped";
    case "process.stale":
      return "suspected_stalled";
    case "process.exited":
    case "session.ended":
      return "exited";
  }
}

function retryDelay(policy: RetryPolicy, attemptNumber: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attemptNumber - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

const MAX_PROVIDER_RETRY_AFTER_MS = 60 * 60_000;

function assertIsoCutoff(value: string, name: string): void {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function assertHostedOpaque(
  value: string,
  name: string,
  maximumLength = 2_048,
): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new Error(`${name} is not a bounded opaque value`);
  }
}

function collisionComparable(payloadJson: string): string {
  const event = AgentAttentionEventV1Schema.parse(
    JSON.parse(payloadJson) as unknown,
  );
  return JSON.stringify({
    ...event,
    occurredAt: "<retry-stable>",
    ...(event.request === undefined
      ? {}
      : {
          request: {
            ...event.request,
            expiresAt: "<retry-stable>",
            ...(event.request.interaction === undefined
              ? {}
              : {
                  interaction: {
                    ...event.request.interaction,
                    createdAt: "<retry-stable>",
                    expiresAt: "<retry-stable>",
                  },
                }),
          },
        }),
  });
}

function defaultOptions(
  request: AgentAttentionEventV1["request"],
): Array<{ id: string; label: string }> {
  if (request === undefined) {
    return [];
  }
  if (request.kind === "select" || request.kind === "multi-select") {
    return request.options ?? [];
  }
  if (request.kind === "question-set") {
    return (request.interaction?.questions ?? []).flatMap((question) => {
      if (question.kind === "confirm") {
        return [
          { id: question.confirm.optionId, label: question.confirm.label },
          { id: question.decline.optionId, label: question.decline.label },
        ];
      }
      return question.kind === "single-select" ||
        question.kind === "multi-select"
        ? question.options.map((option) => ({
            id: option.optionId,
            label: option.label,
          }))
        : [];
    });
  }
  if (request.kind === "confirm") {
    return [
      { id: "yes_option", label: "Yes" },
      { id: "no_option", label: "No" },
    ];
  }
  if (request.kind === "permission") {
    return [
      { id: "allow_once", label: "Allow once" },
      { id: "deny_request", label: "Deny" },
      { id: "terminal_only", label: "Handle at terminal" },
    ];
  }
  return [];
}

export class RelayStore {
  private readonly database: Database.Database;

  public constructor(path = ":memory:") {
    this.database = new Database(path);
    try {
      const observedSchemaVersion = this.database.pragma("user_version", {
        simple: true,
      }) as number;
      if (observedSchemaVersion > RELAY_STORE_SCHEMA_VERSION) {
        throw new Error(
          `SQLite schema version ${String(observedSchemaVersion)} is newer than supported version ${String(RELAY_STORE_SCHEMA_VERSION)}; refusing unsafe downgrade`,
        );
      }
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      if (path !== ":memory:") {
        this.database.pragma("journal_mode = WAL");
        this.database.pragma("synchronous = FULL");
      }
      this.migrate(observedSchemaVersion);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private migrate(observedSchemaVersion: number): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bridge_session_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        harness_version TEXT NOT NULL,
        project_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        state TEXT NOT NULL,
        last_event_type TEXT,
        last_seen_at TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, harness, session_id)
      );

      CREATE TABLE IF NOT EXISTS native_hook_sequence_counters (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, harness, session_id)
      );

      CREATE TABLE IF NOT EXISTS native_hook_sequence_allocations (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        allocated_at TEXT NOT NULL,
        PRIMARY KEY (
          machine_id, harness, session_id, source_fingerprint
        ),
        UNIQUE(event_id)
      );

      CREATE INDEX IF NOT EXISTS native_hook_sequence_allocations_retention_idx
        ON native_hook_sequence_allocations(allocated_at, event_id);

      CREATE TABLE IF NOT EXISTS session_product_ownership (
        adoption_id TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        product_session_id TEXT NOT NULL UNIQUE,
        claimed_at TEXT NOT NULL,
        UNIQUE(machine_id, harness, session_id),
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_topics (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        transport_name TEXT NOT NULL,
        transport_scope TEXT NOT NULL,
        provider TEXT NOT NULL,
        repository TEXT NOT NULL,
        branch TEXT,
        short_session_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        display_topic_name TEXT,
        desired_topic_name TEXT NOT NULL,
        topic_id TEXT,
        provisioning_status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_started_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        title_update_status TEXT NOT NULL DEFAULT 'ready',
        title_attempt_count INTEGER NOT NULL DEFAULT 0,
        title_next_attempt_at TEXT NOT NULL,
        title_lease_started_at TEXT,
        title_last_error_code TEXT,
        title_last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          machine_id, harness, session_id, transport_name, transport_scope
        ),
        UNIQUE (transport_name, transport_scope, topic_id),
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS session_topics_status_idx
        ON session_topics(
          provisioning_status, next_attempt_at, updated_at
        );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_started_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        transport_name TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
      );

      CREATE INDEX IF NOT EXISTS events_due_idx
        ON events(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS event_activity_counters (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
        deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0)
      );

      INSERT OR IGNORE INTO event_activity_counters (
        singleton, inserted_count, deleted_count
      ) SELECT 1, COUNT(*), 0 FROM events;

      CREATE TRIGGER IF NOT EXISTS event_activity_insert
      AFTER INSERT ON events
      BEGIN
        UPDATE event_activity_counters
        SET inserted_count = inserted_count + 1
        WHERE singleton = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS event_activity_delete
      AFTER DELETE ON events
      BEGIN
        UPDATE event_activity_counters
        SET deleted_count = deleted_count + 1
        WHERE singleton = 1;
      END;

      CREATE TABLE IF NOT EXISTS card_actions (
        action_token TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, action_kind),
        FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS card_action_executions (
        action_token TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        error_message TEXT,
        FOREIGN KEY (action_token)
          REFERENCES card_actions(action_token) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_controls (
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        muted_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, harness, session_id),
        FOREIGN KEY (machine_id, harness, session_id)
          REFERENCES sessions(machine_id, harness, session_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS topic_cleanup_operations (
        operation_id TEXT PRIMARY KEY,
        transport_name TEXT NOT NULL,
        transport_scope TEXT NOT NULL,
        selection_mode TEXT NOT NULL DEFAULT 'proven-dead',
        inactive_before TEXT,
        state TEXT NOT NULL,
        eligible_count INTEGER NOT NULL,
        candidates_json TEXT NOT NULL,
        preview_message_id TEXT,
        decision_update_id INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS topic_cleanup_due_idx
        ON topic_cleanup_operations(state, updated_at, created_at);

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        UNIQUE(event_id, attempt_number),
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS notification_groups (
        anchor_event_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        latest_occurred_at TEXT NOT NULL,
        transport_name TEXT NOT NULL,
        transport_message_id TEXT NOT NULL,
        topic_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (anchor_event_id) REFERENCES events(event_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS notification_groups_candidate_idx
        ON notification_groups(
          machine_id, harness, session_id, event_type, fingerprint, updated_at
        );

      CREATE TABLE IF NOT EXISTS notification_group_members (
        event_id TEXT PRIMARY KEY,
        anchor_event_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
        FOREIGN KEY (anchor_event_id)
          REFERENCES notification_groups(anchor_event_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pending_requests (
        correlation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        machine_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        state TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        question TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_by TEXT,
        answer TEXT,
        resolved_at TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS pending_options (
        option_token TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        label TEXT NOT NULL,
        UNIQUE(correlation_id, option_id),
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id)
      );

      CREATE TABLE IF NOT EXISTS hosted_delivery_mappings (
        event_id TEXT PRIMARY KEY,
        stream_key TEXT NOT NULL,
        transport_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        interaction_type TEXT NOT NULL
          CHECK (interaction_type IN ('confirm', 'select', 'input')),
        created_at TEXT NOT NULL,
        UNIQUE (stream_key, message_id),
        UNIQUE (stream_key, interaction_id),
        FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS hosted_poll_state (
        stream_key TEXT PRIMARY KEY,
        committed_cursor TEXT,
        last_successful_poll_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hosted_event_claims (
        claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        message_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK (
            outcome IN (
              'answered', 'duplicate', 'terminal', 'quarantined', 'stopped'
            )
          ),
        disposition TEXT
          CHECK (disposition IN ('processed', 'quarantined')),
        reason_code TEXT,
        received_at TEXT NOT NULL,
        handled_at TEXT NOT NULL,
        UNIQUE (stream_key, event_id),
        UNIQUE (stream_key, cursor)
      );

      CREATE INDEX IF NOT EXISTS hosted_event_claims_order_idx
        ON hosted_event_claims(stream_key, claim_id);

      CREATE TABLE IF NOT EXISTS hosted_event_acknowledgements (
        stream_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        disposition TEXT NOT NULL
          CHECK (disposition IN ('processed', 'quarantined')),
        reason_code TEXT,
        state TEXT NOT NULL
          CHECK (
            state IN (
              'pending', 'acknowledging', 'retry', 'acknowledged', 'blocked'
            )
          ),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error_code TEXT,
        acknowledged_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stream_key, event_id),
        FOREIGN KEY (stream_key, event_id)
          REFERENCES hosted_event_claims(stream_key, event_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS hosted_event_ack_due_idx
        ON hosted_event_acknowledgements(
          stream_key, state, next_attempt_at
        );

      CREATE TABLE IF NOT EXISTS hosted_message_updates (
        stream_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK (
            outcome IN (
              'answered', 'duplicate', 'terminal', 'quarantined'
            )
          ),
        reason_code TEXT,
        state TEXT NOT NULL
          CHECK (
            state IN (
              'pending', 'updating', 'retry', 'updated', 'blocked'
            )
          ),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error_code TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stream_key, event_id),
        FOREIGN KEY (stream_key, event_id)
          REFERENCES hosted_event_claims(stream_key, event_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS hosted_message_update_due_idx
        ON hosted_message_updates(stream_key, state, next_attempt_at);

      CREATE TABLE IF NOT EXISTS interaction_drafts (
        correlation_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        min_selections INTEGER NOT NULL,
        max_selections INTEGER NOT NULL,
        submit_token TEXT NOT NULL UNIQUE,
        cancel_token TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS interaction_draft_options (
        correlation_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY (correlation_id, option_id),
        FOREIGN KEY (correlation_id)
          REFERENCES interaction_drafts(correlation_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS question_set_drafts (
        correlation_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        presentation_mode TEXT,
        submit_token TEXT NOT NULL UNIQUE,
        cancel_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS question_set_steps (
        correlation_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        next_token TEXT UNIQUE,
        back_token TEXT UNIQUE,
        PRIMARY KEY (correlation_id, question_id),
        UNIQUE (correlation_id, ordinal),
        FOREIGN KEY (correlation_id)
          REFERENCES question_set_drafts(correlation_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS question_set_answers (
        correlation_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (correlation_id, question_id),
        FOREIGN KEY (correlation_id, question_id)
          REFERENCES question_set_steps(correlation_id, question_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL,
        outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resume_commands (
        correlation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        bridge_session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        surface TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        answer TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY (correlation_id)
          REFERENCES pending_requests(correlation_id)
      );

      CREATE INDEX IF NOT EXISTS resume_commands_owner_idx
        ON resume_commands(owner_id, state, claimed_at);

      CREATE TABLE IF NOT EXISTS diagnostics (
        diagnostic_id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS diagnostics_recorded_idx
        ON diagnostics(recorded_at, diagnostic_id);

      CREATE TABLE IF NOT EXISTS browser_commands (
        operation_id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS browser_commands_created_idx
        ON browser_commands(created_at, operation_id);

      CREATE TABLE IF NOT EXISTS web_changes (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        session_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS web_changes_cursor_idx
        ON web_changes(change_id);

      CREATE TRIGGER IF NOT EXISTS web_sessions_insert
      AFTER INSERT ON sessions
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session', 'insert',
          NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
          NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'harness', NEW.harness,
            'surface', NEW.surface,
            'state', NEW.state,
            'lastSeenAt', NEW.last_seen_at,
            'lastSequence', NEW.last_sequence
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_sessions_update
      AFTER UPDATE ON sessions
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session', 'update',
          NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
          NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'harness', NEW.harness,
            'surface', NEW.surface,
            'state', NEW.state,
            'lastEventType', NEW.last_event_type,
            'lastSeenAt', NEW.last_seen_at,
            'lastSequence', NEW.last_sequence
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_sessions_delete
      AFTER DELETE ON sessions
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session', 'delete',
          OLD.machine_id || ':' || OLD.harness || ':' || OLD.session_id,
          OLD.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('harness', OLD.harness)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_events_insert
      AFTER INSERT ON events
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'event', 'insert', NEW.event_id, NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('type', NEW.type, 'status', NEW.status)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_events_update
      AFTER UPDATE ON events
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'event', 'update', NEW.event_id, NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('type', NEW.type, 'status', NEW.status)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_events_delete
      AFTER DELETE ON events
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'event', 'delete', OLD.event_id, OLD.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('type', OLD.type, 'status', OLD.status)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_requests_insert
      AFTER INSERT ON pending_requests
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'request', 'insert', NEW.correlation_id, NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'eventId', NEW.event_id,
            'requestKind', NEW.request_kind,
            'state', NEW.state,
            'expiresAt', NEW.expires_at
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_requests_update
      AFTER UPDATE ON pending_requests
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'request', 'update', NEW.correlation_id, NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'eventId', NEW.event_id,
            'requestKind', NEW.request_kind,
            'state', NEW.state,
            'expiresAt', NEW.expires_at,
            'resolvedBy', NEW.resolved_by
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_requests_delete
      AFTER DELETE ON pending_requests
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'request', 'delete', OLD.correlation_id, OLD.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'eventId', OLD.event_id,
            'requestKind', OLD.request_kind,
            'state', OLD.state
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_diagnostics_insert
      AFTER INSERT ON diagnostics
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, occurred_at, payload_json
        ) VALUES (
          'diagnostic', 'insert', NEW.diagnostic_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('level', NEW.level, 'code', NEW.code)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_diagnostics_delete
      AFTER DELETE ON diagnostics
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, occurred_at, payload_json
        ) VALUES (
          'diagnostic', 'delete', OLD.diagnostic_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('level', OLD.level, 'code', OLD.code)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_controls_insert
      AFTER INSERT ON session_controls
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session-control', 'insert',
          NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
          NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'muted', NEW.muted_at IS NOT NULL,
            'ended', NEW.ended_at IS NOT NULL
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_controls_update
      AFTER UPDATE ON session_controls
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session-control', 'update',
          NEW.machine_id || ':' || NEW.harness || ':' || NEW.session_id,
          NEW.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object(
            'muted', NEW.muted_at IS NOT NULL,
            'ended', NEW.ended_at IS NOT NULL
          )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS web_controls_delete
      AFTER DELETE ON session_controls
      BEGIN
        INSERT INTO web_changes (
          kind, action, entity_id, session_id, occurred_at, payload_json
        ) VALUES (
          'session-control', 'delete',
          OLD.machine_id || ':' || OLD.harness || ':' || OLD.session_id,
          OLD.session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object()
        );
      END;
    `);
    const sessionColumns = this.database
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "last_event_type")) {
      this.database.exec(
        "ALTER TABLE sessions ADD COLUMN last_event_type TEXT",
      );
      this.database.exec(`
        UPDATE sessions
        SET last_event_type = (
          SELECT events.type
          FROM events
          WHERE events.machine_id = sessions.machine_id
            AND events.harness = sessions.harness
            AND events.session_id = sessions.session_id
          ORDER BY
            CAST(json_extract(events.payload_json, '$.sequence') AS INTEGER)
              DESC,
            events.created_at DESC,
            events.event_id DESC
          LIMIT 1
        )
      `);
    }
    const questionSetColumns = this.database
      .prepare("PRAGMA table_info(question_set_drafts)")
      .all() as Array<{ name: string }>;
    if (
      !questionSetColumns.some((column) => column.name === "presentation_mode")
    ) {
      this.database.exec(
        "ALTER TABLE question_set_drafts ADD COLUMN presentation_mode TEXT",
      );
    }
    const topicCleanupColumns = this.database
      .prepare("PRAGMA table_info(topic_cleanup_operations)")
      .all() as Array<{ name: string }>;
    if (
      !topicCleanupColumns.some((column) => column.name === "selection_mode")
    ) {
      this.database.exec(
        "ALTER TABLE topic_cleanup_operations ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'proven-dead'",
      );
    }
    if (
      !topicCleanupColumns.some((column) => column.name === "inactive_before")
    ) {
      this.database.exec(
        "ALTER TABLE topic_cleanup_operations ADD COLUMN inactive_before TEXT",
      );
    }
    const sessionTopicColumns = this.database
      .prepare("PRAGMA table_info(session_topics)")
      .all() as Array<{ name: string }>;
    const hasSessionTopicColumn = (name: string): boolean =>
      sessionTopicColumns.some((column) => column.name === name);
    if (!hasSessionTopicColumn("display_topic_name")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN display_topic_name TEXT",
      );
    }
    if (!hasSessionTopicColumn("desired_topic_name")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN desired_topic_name TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!hasSessionTopicColumn("title_update_status")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_update_status TEXT NOT NULL DEFAULT 'ready'",
      );
    }
    if (!hasSessionTopicColumn("title_attempt_count")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_attempt_count INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasSessionTopicColumn("title_next_attempt_at")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
      );
    }
    if (!hasSessionTopicColumn("title_lease_started_at")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_lease_started_at TEXT",
      );
    }
    if (!hasSessionTopicColumn("title_last_error_code")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_last_error_code TEXT",
      );
    }
    if (!hasSessionTopicColumn("title_last_error_message")) {
      this.database.exec(
        "ALTER TABLE session_topics ADD COLUMN title_last_error_message TEXT",
      );
    }
    this.database.exec(`
      UPDATE session_topics
      SET
        display_topic_name = CASE
          WHEN provisioning_status = 'ready' AND topic_id IS NOT NULL
            THEN COALESCE(display_topic_name, topic_name)
          ELSE display_topic_name
        END,
        desired_topic_name = CASE
          WHEN desired_topic_name = '' THEN topic_name
          ELSE desired_topic_name
        END,
        title_next_attempt_at = CASE
          WHEN title_next_attempt_at = '1970-01-01T00:00:00.000Z'
            THEN updated_at
          ELSE title_next_attempt_at
        END
    `);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS session_topics_title_status_idx
        ON session_topics(
          title_update_status, title_next_attempt_at, updated_at
        )
    `);
    if (observedSchemaVersion < 7) {
      const rename = this.database.transaction(() => {
        for (const [table, column] of HOSTED_TRANSPORT_IDENTITY_COLUMNS) {
          this.database
            .prepare(
              `UPDATE ${table} SET ${column} = 'whooshbang' WHERE ${column} = 'notifications'`,
            )
            .run();
        }
      });
      rename();
    }
    this.database.pragma(
      `user_version = ${String(RELAY_STORE_SCHEMA_VERSION)}`,
    );
  }

  public close(): void {
    this.database.close();
  }

  public registerSession(sessionInput: SessionRegistrationV1): void {
    const session = SessionRegistrationV1Schema.parse(sessionInput);
    this.database
      .prepare(
        `
        INSERT INTO sessions (
          machine_id, harness, session_id, bridge_session_id, surface,
          harness_version, project_json, capabilities_json, state,
          last_seen_at, last_sequence, updated_at
        ) VALUES (
          @machineId, @harness, @sessionId, @bridgeSessionId, @surface,
          @harnessVersion, @projectJson, @capabilitiesJson, 'active',
          @registeredAt, 0, @registeredAt
        )
        ON CONFLICT(machine_id, harness, session_id) DO UPDATE SET
          bridge_session_id = excluded.bridge_session_id,
          surface = excluded.surface,
          harness_version = excluded.harness_version,
          project_json = excluded.project_json,
          capabilities_json = excluded.capabilities_json,
          last_seen_at = CASE
            WHEN excluded.last_seen_at > sessions.last_seen_at
              THEN excluded.last_seen_at
            ELSE sessions.last_seen_at
          END,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        ...session,
        projectJson: JSON.stringify(session.project),
        capabilitiesJson: JSON.stringify(session.capabilities),
      });
  }

  public getSessionLaneState(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): SessionLaneState {
    const row = this.database
      .prepare(
        `
        SELECT
          sessions.state,
          sessions.last_event_type,
          controls.muted_at,
          controls.ended_at
        FROM sessions
        LEFT JOIN session_controls AS controls
          ON controls.machine_id = sessions.machine_id
          AND controls.harness = sessions.harness
          AND controls.session_id = sessions.session_id
        WHERE sessions.machine_id = @machineId
          AND sessions.harness = @harness
          AND sessions.session_id = @sessionId
      `,
      )
      .get(input) as
      | {
          state: SessionRecord["state"];
          last_event_type: EventType | null;
          muted_at: string | null;
          ended_at: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new Error("session topic references an unknown session");
    }
    if (row.ended_at !== null || row.last_event_type === "session.ended") {
      return "ended";
    }
    if (
      row.state === "stopped" ||
      row.last_event_type === "turn.failed" ||
      row.last_event_type === "process.exited"
    ) {
      return "crashed";
    }
    if (
      row.state === "suspected_stalled" ||
      row.last_event_type === "process.stale"
    ) {
      return "stale";
    }
    if (row.muted_at !== null) {
      return "muted";
    }
    return row.state === "waiting" ? "waiting" : "running";
  }

  private topicFromRow(row: SessionTopicRow): SessionTopicRecord {
    return {
      machineId: row.machine_id,
      harness: row.harness,
      sessionId: row.session_id,
      transportName: row.transport_name,
      transportScope: row.transport_scope,
      provider: row.provider,
      repository: row.repository,
      ...(row.branch === null ? {} : { branch: row.branch }),
      shortSessionId: row.short_session_id,
      lifecycleState: row.lifecycle_state,
      laneState: this.getSessionLaneState({
        machineId: row.machine_id,
        harness: row.harness,
        sessionId: row.session_id,
      }),
      topicName: row.topic_name,
      ...(row.display_topic_name === null
        ? {}
        : { displayTopicName: row.display_topic_name }),
      desiredTopicName: row.desired_topic_name,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      provisioningStatus: row.provisioning_status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      ...(row.last_error_code === null
        ? {}
        : { lastErrorCode: row.last_error_code }),
      ...(row.last_error_message === null
        ? {}
        : { lastErrorMessage: row.last_error_message }),
      titleUpdateStatus: row.title_update_status,
      titleAttemptCount: row.title_attempt_count,
      titleNextAttemptAt: row.title_next_attempt_at,
      ...(row.title_last_error_code === null
        ? {}
        : { titleLastErrorCode: row.title_last_error_code }),
      ...(row.title_last_error_message === null
        ? {}
        : { titleLastErrorMessage: row.title_last_error_message }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getSessionTopicRow(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
  }): SessionTopicRow | undefined {
    return this.database
      .prepare(
        `
        SELECT
          machine_id, harness, session_id, transport_name, transport_scope,
          provider, repository, branch, short_session_id, lifecycle_state,
          topic_name, display_topic_name, desired_topic_name, topic_id,
          provisioning_status, attempt_count, next_attempt_at, last_error_code,
          last_error_message, title_update_status, title_attempt_count,
          title_next_attempt_at, title_last_error_code,
          title_last_error_message, created_at, updated_at
        FROM session_topics
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
      `,
      )
      .get(input) as SessionTopicRow | undefined;
  }

  private topicDeletionClaimed(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    topicId: string;
  }): boolean {
    return (
      this.database
        .prepare(
          `
          SELECT 1
          FROM topic_cleanup_operations AS cleanup,
            json_each(cleanup.candidates_json) AS candidate
          WHERE cleanup.transport_name = @transportName
            AND cleanup.transport_scope = @transportScope
            AND cleanup.state = 'claimed'
            AND json_extract(candidate.value, '$.machineId') = @machineId
            AND json_extract(candidate.value, '$.harness') = @harness
            AND json_extract(candidate.value, '$.sessionId') = @sessionId
            AND json_extract(candidate.value, '$.topicId') = @topicId
            AND json_extract(candidate.value, '$.state')
              IN ('pending', 'retry', 'deleting')
          LIMIT 1
        `,
        )
        .get(input) !== undefined
    );
  }

  public claimSessionTopic(
    input: ClaimSessionTopicInput,
  ): SessionTopicClaimResult {
    assertIsoCutoff(input.now, "topic claim time");
    if (
      input.transportName.trim().length === 0 ||
      input.transportScope.trim().length === 0
    ) {
      throw new Error("topic transport identity is required");
    }
    if (
      input.repository.length < 1 ||
      input.repository.length > 120 ||
      input.topicName.length < 1 ||
      [...input.topicName].length > 128
    ) {
      throw new Error("topic metadata is outside supported bounds");
    }
    return this.database.transaction((): SessionTopicClaimResult => {
      const session = this.database
        .prepare(
          `
          SELECT state
          FROM sessions
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
        `,
        )
        .get(input) as { state: SessionRecord["state"] } | undefined;
      if (session === undefined) {
        throw new Error("cannot claim a topic for an unknown session");
      }
      const existingRow = this.getSessionTopicRow(input);
      if (
        existingRow?.provisioning_status === "ready" &&
        existingRow.topic_id !== null &&
        this.topicDeletionClaimed({
          ...input,
          topicId: existingRow.topic_id,
        })
      ) {
        return {
          outcome: "deleting",
          topic: this.topicFromRow(existingRow),
        };
      }
      const metadata = {
        ...input,
        lifecycleState: session.state,
        desiredTopicName: sessionTopicDisplayName(
          input.topicName,
          this.getSessionLaneState(input),
        ),
      };
      this.database
        .prepare(
          `
          INSERT OR IGNORE INTO session_topics (
            machine_id, harness, session_id, transport_name, transport_scope,
            provider, repository, branch, short_session_id, lifecycle_state,
            topic_name, desired_topic_name, provisioning_status,
            next_attempt_at, title_next_attempt_at, created_at, updated_at
          ) VALUES (
            @machineId, @harness, @sessionId, @transportName, @transportScope,
            @provider, @repository, @branch, @shortSessionId, @lifecycleState,
            @topicName, @desiredTopicName, 'pending', @now, @now, @now, @now
          )
        `,
        )
        .run({
          ...metadata,
          branch: input.branch ?? null,
        });
      this.database
        .prepare(
          `
          UPDATE session_topics SET
            provider = @provider,
            repository = @repository,
            branch = @branch,
            short_session_id = @shortSessionId,
            lifecycle_state = @lifecycleState,
            topic_name = CASE
              WHEN provisioning_status = 'ready' THEN topic_name
              ELSE @topicName
            END,
            desired_topic_name = CASE
              WHEN provisioning_status = 'ready' THEN desired_topic_name
              ELSE @desiredTopicName
            END,
            title_next_attempt_at = CASE
              WHEN provisioning_status = 'ready' THEN title_next_attempt_at
              ELSE @now
            END,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
        `,
        )
        .run({
          ...metadata,
          branch: input.branch ?? null,
        });
      const currentRow = this.getSessionTopicRow(input);
      if (currentRow === undefined) {
        throw new Error("session topic disappeared during claim");
      }
      const current = this.topicFromRow(currentRow);
      if (current.provisioningStatus === "ready") {
        if (current.topicId === undefined) {
          throw new Error("ready session topic is missing its topic id");
        }
        return { outcome: "ready", topic: current };
      }
      if (current.provisioningStatus === "creating") {
        return { outcome: "busy", topic: current };
      }
      if (current.provisioningStatus === "failed") {
        return { outcome: "failed", topic: current };
      }
      if (
        current.provisioningStatus === "retry" &&
        current.nextAttemptAt > input.now
      ) {
        return { outcome: "deferred", topic: current };
      }
      const update = this.database
        .prepare(
          `
          UPDATE session_topics SET
            provisioning_status = 'creating',
            attempt_count = attempt_count + 1,
            lease_started_at = @now,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND provisioning_status IN ('pending', 'retry')
            AND next_attempt_at <= @now
        `,
        )
        .run(input);
      if (update.changes !== 1) {
        const raced = this.getSessionTopicRow(input);
        if (raced === undefined) {
          throw new Error("session topic disappeared after claim race");
        }
        return { outcome: "busy", topic: this.topicFromRow(raced) };
      }
      const claimedRow = this.getSessionTopicRow(input);
      if (claimedRow === undefined) {
        throw new Error("claimed session topic disappeared");
      }
      const claimed = this.topicFromRow(claimedRow);
      return {
        outcome: "claimed",
        topic: claimed,
        attemptNumber: claimed.attemptCount,
      };
    })();
  }

  public markSessionTopicReady(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    attemptNumber: number;
    topicId: string;
    displayTopicName: string;
    now: string;
  }): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic ready time");
    if (input.topicId.trim().length === 0 || input.topicId.length > 128) {
      throw new Error("topic id is outside supported bounds");
    }
    if (
      input.displayTopicName.trim().length === 0 ||
      [...input.displayTopicName].length > 128
    ) {
      throw new Error("display topic name is outside supported bounds");
    }
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          topic_id = @topicId,
          display_topic_name = @displayTopicName,
          desired_topic_name = @displayTopicName,
          provisioning_status = 'ready',
          lease_started_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          title_update_status = 'ready',
          title_attempt_count = 0,
          title_next_attempt_at = @now,
          title_lease_started_at = NULL,
          title_last_error_code = NULL,
          title_last_error_message = NULL,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND provisioning_status = 'creating'
          AND attempt_count = @attemptNumber
      `,
      )
      .run(input).changes;
    if (changes !== 1) {
      throw new Error("cannot complete an unclaimed session topic");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("ready session topic disappeared");
    }
    return this.topicFromRow(row);
  }

  public markSessionTopicFailed(
    input: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      transportName: string;
      transportScope: string;
      attemptNumber: number;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      now: string;
    },
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic failure time");
    const exhausted = input.attemptNumber >= policy.maxAttempts;
    const provisioningStatus: TopicProvisioningStatus =
      input.retryable && !exhausted ? "retry" : "failed";
    const nextAttemptAt = new Date(
      Date.parse(input.now) + retryDelay(policy, input.attemptNumber),
    ).toISOString();
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          provisioning_status = @provisioningStatus,
          next_attempt_at = @nextAttemptAt,
          lease_started_at = NULL,
          last_error_code = @errorCode,
          last_error_message = @errorMessage,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND provisioning_status = 'creating'
          AND attempt_count = @attemptNumber
      `,
      )
      .run({
        ...input,
        provisioningStatus,
        nextAttemptAt,
        errorMessage: input.errorMessage.slice(0, 2_000),
      }).changes;
    if (changes !== 1) {
      throw new Error("cannot fail an unclaimed session topic");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("failed session topic disappeared");
    }
    return this.topicFromRow(row);
  }

  public reconcileUnavailableSessionTopic(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    topicId: string;
    errorCode: string;
    errorMessage: string;
    now: string;
  }): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic reconciliation time");
    return this.database.transaction(() => {
      const currentRow = this.getSessionTopicRow(input);
      if (currentRow === undefined) {
        throw new Error("cannot reconcile an unknown session topic");
      }
      const current = this.topicFromRow(currentRow);
      if (
        current.provisioningStatus !== "ready" ||
        current.topicId !== input.topicId
      ) {
        return current;
      }
      const changes = this.database
        .prepare(
          `
          UPDATE session_topics SET
            topic_id = NULL,
            display_topic_name = NULL,
            provisioning_status = 'retry',
            next_attempt_at = @now,
            lease_started_at = NULL,
            last_error_code = @errorCode,
            last_error_message = @errorMessage,
            title_update_status = 'ready',
            title_attempt_count = 0,
            title_next_attempt_at = @now,
            title_lease_started_at = NULL,
            title_last_error_code = NULL,
            title_last_error_message = NULL,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND provisioning_status = 'ready'
            AND topic_id = @topicId
        `,
        )
        .run({
          ...input,
          errorMessage: input.errorMessage.slice(0, 2_000),
        }).changes;
      if (changes !== 1) {
        const raced = this.getSessionTopicRow(input);
        if (raced === undefined) {
          throw new Error("session topic disappeared during reconciliation");
        }
        return this.topicFromRow(raced);
      }
      const reconciled = this.getSessionTopicRow(input);
      if (reconciled === undefined) {
        throw new Error("reconciled session topic disappeared");
      }
      return this.topicFromRow(reconciled);
    })();
  }

  public recoverInterruptedTopics(now: string, limit = 500): number {
    assertIsoCutoff(now, "topic recovery time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error("topic recovery limit must be between 1 and 5000");
    }
    return this.database
      .prepare(
        `
        UPDATE session_topics SET
          provisioning_status = 'retry',
          next_attempt_at = ?,
          lease_started_at = NULL,
          last_error_code = 'topic-creation-interrupted',
          last_error_message = 'daemon stopped during topic creation',
          updated_at = ?
        WHERE rowid IN (
          SELECT rowid
          FROM session_topics
          WHERE provisioning_status = 'creating'
          ORDER BY updated_at, rowid
          LIMIT ?
        )
      `,
      )
      .run(now, now, limit).changes;
  }

  public getSessionTopic(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
  }): SessionTopicRecord | undefined {
    const row = this.getSessionTopicRow(input);
    return row === undefined ? undefined : this.topicFromRow(row);
  }

  public getSessionTopicByTopicId(input: {
    transportName: string;
    transportScope: string;
    topicId: string;
  }): SessionTopicRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT
          machine_id, harness, session_id, transport_name, transport_scope,
          provider, repository, branch, short_session_id, lifecycle_state,
          topic_name, display_topic_name, desired_topic_name, topic_id,
          provisioning_status, attempt_count, next_attempt_at, last_error_code,
          last_error_message, title_update_status, title_attempt_count,
          title_next_attempt_at, title_last_error_code,
          title_last_error_message, created_at, updated_at
        FROM session_topics
        WHERE transport_name = @transportName
          AND transport_scope = @transportScope
          AND topic_id = @topicId
          AND provisioning_status = 'ready'
      `,
      )
      .get(input) as SessionTopicRow | undefined;
    return row === undefined ? undefined : this.topicFromRow(row);
  }

  public listSessionTopics(): SessionTopicRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT
          machine_id, harness, session_id, transport_name, transport_scope,
          provider, repository, branch, short_session_id, lifecycle_state,
          topic_name, display_topic_name, desired_topic_name, topic_id,
          provisioning_status, attempt_count, next_attempt_at, last_error_code,
          last_error_message, title_update_status, title_attempt_count,
          title_next_attempt_at, title_last_error_code,
          title_last_error_message, created_at, updated_at
        FROM session_topics
        ORDER BY updated_at DESC, machine_id, harness, session_id
      `,
      )
      .all() as SessionTopicRow[];
    return rows.map((row) => this.topicFromRow(row));
  }

  public reconcileSessionTopicTitles(input: {
    transportName: string;
    transportScope: string;
    now: string;
  }): number {
    assertIsoCutoff(input.now, "topic title reconciliation time");
    const topics = this.listSessionTopics().filter(
      (topic) =>
        topic.transportName === input.transportName &&
        topic.transportScope === input.transportScope &&
        topic.provisioningStatus === "ready" &&
        topic.topicId !== undefined,
    );
    return this.database.transaction(() => {
      let scheduled = 0;
      for (const topic of topics) {
        if (topic.titleUpdateStatus === "updating") {
          continue;
        }
        const desiredTopicName = sessionTopicDisplayName(
          topic.topicName,
          topic.laneState,
        );
        if (topic.displayTopicName === desiredTopicName) {
          if (
            topic.desiredTopicName !== desiredTopicName ||
            topic.titleUpdateStatus !== "ready"
          ) {
            this.database
              .prepare(
                `
                UPDATE session_topics SET
                  desired_topic_name = @desiredTopicName,
                  title_update_status = 'ready',
                  title_attempt_count = 0,
                  title_next_attempt_at = @now,
                  title_lease_started_at = NULL,
                  title_last_error_code = NULL,
                  title_last_error_message = NULL,
                  updated_at = @now
                WHERE machine_id = @machineId
                  AND harness = @harness
                  AND session_id = @sessionId
                  AND transport_name = @transportName
                  AND transport_scope = @transportScope
                  AND provisioning_status = 'ready'
                  AND title_update_status <> 'updating'
              `,
              )
              .run({ ...topic, ...input, desiredTopicName });
          }
          continue;
        }
        const stateChanged = topic.desiredTopicName !== desiredTopicName;
        if (!stateChanged && topic.titleUpdateStatus !== "ready") {
          continue;
        }
        const changes = this.database
          .prepare(
            `
            UPDATE session_topics SET
              desired_topic_name = @desiredTopicName,
              title_update_status = 'pending',
              title_attempt_count = 0,
              title_next_attempt_at = @now,
              title_lease_started_at = NULL,
              title_last_error_code = NULL,
              title_last_error_message = NULL,
              updated_at = @now
            WHERE machine_id = @machineId
              AND harness = @harness
              AND session_id = @sessionId
              AND transport_name = @transportName
              AND transport_scope = @transportScope
              AND provisioning_status = 'ready'
              AND topic_id = @topicId
              AND title_update_status <> 'updating'
          `,
          )
          .run({ ...topic, ...input, desiredTopicName }).changes;
        scheduled += changes;
      }
      return scheduled;
    })();
  }

  public claimNextSessionTopicTitleUpdate(input: {
    transportName: string;
    transportScope: string;
    now: string;
  }): ClaimedTopicTitleUpdate | undefined {
    assertIsoCutoff(input.now, "topic title claim time");
    return this.database.transaction(() => {
      const candidate = this.database
        .prepare(
          `
          SELECT
            machine_id, harness, session_id, transport_name, transport_scope
          FROM session_topics
          WHERE provisioning_status = 'ready'
            AND topic_id IS NOT NULL
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND title_update_status IN ('pending', 'retry')
            AND title_next_attempt_at <= @now
          ORDER BY title_next_attempt_at, updated_at, rowid
          LIMIT 1
        `,
        )
        .get(input) as
        | {
            machine_id: string;
            harness: Harness;
            session_id: string;
            transport_name: string;
            transport_scope: string;
          }
        | undefined;
      if (candidate === undefined) {
        return undefined;
      }
      const identity = {
        machineId: candidate.machine_id,
        harness: candidate.harness,
        sessionId: candidate.session_id,
        transportName: candidate.transport_name,
        transportScope: candidate.transport_scope,
      };
      const changes = this.database
        .prepare(
          `
          UPDATE session_topics SET
            title_update_status = 'updating',
            title_attempt_count = title_attempt_count + 1,
            title_lease_started_at = @now,
            title_last_error_code = NULL,
            title_last_error_message = NULL,
            updated_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND provisioning_status = 'ready'
            AND topic_id IS NOT NULL
            AND title_update_status IN ('pending', 'retry')
            AND title_next_attempt_at <= @now
        `,
        )
        .run({ ...identity, now: input.now }).changes;
      if (changes !== 1) {
        return undefined;
      }
      const row = this.getSessionTopicRow(identity);
      if (row === undefined) {
        throw new Error("claimed topic title update disappeared");
      }
      const topic = this.topicFromRow(row);
      return {
        topic,
        attemptNumber: topic.titleAttemptCount,
      };
    })();
  }

  public markSessionTopicTitleUpdated(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
    transportName: string;
    transportScope: string;
    topicId: string;
    desiredTopicName: string;
    attemptNumber: number;
    now: string;
  }): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic title completion time");
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          display_topic_name = @desiredTopicName,
          title_update_status = 'ready',
          title_next_attempt_at = @now,
          title_lease_started_at = NULL,
          title_last_error_code = NULL,
          title_last_error_message = NULL,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND topic_id = @topicId
          AND provisioning_status = 'ready'
          AND title_update_status = 'updating'
          AND title_attempt_count = @attemptNumber
          AND desired_topic_name = @desiredTopicName
      `,
      )
      .run(input).changes;
    if (changes !== 1) {
      throw new Error("cannot complete an unclaimed topic title update");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("updated topic title disappeared");
    }
    return this.topicFromRow(row);
  }

  public markSessionTopicTitleFailed(
    input: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      transportName: string;
      transportScope: string;
      topicId: string;
      desiredTopicName: string;
      attemptNumber: number;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      now: string;
    },
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): SessionTopicRecord {
    assertIsoCutoff(input.now, "topic title failure time");
    const exhausted = input.attemptNumber >= policy.maxAttempts;
    const titleUpdateStatus: TopicTitleUpdateStatus =
      input.retryable && !exhausted ? "retry" : "failed";
    const titleNextAttemptAt = new Date(
      Date.parse(input.now) + retryDelay(policy, input.attemptNumber),
    ).toISOString();
    const changes = this.database
      .prepare(
        `
        UPDATE session_topics SET
          title_update_status = @titleUpdateStatus,
          title_next_attempt_at = @titleNextAttemptAt,
          title_lease_started_at = NULL,
          title_last_error_code = @errorCode,
          title_last_error_message = @errorMessage,
          updated_at = @now
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND transport_name = @transportName
          AND transport_scope = @transportScope
          AND topic_id = @topicId
          AND provisioning_status = 'ready'
          AND title_update_status = 'updating'
          AND title_attempt_count = @attemptNumber
          AND desired_topic_name = @desiredTopicName
      `,
      )
      .run({
        ...input,
        titleUpdateStatus,
        titleNextAttemptAt,
        errorMessage: input.errorMessage.slice(0, 2_000),
      }).changes;
    if (changes !== 1) {
      throw new Error("cannot fail an unclaimed topic title update");
    }
    const row = this.getSessionTopicRow(input);
    if (row === undefined) {
      throw new Error("failed topic title update disappeared");
    }
    return this.topicFromRow(row);
  }

  public recoverInterruptedTopicTitleUpdates(now: string, limit = 500): number {
    assertIsoCutoff(now, "topic title recovery time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error("topic title recovery limit must be between 1 and 5000");
    }
    return this.database
      .prepare(
        `
        UPDATE session_topics SET
          title_update_status = 'retry',
          title_next_attempt_at = ?,
          title_lease_started_at = NULL,
          title_last_error_code = 'topic-title-update-interrupted',
          title_last_error_message = 'daemon stopped during topic title update',
          updated_at = ?
        WHERE rowid IN (
          SELECT rowid
          FROM session_topics
          WHERE title_update_status = 'updating'
          ORDER BY updated_at, rowid
          LIMIT ?
        )
      `,
      )
      .run(now, now, limit).changes;
  }

  public allocateNativeHookSequence(
    inputValue: NativeHookSequenceAllocationInput,
  ): number {
    const input = NativeHookSequenceAllocationInputSchema.parse(inputValue);
    const allocate = this.database.transaction((): number => {
      const existing = this.database
        .prepare(
          `
          SELECT event_id, sequence
          FROM native_hook_sequence_allocations
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND source_fingerprint = @sourceFingerprint
        `,
        )
        .get(input) as
        | {
            event_id: string;
            sequence: number;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.event_id !== input.eventId) {
          throw new Error(
            "native hook fingerprint is already bound to another event",
          );
        }
        return existing.sequence;
      }

      const existingEventAllocation = this.database
        .prepare(
          `
          SELECT machine_id, harness, session_id, source_fingerprint
          FROM native_hook_sequence_allocations
          WHERE event_id = @eventId
        `,
        )
        .get(input) as
        | {
            machine_id: string;
            harness: Harness;
            session_id: string;
            source_fingerprint: string;
          }
        | undefined;
      if (existingEventAllocation !== undefined) {
        throw new Error(
          "native hook event identity is already bound to another source",
        );
      }

      const retainedEvent = this.database
        .prepare(
          `
          SELECT machine_id, harness, session_id, payload_json
          FROM events
          WHERE event_id = @eventId
        `,
        )
        .get(input) as
        | {
            machine_id: string;
            harness: Harness;
            session_id: string;
            payload_json: string;
          }
        | undefined;
      let retainedSequence: number | undefined;
      if (retainedEvent !== undefined) {
        if (
          retainedEvent.machine_id !== input.machineId ||
          retainedEvent.harness !== input.harness ||
          retainedEvent.session_id !== input.sessionId
        ) {
          throw new Error(
            "native hook event identity is already bound to another session",
          );
        }
        retainedSequence = AgentAttentionEventV1Schema.parse(
          JSON.parse(retainedEvent.payload_json) as unknown,
        ).sequence;
      }

      const counter = this.database
        .prepare(
          `
          SELECT last_sequence
          FROM native_hook_sequence_counters
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
        `,
        )
        .get(input) as { last_sequence: number } | undefined;
      const session = this.database
        .prepare(
          `
          SELECT last_sequence
          FROM sessions
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
        `,
        )
        .get(input) as { last_sequence: number } | undefined;
      const priorSequence = Math.max(
        counter?.last_sequence ?? 0,
        session?.last_sequence ?? 0,
        retainedSequence ?? 0,
      );
      const sequence = retainedSequence ?? priorSequence + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error("native hook sequence space is exhausted");
      }

      this.database
        .prepare(
          `
          INSERT INTO native_hook_sequence_counters (
            machine_id, harness, session_id, last_sequence, updated_at
          ) VALUES (
            @machineId, @harness, @sessionId, @sequence, @allocatedAt
          )
          ON CONFLICT(machine_id, harness, session_id) DO UPDATE SET
            last_sequence = MAX(
              native_hook_sequence_counters.last_sequence,
              excluded.last_sequence
            ),
            updated_at = MAX(
              native_hook_sequence_counters.updated_at,
              excluded.updated_at
            )
        `,
        )
        .run({ ...input, sequence });
      this.database
        .prepare(
          `
          INSERT INTO native_hook_sequence_allocations (
            machine_id, harness, session_id, source_fingerprint, event_id,
            sequence, allocated_at
          ) VALUES (
            @machineId, @harness, @sessionId, @sourceFingerprint, @eventId,
            @sequence, @allocatedAt
          )
        `,
        )
        .run({ ...input, sequence });
      return sequence;
    });
    return allocate.immediate();
  }

  public heartbeat(heartbeatInput: SessionHeartbeatV1): boolean {
    const heartbeat = SessionHeartbeatV1Schema.parse(heartbeatInput);
    const result = this.database
      .prepare(
        `
        UPDATE sessions SET
          state = CASE
            WHEN @sequence >= last_sequence THEN @state
            ELSE state
          END,
          last_sequence = MAX(last_sequence, @sequence),
          last_seen_at = MAX(last_seen_at, @observedAt),
          updated_at = @observedAt
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
      `,
      )
      .run(heartbeat);
    return result.changes === 1;
  }

  public ingestEvent(eventInput: AgentAttentionEventV1): IngestResult {
    const event = AgentAttentionEventV1Schema.parse(eventInput);
    return this.database.transaction(() => {
      if (
        this.sessionActuatorOwner({
          machineId: event.machineId,
          harness: event.harness,
          sessionId: event.sessionId,
        }) === "product-managed"
      ) {
        throw new Error(
          "product-managed session rejects standalone attention ingestion",
        );
      }
      this.registerSession({
        schema: "agent-session.v1",
        machineId: event.machineId,
        bridgeSessionId: event.bridgeSessionId,
        harness: event.harness,
        surface: event.surface,
        harnessVersion: event.harnessVersion,
        sessionId: event.sessionId,
        project: event.project,
        capabilities: event.capabilities,
        registeredAt: event.occurredAt,
      });

      const state = stateForEvent(event.type);
      this.database
        .prepare(
          `
          UPDATE sessions SET
            state = CASE
              WHEN @sequence >= last_sequence THEN @state
              ELSE state
            END,
            last_event_type = CASE
              WHEN @sequence >= last_sequence THEN @type
              ELSE last_event_type
            END,
            last_sequence = MAX(last_sequence, @sequence),
            last_seen_at = MAX(last_seen_at, @occurredAt),
            updated_at = @occurredAt
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
        `,
        )
        .run({ ...event, state });
      if (event.type === "session.ended") {
        this.upsertSessionControl(event, "ended_at", event.occurredAt);
      }

      const payloadJson = JSON.stringify(event);
      const result = this.database
        .prepare(
          `
          INSERT OR IGNORE INTO events (
            event_id, machine_id, harness, session_id, type, payload_json,
            status, next_attempt_at, created_at
          ) VALUES (
            @eventId, @machineId, @harness, @sessionId, @type, @payloadJson,
            'queued', @occurredAt, @occurredAt
          )
        `,
        )
        .run({ ...event, payloadJson });
      const inserted = result.changes === 1;

      const existing = this.database
        .prepare(
          `
          SELECT event_id, payload_json, status, attempt_count
          FROM events WHERE event_id = ?
        `,
        )
        .get(event.eventId) as EventRow | undefined;
      if (existing === undefined) {
        throw new Error(`event ${event.eventId} disappeared after ingestion`);
      }
      if (
        !inserted &&
        collisionComparable(existing.payload_json) !==
          collisionComparable(payloadJson)
      ) {
        throw new Error(
          `event id collision: ${event.eventId} has a different payload`,
        );
      }
      if (inserted && event.request !== undefined) {
        this.database
          .prepare(
            `
            INSERT INTO pending_requests (
              correlation_id, event_id, machine_id, harness, session_id,
              turn_id, state, request_kind, question, expires_at, created_at
            ) VALUES (
              @correlationId, @eventId, @machineId, @harness, @sessionId,
              @turnId, 'open', @requestKind, @question, @expiresAt, @createdAt
            )
          `,
          )
          .run({
            correlationId: event.request.correlationId,
            eventId: event.eventId,
            machineId: event.machineId,
            harness: event.harness,
            sessionId: event.sessionId,
            turnId: event.turnId ?? null,
            requestKind: event.request.kind,
            question: event.request.question,
            expiresAt: event.request.expiresAt,
            createdAt: event.occurredAt,
          });
        const insertOption = this.database.prepare(
          `
          INSERT INTO pending_options (
            option_token, correlation_id, option_id, label
          ) VALUES (?, ?, ?, ?)
        `,
        );
        for (const option of defaultOptions(event.request)) {
          insertOption.run(
            `decision_${randomUUID()}`,
            event.request.correlationId,
            option.id,
            option.label,
          );
        }
        if (event.request.kind === "multi-select") {
          if (
            event.request.minSelections === undefined ||
            event.request.maxSelections === undefined
          ) {
            throw new Error("validated multi-select request lost its bounds");
          }
          this.database
            .prepare(
              `
              INSERT INTO interaction_drafts (
                correlation_id, state, min_selections, max_selections,
                submit_token, cancel_token, revision, created_at, updated_at
              ) VALUES (?, 'pending', ?, ?, ?, ?, 0, ?, ?)
            `,
            )
            .run(
              event.request.correlationId,
              event.request.minSelections,
              event.request.maxSelections,
              `draft_submit_${randomUUID()}`,
              `draft_cancel_${randomUUID()}`,
              event.occurredAt,
              event.occurredAt,
            );
        }
        if (event.request.kind === "question-set") {
          const interaction = event.request.interaction;
          if (interaction === undefined) {
            throw new Error(
              "validated question-set request lost its interaction",
            );
          }
          this.database
            .prepare(
              `
              INSERT INTO question_set_drafts (
                correlation_id, state, current_index, revision,
                submit_token, cancel_token, created_at, updated_at
              ) VALUES (?, 'pending', 0, 0, ?, ?, ?, ?)
            `,
            )
            .run(
              event.request.correlationId,
              `wizard_submit_${randomUUID()}`,
              `wizard_cancel_${randomUUID()}`,
              event.occurredAt,
              event.occurredAt,
            );
          const insertStep = this.database.prepare(
            `
            INSERT INTO question_set_steps (
              correlation_id, question_id, ordinal, next_token, back_token
            ) VALUES (?, ?, ?, ?, ?)
          `,
          );
          for (const [index, question] of interaction.questions.entries()) {
            insertStep.run(
              event.request.correlationId,
              question.questionId,
              index,
              index === interaction.questions.length - 1
                ? null
                : `wizard_next_${randomUUID()}`,
              index === 0 ? null : `wizard_back_${randomUUID()}`,
            );
          }
        }
      }
      return {
        eventId: event.eventId,
        inserted,
        status: existing.status,
      };
    })();
  }

  public sessionActuatorOwner(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): "standalone-attention" | "product-managed" {
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM session_product_ownership
         WHERE machine_id = ? AND harness = ? AND session_id = ?`,
      )
      .get(input.machineId, input.harness, input.sessionId);
    return row === undefined ? "standalone-attention" : "product-managed";
  }

  public inspectSessionProductOwnership(
    adoptionId: string,
  ): SessionProductOwnershipReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT adoption_id, request_fingerprint, machine_id, harness,
                session_id, product_session_id, claimed_at
         FROM session_product_ownership WHERE adoption_id = ?`,
      )
      .get(adoptionId) as
      | {
          adoption_id: string;
          request_fingerprint: string;
          machine_id: string;
          harness: "codex";
          session_id: string;
          product_session_id: string;
          claimed_at: string;
        }
      | undefined;
    return row
      ? {
          adoptionId: row.adoption_id,
          requestFingerprint: row.request_fingerprint,
          machineId: row.machine_id,
          harness: row.harness,
          sessionId: row.session_id,
          productSessionId: row.product_session_id,
          claimedAt: row.claimed_at,
        }
      : undefined;
  }

  public listSessionAdoptionCandidates(input: {
    projectCwdHash: string;
    harnessVersion: string;
    limit?: number;
  }): SessionAdoptionCandidateCheckpoint[] {
    const limit = input.limit ?? 20;
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(input.projectCwdHash) ||
      input.harnessVersion.length < 1 ||
      input.harnessVersion.length > 120 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new TypeError("Session adoption candidate query is malformed.");
    }
    const rows = this.database
      .prepare(
        `SELECT
           sessions.machine_id, sessions.bridge_session_id,
           sessions.harness_version, sessions.session_id,
           sessions.project_json, sessions.capabilities_json,
           sessions.state, sessions.last_seen_at, sessions.last_sequence
         FROM sessions
         LEFT JOIN session_controls AS controls
           ON controls.machine_id = sessions.machine_id
           AND controls.harness = sessions.harness
           AND controls.session_id = sessions.session_id
         WHERE sessions.harness = 'codex'
           AND sessions.surface = 'cli'
           AND sessions.harness_version = @harnessVersion
           AND sessions.state IN ('active', 'waiting')
           AND json_extract(sessions.project_json, '$.cwdHash')
             = @projectCwdHash
           AND controls.ended_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_product_ownership AS ownership
             WHERE ownership.machine_id = sessions.machine_id
               AND ownership.harness = sessions.harness
               AND ownership.session_id = sessions.session_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_requests AS pending
             WHERE pending.machine_id = sessions.machine_id
               AND pending.harness = sessions.harness
               AND pending.session_id = sessions.session_id
               AND pending.state = 'open'
           )
           AND NOT EXISTS (
             SELECT 1 FROM resume_commands AS resume
             WHERE resume.machine_id = sessions.machine_id
               AND resume.harness = sessions.harness
               AND resume.session_id = sessions.session_id
               AND resume.state IN ('claimed', 'running')
           )
         ORDER BY sessions.last_seen_at DESC, sessions.machine_id,
                  sessions.session_id
         LIMIT @limit`,
      )
      .all({
        projectCwdHash: input.projectCwdHash,
        harnessVersion: input.harnessVersion,
        limit,
      }) as SessionAdoptionCandidateRow[];
    return rows.map((row) => this.sessionAdoptionCandidateFromRow(row));
  }

  public inspectSessionAdoptionCandidate(input: {
    machineId: string;
    nativeSessionReference: string;
    projectCwdHash: string;
    harnessVersion: string;
  }): SessionAdoptionCandidateCheckpoint | undefined {
    if (
      !boundedOwnershipIdentifier(input.machineId) ||
      !boundedOwnershipIdentifier(input.nativeSessionReference) ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.projectCwdHash) ||
      input.harnessVersion.length < 1 ||
      input.harnessVersion.length > 120
    ) {
      throw new TypeError("Session adoption candidate identity is malformed.");
    }
    const row = this.database
      .prepare(
        `SELECT
           sessions.machine_id, sessions.bridge_session_id,
           sessions.harness_version, sessions.session_id,
           sessions.project_json, sessions.capabilities_json,
           sessions.state, sessions.last_seen_at, sessions.last_sequence
         FROM sessions
         LEFT JOIN session_controls AS controls
           ON controls.machine_id = sessions.machine_id
           AND controls.harness = sessions.harness
           AND controls.session_id = sessions.session_id
         WHERE sessions.machine_id = @machineId
           AND sessions.harness = 'codex'
           AND sessions.surface = 'cli'
           AND sessions.session_id = @nativeSessionReference
           AND sessions.harness_version = @harnessVersion
           AND sessions.state IN ('active', 'waiting')
           AND json_extract(sessions.project_json, '$.cwdHash')
             = @projectCwdHash
           AND controls.ended_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_product_ownership AS ownership
             WHERE ownership.machine_id = sessions.machine_id
               AND ownership.harness = sessions.harness
               AND ownership.session_id = sessions.session_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_requests AS pending
             WHERE pending.machine_id = sessions.machine_id
               AND pending.harness = sessions.harness
               AND pending.session_id = sessions.session_id
               AND pending.state = 'open'
           )
           AND NOT EXISTS (
             SELECT 1 FROM resume_commands AS resume
             WHERE resume.machine_id = sessions.machine_id
               AND resume.harness = sessions.harness
               AND resume.session_id = sessions.session_id
               AND resume.state IN ('claimed', 'running')
           )`,
      )
      .get(input) as SessionAdoptionCandidateRow | undefined;
    return row === undefined
      ? undefined
      : this.sessionAdoptionCandidateFromRow(row);
  }

  private sessionAdoptionCandidateFromRow(
    row: SessionAdoptionCandidateRow,
  ): SessionAdoptionCandidateCheckpoint {
    const project = ProjectRefSchema.parse(
      JSON.parse(row.project_json) as unknown,
    );
    return {
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: "codex",
      surface: "cli",
      harnessVersion: row.harness_version,
      nativeSessionReference: row.session_id,
      expectedSequence: row.last_sequence,
      projectName: project.displayName,
      projectCwdHash: project.cwdHash,
      projectAuthorityDigest: `sha256:${sha256(row.project_json)}`,
      standaloneCapabilityDigest: sha256(row.capabilities_json),
      state: row.state,
      lastSeenAt: row.last_seen_at,
    };
  }

  public claimSessionForProduct(
    claim: SessionProductOwnershipClaim,
  ): SessionProductOwnershipResult {
    return this.database.transaction((): SessionProductOwnershipResult => {
      if (
        !boundedOwnershipIdentifier(claim.adoptionId) ||
        !/^[a-f0-9]{64}$/u.test(claim.requestFingerprint) ||
        !boundedOwnershipIdentifier(claim.machineId) ||
        claim.harness !== "codex" ||
        claim.surface !== "cli" ||
        !boundedOwnershipIdentifier(claim.sessionId) ||
        !boundedOwnershipIdentifier(claim.bridgeSessionId) ||
        !Number.isSafeInteger(claim.expectedSequence) ||
        claim.expectedSequence < 0 ||
        !/^sha256:[a-f0-9]{64}$/u.test(claim.projectAuthorityDigest) ||
        !/^[a-f0-9]{64}$/u.test(claim.capabilityDigest) ||
        typeof claim.harnessVersion !== "string" ||
        claim.harnessVersion.length < 1 ||
        claim.harnessVersion.length > 120 ||
        !/^[A-Za-z0-9][A-Za-z0-9._+ -]*$/u.test(claim.harnessVersion) ||
        !boundedOwnershipIdentifier(claim.productSessionId) ||
        !Number.isFinite(Date.parse(claim.claimedAt))
      ) {
        return { outcome: "rejected", safeCode: "adoption_claim_malformed" };
      }
      const sameAdoption = this.inspectSessionProductOwnership(
        claim.adoptionId,
      );
      if (sameAdoption) {
        return sameAdoption.requestFingerprint === claim.requestFingerprint &&
          sameAdoption.machineId === claim.machineId &&
          sameAdoption.harness === claim.harness &&
          sameAdoption.sessionId === claim.sessionId &&
          sameAdoption.productSessionId === claim.productSessionId
          ? { outcome: "duplicate" as const, receipt: sameAdoption }
          : {
              outcome: "rejected" as const,
              safeCode: "adoption_identity_conflict",
            };
      }
      const session = this.database
        .prepare(
          `SELECT machine_id, bridge_session_id, harness, surface,
                  harness_version, session_id, project_json, capabilities_json,
                  state, last_sequence
           FROM sessions
           WHERE machine_id = ? AND harness = ? AND session_id = ?`,
        )
        .get(claim.machineId, claim.harness, claim.sessionId) as
        | {
            machine_id: string;
            bridge_session_id: string;
            harness: Harness;
            surface: Surface;
            harness_version: string;
            session_id: string;
            project_json: string;
            capabilities_json: string;
            state: SessionRecord["state"];
            last_sequence: number;
          }
        | undefined;
      if (!session) {
        return { outcome: "rejected", safeCode: "session_not_found" };
      }
      if (
        session.harness !== "codex" ||
        session.surface !== "cli" ||
        !["active", "waiting"].includes(session.state)
      ) {
        return { outcome: "rejected", safeCode: "session_ineligible" };
      }
      if (
        session.bridge_session_id !== claim.bridgeSessionId ||
        session.harness_version !== claim.harnessVersion ||
        session.last_sequence !== claim.expectedSequence ||
        `sha256:${sha256(session.project_json)}` !==
          claim.projectAuthorityDigest ||
        sha256(session.capabilities_json) !== claim.capabilityDigest
      ) {
        return { outcome: "rejected", safeCode: "session_checkpoint_changed" };
      }
      if (
        this.sessionActuatorOwner(claim) === "product-managed" ||
        this.database
          .prepare(
            `SELECT 1 AS present FROM session_product_ownership
             WHERE product_session_id = ? LIMIT 1`,
          )
          .get(claim.productSessionId) !== undefined
      ) {
        return { outcome: "rejected", safeCode: "session_owner_conflict" };
      }
      const controls = this.database
        .prepare(
          `SELECT ended_at FROM session_controls
           WHERE machine_id = ? AND harness = ? AND session_id = ?`,
        )
        .get(claim.machineId, claim.harness, claim.sessionId) as
        { ended_at: string | null } | undefined;
      if (controls?.ended_at !== null && controls?.ended_at !== undefined) {
        return { outcome: "rejected", safeCode: "session_ineligible" };
      }
      const pending = this.database
        .prepare(
          `SELECT 1 AS present FROM pending_requests
           WHERE machine_id = ? AND harness = ? AND session_id = ?
             AND state = 'open' LIMIT 1`,
        )
        .get(claim.machineId, claim.harness, claim.sessionId);
      const resume = this.database
        .prepare(
          `SELECT 1 AS present FROM resume_commands
           WHERE machine_id = ? AND harness = ? AND session_id = ?
             AND state IN ('claimed', 'running') LIMIT 1`,
        )
        .get(claim.machineId, claim.harness, claim.sessionId);
      if (pending !== undefined || resume !== undefined) {
        return {
          outcome: "rejected",
          safeCode: "standalone_interaction_pending",
        };
      }
      this.database
        .prepare(
          `INSERT INTO session_product_ownership(
             adoption_id, request_fingerprint, machine_id, harness,
             session_id, product_session_id, claimed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.adoptionId,
          claim.requestFingerprint,
          claim.machineId,
          claim.harness,
          claim.sessionId,
          claim.productSessionId,
          claim.claimedAt,
        );
      const receipt = this.inspectSessionProductOwnership(claim.adoptionId);
      if (!receipt) {
        throw new Error("session ownership receipt did not commit");
      }
      return { outcome: "claimed", receipt };
    })();
  }

  public claimDueEvents(now: string, limit = 50): ClaimedEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("delivery claim limit must be between 1 and 500");
    }
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT event_id, payload_json, status, attempt_count
          FROM events
          WHERE status IN ('queued', 'retry')
            AND next_attempt_at <= ?
          ORDER BY created_at, event_id
          LIMIT ?
        `,
        )
        .all(now, limit) as EventRow[];

      const claimed: ClaimedEvent[] = [];
      for (const row of rows) {
        const attemptNumber = row.attempt_count + 1;
        const update = this.database
          .prepare(
            `
            UPDATE events SET
              status = 'delivering',
              attempt_count = ?,
              lease_started_at = ?
            WHERE event_id = ?
              AND status IN ('queued', 'retry')
          `,
          )
          .run(attemptNumber, now, row.event_id);
        if (update.changes !== 1) {
          continue;
        }
        this.database
          .prepare(
            `
            INSERT INTO delivery_attempts (
              event_id, attempt_number, status, started_at
            ) VALUES (?, ?, 'delivering', ?)
          `,
          )
          .run(row.event_id, attemptNumber, now);
        claimed.push({
          event: AgentAttentionEventV1Schema.parse(
            JSON.parse(row.payload_json) as unknown,
          ),
          attemptNumber,
        });
      }
      return claimed;
    })();
  }

  private markDeliveredWithinTransaction(
    eventId: string,
    attemptNumber: number,
    transportName: string,
    messageId: string,
    now: string,
    hostedInteraction?: {
      id: string;
      streamKey: string;
      type: HostedInteractionType;
    },
  ): number {
    const update = this.database
      .prepare(
        `
          UPDATE events SET
            status = 'delivered',
            transport_name = ?,
            transport_message_id = ?,
            delivered_at = ?,
            lease_started_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL
          WHERE event_id = ? AND status = 'delivering'
        `,
      )
      .run(transportName, messageId, now, eventId);
    this.database
      .prepare(
        `
          UPDATE delivery_attempts SET
            status = 'delivered',
            finished_at = ?
          WHERE event_id = ? AND attempt_number = ?
        `,
      )
      .run(now, eventId, attemptNumber);
    this.database
      .prepare(
        `
          UPDATE pending_requests SET transport_message_id = ?
          WHERE event_id = ?
        `,
      )
      .run(messageId, eventId);
    if (hostedInteraction !== undefined) {
      if (!/^[a-f0-9]{64}$/u.test(hostedInteraction.streamKey)) {
        throw new Error("hosted stream key must be a full SHA-256 digest");
      }
      this.database
        .prepare(
          `
          INSERT INTO hosted_delivery_mappings (
            event_id, stream_key, transport_name, message_id, interaction_id,
            interaction_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            stream_key = excluded.stream_key,
            transport_name = excluded.transport_name,
            message_id = excluded.message_id,
            interaction_id = excluded.interaction_id,
            interaction_type = excluded.interaction_type
        `,
        )
        .run(
          eventId,
          hostedInteraction.streamKey,
          transportName,
          messageId,
          hostedInteraction.id,
          hostedInteraction.type,
          now,
        );
    }
    return update.changes;
  }

  public markDelivered(
    eventId: string,
    attemptNumber: number,
    transportName: string,
    messageId: string,
    now: string,
    hostedInteraction?: {
      id: string;
      streamKey: string;
      type: HostedInteractionType;
    },
  ): void {
    const result = this.database.transaction(() =>
      this.markDeliveredWithinTransaction(
        eventId,
        attemptNumber,
        transportName,
        messageId,
        now,
        hostedInteraction,
      ),
    )();
    if (result !== 1) {
      throw new Error(`cannot mark non-delivering event ${eventId} delivered`);
    }
  }

  public findNotificationCoalescingTarget(input: {
    event: AgentAttentionEventV1;
    fingerprint: string;
    windowMs: number;
    now: string;
  }): NotificationGroupRecord | undefined {
    assertIsoCutoff(input.now, "notification coalescing time");
    if (
      !Number.isSafeInteger(input.windowMs) ||
      input.windowMs < 1 ||
      input.windowMs > 3_600_000
    ) {
      throw new Error(
        "notification coalescing window must be between 1 and 3600000 ms",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) {
      throw new Error("notification coalescing fingerprint is invalid");
    }
    const cutoff = new Date(
      Date.parse(input.now) - input.windowMs,
    ).toISOString();
    const row = this.database
      .prepare(
        `
        SELECT
          anchor_event_id, event_count, latest_occurred_at, transport_name,
          transport_message_id, topic_id
        FROM notification_groups
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
          AND event_type = @type
          AND fingerprint = @fingerprint
          AND updated_at >= @cutoff
          AND NOT EXISTS (
            SELECT 1
            FROM card_actions
            JOIN card_action_executions
              ON card_action_executions.action_token =
                card_actions.action_token
            WHERE card_actions.event_id =
              notification_groups.anchor_event_id
              AND card_actions.action_kind = 'details'
          )
        ORDER BY updated_at DESC, anchor_event_id DESC
        LIMIT 1
      `,
      )
      .get({
        ...input.event,
        fingerprint: input.fingerprint,
        cutoff,
      }) as
      | {
          anchor_event_id: string;
          event_count: number;
          latest_occurred_at: string;
          transport_name: string;
          transport_message_id: string;
          topic_id: string | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          anchorEventId: row.anchor_event_id,
          eventCount: row.event_count,
          latestOccurredAt: row.latest_occurred_at,
          transportName: row.transport_name,
          transportMessageId: row.transport_message_id,
          ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
        };
  }

  public markNotificationAnchorDelivered(input: {
    event: AgentAttentionEventV1;
    attemptNumber: number;
    fingerprint: string;
    transportName: string;
    messageId: string;
    topicId?: string;
    now: string;
  }): void {
    assertIsoCutoff(input.now, "notification anchor delivery time");
    const changed = this.database.transaction(() => {
      const delivered = this.markDeliveredWithinTransaction(
        input.event.eventId,
        input.attemptNumber,
        input.transportName,
        input.messageId,
        input.now,
      );
      if (delivered !== 1) {
        return delivered;
      }
      this.database
        .prepare(
          `
          INSERT INTO notification_groups (
            anchor_event_id, machine_id, harness, session_id, event_type,
            fingerprint, event_count, latest_occurred_at, transport_name,
            transport_message_id, topic_id, created_at, updated_at
          ) VALUES (
            @eventId, @machineId, @harness, @sessionId, @type, @fingerprint,
            1, @occurredAt, @transportName, @messageId, @topicId, @now, @now
          )
        `,
        )
        .run({
          ...input.event,
          fingerprint: input.fingerprint,
          transportName: input.transportName,
          messageId: input.messageId,
          topicId: input.topicId ?? null,
          now: input.now,
        });
      this.database
        .prepare(
          `
          INSERT INTO notification_group_members (
            event_id, anchor_event_id, joined_at
          ) VALUES (?, ?, ?)
        `,
        )
        .run(input.event.eventId, input.event.eventId, input.now);
      return delivered;
    })();
    if (changed !== 1) {
      throw new Error(
        `cannot mark non-delivering event ${input.event.eventId} delivered`,
      );
    }
  }

  public markNotificationCoalesced(input: {
    event: AgentAttentionEventV1;
    attemptNumber: number;
    anchorEventId: string;
    expectedEventCount: number;
    now: string;
  }): NotificationGroupRecord {
    assertIsoCutoff(input.now, "notification coalescing completion time");
    return this.database.transaction(() => {
      const group = this.database
        .prepare(
          `
          SELECT
            event_count, latest_occurred_at, transport_name,
            transport_message_id, topic_id
          FROM notification_groups
          WHERE anchor_event_id = ?
        `,
        )
        .get(input.anchorEventId) as
        | {
            event_count: number;
            latest_occurred_at: string;
            transport_name: string;
            transport_message_id: string;
            topic_id: string | null;
          }
        | undefined;
      if (group === undefined) {
        throw new Error("notification coalescing anchor disappeared");
      }
      if (group.event_count !== input.expectedEventCount) {
        throw new Error("notification coalescing anchor changed concurrently");
      }
      const joined = this.database
        .prepare(
          `
          INSERT OR IGNORE INTO notification_group_members (
            event_id, anchor_event_id, joined_at
          ) VALUES (?, ?, ?)
        `,
        )
        .run(input.event.eventId, input.anchorEventId, input.now).changes;
      if (joined !== 1) {
        throw new Error("notification event was already coalesced");
      }
      const latestOccurredAt =
        input.event.occurredAt > group.latest_occurred_at
          ? input.event.occurredAt
          : group.latest_occurred_at;
      const updated = this.database
        .prepare(
          `
          UPDATE notification_groups SET
            event_count = event_count + 1,
            latest_occurred_at = ?,
            updated_at = ?
          WHERE anchor_event_id = ? AND event_count = ?
        `,
        )
        .run(
          latestOccurredAt,
          input.now,
          input.anchorEventId,
          input.expectedEventCount,
        ).changes;
      if (updated !== 1) {
        throw new Error("notification coalescing anchor changed concurrently");
      }
      const delivered = this.markDeliveredWithinTransaction(
        input.event.eventId,
        input.attemptNumber,
        group.transport_name,
        group.transport_message_id,
        input.now,
      );
      if (delivered !== 1) {
        throw new Error(
          `cannot mark non-delivering event ${input.event.eventId} delivered`,
        );
      }
      this.recordDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_coalesced_${sha256(input.event.eventId).slice(0, 40)}`,
        recordedAt: input.now,
        source: "daemon",
        level: "info",
        code: "notification.coalesced",
        message:
          "equivalent routine event coalesced into an existing session card",
      });
      return {
        anchorEventId: input.anchorEventId,
        eventCount: input.expectedEventCount + 1,
        latestOccurredAt,
        transportName: group.transport_name,
        transportMessageId: group.transport_message_id,
        ...(group.topic_id === null ? {} : { topicId: group.topic_id }),
      };
    })();
  }

  public notificationDetails(eventId: string, limit = 10): NotificationDetails {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("notification detail limit must be between 1 and 50");
    }
    const group = this.database
      .prepare(
        `
        SELECT groups.anchor_event_id, groups.event_count
        FROM notification_groups AS groups
        JOIN notification_group_members AS members
          ON members.anchor_event_id = groups.anchor_event_id
        WHERE members.event_id = ?
      `,
      )
      .get(eventId) as
      { anchor_event_id: string; event_count: number } | undefined;
    if (group === undefined) {
      const event = this.getEvent(eventId)?.event;
      return {
        events: event === undefined ? [] : [event],
        totalCount: event === undefined ? 0 : 1,
      };
    }
    const rows = this.database
      .prepare(
        `
        SELECT events.payload_json
        FROM notification_group_members AS members
        JOIN events ON events.event_id = members.event_id
        WHERE members.anchor_event_id = ?
        ORDER BY
          CAST(json_extract(events.payload_json, '$.sequence') AS INTEGER)
            DESC,
          events.created_at DESC,
          events.event_id DESC
        LIMIT ?
      `,
      )
      .all(group.anchor_event_id, limit) as Array<{ payload_json: string }>;
    return {
      events: rows
        .map((row) =>
          AgentAttentionEventV1Schema.parse(
            JSON.parse(row.payload_json) as unknown,
          ),
        )
        .reverse(),
      totalCount: group.event_count,
    };
  }

  public markDeliveryFailed(
    eventId: string,
    attemptNumber: number,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    now: string,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    retryAfterMs?: number,
  ): DeliveryStatus {
    if (
      retryAfterMs !== undefined &&
      (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
    ) {
      throw new Error("provider retry delay must be a non-negative integer");
    }
    const exhausted = attemptNumber >= policy.maxAttempts;
    const status: DeliveryStatus =
      retryable && !exhausted ? "retry" : "dead_letter";
    const delay = Math.max(
      retryDelay(policy, attemptNumber),
      Math.min(retryAfterMs ?? 0, MAX_PROVIDER_RETRY_AFTER_MS),
    );
    const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
    const changes = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `
          UPDATE events SET
            status = @status,
            next_attempt_at = @nextAttemptAt,
            lease_started_at = NULL,
            last_error_code = @errorCode,
            last_error_message = @errorMessage
          WHERE event_id = @eventId AND status = 'delivering'
        `,
        )
        .run({
          eventId,
          status,
          nextAttemptAt,
          errorCode,
          errorMessage: errorMessage.slice(0, 2_000),
        });
      this.database
        .prepare(
          `
          UPDATE delivery_attempts SET
            status = @status,
            finished_at = @now,
            error_code = @errorCode,
            error_message = @errorMessage
          WHERE event_id = @eventId AND attempt_number = @attemptNumber
        `,
        )
        .run({
          eventId,
          attemptNumber,
          status,
          now,
          errorCode,
          errorMessage: errorMessage.slice(0, 2_000),
        });
      return update.changes;
    })();
    if (changes !== 1) {
      throw new Error(`cannot fail non-delivering event ${eventId}`);
    }
    return status;
  }

  public recoverInterruptedDeliveries(now: string): number {
    const result = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT event_id, attempt_count
          FROM events WHERE status = 'delivering'
        `,
        )
        .all() as Array<{ event_id: string; attempt_count: number }>;
      for (const row of rows) {
        this.database
          .prepare(
            `
            UPDATE delivery_attempts SET
              status = 'retry',
              finished_at = ?,
              error_code = 'delivery-interrupted',
              error_message = 'daemon stopped during delivery'
            WHERE event_id = ? AND attempt_number = ?
          `,
          )
          .run(now, row.event_id, row.attempt_count);
      }
      return this.database
        .prepare(
          `
          UPDATE events SET
            status = 'retry',
            next_attempt_at = ?,
            lease_started_at = NULL,
            last_error_code = 'delivery-interrupted',
            last_error_message = 'daemon stopped during delivery'
          WHERE status = 'delivering'
        `,
        )
        .run(now).changes;
    })();
    return result;
  }

  public quarantineStaleBacklog(input: StaleBacklogQuarantineInput): number {
    assertIsoCutoff(input.cutoff, "stale backlog cutoff");
    assertIsoCutoff(input.now, "stale backlog quarantine time");
    if (input.cutoff > input.now) {
      throw new Error("stale backlog cutoff cannot be in the future");
    }
    return this.database
      .prepare(
        `
        UPDATE events SET
          status = 'dead_letter',
          next_attempt_at = @now,
          lease_started_at = NULL,
          last_error_code = 'delivery-stale-backlog',
          last_error_message =
            'Event exceeded the startup backlog age before transport delivery'
        WHERE status IN ('queued', 'retry')
          AND created_at < @cutoff
          AND type <> 'process.exited'
          AND NOT EXISTS (
            SELECT 1
            FROM pending_requests AS pending
            WHERE pending.event_id = events.event_id
              AND pending.state = 'open'
              AND pending.expires_at > @now
          )
      `,
      )
      .run(input).changes;
  }

  public getEvent(
    eventId: string,
  ): { event: AgentAttentionEventV1; status: DeliveryStatus } | undefined {
    const row = this.database
      .prepare(
        `
        SELECT event_id, payload_json, status, attempt_count
        FROM events WHERE event_id = ?
      `,
      )
      .get(eventId) as EventRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      event: AgentAttentionEventV1Schema.parse(
        JSON.parse(row.payload_json) as unknown,
      ),
      status: row.status,
    };
  }

  public getLatestEventForSession(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): { event: AgentAttentionEventV1; status: DeliveryStatus } | undefined {
    const row = this.database
      .prepare(
        `
        SELECT event_id
        FROM events
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
        ORDER BY
          CAST(json_extract(payload_json, '$.sequence') AS INTEGER) DESC,
          created_at DESC,
          event_id DESC
        LIMIT 1
      `,
      )
      .get(input) as { event_id: string } | undefined;
    return row === undefined ? undefined : this.getEvent(row.event_id);
  }

  public getDeliveryReceiptForEvent(
    eventId: string,
  ): { transportName: string; messageId: string } | undefined {
    const row = this.database
      .prepare(
        `
        SELECT transport_name, transport_message_id
        FROM events
        WHERE event_id = ?
          AND transport_name IS NOT NULL
          AND transport_message_id IS NOT NULL
      `,
      )
      .get(eventId) as
      { transport_name: string; transport_message_id: string } | undefined;
    return row === undefined
      ? undefined
      : {
          transportName: row.transport_name,
          messageId: row.transport_message_id,
        };
  }

  public registerCardActions(
    eventId: string,
    actions: Array<{ token: string; kind: CardActionKind }>,
    now: string,
  ): CardActionRecord[] {
    assertIsoCutoff(now, "card action registration time");
    return this.database.transaction(() => {
      for (const action of actions) {
        const token = CardActionTokenSchema.parse(action.token);
        const kind = CardActionKindSchema.parse(action.kind);
        this.database
          .prepare(
            `
            INSERT OR IGNORE INTO card_actions (
              action_token, event_id, action_kind, created_at
            ) VALUES (?, ?, ?, ?)
          `,
          )
          .run(token, eventId, kind, now);
        const existing = this.getCardAction(token);
        if (
          existing === undefined ||
          existing.eventId !== eventId ||
          existing.kind !== kind
        ) {
          throw new Error(`card action token collision for ${token}`);
        }
      }
      return actions.map((action) => {
        const registered = this.getCardAction(action.token);
        if (registered === undefined) {
          throw new Error(`card action ${action.token} disappeared`);
        }
        return registered;
      });
    })();
  }

  public getCardAction(token: string): CardActionRecord | undefined {
    const parsed = CardActionTokenSchema.safeParse(token);
    if (!parsed.success) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `
        SELECT
          actions.action_token,
          actions.event_id,
          actions.action_kind,
          actions.created_at,
          executions.state AS execution_state,
          executions.update_id,
          executions.claimed_at,
          executions.finished_at,
          executions.outcome,
          executions.error_message
        FROM card_actions AS actions
        LEFT JOIN card_action_executions AS executions
          ON executions.action_token = actions.action_token
        WHERE actions.action_token = ?
      `,
      )
      .get(parsed.data) as CardActionRow | undefined;
    return row === undefined
      ? undefined
      : {
          token: row.action_token,
          eventId: row.event_id,
          kind: row.action_kind,
          createdAt: row.created_at,
          state: row.execution_state ?? "open",
          ...(row.update_id === null ? {} : { updateId: row.update_id }),
          ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
          ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
          ...(row.outcome === null ? {} : { outcome: row.outcome }),
          ...(row.error_message === null
            ? {}
            : { errorMessage: row.error_message }),
        };
  }

  private finishCardActionExecution(input: {
    token: string;
    state: "succeeded" | "failed";
    outcome: string;
    now: string;
    errorMessage?: string;
  }): CardActionRecord {
    const changes = this.database
      .prepare(
        `
        UPDATE card_action_executions SET
          state = @state,
          finished_at = @now,
          outcome = @outcome,
          error_message = @errorMessage
        WHERE action_token = @token AND state = 'claimed'
      `,
      )
      .run({
        ...input,
        errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
      }).changes;
    if (changes !== 1) {
      throw new Error(`card action ${input.token} is not claimed`);
    }
    const action = this.getCardAction(input.token);
    if (action === undefined) {
      throw new Error(`card action ${input.token} disappeared`);
    }
    return action;
  }

  private upsertSessionControl(
    event: AgentAttentionEventV1,
    field: "muted_at" | "ended_at",
    now: string,
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO session_controls (
          machine_id, harness, session_id, ${field}, updated_at
        ) VALUES (
          @machineId, @harness, @sessionId, @now, @now
        )
        ON CONFLICT(machine_id, harness, session_id) DO UPDATE SET
          ${field} = excluded.${field},
          updated_at = excluded.updated_at
      `,
      )
      .run({ ...event, now });
  }

  public executeCardAction(input: {
    token: string;
    kind: CardActionKind;
    updateId: number;
    now: string;
    resolvedBy?: "telegram" | "web";
  }): CardActionExecutionResult {
    assertIsoCutoff(input.now, "card action execution time");
    if (!Number.isSafeInteger(input.updateId) || input.updateId < 0) {
      throw new Error("card action update id must be a non-negative integer");
    }
    return this.database.transaction((): CardActionExecutionResult => {
      const action = this.getCardAction(input.token);
      if (action === undefined) {
        return { outcome: "not_found" };
      }
      if (action.kind !== input.kind) {
        return { outcome: "kind_mismatch", action };
      }
      if (action.state !== "open") {
        return { outcome: "duplicate", action };
      }
      const eventRecord = this.getEvent(action.eventId);
      if (eventRecord === undefined) {
        return { outcome: "not_found", action };
      }
      this.expireRequests(input.now);
      const pending = this.getPendingForEvent(action.eventId);
      if (
        input.kind === "end" &&
        pending !== undefined &&
        pending.state === "open"
      ) {
        return {
          outcome: "blocked",
          action,
          reason: "answer the pending question before ending this relay lane",
        };
      }
      const claimed = this.database
        .prepare(
          `
          INSERT OR IGNORE INTO card_action_executions (
            action_token, state, update_id, claimed_at
          ) VALUES (?, 'claimed', ?, ?)
        `,
        )
        .run(input.token, input.updateId, input.now).changes;
      if (claimed !== 1) {
        const raced = this.getCardAction(input.token);
        if (raced === undefined) {
          return { outcome: "not_found" };
        }
        return { outcome: "duplicate", action: raced };
      }
      if (input.kind === "details") {
        const current = this.getCardAction(input.token);
        if (current === undefined) {
          throw new Error(`claimed card action ${input.token} disappeared`);
        }
        return { outcome: "claimed", action: current };
      }
      if (input.kind === "continue") {
        if (
          pending?.requestKind !== "continuation" ||
          (!eventRecord.event.capabilities.inlineContinue &&
            !eventRecord.event.capabilities.lateResume)
        ) {
          return {
            outcome: "stale",
            action: this.finishCardActionExecution({
              token: input.token,
              state: "failed",
              outcome: "continuation-unavailable",
              now: input.now,
              errorMessage:
                "event no longer has a supported continuation request",
            }),
          };
        }
        const resolution = this.resolveRequest({
          correlationId: pending.correlationId,
          answer: "Continue.",
          resolvedBy: input.resolvedBy ?? "telegram",
          now: input.now,
          expected: {
            machineId: pending.machineId,
            harness: pending.harness,
            sessionId: pending.sessionId,
            ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
          },
        });
        if (resolution.outcome !== "answered") {
          return {
            outcome: "stale",
            action: this.finishCardActionExecution({
              token: input.token,
              state: "failed",
              outcome: `continuation-${resolution.outcome}`,
              now: input.now,
              errorMessage: "continuation request is no longer actionable",
            }),
          };
        }
      } else if (input.kind === "mute") {
        this.upsertSessionControl(eventRecord.event, "muted_at", input.now);
      } else {
        this.upsertSessionControl(eventRecord.event, "ended_at", input.now);
      }
      return {
        outcome: "succeeded",
        action: this.finishCardActionExecution({
          token: input.token,
          state: "succeeded",
          outcome: input.kind,
          now: input.now,
        }),
      };
    })();
  }

  public executeBrowserCardAction(input: {
    operationId: string;
    eventId: string;
    token: string;
    kind: Exclude<CardActionKind, "details">;
    now: string;
  }): BrowserSessionActionResult {
    const replay = this.replayBrowserCardAction(input);
    if (replay !== undefined) {
      return replay;
    }
    const payloadHash = sha256(JSON.stringify([input.eventId, input.kind]));
    return this.database.transaction((): BrowserSessionActionResult => {
      const racedReplay = this.replayBrowserCardAction(input);
      if (racedReplay !== undefined) {
        return racedReplay;
      }
      const execution = this.executeCardAction({
        token: input.token,
        kind: input.kind,
        updateId: Number.parseInt(sha256(input.operationId).slice(0, 12), 16),
        now: input.now,
        resolvedBy: "web",
      });
      this.database
        .prepare(
          `
          INSERT INTO browser_commands (
            operation_id, correlation_id, payload_hash, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.operationId,
          input.eventId,
          payloadHash,
          execution.outcome,
          input.now,
        );
      return { ...execution, replayed: false };
    })();
  }

  public replayBrowserCardAction(input: {
    operationId: string;
    eventId: string;
    token: string;
    kind: Exclude<CardActionKind, "details">;
  }): BrowserSessionActionResult | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.operationId)) {
      throw new Error("browser operation id is malformed");
    }
    const payloadHash = sha256(JSON.stringify([input.eventId, input.kind]));
    const prior = this.database
      .prepare(
        `
          SELECT correlation_id, payload_hash, outcome
          FROM browser_commands
          WHERE operation_id = ?
        `,
      )
      .get(input.operationId) as
      | {
          correlation_id: string;
          payload_hash: string;
          outcome: BrowserSessionActionOutcome;
        }
      | undefined;
    if (prior === undefined) {
      return undefined;
    }
    if (
      prior.correlation_id !== input.eventId ||
      prior.payload_hash !== payloadHash
    ) {
      return { outcome: "replay_conflict", replayed: true };
    }
    const action = this.getCardAction(input.token);
    return {
      outcome: prior.outcome,
      replayed: true,
      ...(action === undefined ? {} : { action }),
    };
  }

  public finishCardAction(input: {
    token: string;
    succeeded: boolean;
    outcome: string;
    now: string;
    errorMessage?: string;
  }): CardActionRecord {
    assertIsoCutoff(input.now, "card action completion time");
    return this.finishCardActionExecution({
      ...input,
      state: input.succeeded ? "succeeded" : "failed",
    });
  }

  private controlFromRow(row: SessionControlRow): SessionControlRecord {
    return {
      machineId: row.machine_id,
      harness: row.harness,
      sessionId: row.session_id,
      ...(row.muted_at === null ? {} : { mutedAt: row.muted_at }),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      updatedAt: row.updated_at,
    };
  }

  public getSessionControl(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): SessionControlRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT machine_id, harness, session_id, muted_at, ended_at, updated_at
        FROM session_controls
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
      `,
      )
      .get(input) as SessionControlRow | undefined;
    return row === undefined ? undefined : this.controlFromRow(row);
  }

  public listSessionControls(): SessionControlRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT machine_id, harness, session_id, muted_at, ended_at, updated_at
        FROM session_controls
        ORDER BY updated_at DESC, machine_id, harness, session_id
      `,
      )
      .all() as SessionControlRow[];
    return rows.map((row) => this.controlFromRow(row));
  }

  private topicCleanupFromRow(
    row: TopicCleanupOperationRow,
  ): TopicCleanupOperationRecord {
    const candidates = TopicCleanupCandidatesSchema.parse(
      JSON.parse(row.candidates_json) as unknown,
    ).map((candidate): TopicCleanupCandidateRecord => ({
      machineId: candidate.machineId,
      harness: candidate.harness,
      sessionId: candidate.sessionId,
      topicId: candidate.topicId,
      repository: candidate.repository,
      shortSessionId: candidate.shortSessionId,
      ...(candidate.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: candidate.lastActivityAt }),
      state: candidate.state,
      attemptCount: candidate.attemptCount,
      nextAttemptAt: candidate.nextAttemptAt,
      ...(candidate.lastErrorCode === undefined
        ? {}
        : { lastErrorCode: candidate.lastErrorCode }),
    }));
    return {
      operationId: row.operation_id,
      transportName: row.transport_name,
      transportScope: row.transport_scope,
      mode: TopicCleanupModeSchema.parse(row.selection_mode),
      ...(row.inactive_before === null
        ? {}
        : {
            inactiveBefore: z.iso
              .datetime({ offset: true })
              .parse(row.inactive_before),
          }),
      state: row.state,
      eligibleCount: row.eligible_count,
      candidates,
      ...(row.preview_message_id === null
        ? {}
        : { previewMessageId: row.preview_message_id }),
      ...(row.decision_update_id === null
        ? {}
        : { decisionUpdateId: row.decision_update_id }),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      updatedAt: row.updated_at,
      ...(row.last_error_code === null
        ? {}
        : { lastErrorCode: row.last_error_code }),
    };
  }

  private getTopicCleanupRow(
    operationId: string,
  ): TopicCleanupOperationRow | undefined {
    return this.database
      .prepare(
        `
        SELECT *
        FROM topic_cleanup_operations
        WHERE operation_id = ?
      `,
      )
      .get(operationId) as TopicCleanupOperationRow | undefined;
  }

  public getTopicCleanupOperation(
    operationId: string,
  ): TopicCleanupOperationRecord | undefined {
    const row = this.getTopicCleanupRow(operationId);
    return row === undefined ? undefined : this.topicCleanupFromRow(row);
  }

  public listTopicCleanupOperations(): TopicCleanupOperationRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM topic_cleanup_operations
        ORDER BY created_at, operation_id
      `,
      )
      .all() as TopicCleanupOperationRow[];
    return rows.map((row) => this.topicCleanupFromRow(row));
  }

  private topicCleanupEligibilityWhere(mode: TopicCleanupMode): string {
    const selection =
      mode === "proven-dead"
        ? `(
          controls.ended_at IS NOT NULL
          OR sessions.last_event_type = 'session.ended'
        )`
        : `(
          topics.updated_at <= @inactiveBefore
          AND controls.ended_at IS NULL
          AND (
            sessions.last_event_type IS NULL
            OR sessions.last_event_type <> 'session.ended'
          )
        )`;
    return `
      topics.transport_name = @transportName
      AND topics.transport_scope = @transportScope
      AND topics.provisioning_status = 'ready'
      AND topics.topic_id IS NOT NULL
      AND ${selection}
      AND sessions.state <> 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM pending_requests AS pending
        WHERE pending.machine_id = topics.machine_id
          AND pending.harness = topics.harness
          AND pending.session_id = topics.session_id
          AND pending.state = 'open'
          AND pending.expires_at > @now
      )
      AND NOT EXISTS (
        SELECT 1
        FROM resume_commands AS resume
        WHERE resume.machine_id = topics.machine_id
          AND resume.harness = topics.harness
          AND resume.session_id = topics.session_id
          AND resume.state IN ('claimed', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM events AS event
        WHERE event.machine_id = topics.machine_id
          AND event.harness = topics.harness
          AND event.session_id = topics.session_id
          AND event.status IN ('queued', 'retry', 'delivering')
      )
    `;
  }

  public createTopicCleanupPreview(input: {
    operationId: string;
    transportName: string;
    transportScope: string;
    now: string;
    expiresAt: string;
    mode?: TopicCleanupMode;
    inactiveBefore?: string;
    limit?: number;
  }): TopicCleanupOperationRecord {
    assertIsoCutoff(input.now, "topic cleanup preview time");
    assertIsoCutoff(input.expiresAt, "topic cleanup preview expiry");
    if (input.expiresAt <= input.now) {
      throw new Error("topic cleanup preview expiry must be in the future");
    }
    const mode = TopicCleanupModeSchema.parse(input.mode ?? "proven-dead");
    const inactiveBefore =
      mode === "inactive" ? input.inactiveBefore : undefined;
    if (mode === "inactive") {
      if (inactiveBefore === undefined) {
        throw new Error("inactive topic cleanup requires an inactivity cutoff");
      }
      assertIsoCutoff(inactiveBefore, "inactive topic cleanup cutoff");
      if (inactiveBefore >= input.now) {
        throw new Error(
          "inactive topic cleanup cutoff must be before the preview time",
        );
      }
    } else if (input.inactiveBefore !== undefined) {
      throw new Error(
        "proven-dead topic cleanup does not accept an inactivity cutoff",
      );
    }
    if (
      input.operationId.length < 16 ||
      input.operationId.length > 64 ||
      !/^[A-Za-z0-9_-]+$/u.test(input.operationId)
    ) {
      throw new Error("topic cleanup operation id is outside supported bounds");
    }
    if (
      input.transportName.trim().length === 0 ||
      input.transportName.length > 120 ||
      input.transportScope.trim().length === 0 ||
      input.transportScope.length > 160
    ) {
      throw new Error("topic cleanup transport identity is invalid");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("topic cleanup preview limit must be between 1 and 100");
    }
    return this.database.transaction(() => {
      this.database
        .prepare(
          `
          UPDATE topic_cleanup_operations SET
            state = 'superseded',
            finished_at = @now,
            updated_at = @now,
            last_error_code = 'topic-cleanup-superseded',
            last_error_message =
              'A newer cleanup preview replaced this confirmation'
          WHERE transport_name = @transportName
            AND transport_scope = @transportScope
            AND state = 'previewed'
        `,
        )
        .run(input);
      const from = `
        FROM session_topics AS topics
        JOIN sessions
          ON sessions.machine_id = topics.machine_id
          AND sessions.harness = topics.harness
          AND sessions.session_id = topics.session_id
        LEFT JOIN session_controls AS controls
          ON controls.machine_id = topics.machine_id
          AND controls.harness = topics.harness
          AND controls.session_id = topics.session_id
        WHERE ${this.topicCleanupEligibilityWhere(mode)}
      `;
      const queryInput = {
        ...input,
        mode,
        inactiveBefore: inactiveBefore ?? null,
      };
      const eligibleCount = (
        this.database
          .prepare(`SELECT COUNT(*) AS count ${from}`)
          .get(queryInput) as { count: number }
      ).count;
      const rows = this.database
        .prepare(
          `
          SELECT
            topics.machine_id,
            topics.harness,
            topics.session_id,
            topics.topic_id,
            topics.repository,
            topics.short_session_id,
            topics.updated_at
          ${from}
          ORDER BY topics.updated_at, topics.machine_id, topics.harness,
            topics.session_id
          LIMIT @limit
        `,
        )
        .all({ ...queryInput, limit }) as Array<{
        machine_id: string;
        harness: Harness;
        session_id: string;
        topic_id: string;
        repository: string;
        short_session_id: string;
        updated_at: string;
      }>;
      const candidates: TopicCleanupCandidateRecord[] = rows.map((row) => ({
        machineId: row.machine_id,
        harness: row.harness,
        sessionId: row.session_id,
        topicId: row.topic_id,
        repository: row.repository,
        shortSessionId: row.short_session_id,
        lastActivityAt: row.updated_at,
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: input.now,
      }));
      TopicCleanupCandidatesSchema.parse(candidates);
      this.database
        .prepare(
          `
          INSERT INTO topic_cleanup_operations (
            operation_id, transport_name, transport_scope, selection_mode,
            inactive_before, state, eligible_count, candidates_json,
            created_at, expires_at, finished_at, updated_at
          ) VALUES (
            @operationId, @transportName, @transportScope, @mode,
            @inactiveBefore, @state, @eligibleCount, @candidatesJson,
            @now, @expiresAt, @finishedAt, @now
          )
        `,
        )
        .run({
          ...queryInput,
          state: candidates.length === 0 ? "completed" : "previewed",
          eligibleCount,
          candidatesJson: JSON.stringify(candidates),
          finishedAt: candidates.length === 0 ? input.now : null,
        });
      return this.getTopicCleanupOperation(input.operationId)!;
    })();
  }

  public attachTopicCleanupPreview(input: {
    operationId: string;
    messageId: string;
    now: string;
  }): TopicCleanupOperationRecord {
    assertIsoCutoff(input.now, "topic cleanup preview attachment time");
    if (input.messageId.length < 1 || input.messageId.length > 128) {
      throw new Error("topic cleanup preview message id is invalid");
    }
    return this.database.transaction(() => {
      const row = this.getTopicCleanupRow(input.operationId);
      if (row === undefined) {
        throw new Error("topic cleanup preview does not exist");
      }
      if (
        row.preview_message_id !== null &&
        row.preview_message_id !== input.messageId
      ) {
        throw new Error("topic cleanup preview message id changed");
      }
      this.database
        .prepare(
          `
          UPDATE topic_cleanup_operations SET
            preview_message_id = @messageId,
            updated_at = @now
          WHERE operation_id = @operationId
        `,
        )
        .run(input);
      return this.getTopicCleanupOperation(input.operationId)!;
    })();
  }

  public failTopicCleanupPreview(input: {
    operationId: string;
    errorCode: string;
    errorMessage: string;
    now: string;
  }): TopicCleanupOperationRecord {
    assertIsoCutoff(input.now, "topic cleanup preview failure time");
    this.database
      .prepare(
        `
        UPDATE topic_cleanup_operations SET
          state = 'preview-failed',
          finished_at = @now,
          updated_at = @now,
          last_error_code = @errorCode,
          last_error_message = @errorMessage
        WHERE operation_id = @operationId
          AND preview_message_id IS NULL
          AND state IN ('previewed', 'completed')
      `,
      )
      .run({
        ...input,
        errorMessage: input.errorMessage.slice(0, 2_000),
      });
    const operation = this.getTopicCleanupOperation(input.operationId);
    if (operation === undefined) {
      throw new Error("topic cleanup preview does not exist");
    }
    return operation;
  }

  public expireTopicCleanupPreviews(now: string): number {
    assertIsoCutoff(now, "topic cleanup expiry time");
    return this.database
      .prepare(
        `
        UPDATE topic_cleanup_operations SET
          state = 'expired',
          finished_at = @now,
          updated_at = @now,
          last_error_code = 'topic-cleanup-expired',
          last_error_message = 'Cleanup confirmation expired'
        WHERE state = 'previewed'
          AND expires_at <= @now
      `,
      )
      .run({ now }).changes;
  }

  public decideTopicCleanup(input: {
    operationId: string;
    action: "confirm" | "cancel";
    messageId: string;
    updateId: number;
    now: string;
  }): TopicCleanupDecisionResult {
    assertIsoCutoff(input.now, "topic cleanup decision time");
    if (!Number.isSafeInteger(input.updateId) || input.updateId < 0) {
      throw new Error("topic cleanup update id is invalid");
    }
    return this.database.transaction((): TopicCleanupDecisionResult => {
      let operation = this.getTopicCleanupOperation(input.operationId);
      if (operation === undefined) {
        return { outcome: "not-found" };
      }
      if (operation.previewMessageId !== input.messageId) {
        return { outcome: "message-mismatch", operation };
      }
      if (operation.state === "previewed" && operation.expiresAt <= input.now) {
        this.expireTopicCleanupPreviews(input.now);
        operation = this.getTopicCleanupOperation(input.operationId)!;
        return { outcome: "expired", operation };
      }
      if (
        operation.state === "claimed" ||
        operation.state === "completed" ||
        operation.state === "completed-with-errors"
      ) {
        return { outcome: "duplicate", operation };
      }
      if (operation.state !== "previewed") {
        return {
          outcome: operation.state === "expired" ? "expired" : "not-ready",
          operation,
        };
      }
      const state = input.action === "confirm" ? "claimed" : "cancelled";
      this.database
        .prepare(
          `
          UPDATE topic_cleanup_operations SET
            state = @state,
            decision_update_id = @updateId,
            claimed_at = @claimedAt,
            finished_at = @finishedAt,
            updated_at = @now
          WHERE operation_id = @operationId
            AND state = 'previewed'
        `,
        )
        .run({
          ...input,
          state,
          claimedAt: input.action === "confirm" ? input.now : null,
          finishedAt: input.action === "cancel" ? input.now : null,
        });
      operation = this.getTopicCleanupOperation(input.operationId)!;
      return {
        outcome: input.action === "confirm" ? "claimed" : "cancelled",
        operation,
      };
    })();
  }

  private topicCleanupCandidateEligible(
    operation: TopicCleanupOperationRecord,
    candidate: TopicCleanupCandidateRecord,
    now: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `
          SELECT 1
          FROM session_topics AS topics
          JOIN sessions
            ON sessions.machine_id = topics.machine_id
            AND sessions.harness = topics.harness
            AND sessions.session_id = topics.session_id
          LEFT JOIN session_controls AS controls
            ON controls.machine_id = topics.machine_id
            AND controls.harness = topics.harness
            AND controls.session_id = topics.session_id
          WHERE ${this.topicCleanupEligibilityWhere(operation.mode)}
            AND topics.machine_id = @machineId
            AND topics.harness = @harness
            AND topics.session_id = @sessionId
            AND topics.topic_id = @topicId
        `,
        )
        .get({
          ...candidate,
          transportName: operation.transportName,
          transportScope: operation.transportScope,
          inactiveBefore: operation.inactiveBefore ?? null,
          now,
        }) !== undefined
    );
  }

  private saveTopicCleanupCandidates(input: {
    operationId: string;
    candidates: TopicCleanupCandidateRecord[];
    now: string;
  }): void {
    TopicCleanupCandidatesSchema.parse(input.candidates);
    this.database
      .prepare(
        `
        UPDATE topic_cleanup_operations SET
          candidates_json = @candidatesJson,
          updated_at = @now
        WHERE operation_id = @operationId
      `,
      )
      .run({
        ...input,
        candidatesJson: JSON.stringify(input.candidates),
      });
  }

  private finalizeTopicCleanupOperation(
    operationId: string,
    candidates: TopicCleanupCandidateRecord[],
    now: string,
  ): { operation: TopicCleanupOperationRecord; becameTerminal: boolean } {
    if (
      !candidates.every((candidate) => topicCleanupIsTerminal(candidate.state))
    ) {
      this.saveTopicCleanupCandidates({ operationId, candidates, now });
      return {
        operation: this.getTopicCleanupOperation(operationId)!,
        becameTerminal: false,
      };
    }
    const prior = this.getTopicCleanupOperation(operationId)!;
    const state = candidates.some((candidate) => candidate.state === "failed")
      ? "completed-with-errors"
      : "completed";
    this.database
      .prepare(
        `
        UPDATE topic_cleanup_operations SET
          state = @state,
          candidates_json = @candidatesJson,
          finished_at = @now,
          updated_at = @now
        WHERE operation_id = @operationId
          AND state = 'claimed'
      `,
      )
      .run({
        operationId,
        state,
        candidatesJson: JSON.stringify(candidates),
        now,
      });
    return {
      operation: this.getTopicCleanupOperation(operationId)!,
      becameTerminal: prior.state === "claimed",
    };
  }

  public recoverInterruptedTopicCleanups(now: string): number {
    assertIsoCutoff(now, "topic cleanup recovery time");
    return this.database.transaction(() => {
      this.expireTopicCleanupPreviews(now);
      const rows = this.database
        .prepare(
          `
          SELECT *
          FROM topic_cleanup_operations
          WHERE state = 'claimed'
          ORDER BY created_at, operation_id
        `,
        )
        .all() as TopicCleanupOperationRow[];
      let recovered = 0;
      for (const row of rows) {
        const operation = this.topicCleanupFromRow(row);
        const candidates = operation.candidates.map((candidate) => {
          if (candidate.state !== "deleting") {
            return candidate;
          }
          recovered += 1;
          return {
            ...candidate,
            state: "retry" as const,
            nextAttemptAt: now,
            lastErrorCode: "topic-cleanup-interrupted",
          };
        });
        this.saveTopicCleanupCandidates({
          operationId: operation.operationId,
          candidates,
          now,
        });
      }
      return recovered;
    })();
  }

  public claimNextTopicCleanupCandidate(now: string): TopicCleanupClaimResult {
    assertIsoCutoff(now, "topic cleanup claim time");
    return this.database.transaction((): TopicCleanupClaimResult => {
      this.expireTopicCleanupPreviews(now);
      const rows = this.database
        .prepare(
          `
          SELECT *
          FROM topic_cleanup_operations
          WHERE state = 'claimed'
          ORDER BY created_at, operation_id
        `,
        )
        .all() as TopicCleanupOperationRow[];
      for (const row of rows) {
        const operation = this.topicCleanupFromRow(row);
        const candidates = [...operation.candidates];
        let skipped = 0;
        for (const [index, candidate] of candidates.entries()) {
          if (
            candidate.state !== "pending" &&
            !(candidate.state === "retry" && candidate.nextAttemptAt <= now)
          ) {
            continue;
          }
          if (!this.topicCleanupCandidateEligible(operation, candidate, now)) {
            candidates[index] = {
              ...candidate,
              state: "skipped",
              nextAttemptAt: now,
              lastErrorCode: "topic-cleanup-state-changed",
            };
            skipped += 1;
            continue;
          }
          const { lastErrorCode: _lastErrorCode, ...candidateWithoutError } =
            candidate;
          const claimed: TopicCleanupCandidateRecord = {
            ...candidateWithoutError,
            state: "deleting",
            attemptCount: candidate.attemptCount + 1,
            nextAttemptAt: now,
          };
          candidates[index] = claimed;
          this.saveTopicCleanupCandidates({
            operationId: operation.operationId,
            candidates,
            now,
          });
          return {
            outcome: "claimed",
            operation: this.getTopicCleanupOperation(operation.operationId)!,
            candidate: claimed,
            skipped,
          };
        }
        const finalized = this.finalizeTopicCleanupOperation(
          operation.operationId,
          candidates,
          now,
        );
        if (finalized.becameTerminal) {
          return {
            outcome: "terminal",
            operation: finalized.operation,
            skipped,
          };
        }
      }
      return { outcome: "none" };
    })();
  }

  public completeTopicCleanupCandidate(input: {
    operationId: string;
    topicId: string;
    attemptNumber: number;
    outcome: "deleted" | "already-missing";
    now: string;
  }): TopicCleanupCompletionResult {
    assertIsoCutoff(input.now, "topic cleanup completion time");
    return this.database.transaction(() => {
      const operation = this.getTopicCleanupOperation(input.operationId);
      if (operation === undefined || operation.state !== "claimed") {
        throw new Error("cannot complete an inactive topic cleanup");
      }
      const candidates = [...operation.candidates];
      const index = candidates.findIndex(
        (candidate) => candidate.topicId === input.topicId,
      );
      const candidate = candidates[index];
      if (
        candidate === undefined ||
        candidate.state !== "deleting" ||
        candidate.attemptCount !== input.attemptNumber
      ) {
        throw new Error("cannot complete an unclaimed topic deletion");
      }
      this.database
        .prepare(
          `
          DELETE FROM session_topics
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND transport_name = @transportName
            AND transport_scope = @transportScope
            AND topic_id = @topicId
        `,
        )
        .run({
          ...candidate,
          transportName: operation.transportName,
          transportScope: operation.transportScope,
        });
      const { lastErrorCode: _lastErrorCode, ...candidateWithoutError } =
        candidate;
      candidates[index] = {
        ...candidateWithoutError,
        state: input.outcome === "deleted" ? "deleted" : "already-missing",
        nextAttemptAt: input.now,
      };
      return this.finalizeTopicCleanupOperation(
        operation.operationId,
        candidates,
        input.now,
      );
    })();
  }

  public failTopicCleanupCandidate(
    input: {
      operationId: string;
      topicId: string;
      attemptNumber: number;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      now: string;
    },
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): TopicCleanupCompletionResult {
    assertIsoCutoff(input.now, "topic cleanup failure time");
    return this.database.transaction(() => {
      const operation = this.getTopicCleanupOperation(input.operationId);
      if (operation === undefined || operation.state !== "claimed") {
        throw new Error("cannot fail an inactive topic cleanup");
      }
      const candidates = [...operation.candidates];
      const index = candidates.findIndex(
        (candidate) => candidate.topicId === input.topicId,
      );
      const candidate = candidates[index];
      if (
        candidate === undefined ||
        candidate.state !== "deleting" ||
        candidate.attemptCount !== input.attemptNumber
      ) {
        throw new Error("cannot fail an unclaimed topic deletion");
      }
      const exhausted = candidate.attemptCount >= policy.maxAttempts;
      const retryable = input.retryable && !exhausted;
      candidates[index] = {
        ...candidate,
        state: retryable ? "retry" : "failed",
        nextAttemptAt: new Date(
          Date.parse(input.now) +
            retryDelay(policy, Math.max(1, candidate.attemptCount)),
        ).toISOString(),
        lastErrorCode: input.errorCode.slice(0, 160),
      };
      this.database
        .prepare(
          `
          UPDATE topic_cleanup_operations SET
            last_error_code = @errorCode,
            last_error_message = @errorMessage,
            updated_at = @now
          WHERE operation_id = @operationId
        `,
        )
        .run({
          ...input,
          errorMessage: input.errorMessage.slice(0, 2_000),
        });
      return this.finalizeTopicCleanupOperation(
        operation.operationId,
        candidates,
        input.now,
      );
    })();
  }

  public suppressionReason(
    event: AgentAttentionEventV1,
    options: {
      allowBackgroundWorkDelivery?: boolean;
    } = {},
  ): "muted" | "ended" | "background-work" | undefined {
    const control = this.getSessionControl(event);
    if (
      event.type !== "session.ended" &&
      (control?.endedAt !== undefined ||
        this.getSessionLaneState(event) === "ended")
    ) {
      return "ended";
    }
    if (event.type === "session.ended") {
      return undefined;
    }
    if (
      event.backgroundWork !== undefined &&
      options.allowBackgroundWorkDelivery !== true
    ) {
      return "background-work";
    }
    if (
      event.request !== undefined ||
      event.type === "turn.failed" ||
      event.type === "process.exited" ||
      event.type === "process.stale"
    ) {
      return undefined;
    }
    return control?.mutedAt === undefined ? undefined : "muted";
  }

  public markDeliverySuppressed(
    eventId: string,
    attemptNumber: number,
    reason: "muted" | "ended" | "background-work",
    now: string,
  ): void {
    this.database.transaction(() => {
      if (reason === "ended") {
        this.database
          .prepare(
            `
            UPDATE pending_requests SET
              state = 'cancelled',
              resolved_at = ?
            WHERE event_id = ? AND state = 'open'
          `,
          )
          .run(now, eventId);
        this.database
          .prepare(
            `
            UPDATE interaction_drafts
            SET state = 'cancelled', updated_at = ?
            WHERE state IN ('pending', 'drafting')
              AND correlation_id IN (
                SELECT correlation_id
                FROM pending_requests
                WHERE event_id = ?
              )
          `,
          )
          .run(now, eventId);
        this.database
          .prepare(
            `
            UPDATE question_set_drafts
            SET state = 'cancelled', updated_at = ?
            WHERE state IN ('pending', 'drafting')
              AND correlation_id IN (
                SELECT correlation_id
                FROM pending_requests
                WHERE event_id = ?
              )
          `,
          )
          .run(now, eventId);
      }
      const delivered = this.markDeliveredWithinTransaction(
        eventId,
        attemptNumber,
        "session-control",
        `suppressed:${reason}`,
        now,
      );
      if (delivered !== 1) {
        throw new Error(`cannot suppress non-delivering event ${eventId}`);
      }
      this.recordDiagnostic({
        schema: "agent-relay-diagnostic.v1",
        diagnosticId: `diag_suppressed_${sha256(
          `${eventId}\u001f${reason}`,
        ).slice(0, 40)}`,
        recordedAt: now,
        source: "daemon",
        level: "info",
        code: "notification.suppressed",
        message:
          reason === "background-work"
            ? "routine notification suppressed because structured background work remains active"
            : `notification suppressed because the relay lane is ${reason}`,
      });
    })();
  }

  public getEventTransportReceipt(
    eventId: string,
  ): { transportName: string; messageId: string } | undefined {
    const row = this.database
      .prepare(
        `
        SELECT transport_name, transport_message_id
        FROM events WHERE event_id = ? AND status = 'delivered'
      `,
      )
      .get(eventId) as
      | {
          transport_name: string | null;
          transport_message_id: string | null;
        }
      | undefined;
    return row?.transport_name === null ||
      row?.transport_name === undefined ||
      row.transport_message_id === null
      ? undefined
      : {
          transportName: row.transport_name,
          messageId: row.transport_message_id,
        };
  }

  private pendingFromRow(row: PendingRow): PendingRequestRecord {
    const optionRows = this.database
      .prepare(
        `
        SELECT option_token, option_id, label
        FROM pending_options
        WHERE correlation_id = ?
        ORDER BY rowid
      `,
      )
      .all(row.correlation_id) as PendingOptionRow[];
    return {
      correlationId: row.correlation_id,
      eventId: row.event_id,
      machineId: row.machine_id,
      harness: row.harness,
      sessionId: row.session_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      state: row.state,
      requestKind: row.request_kind,
      question: row.question,
      expiresAt: row.expires_at,
      ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by }),
      ...(row.answer === null ? {} : { answer: row.answer }),
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
      ...(row.transport_message_id === null
        ? {}
        : { transportMessageId: row.transport_message_id }),
      options: optionRows.map((option) => ({
        token: option.option_token,
        optionId: option.option_id,
        label: option.label,
      })),
    };
  }

  public getPendingRequest(
    correlationId: string,
  ): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  public listPendingRequests(limit = 100): PendingRequestRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("pending request limit must be between 1 and 500");
    }
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE state = 'open'
        ORDER BY expires_at, created_at, correlation_id
        LIMIT ?
      `,
      )
      .all(limit) as PendingRow[];
    return rows.map((row) => this.pendingFromRow(row));
  }

  public countOpenRequests(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): number {
    const row = this.database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pending_requests
        WHERE machine_id = ?
          AND harness = ?
          AND session_id = ?
          AND state = 'open'
      `,
      )
      .get(input.machineId, input.harness, input.sessionId) as {
      count: number;
    };
    return row.count;
  }

  public getPendingForEvent(eventId: string): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE event_id = ?
      `,
      )
      .get(eventId) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  public getPendingForTransportMessage(
    messageId: string,
  ): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM pending_requests
        WHERE transport_message_id = ?
      `,
      )
      .get(messageId) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  public getPendingForOptionToken(
    token: string,
  ): PendingRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT pending_requests.*
        FROM pending_options
        JOIN pending_requests USING (correlation_id)
        WHERE pending_options.option_token = ?
      `,
      )
      .get(token) as PendingRow | undefined;
    return row === undefined ? undefined : this.pendingFromRow(row);
  }

  private multiSelectDraftFromRow(
    row: MultiSelectDraftRow,
  ): MultiSelectDraftRecord {
    const selected = this.database
      .prepare(
        `
        SELECT selected.option_id
        FROM interaction_draft_options AS selected
        JOIN pending_options AS option
          ON option.correlation_id = selected.correlation_id
          AND option.option_id = selected.option_id
        WHERE selected.correlation_id = ?
        ORDER BY option.rowid
      `,
      )
      .all(row.correlation_id) as Array<{ option_id: string }>;
    return {
      correlationId: row.correlation_id,
      state: row.state,
      minSelections: row.min_selections,
      maxSelections: row.max_selections,
      submitToken: row.submit_token,
      cancelToken: row.cancel_token,
      revision: row.revision,
      selectedOptionIds: selected.map((option) => option.option_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public getMultiSelectDraft(
    correlationId: string,
  ): MultiSelectDraftRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM interaction_drafts
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as MultiSelectDraftRow | undefined;
    return row === undefined ? undefined : this.multiSelectDraftFromRow(row);
  }

  public getMultiSelectDraftByActionToken(token: string):
    | {
        request: PendingRequestRecord;
        draft: MultiSelectDraftRecord;
        action: "submit" | "cancel";
      }
    | undefined {
    const row = this.database
      .prepare(
        `
        SELECT *,
          CASE WHEN submit_token = @token THEN 'submit' ELSE 'cancel' END
            AS draft_action
        FROM interaction_drafts
        WHERE submit_token = @token OR cancel_token = @token
      `,
      )
      .get({ token }) as
      (MultiSelectDraftRow & { draft_action: "submit" | "cancel" }) | undefined;
    if (row === undefined) {
      return undefined;
    }
    const request = this.getPendingRequest(row.correlation_id);
    return request === undefined
      ? undefined
      : {
          request,
          draft: this.multiSelectDraftFromRow(row),
          action: row.draft_action,
        };
  }

  private pendingExpectedMatches(
    request: PendingRequestRecord,
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    },
  ): boolean {
    return (
      request.machineId === expected.machineId &&
      request.harness === expected.harness &&
      request.sessionId === expected.sessionId &&
      request.turnId === expected.turnId &&
      request.transportMessageId === expected.transportMessageId
    );
  }

  private synchronizeTerminalDraft(
    request: PendingRequestRecord,
    now: string,
  ): MultiSelectDraftRecord | undefined {
    const stateByRequest: Record<
      PendingRequestState,
      MultiSelectDraftState | undefined
    > = {
      open: undefined,
      answered: "superseded",
      expired: "expired",
      cancelled: "cancelled",
      failed: "failed",
    };
    const state = stateByRequest[request.state];
    if (state !== undefined) {
      this.database
        .prepare(
          `
          UPDATE interaction_drafts SET state = ?, updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(state, now, request.correlationId);
    }
    return this.getMultiSelectDraft(request.correlationId);
  }

  public setMultiSelectOption(input: {
    optionToken: string;
    selected: boolean;
    now: string;
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    };
  }): MultiSelectDraftMutationResult {
    return this.database.transaction((): MultiSelectDraftMutationResult => {
      const request = this.getPendingForOptionToken(input.optionToken);
      if (request?.requestKind !== "multi-select") {
        return { outcome: "not_found" };
      }
      const currentDraft = this.getMultiSelectDraft(request.correlationId);
      if (currentDraft === undefined) {
        return { outcome: "not_found", request };
      }
      if (!this.pendingExpectedMatches(request, input.expected)) {
        return {
          outcome: "identity_mismatch",
          request,
          draft: currentDraft,
        };
      }
      if (request.state !== "open") {
        const draft =
          this.synchronizeTerminalDraft(request, input.now) ?? currentDraft;
        return {
          outcome:
            request.state === "expired"
              ? "expired"
              : request.state === "failed"
                ? "failed"
                : "stale",
          request,
          draft,
        };
      }
      if (input.now >= request.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests
            SET state = 'expired', resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE interaction_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(request.correlationId),
          draft: this.getMultiSelectDraft(request.correlationId)!,
        };
      }

      const option = request.options.find(
        (candidate) => candidate.token === input.optionToken,
      );
      if (option === undefined) {
        return { outcome: "not_found", request, draft: currentDraft };
      }
      const alreadySelected =
        this.database
          .prepare(
            `
            SELECT 1
            FROM interaction_draft_options
            WHERE correlation_id = ? AND option_id = ?
          `,
          )
          .get(request.correlationId, option.optionId) !== undefined;
      if (alreadySelected === input.selected) {
        return {
          outcome: "unchanged",
          request,
          draft: currentDraft,
        };
      }
      if (
        input.selected &&
        currentDraft.selectedOptionIds.length >= currentDraft.maxSelections
      ) {
        return {
          outcome: "selection_limit",
          request,
          draft: currentDraft,
        };
      }
      if (input.selected) {
        this.database
          .prepare(
            `
            INSERT INTO interaction_draft_options (
              correlation_id, option_id, selected_at
            ) VALUES (?, ?, ?)
          `,
          )
          .run(request.correlationId, option.optionId, input.now);
      } else {
        this.database
          .prepare(
            `
            DELETE FROM interaction_draft_options
            WHERE correlation_id = ? AND option_id = ?
          `,
          )
          .run(request.correlationId, option.optionId);
      }
      this.database
        .prepare(
          `
          UPDATE interaction_drafts SET
            state = 'drafting',
            revision = revision + 1,
            updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, request.correlationId);
      return {
        outcome: "updated",
        request,
        draft: this.getMultiSelectDraft(request.correlationId)!,
      };
    })();
  }

  public finishMultiSelectDraft(input: {
    actionToken: string;
    action: "submit" | "cancel";
    now: string;
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    };
  }): MultiSelectSubmitResult {
    return this.database.transaction((): MultiSelectSubmitResult => {
      const entry = this.getMultiSelectDraftByActionToken(input.actionToken);
      if (
        entry === undefined ||
        entry.action !== input.action ||
        entry.request.requestKind !== "multi-select"
      ) {
        return { outcome: "not_found" };
      }
      const { request, draft } = entry;
      if (!this.pendingExpectedMatches(request, input.expected)) {
        return { outcome: "identity_mismatch", request, draft };
      }
      if (request.state !== "open") {
        const synchronized =
          this.synchronizeTerminalDraft(request, input.now) ?? draft;
        return {
          outcome:
            request.state === "answered" ||
            (request.state === "cancelled" && input.action === "cancel")
              ? "duplicate"
              : request.state === "expired"
                ? "expired"
                : request.state === "failed"
                  ? "failed"
                  : "stale",
          request,
          draft: synchronized,
        };
      }
      if (input.now >= request.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests
            SET state = 'expired', resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE interaction_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(request.correlationId),
          draft: this.getMultiSelectDraft(request.correlationId)!,
        };
      }
      if (input.action === "cancel") {
        this.database
          .prepare(
            `
            UPDATE pending_requests SET
              state = 'cancelled',
              resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE interaction_drafts SET
              state = 'cancelled',
              revision = revision + 1,
              updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "cancelled",
          request: this.requirePending(request.correlationId),
          draft: this.getMultiSelectDraft(request.correlationId)!,
        };
      }

      if (
        draft.selectedOptionIds.length < draft.minSelections ||
        draft.selectedOptionIds.length > draft.maxSelections
      ) {
        return { outcome: "invalid_selection", request, draft };
      }
      const answer = JSON.stringify(draft.selectedOptionIds);
      if (Buffer.byteLength(answer, "utf8") > 4_000) {
        throw new Error("validated multi-select answer exceeds 4000 bytes");
      }
      const update = this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'answered',
            resolved_by = 'telegram',
            answer = ?,
            resolved_at = ?
          WHERE correlation_id = ? AND state = 'open'
        `,
        )
        .run(answer, input.now, request.correlationId);
      if (update.changes !== 1) {
        const raced = this.requirePending(request.correlationId);
        return {
          outcome: "duplicate",
          request: raced,
          draft:
            this.synchronizeTerminalDraft(raced, input.now) ??
            this.getMultiSelectDraft(request.correlationId)!,
        };
      }
      this.database
        .prepare(
          `
          UPDATE interaction_drafts SET
            state = 'submitted',
            revision = revision + 1,
            updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, request.correlationId);
      return {
        outcome: "answered",
        request: this.requirePending(request.correlationId),
        draft: this.getMultiSelectDraft(request.correlationId)!,
      };
    })();
  }

  private questionSetInteraction(
    request: PendingRequestRecord,
  ): OperatorInteractionRequestV1 | undefined {
    const event = this.getEvent(request.eventId)?.event;
    return event?.request?.kind === "question-set"
      ? event.request.interaction
      : undefined;
  }

  private questionSetDraftFromRow(
    row: QuestionSetDraftRow,
    interaction: OperatorInteractionRequestV1,
  ): QuestionSetDraftRecord {
    const step = this.database
      .prepare(
        `
        SELECT *
        FROM question_set_steps
        WHERE correlation_id = ? AND ordinal = ?
      `,
      )
      .get(row.correlation_id, row.current_index) as
      QuestionSetStepRow | undefined;
    if (step === undefined) {
      throw new Error("question-set draft points outside its question order");
    }
    const answerRows = this.database
      .prepare(
        `
        SELECT answer.answer_json
        FROM question_set_answers AS answer
        JOIN question_set_steps AS step
          ON step.correlation_id = answer.correlation_id
          AND step.question_id = answer.question_id
        WHERE answer.correlation_id = ?
        ORDER BY step.ordinal
      `,
      )
      .all(row.correlation_id) as Array<{ answer_json: string }>;
    return {
      correlationId: row.correlation_id,
      state: row.state,
      currentIndex: row.current_index,
      revision: row.revision,
      ...(row.presentation_mode === null
        ? {}
        : {
            presentationMode: InteractionPresentationModeSchema.parse(
              row.presentation_mode,
            ),
          }),
      submitToken: row.submit_token,
      cancelToken: row.cancel_token,
      ...(step.back_token === null ? {} : { backToken: step.back_token }),
      ...(step.next_token === null ? {} : { nextToken: step.next_token }),
      interaction,
      answers: answerRows.map((answer) =>
        InteractionQuestionAnswerSchema.parse(
          JSON.parse(answer.answer_json) as unknown,
        ),
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public getQuestionSetDraft(
    correlationId: string,
  ): QuestionSetDraftRecord | undefined {
    const request = this.getPendingRequest(correlationId);
    const interaction =
      request === undefined ? undefined : this.questionSetInteraction(request);
    if (interaction === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM question_set_drafts
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as QuestionSetDraftRow | undefined;
    return row === undefined
      ? undefined
      : this.questionSetDraftFromRow(row, interaction);
  }

  public setQuestionSetPresentationMode(
    correlationId: string,
    mode: InteractionPresentationMode,
    now: string,
  ): QuestionSetDraftRecord {
    assertIsoCutoff(now, "question-set presentation time");
    const presentationMode = InteractionPresentationModeSchema.parse(mode);
    const changed = this.database
      .prepare(
        `
        UPDATE question_set_drafts
        SET presentation_mode = ?, updated_at = ?
        WHERE correlation_id = ?
          AND (presentation_mode IS NULL OR presentation_mode = ?)
      `,
      )
      .run(presentationMode, now, correlationId, presentationMode).changes;
    if (changed !== 1) {
      throw new Error(
        "question-set presentation mode changed after it was selected",
      );
    }
    const draft = this.getQuestionSetDraft(correlationId);
    if (draft === undefined) {
      throw new Error("question-set draft disappeared while selecting a mode");
    }
    return draft;
  }

  public getQuestionSetDraftByActionToken(
    token: string,
    action: "next" | "back" | "submit" | "cancel",
  ):
    | {
        request: PendingRequestRecord;
        draft: QuestionSetDraftRecord;
      }
    | undefined {
    const correlationId = this.questionSetCorrelationForToken(token, action);
    if (correlationId === undefined) {
      return undefined;
    }
    const request = this.getPendingRequest(correlationId);
    const draft = this.getQuestionSetDraft(correlationId);
    return request?.requestKind !== "question-set" || draft === undefined
      ? undefined
      : { request, draft };
  }

  private questionSetCorrelationForToken(
    token: string,
    action: "next" | "back" | "submit" | "cancel",
  ): string | undefined {
    if (action === "submit" || action === "cancel") {
      const column = action === "submit" ? "submit_token" : "cancel_token";
      const row = this.database
        .prepare(
          `
          SELECT correlation_id
          FROM question_set_drafts
          WHERE ${column} = ?
        `,
        )
        .get(token) as { correlation_id: string } | undefined;
      return row?.correlation_id;
    }
    const column = action === "next" ? "next_token" : "back_token";
    const row = this.database
      .prepare(
        `
        SELECT correlation_id
        FROM question_set_steps
        WHERE ${column} = ?
      `,
      )
      .get(token) as { correlation_id: string } | undefined;
    return row?.correlation_id;
  }

  private questionSetOptionIds(question: InteractionQuestion): string[] {
    if (question.kind === "confirm") {
      return [question.confirm.optionId, question.decline.optionId];
    }
    return question.kind === "single-select" || question.kind === "multi-select"
      ? question.options.map((option) => option.optionId)
      : [];
  }

  private questionSetAnswer(
    draft: QuestionSetDraftRecord,
    question: InteractionQuestion,
  ): InteractionQuestionAnswer | undefined {
    return draft.answers.find(
      (answer) => answer.questionId === question.questionId,
    );
  }

  private completeQuestionSetAnswer(
    draft: QuestionSetDraftRecord,
    question: InteractionQuestion,
  ): InteractionQuestionAnswer | undefined {
    const answer = this.questionSetAnswer(draft, question);
    if (question.kind === "multi-select") {
      const optionIds = answer?.kind === "multi-select" ? answer.optionIds : [];
      return optionIds.length >= question.minSelections &&
        optionIds.length <= question.maxSelections
        ? {
            questionId: question.questionId,
            kind: "multi-select",
            optionIds,
          }
        : undefined;
    }
    return answer?.kind === question.kind ? answer : undefined;
  }

  private saveQuestionSetAnswer(
    correlationId: string,
    answer: InteractionQuestionAnswer,
    now: string,
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO question_set_answers (
          correlation_id, question_id, answer_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(correlation_id, question_id) DO UPDATE SET
          answer_json = excluded.answer_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(correlationId, answer.questionId, JSON.stringify(answer), now);
  }

  private synchronizeTerminalQuestionSet(
    request: PendingRequestRecord,
    now: string,
  ): QuestionSetDraftRecord | undefined {
    const stateByRequest: Record<
      PendingRequestState,
      QuestionSetDraftState | undefined
    > = {
      open: undefined,
      answered: "superseded",
      expired: "expired",
      cancelled: "cancelled",
      failed: "failed",
    };
    const state = stateByRequest[request.state];
    if (state !== undefined) {
      this.database
        .prepare(
          `
          UPDATE question_set_drafts SET state = ?, updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(state, now, request.correlationId);
    }
    return this.getQuestionSetDraft(request.correlationId);
  }

  public mutateQuestionSet(input: {
    action:
      "choose" | "select" | "unselect" | "next" | "back" | "submit" | "cancel";
    token: string;
    now: string;
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    };
  }): QuestionSetMutationResult {
    return this.database.transaction((): QuestionSetMutationResult => {
      const optionAction =
        input.action === "choose" ||
        input.action === "select" ||
        input.action === "unselect";
      const optionRequest = optionAction
        ? this.getPendingForOptionToken(input.token)
        : undefined;
      const correlationId = optionAction
        ? optionRequest?.correlationId
        : this.questionSetCorrelationForToken(
            input.token,
            input.action as "next" | "back" | "submit" | "cancel",
          );
      const request =
        correlationId === undefined
          ? undefined
          : (optionRequest ?? this.getPendingRequest(correlationId));
      if (request?.requestKind !== "question-set") {
        return { outcome: "not_found" };
      }
      let draft = this.getQuestionSetDraft(request.correlationId);
      if (draft === undefined) {
        return { outcome: "not_found", request };
      }
      if (!this.pendingExpectedMatches(request, input.expected)) {
        return { outcome: "identity_mismatch", request, draft };
      }
      if (request.state !== "open") {
        draft =
          this.synchronizeTerminalQuestionSet(request, input.now) ?? draft;
        return {
          outcome:
            request.state === "answered" ||
            (request.state === "cancelled" && input.action === "cancel")
              ? "duplicate"
              : request.state === "expired"
                ? "expired"
                : request.state === "failed"
                  ? "failed"
                  : "stale",
          request,
          draft,
        };
      }
      if (input.now >= request.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests
            SET state = 'expired', resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE question_set_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(request.correlationId),
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }

      const question = draft.interaction.questions[draft.currentIndex];
      if (question === undefined) {
        return { outcome: "invalid_transition", request, draft };
      }
      if (input.action === "cancel") {
        if (input.token !== draft.cancelToken) {
          return { outcome: "invalid_transition", request, draft };
        }
        this.database
          .prepare(
            `
            UPDATE pending_requests
            SET state = 'cancelled', resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE question_set_drafts SET
              state = 'cancelled',
              revision = revision + 1,
              updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "cancelled",
          request: this.requirePending(request.correlationId),
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }
      if (input.action === "back") {
        if (input.token !== draft.backToken || draft.currentIndex <= 0) {
          return { outcome: "invalid_transition", request, draft };
        }
        this.database
          .prepare(
            `
            UPDATE question_set_drafts SET
              current_index = current_index - 1,
              state = 'drafting',
              revision = revision + 1,
              updated_at = ?
            WHERE correlation_id = ? AND current_index = ?
          `,
          )
          .run(input.now, request.correlationId, draft.currentIndex);
        return {
          outcome: "moved",
          request,
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }
      if (input.action === "next") {
        if (
          input.token !== draft.nextToken ||
          draft.currentIndex >= draft.interaction.questions.length - 1
        ) {
          return { outcome: "invalid_transition", request, draft };
        }
        const answer = this.completeQuestionSetAnswer(draft, question);
        if (answer === undefined) {
          return {
            outcome:
              question.kind === "free-text"
                ? "unsupported_question"
                : "incomplete",
            request,
            draft,
          };
        }
        if (
          question.kind === "multi-select" &&
          this.questionSetAnswer(draft, question) === undefined
        ) {
          this.saveQuestionSetAnswer(request.correlationId, answer, input.now);
        }
        this.database
          .prepare(
            `
            UPDATE question_set_drafts SET
              current_index = current_index + 1,
              state = 'drafting',
              revision = revision + 1,
              updated_at = ?
            WHERE correlation_id = ? AND current_index = ?
          `,
          )
          .run(input.now, request.correlationId, draft.currentIndex);
        return {
          outcome: "moved",
          request,
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }
      if (input.action === "submit") {
        if (
          input.token !== draft.submitToken ||
          draft.currentIndex !== draft.interaction.questions.length - 1
        ) {
          return { outcome: "invalid_transition", request, draft };
        }
        const answers = draft.interaction.questions.map((item) =>
          this.completeQuestionSetAnswer(draft, item),
        );
        if (answers.some((answer) => answer === undefined)) {
          const unsupported = draft.interaction.questions.some(
            (item, index) =>
              answers[index] === undefined && item.kind === "free-text",
          );
          return {
            outcome: unsupported ? "unsupported_question" : "incomplete",
            request,
            draft,
          };
        }
        for (const [index, answer] of answers.entries()) {
          const question = draft.interaction.questions[index]!;
          if (
            answer !== undefined &&
            this.questionSetAnswer(draft, question) === undefined
          ) {
            this.saveQuestionSetAnswer(
              request.correlationId,
              answer,
              input.now,
            );
          }
        }
        const answerEnvelope = {
          schema: "agent-interaction-answer.v1" as const,
          answerId: `interaction_answer_${randomUUID()}`,
          requestId: draft.interaction.requestId,
          submittedAt: input.now,
          answers: answers as InteractionQuestionAnswer[],
        };
        const answer = encodeInteractionAnswer(
          draft.interaction,
          answerEnvelope,
        );
        const update = this.database
          .prepare(
            `
            UPDATE pending_requests SET
              state = 'answered',
              resolved_by = 'telegram',
              answer = ?,
              resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(answer, input.now, request.correlationId);
        if (update.changes !== 1) {
          const raced = this.requirePending(request.correlationId);
          return {
            outcome: "duplicate",
            request: raced,
            draft:
              this.synchronizeTerminalQuestionSet(raced, input.now) ??
              this.getQuestionSetDraft(request.correlationId)!,
          };
        }
        this.database
          .prepare(
            `
            UPDATE question_set_drafts SET
              state = 'submitted',
              revision = revision + 1,
              updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "answered",
          request: this.requirePending(request.correlationId),
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }

      const option = request.options.find(
        (candidate) => candidate.token === input.token,
      );
      if (option === undefined) {
        return { outcome: "not_found", request, draft };
      }
      if (!this.questionSetOptionIds(question).includes(option.optionId)) {
        return { outcome: "invalid_transition", request, draft };
      }
      let answer: InteractionQuestionAnswer;
      if (input.action === "choose") {
        if (question.kind !== "confirm" && question.kind !== "single-select") {
          return { outcome: "invalid_transition", request, draft };
        }
        answer = {
          questionId: question.questionId,
          kind: question.kind,
          optionId: option.optionId,
        };
      } else {
        if (question.kind !== "multi-select") {
          return { outcome: "invalid_transition", request, draft };
        }
        const current = this.questionSetAnswer(draft, question);
        const optionIds =
          current?.kind === "multi-select" ? [...current.optionIds] : [];
        const alreadySelected = optionIds.includes(option.optionId);
        const selected = input.action === "select";
        if (alreadySelected === selected) {
          return { outcome: "unchanged", request, draft };
        }
        if (selected) {
          if (optionIds.length >= question.maxSelections) {
            return { outcome: "selection_limit", request, draft };
          }
          optionIds.push(option.optionId);
          const order = this.questionSetOptionIds(question);
          optionIds.sort((left, right) => {
            return order.indexOf(left) - order.indexOf(right);
          });
        } else {
          optionIds.splice(optionIds.indexOf(option.optionId), 1);
        }
        answer = {
          questionId: question.questionId,
          kind: "multi-select",
          optionIds,
        };
      }
      const previous = this.questionSetAnswer(draft, question);
      if (
        previous !== undefined &&
        JSON.stringify(previous) === JSON.stringify(answer)
      ) {
        return { outcome: "unchanged", request, draft };
      }
      this.saveQuestionSetAnswer(request.correlationId, answer, input.now);
      this.database
        .prepare(
          `
          UPDATE question_set_drafts SET
            state = 'drafting',
            revision = revision + 1,
            updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, request.correlationId);
      return {
        outcome: "updated",
        request,
        draft: this.getQuestionSetDraft(request.correlationId)!,
      };
    })();
  }

  public setQuestionSetText(input: {
    correlationId: string;
    text: string;
    now: string;
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    };
  }): QuestionSetTextMutationResult {
    return this.database.transaction((): QuestionSetTextMutationResult => {
      const request = this.getPendingRequest(input.correlationId);
      if (request?.requestKind !== "question-set") {
        return { outcome: "not_found" };
      }
      let draft = this.getQuestionSetDraft(request.correlationId);
      if (draft === undefined) {
        return { outcome: "not_found", request };
      }
      if (!this.pendingExpectedMatches(request, input.expected)) {
        return { outcome: "identity_mismatch", request, draft };
      }
      if (request.state !== "open") {
        draft =
          this.synchronizeTerminalQuestionSet(request, input.now) ?? draft;
        return {
          outcome:
            request.state === "answered"
              ? "duplicate"
              : request.state === "expired"
                ? "expired"
                : request.state === "failed"
                  ? "failed"
                  : "stale",
          request,
          draft,
        };
      }
      if (input.now >= request.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests
            SET state = 'expired', resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, request.correlationId);
        this.database
          .prepare(
            `
            UPDATE question_set_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, request.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(request.correlationId),
          draft: this.getQuestionSetDraft(request.correlationId)!,
        };
      }

      const question = draft.interaction.questions[draft.currentIndex];
      if (question?.kind !== "free-text") {
        return { outcome: "invalid_transition", request, draft };
      }
      const text = input.text.replace(/\r\n?/g, "\n").trim();
      const reason: QuestionSetTextRejectionReason | undefined =
        text.length === 0
          ? "empty"
          : text.length < question.minLength
            ? "too_short"
            : text.length > question.maxLength
              ? "too_long"
              : !question.multiline && text.includes("\n")
                ? "multiline"
                : undefined;
      if (reason !== undefined) {
        return { outcome: "invalid_text", reason, request, draft };
      }
      const answer: InteractionQuestionAnswer = {
        questionId: question.questionId,
        kind: "free-text",
        text,
      };
      const previous = this.questionSetAnswer(draft, question);
      if (
        previous !== undefined &&
        JSON.stringify(previous) === JSON.stringify(answer)
      ) {
        return { outcome: "unchanged", request, draft };
      }
      this.saveQuestionSetAnswer(request.correlationId, answer, input.now);
      this.database
        .prepare(
          `
          UPDATE question_set_drafts SET
            state = 'drafting',
            revision = revision + 1,
            updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, request.correlationId);
      return {
        outcome: "updated",
        request,
        draft: this.getQuestionSetDraft(request.correlationId)!,
      };
    })();
  }

  private requirePending(correlationId: string): PendingRequestRecord {
    const request = this.getPendingRequest(correlationId);
    if (request === undefined) {
      throw new Error(`pending request ${correlationId} disappeared`);
    }
    return request;
  }

  public resolveRequest(input: ResolveRequestInput): ResolutionResult {
    const answer = input.answer.trim().slice(0, 4_000);
    if (answer.length === 0) {
      throw new Error("request answer cannot be empty");
    }
    return this.database.transaction((): ResolutionResult => {
      const current = this.getPendingRequest(input.correlationId);
      if (current === undefined) {
        return { outcome: "not_found" };
      }
      if (
        input.expected !== undefined &&
        (current.machineId !== input.expected.machineId ||
          current.harness !== input.expected.harness ||
          current.sessionId !== input.expected.sessionId ||
          current.turnId !== input.expected.turnId)
      ) {
        return { outcome: "identity_mismatch", request: current };
      }
      if (current.state !== "open") {
        return {
          outcome: current.state === "answered" ? "duplicate" : current.state,
          request: current,
        };
      }
      if (input.now >= current.expiresAt) {
        this.database
          .prepare(
            `
            UPDATE pending_requests SET
              state = 'expired',
              resolved_at = ?
            WHERE correlation_id = ? AND state = 'open'
          `,
          )
          .run(input.now, input.correlationId);
        this.database
          .prepare(
            `
            UPDATE question_set_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, input.correlationId);
        this.database
          .prepare(
            `
            UPDATE interaction_drafts
            SET state = 'expired', updated_at = ?
            WHERE correlation_id = ? AND state IN ('pending', 'drafting')
          `,
          )
          .run(input.now, input.correlationId);
        return {
          outcome: "expired",
          request: this.requirePending(input.correlationId),
        };
      }
      const update = this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'answered',
            resolved_by = ?,
            answer = ?,
            resolved_at = ?
          WHERE correlation_id = ? AND state = 'open'
        `,
        )
        .run(input.resolvedBy, answer, input.now, input.correlationId);
      if (update.changes !== 1) {
        return {
          outcome: "duplicate",
          request: this.requirePending(input.correlationId),
        };
      }
      this.database
        .prepare(
          `
          UPDATE interaction_drafts
          SET state = 'superseded', updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, input.correlationId);
      this.database
        .prepare(
          `
          UPDATE question_set_drafts
          SET state = 'superseded', updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(input.now, input.correlationId);
      return {
        outcome: "answered",
        request: this.requirePending(input.correlationId),
      };
    })();
  }

  public resolveBrowserRequest(input: {
    operationId: string;
    correlationId: string;
    response: BrowserRequestResponse;
    now: string;
  }): BrowserResolutionResult {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.operationId)) {
      throw new Error("browser operation id is malformed");
    }
    assertIsoCutoff(input.now, "browser resolution time");
    const payloadHash = sha256(
      JSON.stringify([input.correlationId, input.response]),
    );
    return this.database.transaction((): BrowserResolutionResult => {
      const prior = this.database
        .prepare(
          `
          SELECT correlation_id, payload_hash, outcome
          FROM browser_commands
          WHERE operation_id = ?
        `,
        )
        .get(input.operationId) as
        | {
            correlation_id: string;
            payload_hash: string;
            outcome: Exclude<BrowserResolutionOutcome, "replay_conflict">;
          }
        | undefined;
      if (prior !== undefined) {
        if (
          prior.correlation_id !== input.correlationId ||
          prior.payload_hash !== payloadHash
        ) {
          return { outcome: "replay_conflict", replayed: true };
        }
        const request = this.getPendingRequest(prior.correlation_id);
        return {
          outcome: prior.outcome,
          replayed: true,
          ...(request === undefined ? {} : { request }),
        };
      }

      const request = this.getPendingRequest(input.correlationId);
      let outcome: Exclude<BrowserResolutionOutcome, "replay_conflict">;
      let resolutionRequest: PendingRequestRecord | undefined;
      if (request === undefined) {
        outcome = "not_found";
      } else {
        const answer = this.browserAnswer(
          request,
          input.response,
          input.operationId,
          input.now,
        );
        if (answer === undefined) {
          outcome = "invalid_answer";
          resolutionRequest = request;
        } else {
          const resolution = this.resolveRequest({
            correlationId: request.correlationId,
            answer,
            resolvedBy: "web",
            now: input.now,
            expected: {
              machineId: request.machineId,
              harness: request.harness,
              sessionId: request.sessionId,
              ...(request.turnId === undefined
                ? {}
                : { turnId: request.turnId }),
            },
          });
          outcome = resolution.outcome;
          resolutionRequest = resolution.request;
        }
      }
      this.database
        .prepare(
          `
          INSERT INTO browser_commands (
            operation_id, correlation_id, payload_hash, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.operationId,
          input.correlationId,
          payloadHash,
          outcome,
          input.now,
        );
      return {
        outcome,
        replayed: false,
        ...(resolutionRequest === undefined
          ? {}
          : { request: resolutionRequest }),
      };
    })();
  }

  private browserAnswer(
    request: PendingRequestRecord,
    response: BrowserRequestResponse,
    operationId: string,
    now: string,
  ): string | undefined {
    if (
      request.requestKind === "input" ||
      request.requestKind === "continuation"
    ) {
      if (response.kind !== "text") {
        return undefined;
      }
      const answer = response.text.replace(/\r\n?/g, "\n").trim();
      return answer.length === 0 || answer.length > 4_000 ? undefined : answer;
    }
    if (
      request.requestKind === "confirm" ||
      request.requestKind === "select" ||
      request.requestKind === "permission"
    ) {
      return response.kind === "option" &&
        request.options.some((option) => option.optionId === response.optionId)
        ? response.optionId
        : undefined;
    }
    if (request.requestKind === "multi-select") {
      if (response.kind !== "multi-select") {
        return undefined;
      }
      const draft = this.getMultiSelectDraft(request.correlationId);
      const selected = new Set(response.optionIds);
      if (
        draft === undefined ||
        selected.size !== response.optionIds.length ||
        selected.size < draft.minSelections ||
        selected.size > draft.maxSelections ||
        response.optionIds.some(
          (optionId) =>
            !request.options.some((option) => option.optionId === optionId),
        )
      ) {
        return undefined;
      }
      const ordered = request.options
        .filter((option) => selected.has(option.optionId))
        .map((option) => option.optionId);
      const answer = JSON.stringify(ordered);
      return Buffer.byteLength(answer, "utf8") <= 4_000 ? answer : undefined;
    }
    if (response.kind !== "question-set") {
      return undefined;
    }
    const interaction = this.questionSetInteraction(request);
    if (interaction === undefined) {
      return undefined;
    }
    const validation = validateInteractionAnswer(interaction, {
      schema: "agent-interaction-answer.v1",
      answerId: operationId,
      requestId: request.correlationId,
      submittedAt: now,
      answers: response.answers,
    });
    return validation.ok ? JSON.stringify(validation.answer) : undefined;
  }

  public resolveOptionToken(
    token: string,
    resolvedBy: "terminal" | "telegram" | "web" | "whooshbang",
    now: string,
    expected?: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
      transportMessageId: string;
    },
  ): ResolutionResult {
    const option = this.database
      .prepare(
        `
        SELECT correlation_id, option_id
        FROM pending_options
        WHERE option_token = ?
      `,
      )
      .get(token) as { correlation_id: string; option_id: string } | undefined;
    if (option === undefined) {
      return { outcome: "not_found" };
    }
    const request = this.getPendingRequest(option.correlation_id);
    if (
      request === undefined ||
      (expected !== undefined &&
        (request.machineId !== expected.machineId ||
          request.harness !== expected.harness ||
          request.sessionId !== expected.sessionId ||
          request.turnId !== expected.turnId ||
          request.transportMessageId !== expected.transportMessageId))
    ) {
      return {
        outcome: request === undefined ? "not_found" : "identity_mismatch",
        ...(request === undefined ? {} : { request }),
      };
    }
    return this.resolveRequest({
      correlationId: option.correlation_id,
      answer: option.option_id,
      resolvedBy,
      now,
      ...(expected === undefined
        ? {}
        : {
            expected: {
              machineId: expected.machineId,
              harness: expected.harness,
              sessionId: expected.sessionId,
              ...(expected.turnId === undefined
                ? {}
                : { turnId: expected.turnId }),
            },
          }),
    });
  }

  private resolveNumberedChoice(
    request: PendingRequestRecord,
    answer: string,
    now: string,
    minimumOptionCount: number,
  ): NumberedChoiceResolutionResult {
    if (
      request.requestKind !== "select" ||
      request.options.length <= minimumOptionCount
    ) {
      return { outcome: "not_found" };
    }
    const normalized = answer.trim();
    if (!/^[1-9][0-9]*$/.test(normalized)) {
      return { outcome: "invalid_choice", request };
    }
    const option = request.options[Number(normalized) - 1];
    if (option === undefined) {
      return { outcome: "invalid_choice", request };
    }
    return this.resolveRequest({
      correlationId: request.correlationId,
      answer: option.optionId,
      resolvedBy: "telegram",
      now,
      expected: {
        machineId: request.machineId,
        harness: request.harness,
        sessionId: request.sessionId,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      },
    });
  }

  public resolveTransportNumberedChoice(
    messageId: string,
    answer: string,
    now: string,
    minimumOptionCount: number,
    expected: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
    },
  ): NumberedChoiceResolutionResult {
    const request = this.getPendingForTransportMessage(messageId);
    if (request === undefined) {
      return { outcome: "not_found" };
    }
    if (
      request.machineId !== expected.machineId ||
      request.harness !== expected.harness ||
      request.sessionId !== expected.sessionId ||
      request.turnId !== expected.turnId
    ) {
      return { outcome: "identity_mismatch", request };
    }
    return this.resolveNumberedChoice(request, answer, now, minimumOptionCount);
  }

  public resolveTransportReply(
    messageId: string,
    answer: string,
    now: string,
    expected?: {
      machineId: string;
      harness: Harness;
      sessionId: string;
      turnId?: string;
    },
  ): ResolutionResult {
    const row = this.database
      .prepare(
        `
        SELECT correlation_id, machine_id, harness, session_id, request_kind
        FROM pending_requests
        WHERE transport_message_id = ?
      `,
      )
      .get(messageId) as
      | {
          correlation_id: string;
          machine_id: string;
          harness: Harness;
          session_id: string;
          request_kind: PendingRequestRecord["requestKind"];
        }
      | undefined;
    if (
      row === undefined ||
      (row.request_kind !== "input" && row.request_kind !== "continuation") ||
      (expected !== undefined &&
        (row.machine_id !== expected.machineId ||
          row.harness !== expected.harness ||
          row.session_id !== expected.sessionId))
    ) {
      return { outcome: "not_found" };
    }
    return this.resolveRequest({
      correlationId: row.correlation_id,
      answer,
      resolvedBy: "telegram",
      now,
      ...(expected === undefined ? {} : { expected }),
    });
  }

  public resolveTopicText(input: {
    transportName: string;
    transportScope: string;
    topicId: string;
    answer: string;
    now: string;
    numberedChoiceMinimumOptions?: number;
  }): TopicTextCorrelationResult {
    return this.database.transaction((): TopicTextCorrelationResult => {
      const topic = this.database
        .prepare(
          `
          SELECT machine_id, harness, session_id
          FROM session_topics
          WHERE transport_name = @transportName
            AND transport_scope = @transportScope
            AND topic_id = @topicId
            AND provisioning_status = 'ready'
        `,
        )
        .get(input) as
        | {
            machine_id: string;
            harness: Harness;
            session_id: string;
          }
        | undefined;
      if (topic === undefined) {
        return { outcome: "topic_not_found", eligibleCount: 0 };
      }

      this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'expired',
            resolved_at = @now
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND state = 'open'
            AND expires_at <= @now
        `,
        )
        .run({
          machineId: topic.machine_id,
          harness: topic.harness,
          sessionId: topic.session_id,
          now: input.now,
        });
      this.database
        .prepare(
          `
          UPDATE interaction_drafts
          SET state = 'expired', updated_at = @now
          WHERE state IN ('pending', 'drafting')
            AND correlation_id IN (
              SELECT correlation_id
              FROM pending_requests
              WHERE machine_id = @machineId
                AND harness = @harness
                AND session_id = @sessionId
                AND state = 'expired'
            )
        `,
        )
        .run({
          machineId: topic.machine_id,
          harness: topic.harness,
          sessionId: topic.session_id,
          now: input.now,
        });
      this.database
        .prepare(
          `
          UPDATE question_set_drafts
          SET state = 'expired', updated_at = @now
          WHERE state IN ('pending', 'drafting')
            AND correlation_id IN (
              SELECT correlation_id
              FROM pending_requests
              WHERE machine_id = @machineId
                AND harness = @harness
                AND session_id = @sessionId
                AND state = 'expired'
            )
        `,
        )
        .run({
          machineId: topic.machine_id,
          harness: topic.harness,
          sessionId: topic.session_id,
          now: input.now,
        });

      const candidates = this.database
        .prepare(
          `
          SELECT *
          FROM pending_requests
          WHERE machine_id = @machineId
            AND harness = @harness
            AND session_id = @sessionId
            AND state = 'open'
            AND expires_at > @now
            AND transport_message_id IS NOT NULL
            AND (
              request_kind IN ('input', 'continuation')
              OR (
                @numberedChoiceMinimumOptions IS NOT NULL
                AND request_kind = 'select'
                AND (
                  SELECT COUNT(*)
                  FROM pending_options
                  WHERE pending_options.correlation_id =
                    pending_requests.correlation_id
                ) > @numberedChoiceMinimumOptions
              )
              OR (
                request_kind = 'question-set'
                AND EXISTS (
                  SELECT 1
                  FROM question_set_drafts AS draft
                  JOIN events
                    ON events.event_id = pending_requests.event_id
                  WHERE draft.correlation_id =
                    pending_requests.correlation_id
                    AND (
                      json_extract(
                        events.payload_json,
                        '$.request.interaction.questions[' ||
                          draft.current_index || '].kind'
                      ) = 'free-text'
                      OR (
                        draft.presentation_mode = 'numbered-text'
                        AND json_extract(
                          events.payload_json,
                          '$.request.interaction.questions[' ||
                            draft.current_index || '].kind'
                        ) IN ('confirm', 'single-select')
                      )
                    )
                )
              )
            )
          ORDER BY created_at, correlation_id
          LIMIT 2
        `,
        )
        .all({
          machineId: topic.machine_id,
          harness: topic.harness,
          sessionId: topic.session_id,
          now: input.now,
          numberedChoiceMinimumOptions:
            input.numberedChoiceMinimumOptions ?? null,
        }) as PendingRow[];
      if (candidates.length === 0) {
        return { outcome: "no_eligible_request", eligibleCount: 0 };
      }
      if (candidates.length > 1) {
        return {
          outcome: "ambiguous_request",
          eligibleCount: candidates.length,
        };
      }

      const request = this.pendingFromRow(candidates[0]!);
      if (request.requestKind === "question-set") {
        if (request.transportMessageId === undefined) {
          throw new Error(
            "eligible question-set text request is not delivered",
          );
        }
        const draft = this.getQuestionSetDraft(request.correlationId);
        const question = draft?.interaction.questions[draft.currentIndex];
        if (draft === undefined || question === undefined) {
          throw new Error("eligible question-set draft is missing");
        }
        const expected = {
          machineId: request.machineId,
          harness: request.harness,
          sessionId: request.sessionId,
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          transportMessageId: request.transportMessageId,
        };
        if (question.kind === "free-text") {
          return {
            outcome: "drafted",
            eligibleCount: 1,
            request,
            mutation: this.setQuestionSetText({
              correlationId: request.correlationId,
              text: input.answer,
              now: input.now,
              expected,
            }),
          };
        }
        const optionIds = this.questionSetOptionIds(question);
        const normalized = input.answer.trim();
        const optionIndex = /^[1-9][0-9]*$/.test(normalized)
          ? Number(normalized) - 1
          : -1;
        const optionId = optionIds[optionIndex];
        const option =
          optionId === undefined
            ? undefined
            : request.options.find(
                (candidate) => candidate.optionId === optionId,
              );
        return {
          outcome: "choice_drafted",
          eligibleCount: 1,
          request,
          mutation:
            option === undefined
              ? { outcome: "invalid_choice", request, draft }
              : this.mutateQuestionSet({
                  action: "choose",
                  token: option.token,
                  now: input.now,
                  expected,
                }),
        };
      }
      if (input.answer.trim().length === 0) {
        return {
          outcome: "invalid_text",
          eligibleCount: 1,
          request,
        };
      }
      return {
        outcome: "resolved",
        eligibleCount: 1,
        request,
        resolution:
          request.requestKind === "select"
            ? this.resolveNumberedChoice(
                request,
                input.answer,
                input.now,
                input.numberedChoiceMinimumOptions ?? Number.MAX_SAFE_INTEGER,
              )
            : this.resolveRequest({
                correlationId: request.correlationId,
                answer: input.answer,
                resolvedBy: "telegram",
                now: input.now,
                expected: {
                  machineId: request.machineId,
                  harness: request.harness,
                  sessionId: request.sessionId,
                  ...(request.turnId === undefined
                    ? {}
                    : { turnId: request.turnId }),
                },
              }),
      };
    })();
  }

  public cancelRequest(correlationId: string, now: string): ResolutionResult {
    return this.database.transaction((): ResolutionResult => {
      const current = this.getPendingRequest(correlationId);
      if (current === undefined) {
        return { outcome: "not_found" };
      }
      if (current.state !== "open") {
        return {
          outcome: current.state === "answered" ? "duplicate" : current.state,
          request: current,
        };
      }
      this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'cancelled',
            resolved_at = ?
          WHERE correlation_id = ? AND state = 'open'
        `,
        )
        .run(now, correlationId);
      this.database
        .prepare(
          `
          UPDATE interaction_drafts
          SET state = 'cancelled', updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(now, correlationId);
      this.database
        .prepare(
          `
          UPDATE question_set_drafts
          SET state = 'cancelled', updated_at = ?
          WHERE correlation_id = ? AND state IN ('pending', 'drafting')
        `,
        )
        .run(now, correlationId);
      return {
        outcome: "cancelled",
        request: this.requirePending(correlationId),
      };
    })();
  }

  public expireRequests(now: string): number {
    return this.database.transaction(() => {
      const changes = this.database
        .prepare(
          `
          UPDATE pending_requests SET
            state = 'expired',
            resolved_at = ?
          WHERE state = 'open' AND expires_at <= ?
        `,
        )
        .run(now, now).changes;
      this.database
        .prepare(
          `
          UPDATE interaction_drafts
          SET state = 'expired', updated_at = ?
          WHERE state IN ('pending', 'drafting')
            AND correlation_id IN (
              SELECT correlation_id
              FROM pending_requests
              WHERE state = 'expired'
            )
        `,
        )
        .run(now);
      this.database
        .prepare(
          `
          UPDATE question_set_drafts
          SET state = 'expired', updated_at = ?
          WHERE state IN ('pending', 'drafting')
            AND correlation_id IN (
              SELECT correlation_id
              FROM pending_requests
              WHERE state = 'expired'
            )
        `,
        )
        .run(now);
      return changes;
    })();
  }

  private resumeCommandFromRow(row: ResumeCommandRow): ResumeCommandRecord {
    return {
      correlationId: row.correlation_id,
      ownerId: row.owner_id,
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: row.harness,
      surface: row.surface,
      sessionId: row.session_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      answer: row.answer,
      state: row.state,
      claimedAt: row.claimed_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      ...(row.signal === null ? {} : { signal: row.signal }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.error_message === null
        ? {}
        : { errorMessage: row.error_message }),
    };
  }

  public getResumeCommand(
    correlationId: string,
  ): ResumeCommandRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT * FROM resume_commands
        WHERE correlation_id = ?
      `,
      )
      .get(correlationId) as ResumeCommandRow | undefined;
    return row === undefined ? undefined : this.resumeCommandFromRow(row);
  }

  public listResumeCommands(): ResumeCommandRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT * FROM resume_commands
        ORDER BY claimed_at, correlation_id
      `,
      )
      .all() as ResumeCommandRow[];
    return rows.map((row) => this.resumeCommandFromRow(row));
  }

  public claimNextResume(input: ClaimResumeInput): ResumeClaimResult {
    return this.database.transaction((): ResumeClaimResult => {
      this.expireRequests(input.now);
      const candidates = this.database
        .prepare(
          `
          SELECT
            pending.correlation_id,
            pending.machine_id,
            sessions.bridge_session_id,
            pending.harness,
            sessions.surface,
            pending.session_id,
            pending.turn_id,
            pending.answer,
            pending.state,
            pending.expires_at,
            sessions.capabilities_json
          FROM pending_requests AS pending
          JOIN sessions
            ON sessions.machine_id = pending.machine_id
            AND sessions.harness = pending.harness
            AND sessions.session_id = pending.session_id
          LEFT JOIN resume_commands AS commands
            ON commands.correlation_id = pending.correlation_id
          WHERE pending.machine_id = ?
            AND sessions.bridge_session_id = ?
            AND pending.harness = ?
            AND pending.request_kind = 'continuation'
            AND pending.state IN ('open', 'answered')
            AND pending.expires_at > ?
            AND commands.correlation_id IS NULL
          ORDER BY pending.created_at, pending.correlation_id
        `,
        )
        .all(
          input.machineId,
          input.bridgeSessionId,
          input.harness,
          input.now,
        ) as ResumeCandidateRow[];

      for (const candidate of candidates) {
        if (candidate.state === "open") {
          return {
            outcome: "waiting",
            correlationId: candidate.correlation_id,
            sessionId: candidate.session_id,
            expiresAt: candidate.expires_at,
          };
        }
        if (candidate.answer === null) {
          continue;
        }
        const capabilities = JSON.parse(candidate.capabilities_json) as {
          lateResume?: unknown;
        };
        const supported =
          candidate.surface === "cli" && capabilities.lateResume === true;
        const state: ResumeCommandState = supported ? "claimed" : "unsupported";
        const inserted = this.database
          .prepare(
            `
            INSERT OR IGNORE INTO resume_commands (
              correlation_id, owner_id, machine_id, bridge_session_id,
              harness, surface, session_id, turn_id, answer, state, claimed_at,
              finished_at, error_code, error_message
            ) VALUES (
              @correlationId, @ownerId, @machineId, @bridgeSessionId,
              @harness, @surface, @sessionId, @turnId, @answer, @state,
              @claimedAt, @finishedAt, @errorCode, @errorMessage
            )
          `,
          )
          .run({
            correlationId: candidate.correlation_id,
            ownerId: input.ownerId,
            machineId: candidate.machine_id,
            bridgeSessionId: candidate.bridge_session_id,
            harness: candidate.harness,
            surface: candidate.surface,
            sessionId: candidate.session_id,
            turnId: candidate.turn_id,
            answer: candidate.answer,
            state,
            claimedAt: input.now,
            finishedAt: supported ? null : input.now,
            errorCode: supported ? null : "late-resume-unsupported",
            errorMessage: supported
              ? null
              : `late resume is unsupported for ${candidate.harness}/${candidate.surface}`,
          }).changes;
        if (inserted !== 1) {
          continue;
        }
        if (!supported) {
          return {
            outcome: "unsupported",
            correlationId: candidate.correlation_id,
            harness: candidate.harness,
            surface: candidate.surface,
            sessionId: candidate.session_id,
          };
        }
        const command = this.getResumeCommand(candidate.correlation_id);
        if (command === undefined) {
          throw new Error(
            `claimed resume command ${candidate.correlation_id} disappeared`,
          );
        }
        return { outcome: "claimed", command };
      }
      return { outcome: "none" };
    })();
  }

  public markResumeStarted(
    correlationId: string,
    ownerId: string,
    now: string,
  ): ResumeCommandRecord {
    const changes = this.database
      .prepare(
        `
        UPDATE resume_commands SET
          state = 'running',
          started_at = ?
        WHERE correlation_id = ?
          AND owner_id = ?
          AND state = 'claimed'
      `,
      )
      .run(now, correlationId, ownerId).changes;
    if (changes !== 1) {
      throw new Error(
        `resume command ${correlationId} is not claimable by ${ownerId}`,
      );
    }
    const command = this.getResumeCommand(correlationId);
    if (command === undefined) {
      throw new Error(`resume command ${correlationId} disappeared`);
    }
    return command;
  }

  public markResumeFinished(input: {
    correlationId: string;
    ownerId: string;
    succeeded: boolean;
    now: string;
    exitCode?: number;
    signal?: string;
    errorCode?: string;
    errorMessage?: string;
  }): ResumeCommandRecord {
    const changes = this.database
      .prepare(
        `
        UPDATE resume_commands SET
          state = @state,
          finished_at = @now,
          exit_code = @exitCode,
          signal = @signal,
          error_code = @errorCode,
          error_message = @errorMessage
        WHERE correlation_id = @correlationId
          AND owner_id = @ownerId
          AND state = 'running'
      `,
      )
      .run({
        ...input,
        state: input.succeeded ? "succeeded" : "failed",
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
      }).changes;
    if (changes !== 1) {
      throw new Error(
        `resume command ${input.correlationId} is not running for ${input.ownerId}`,
      );
    }
    const command = this.getResumeCommand(input.correlationId);
    if (command === undefined) {
      throw new Error(`resume command ${input.correlationId} disappeared`);
    }
    return command;
  }

  public claimTelegramUpdate(updateId: number, receivedAt: string): boolean {
    return (
      this.database
        .prepare(
          `
          INSERT OR IGNORE INTO telegram_updates (
            update_id, received_at, outcome
          ) VALUES (?, ?, 'claimed')
        `,
        )
        .run(updateId, receivedAt).changes === 1
    );
  }

  public completeTelegramUpdate(updateId: number, outcome: string): void {
    this.database
      .prepare(
        `
        UPDATE telegram_updates SET outcome = ?
        WHERE update_id = ?
      `,
      )
      .run(outcome.slice(0, 120), updateId);
  }

  public recordDiagnostic(
    diagnosticInput: RelayDiagnosticV1,
  ): DiagnosticIngestResult {
    const diagnostic = RelayDiagnosticV1Schema.parse(diagnosticInput);
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO diagnostics (
          diagnostic_id, recorded_at, source, level, code, message, created_at
        ) VALUES (
          @diagnosticId, @recordedAt, @source, @level, @code, @message,
          @recordedAt
        )
      `,
      )
      .run(diagnostic);
    if (result.changes === 0) {
      const existing = this.database
        .prepare(
          `
          SELECT recorded_at, source, level, code, message
          FROM diagnostics WHERE diagnostic_id = ?
        `,
        )
        .get(diagnostic.diagnosticId) as
        | {
            recorded_at: string;
            source: string;
            level: string;
            code: string;
            message: string;
          }
        | undefined;
      if (
        existing === undefined ||
        existing.recorded_at !== diagnostic.recordedAt ||
        existing.source !== diagnostic.source ||
        existing.level !== diagnostic.level ||
        existing.code !== diagnostic.code ||
        existing.message !== diagnostic.message
      ) {
        throw new Error(
          `diagnostic id collision: ${diagnostic.diagnosticId} has a different payload`,
        );
      }
    }
    return {
      diagnosticId: diagnostic.diagnosticId,
      inserted: result.changes === 1,
    };
  }

  public listDiagnostics(limit = 100): RelayDiagnosticV1[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("diagnostic limit must be between 1 and 500");
    }
    const rows = this.database
      .prepare(
        `
        SELECT diagnostic_id, recorded_at, source, level, code, message
        FROM diagnostics
        ORDER BY recorded_at DESC, diagnostic_id DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<{
      diagnostic_id: string;
      recorded_at: string;
      source: RelayDiagnosticV1["source"];
      level: RelayDiagnosticV1["level"];
      code: string;
      message: string;
    }>;
    return rows.map((row) => ({
      schema: "agent-relay-diagnostic.v1",
      diagnosticId: row.diagnostic_id,
      recordedAt: row.recorded_at,
      source: row.source,
      level: row.level,
      code: row.code,
      message: row.message,
    }));
  }

  public listWebChanges(afterCursor = 0, limit = 100): WebChangeRecord[] {
    if (
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error("web change cursor or limit is outside supported bounds");
    }
    const rows = this.database
      .prepare(
        `
        SELECT
          change_id, kind, action, entity_id, session_id, occurred_at,
          payload_json
        FROM web_changes
        WHERE change_id > ?
        ORDER BY change_id
        LIMIT ?
      `,
      )
      .all(afterCursor, limit) as WebChangeRow[];
    return rows.map((row) => ({
      cursor: row.change_id,
      kind: row.kind,
      action: row.action,
      entityId: row.entity_id,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  public listSessionTimeline(
    input: {
      machineId: string;
      harness: Harness;
      sessionId: string;
    },
    limit = 100,
  ): SessionTimelineRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("session timeline limit must be between 1 and 500");
    }
    const rows = this.database
      .prepare(
        `
        WITH timeline AS (
          SELECT
            'event:' || events.event_id AS id,
            'hook-event' AS kind,
            json_extract(events.payload_json, '$.occurredAt') AS at,
            events.status AS status,
            events.type AS label,
            events.event_id AS event_id,
            pending.correlation_id AS correlation_id,
            events.last_error_code AS detail_code
          FROM events
          LEFT JOIN pending_requests AS pending
            ON pending.event_id = events.event_id
          WHERE events.machine_id = @machineId
            AND events.harness = @harness
            AND events.session_id = @sessionId

          UNION ALL

          SELECT
            'delivery:' || attempts.id AS id,
            'delivery' AS kind,
            COALESCE(attempts.finished_at, attempts.started_at) AS at,
            attempts.status AS status,
            'attempt-' || attempts.attempt_number AS label,
            events.event_id AS event_id,
            pending.correlation_id AS correlation_id,
            attempts.error_code AS detail_code
          FROM delivery_attempts AS attempts
          JOIN events ON events.event_id = attempts.event_id
          LEFT JOIN pending_requests AS pending
            ON pending.event_id = events.event_id
          WHERE events.machine_id = @machineId
            AND events.harness = @harness
            AND events.session_id = @sessionId

          UNION ALL

          SELECT
            'request:' || pending.correlation_id || ':opened' AS id,
            'request' AS kind,
            pending.created_at AS at,
            'open' AS status,
            pending.request_kind AS label,
            pending.event_id AS event_id,
            pending.correlation_id AS correlation_id,
            NULL AS detail_code
          FROM pending_requests AS pending
          WHERE pending.machine_id = @machineId
            AND pending.harness = @harness
            AND pending.session_id = @sessionId

          UNION ALL

          SELECT
            'request:' || pending.correlation_id || ':resolved' AS id,
            'operator-action' AS kind,
            pending.resolved_at AS at,
            pending.state AS status,
            COALESCE(pending.resolved_by, 'unknown') AS label,
            pending.event_id AS event_id,
            pending.correlation_id AS correlation_id,
            'request-resolution' AS detail_code
          FROM pending_requests AS pending
          WHERE pending.machine_id = @machineId
            AND pending.harness = @harness
            AND pending.session_id = @sessionId
            AND pending.resolved_at IS NOT NULL

          UNION ALL

          SELECT
            'action:' || actions.action_token AS id,
            'operator-action' AS kind,
            COALESCE(executions.finished_at, executions.claimed_at) AS at,
            executions.state AS status,
            actions.action_kind AS label,
            events.event_id AS event_id,
            pending.correlation_id AS correlation_id,
            executions.outcome AS detail_code
          FROM card_action_executions AS executions
          JOIN card_actions AS actions
            ON actions.action_token = executions.action_token
          JOIN events ON events.event_id = actions.event_id
          LEFT JOIN pending_requests AS pending
            ON pending.event_id = events.event_id
          WHERE events.machine_id = @machineId
            AND events.harness = @harness
            AND events.session_id = @sessionId

          UNION ALL

          SELECT
            'resume:' || commands.correlation_id AS id,
            'continuation' AS kind,
            COALESCE(
              commands.finished_at,
              commands.started_at,
              commands.claimed_at
            ) AS at,
            commands.state AS status,
            'harness-resume' AS label,
            pending.event_id AS event_id,
            commands.correlation_id AS correlation_id,
            COALESCE(
              commands.error_code,
              commands.signal,
              CASE
                WHEN commands.exit_code IS NULL THEN NULL
                ELSE 'exit-' || commands.exit_code
              END
            ) AS detail_code
          FROM resume_commands AS commands
          LEFT JOIN pending_requests AS pending
            ON pending.correlation_id = commands.correlation_id
          WHERE commands.machine_id = @machineId
            AND commands.harness = @harness
            AND commands.session_id = @sessionId
        )
        SELECT
          id, kind, at, status, label, event_id, correlation_id, detail_code
        FROM timeline
        WHERE at IS NOT NULL
        ORDER BY at DESC, id DESC
        LIMIT @limit
      `,
      )
      .all({ ...input, limit }) as SessionTimelineRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      at: row.at,
      status: row.status,
      label: row.label,
      ...(row.event_id === null ? {} : { eventId: row.event_id }),
      ...(row.correlation_id === null
        ? {}
        : { correlationId: row.correlation_id }),
      ...(row.detail_code === null ? {} : { detailCode: row.detail_code }),
    }));
  }

  public webChangeBounds(): WebChangeBounds {
    const row = this.database
      .prepare(
        `
        SELECT MIN(change_id) AS first_cursor, MAX(change_id) AS last_cursor
        FROM web_changes
      `,
      )
      .get() as {
      first_cursor: number | null;
      last_cursor: number | null;
    };
    return {
      ...(row.first_cursor === null ? {} : { firstCursor: row.first_cursor }),
      ...(row.last_cursor === null ? {} : { lastCursor: row.last_cursor }),
    };
  }

  public pruneRetention(cutoffs: RetentionCutoffs): RetentionResult {
    for (const [name, value] of Object.entries(cutoffs)) {
      if (name !== "limit") {
        assertIsoCutoff(String(value), name);
      }
    }
    const limit = cutoffs.limit ?? 5_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
      throw new Error("retention limit must be between 1 and 50000");
    }

    return this.database.transaction((): RetentionResult => {
      const result: RetentionResult = {
        requestsExpired: 0,
        pendingRequests: 0,
        interactionDrafts: 0,
        questionSetDrafts: 0,
        resumeCommands: 0,
        events: 0,
        deliveryAttempts: 0,
        diagnostics: 0,
        telegramUpdates: 0,
        topicCleanupOperations: 0,
        nativeHookSequenceAllocations: 0,
        nativeHookSequenceCounters: 0,
        sessions: 0,
        webChanges: 0,
        browserCommands: 0,
      };
      const requestRows = this.database
        .prepare(
          `
          SELECT pending.correlation_id
          FROM pending_requests AS pending
          WHERE COALESCE(pending.resolved_at, pending.expires_at) < ?
            AND (
              pending.state IN ('expired', 'cancelled', 'failed')
              OR (
                pending.state = 'answered'
                AND NOT EXISTS (
                  SELECT 1 FROM resume_commands AS command
                  WHERE command.correlation_id = pending.correlation_id
                    AND command.state IN ('claimed', 'running')
                )
              )
            )
          ORDER BY COALESCE(pending.resolved_at, pending.expires_at),
            pending.correlation_id
          LIMIT ?
        `,
        )
        .all(cutoffs.requestBefore, limit) as Array<{
        correlation_id: string;
      }>;
      const deleteResume = this.database.prepare(
        "DELETE FROM resume_commands WHERE correlation_id = ?",
      );
      const deleteOptions = this.database.prepare(
        "DELETE FROM pending_options WHERE correlation_id = ?",
      );
      const deleteDraft = this.database.prepare(
        "DELETE FROM interaction_drafts WHERE correlation_id = ?",
      );
      const deleteQuestionSetDraft = this.database.prepare(
        "DELETE FROM question_set_drafts WHERE correlation_id = ?",
      );
      const deleteRequest = this.database.prepare(
        "DELETE FROM pending_requests WHERE correlation_id = ?",
      );
      for (const row of requestRows) {
        result.resumeCommands += deleteResume.run(row.correlation_id).changes;
        result.interactionDrafts += deleteDraft.run(row.correlation_id).changes;
        result.questionSetDrafts += deleteQuestionSetDraft.run(
          row.correlation_id,
        ).changes;
        deleteOptions.run(row.correlation_id);
        result.pendingRequests += deleteRequest.run(row.correlation_id).changes;
      }

      const eventRows = this.database
        .prepare(
          `
          SELECT events.event_id
          FROM events
          WHERE (
              (
                events.status = 'delivered'
                AND events.delivered_at IS NOT NULL
                AND events.delivered_at < @deliveredBefore
              )
              OR (
                events.status = 'dead_letter'
                AND events.created_at < @deadLetterBefore
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM pending_requests AS pending
              WHERE pending.event_id = events.event_id
            )
          ORDER BY events.created_at, events.event_id
          LIMIT @limit
        `,
        )
        .all({
          deliveredBefore: cutoffs.deliveredBefore,
          deadLetterBefore: cutoffs.deadLetterBefore,
          limit,
        }) as Array<{ event_id: string }>;
      const deleteAttempts = this.database.prepare(
        "DELETE FROM delivery_attempts WHERE event_id = ?",
      );
      const deleteEvent = this.database.prepare(
        `
        DELETE FROM events
        WHERE event_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM pending_requests
            WHERE pending_requests.event_id = events.event_id
          )
      `,
      );
      for (const row of eventRows) {
        result.deliveryAttempts += deleteAttempts.run(row.event_id).changes;
        result.events += deleteEvent.run(row.event_id).changes;
      }

      result.diagnostics = this.database
        .prepare(
          `
          DELETE FROM diagnostics
          WHERE diagnostic_id IN (
            SELECT diagnostic_id FROM diagnostics
            WHERE recorded_at < ?
            ORDER BY recorded_at, diagnostic_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.diagnosticBefore, limit).changes;
      result.telegramUpdates = this.database
        .prepare(
          `
          DELETE FROM telegram_updates
          WHERE update_id IN (
            SELECT update_id FROM telegram_updates
            WHERE received_at < ?
            ORDER BY received_at, update_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.telegramUpdateBefore, limit).changes;
      result.topicCleanupOperations = this.database
        .prepare(
          `
          DELETE FROM topic_cleanup_operations
          WHERE operation_id IN (
            SELECT operation_id FROM topic_cleanup_operations
            WHERE finished_at IS NOT NULL
              AND finished_at < @topicCleanupBefore
              AND state IN (
                'completed', 'completed-with-errors', 'cancelled', 'expired',
                'superseded', 'preview-failed'
              )
            ORDER BY finished_at, operation_id
            LIMIT @limit
          )
        `,
        )
        .run({
          topicCleanupBefore: cutoffs.topicCleanupBefore,
          limit,
        }).changes;
      result.sessions = this.database
        .prepare(
          `
          DELETE FROM sessions
          WHERE rowid IN (
            SELECT sessions.rowid FROM sessions
            WHERE sessions.last_seen_at < ?
              AND sessions.state IN ('stopped', 'suspected_stalled', 'exited')
              AND NOT EXISTS (
                SELECT 1 FROM events
                WHERE events.machine_id = sessions.machine_id
                  AND events.harness = sessions.harness
                  AND events.session_id = sessions.session_id
              )
            ORDER BY sessions.last_seen_at, sessions.rowid
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.sessionBefore, limit).changes;
      result.nativeHookSequenceAllocations = this.database
        .prepare(
          `
          DELETE FROM native_hook_sequence_allocations
          WHERE rowid IN (
            SELECT allocation.rowid
            FROM native_hook_sequence_allocations AS allocation
            LEFT JOIN events
              ON events.event_id = allocation.event_id
            WHERE allocation.allocated_at < @deadLetterBefore
              AND events.event_id IS NULL
            ORDER BY allocation.allocated_at, allocation.rowid
            LIMIT @limit
          )
        `,
        )
        .run({
          deadLetterBefore: cutoffs.deadLetterBefore,
          limit,
        }).changes;
      result.nativeHookSequenceCounters = this.database
        .prepare(
          `
          DELETE FROM native_hook_sequence_counters
          WHERE rowid IN (
            SELECT counter.rowid
            FROM native_hook_sequence_counters AS counter
            LEFT JOIN sessions
              ON sessions.machine_id = counter.machine_id
              AND sessions.harness = counter.harness
              AND sessions.session_id = counter.session_id
            WHERE counter.updated_at < @sessionBefore
              AND sessions.session_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM native_hook_sequence_allocations AS allocation
                WHERE allocation.machine_id = counter.machine_id
                  AND allocation.harness = counter.harness
                  AND allocation.session_id = counter.session_id
              )
            ORDER BY counter.updated_at, counter.rowid
            LIMIT @limit
          )
        `,
        )
        .run({
          sessionBefore: cutoffs.sessionBefore,
          limit,
        }).changes;
      result.webChanges = this.database
        .prepare(
          `
          DELETE FROM web_changes
          WHERE change_id IN (
            SELECT change_id FROM web_changes
            WHERE occurred_at < ?
            ORDER BY change_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.webChangeBefore, limit).changes;
      result.browserCommands = this.database
        .prepare(
          `
          DELETE FROM browser_commands
          WHERE operation_id IN (
            SELECT operation_id FROM browser_commands
            WHERE created_at < ?
            ORDER BY created_at, operation_id
            LIMIT ?
          )
        `,
        )
        .run(cutoffs.browserCommandBefore, limit).changes;
      return result;
    })();
  }

  public listSessions(limit?: number): SessionRecord[] {
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    ) {
      throw new Error("session limit must be between 1 and 500");
    }
    const rows = this.database
      .prepare(
        `
        SELECT
          machine_id, bridge_session_id, harness, surface, harness_version,
          session_id, project_json, state, last_event_type, last_seen_at,
          last_sequence
        FROM sessions
        ORDER BY last_seen_at DESC, machine_id, harness, session_id
        ${limit === undefined ? "" : "LIMIT ?"}
      `,
      )
      .all(...(limit === undefined ? [] : [limit])) as SessionRow[];
    return rows.map((row) => ({
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: row.harness,
      surface: row.surface,
      harnessVersion: row.harness_version,
      sessionId: row.session_id,
      project: ProjectRefSchema.parse(JSON.parse(row.project_json) as unknown),
      state: row.state,
      ...(row.last_event_type === null
        ? {}
        : { lastEventType: row.last_event_type }),
      lastSeenAt: row.last_seen_at,
      lastSequence: row.last_sequence,
    }));
  }

  public getSession(input: {
    machineId: string;
    harness: Harness;
    sessionId: string;
  }): SessionRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT
          machine_id, bridge_session_id, harness, surface, harness_version,
          session_id, project_json, state, last_event_type, last_seen_at,
          last_sequence
        FROM sessions
        WHERE machine_id = @machineId
          AND harness = @harness
          AND session_id = @sessionId
      `,
      )
      .get(input) as SessionRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      machineId: row.machine_id,
      bridgeSessionId: row.bridge_session_id,
      harness: row.harness,
      surface: row.surface,
      harnessVersion: row.harness_version,
      sessionId: row.session_id,
      project: ProjectRefSchema.parse(JSON.parse(row.project_json) as unknown),
      state: row.state,
      ...(row.last_event_type === null
        ? {}
        : { lastEventType: row.last_event_type }),
      lastSeenAt: row.last_seen_at,
      lastSequence: row.last_sequence,
    };
  }

  public listSessionsByBridge(input: {
    machineId: string;
    bridgeSessionId: string;
    harness: Harness;
  }): SessionRecord[] {
    return this.listSessions().filter(
      (session) =>
        session.machineId === input.machineId &&
        session.bridgeSessionId === input.bridgeSessionId &&
        session.harness === input.harness,
    );
  }

  public getHostedDeliveryForMessage(
    streamKey: string,
    messageId: string,
  ): HostedDeliveryRecord | undefined {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertHostedOpaque(messageId, "hosted message id");
    const row = this.database
      .prepare(
        `
        SELECT event_id, message_id, interaction_id, interaction_type
        FROM hosted_delivery_mappings
        WHERE stream_key = ?
          AND transport_name = 'whooshbang'
          AND message_id = ?
      `,
      )
      .get(streamKey, messageId) as
      | {
          event_id: string;
          message_id: string;
          interaction_id: string;
          interaction_type: HostedInteractionType;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const request = this.getPendingForEvent(row.event_id);
    const storedEvent = this.getEvent(row.event_id);
    if (request === undefined || storedEvent === undefined) {
      return undefined;
    }
    return {
      eventId: row.event_id,
      messageId: row.message_id,
      interactionId: row.interaction_id,
      interactionType: row.interaction_type,
      request,
      event: storedEvent.event,
    };
  }

  private hostedClaim(
    streamKey: string,
    eventId: string,
    replayed: boolean,
  ): HostedClaimRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT
          stream_key, event_id, cursor, payload_hash, message_id,
          interaction_id, outcome, disposition, reason_code, handled_at
        FROM hosted_event_claims
        WHERE stream_key = ? AND event_id = ?
      `,
      )
      .get(streamKey, eventId) as
      | {
          stream_key: string;
          event_id: string;
          cursor: string;
          payload_hash: string;
          message_id: string;
          interaction_id: string;
          outcome: HostedClaimOutcome;
          disposition: HostedAcknowledgementDisposition | null;
          reason_code: string | null;
          handled_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          streamKey: row.stream_key,
          eventId: row.event_id,
          cursor: row.cursor,
          payloadHash: row.payload_hash,
          messageId: row.message_id,
          interactionId: row.interaction_id,
          outcome: row.outcome,
          ...(row.disposition === null ? {} : { disposition: row.disposition }),
          ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
          replayed,
          handledAt: row.handled_at,
        };
  }

  public recordHostedEventClaim(
    input: RecordHostedClaimInput,
  ): HostedClaimRecord {
    if (!/^[a-f0-9]{64}$/u.test(input.streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertHostedOpaque(input.eventId, "hosted event id");
    assertHostedOpaque(input.cursor, "hosted cursor");
    if (!/^[a-f0-9]{64}$/u.test(input.payloadHash)) {
      throw new Error("hosted event payload hash must be a SHA-256 digest");
    }
    assertHostedOpaque(input.messageId, "hosted message id");
    assertHostedOpaque(input.interactionId, "hosted interaction id");
    assertIsoCutoff(input.occurredAt, "hosted event occurrence");
    assertIsoCutoff(input.handledAt, "hosted event handling time");
    if (
      "reasonCode" in input.validation &&
      input.validation.reasonCode.length > 128
    ) {
      throw new Error("hosted outcome reason is too long");
    }

    return this.database.transaction((): HostedClaimRecord => {
      const prior = this.hostedClaim(input.streamKey, input.eventId, true);
      if (prior !== undefined) {
        if (
          prior.cursor !== input.cursor ||
          prior.payloadHash !== input.payloadHash ||
          prior.messageId !== input.messageId ||
          prior.interactionId !== input.interactionId
        ) {
          throw new Error(
            "hosted event identity changed after its durable claim",
          );
        }
        return prior;
      }

      const delivery = this.getHostedDeliveryForMessage(
        input.streamKey,
        input.messageId,
      );
      const deliveryMatches =
        delivery !== undefined &&
        delivery.interactionId === input.interactionId;
      let outcome: HostedClaimOutcome;
      let disposition: HostedAcknowledgementDisposition | undefined;
      let reasonCode: string | undefined;

      if (delivery === undefined) {
        outcome = "stopped";
        reasonCode =
          input.validation.outcome === "stop"
            ? input.validation.reasonCode
            : "request_not_found";
      } else if (!deliveryMatches) {
        outcome = "stopped";
        reasonCode = "correlation_mismatch";
      } else if (input.validation.outcome === "ready") {
        if (
          input.validation.resolution.correlationId !==
          delivery.request.correlationId
        ) {
          outcome = "stopped";
          reasonCode = "correlation_mismatch";
        } else {
          const resolution = this.resolveRequest(input.validation.resolution);
          switch (resolution.outcome) {
            case "answered":
              outcome = "answered";
              disposition = "processed";
              break;
            case "duplicate":
              outcome = "duplicate";
              disposition = "processed";
              reasonCode = "already_resolved";
              break;
            case "expired":
            case "cancelled":
              outcome = "terminal";
              disposition = "processed";
              reasonCode =
                resolution.outcome === "expired"
                  ? "locally_expired"
                  : "locally_cancelled";
              break;
            case "failed":
              outcome = "quarantined";
              disposition = "quarantined";
              reasonCode = "local_request_failed";
              break;
            case "identity_mismatch":
              outcome = "stopped";
              reasonCode = "local_identity_mismatch";
              break;
            case "not_found":
              outcome = "stopped";
              reasonCode = "request_not_found";
              break;
          }
        }
      } else {
        reasonCode = input.validation.reasonCode;
        switch (input.validation.outcome) {
          case "duplicate":
            outcome = "duplicate";
            disposition = "processed";
            break;
          case "terminal":
            outcome = "terminal";
            disposition = "processed";
            break;
          case "quarantine":
            outcome = "quarantined";
            disposition = "quarantined";
            break;
          case "stop":
            outcome = "stopped";
            break;
        }
      }

      this.database
        .prepare(
          `
          INSERT INTO hosted_event_claims (
            stream_key, event_id, cursor, payload_hash, message_id,
            interaction_id, outcome, disposition, reason_code, received_at,
            handled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.streamKey,
          input.eventId,
          input.cursor,
          input.payloadHash,
          input.messageId,
          input.interactionId,
          outcome,
          disposition ?? null,
          reasonCode ?? null,
          input.occurredAt,
          input.handledAt,
        );

      this.database
        .prepare(
          `
          INSERT INTO hosted_poll_state (
            stream_key, updated_at
          ) VALUES (?, ?)
          ON CONFLICT(stream_key) DO UPDATE SET updated_at = excluded.updated_at
        `,
        )
        .run(input.streamKey, input.handledAt);

      if (disposition !== undefined) {
        this.database
          .prepare(
            `
            INSERT INTO hosted_event_acknowledgements (
              stream_key, event_id, cursor, disposition, reason_code, state,
              attempt_count, next_attempt_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
          `,
          )
          .run(
            input.streamKey,
            input.eventId,
            input.cursor,
            disposition,
            reasonCode ?? null,
            input.handledAt,
            input.handledAt,
          );
        this.database
          .prepare(
            `
            INSERT INTO hosted_message_updates (
              stream_key, event_id, message_id, interaction_id, outcome,
              reason_code, state, attempt_count, next_attempt_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
          `,
          )
          .run(
            input.streamKey,
            input.eventId,
            input.messageId,
            input.interactionId,
            outcome,
            reasonCode ?? null,
            input.handledAt,
            input.handledAt,
          );
      }
      return this.hostedClaim(input.streamKey, input.eventId, false)!;
    })();
  }

  private hostedAcknowledgementFromRow(row: {
    stream_key: string;
    event_id: string;
    cursor: string;
    disposition: HostedAcknowledgementDisposition;
    reason_code: string | null;
    state: HostedAcknowledgementRecord["state"];
    attempt_count: number;
    next_attempt_at: string;
  }): HostedAcknowledgementRecord {
    return {
      streamKey: row.stream_key,
      eventId: row.event_id,
      cursor: row.cursor,
      disposition: row.disposition,
      ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
      state: row.state,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
    };
  }

  public getHostedAcknowledgementBarrier(
    streamKey: string,
  ): HostedAcknowledgementRecord | undefined {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    const row = this.database
      .prepare(
        `
        SELECT
          acknowledgement.stream_key, acknowledgement.event_id,
          acknowledgement.cursor, acknowledgement.disposition,
          acknowledgement.reason_code, acknowledgement.state,
          acknowledgement.attempt_count, acknowledgement.next_attempt_at
        FROM hosted_event_acknowledgements AS acknowledgement
        JOIN hosted_event_claims AS claim
          ON claim.stream_key = acknowledgement.stream_key
          AND claim.event_id = acknowledgement.event_id
        WHERE acknowledgement.stream_key = ?
          AND acknowledgement.state <> 'acknowledged'
        ORDER BY claim.claim_id
        LIMIT 1
      `,
      )
      .get(streamKey) as
      | {
          stream_key: string;
          event_id: string;
          cursor: string;
          disposition: HostedAcknowledgementDisposition;
          reason_code: string | null;
          state: HostedAcknowledgementRecord["state"];
          attempt_count: number;
          next_attempt_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : this.hostedAcknowledgementFromRow(row);
  }

  public claimHostedAcknowledgement(
    streamKey: string,
    now: string,
  ): HostedAcknowledgementRecord | undefined {
    assertIsoCutoff(now, "hosted acknowledgement claim time");
    return this.database.transaction(() => {
      const barrier = this.getHostedAcknowledgementBarrier(streamKey);
      if (
        barrier === undefined ||
        barrier.state === "blocked" ||
        barrier.state === "acknowledging" ||
        barrier.nextAttemptAt > now
      ) {
        return undefined;
      }
      const update = this.database
        .prepare(
          `
          UPDATE hosted_event_acknowledgements SET
            state = 'acknowledging',
            attempt_count = attempt_count + 1,
            updated_at = ?
          WHERE stream_key = ? AND event_id = ?
            AND state IN ('pending', 'retry')
        `,
        )
        .run(now, streamKey, barrier.eventId);
      if (update.changes !== 1) {
        return undefined;
      }
      return {
        ...barrier,
        state: "acknowledging" as const,
        attemptCount: barrier.attemptCount + 1,
      };
    })();
  }

  private hostedMessageUpdateFromRow(row: {
    stream_key: string;
    event_id: string;
    message_id: string;
    interaction_id: string;
    outcome: HostedClaimOutcome;
    reason_code: string | null;
    resolved_by: PendingRequestRecord["resolvedBy"] | null;
    state: HostedMessageUpdateRecord["state"];
    attempt_count: number;
    next_attempt_at: string;
    last_error_code: string | null;
  }): HostedMessageUpdateRecord {
    const outcome: HostedPresentationOutcome =
      row.outcome === "answered"
        ? "answered"
        : row.outcome === "duplicate"
          ? "duplicate"
          : row.reason_code === "locally_expired" ||
              row.reason_code === "answer_after_expiry"
            ? "expired"
            : row.reason_code === "locally_cancelled"
              ? "cancelled"
              : "unsupported";
    return {
      streamKey: row.stream_key,
      eventId: row.event_id,
      messageId: row.message_id,
      interactionId: row.interaction_id,
      outcome,
      ...(row.resolved_by === null
        ? {}
        : { resolutionSource: row.resolved_by }),
      ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
      state: row.state,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      ...(row.last_error_code === null
        ? {}
        : { lastErrorCode: row.last_error_code }),
    };
  }

  public getHostedMessageUpdate(
    streamKey: string,
    eventId: string,
  ): HostedMessageUpdateRecord | undefined {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertHostedOpaque(eventId, "hosted event id");
    const row = this.database
      .prepare(
        `
        SELECT
          message_update.stream_key, message_update.event_id,
          message_update.message_id, message_update.interaction_id,
          message_update.outcome, message_update.reason_code,
          message_update.state, message_update.attempt_count,
          message_update.next_attempt_at, message_update.last_error_code,
          request.resolved_by
        FROM hosted_message_updates AS message_update
        JOIN hosted_event_claims AS claim
          ON claim.stream_key = message_update.stream_key
          AND claim.event_id = message_update.event_id
        JOIN hosted_delivery_mappings AS delivery
          ON delivery.stream_key = message_update.stream_key
          AND delivery.message_id = claim.message_id
        LEFT JOIN pending_requests AS request
          ON request.event_id = delivery.event_id
        WHERE message_update.stream_key = ?
          AND message_update.event_id = ?
      `,
      )
      .get(streamKey, eventId) as
      | {
          stream_key: string;
          event_id: string;
          message_id: string;
          interaction_id: string;
          outcome: HostedClaimOutcome;
          reason_code: string | null;
          resolved_by: PendingRequestRecord["resolvedBy"] | null;
          state: HostedMessageUpdateRecord["state"];
          attempt_count: number;
          next_attempt_at: string;
          last_error_code: string | null;
        }
      | undefined;
    return row === undefined ? undefined : this.hostedMessageUpdateFromRow(row);
  }

  public claimHostedMessageUpdate(
    streamKey: string,
    now: string,
  ): HostedMessageUpdateRecord | undefined {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertIsoCutoff(now, "hosted message update claim time");
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `
          SELECT message_update.event_id
          FROM hosted_message_updates AS message_update
          JOIN hosted_event_claims AS claim
            ON claim.stream_key = message_update.stream_key
            AND claim.event_id = message_update.event_id
          JOIN hosted_event_acknowledgements AS acknowledgement
            ON acknowledgement.stream_key = message_update.stream_key
            AND acknowledgement.event_id = message_update.event_id
          WHERE message_update.stream_key = ?
            AND message_update.state IN ('pending', 'retry')
            AND message_update.next_attempt_at <= ?
            AND acknowledgement.state = 'acknowledged'
          ORDER BY claim.claim_id
          LIMIT 1
        `,
        )
        .get(streamKey, now) as { event_id: string } | undefined;
      if (row === undefined) {
        return undefined;
      }
      const update = this.database
        .prepare(
          `
          UPDATE hosted_message_updates SET
            state = 'updating',
            attempt_count = attempt_count + 1,
            updated_at = ?
          WHERE stream_key = ? AND event_id = ?
            AND state IN ('pending', 'retry')
        `,
        )
        .run(now, streamKey, row.event_id);
      return update.changes === 1
        ? this.getHostedMessageUpdate(streamKey, row.event_id)
        : undefined;
    })();
  }

  public markHostedMessageUpdateFailed(input: {
    streamKey: string;
    eventId: string;
    errorCode: string;
    retryAt: string;
    retryable: boolean;
    now: string;
  }): void {
    assertHostedOpaque(input.errorCode, "hosted message update error", 128);
    assertIsoCutoff(input.retryAt, "hosted message update retry time");
    assertIsoCutoff(input.now, "hosted message update failure time");
    const state = input.retryable ? "retry" : "blocked";
    const update = this.database
      .prepare(
        `
        UPDATE hosted_message_updates SET
          state = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE stream_key = ? AND event_id = ? AND state = 'updating'
      `,
      )
      .run(
        state,
        input.retryAt,
        input.errorCode,
        input.now,
        input.streamKey,
        input.eventId,
      );
    if (update.changes !== 1) {
      throw new Error("hosted message update is not claimed");
    }
  }

  public markHostedMessageUpdateSucceeded(input: {
    streamKey: string;
    eventId: string;
    now: string;
  }): void {
    assertIsoCutoff(input.now, "hosted message update completion time");
    const update = this.database
      .prepare(
        `
        UPDATE hosted_message_updates SET
          state = 'updated', last_error_code = NULL, updated_at = ?
        WHERE stream_key = ? AND event_id = ? AND state = 'updating'
      `,
      )
      .run(input.now, input.streamKey, input.eventId);
    if (update.changes !== 1) {
      throw new Error("hosted message update is not claimed");
    }
  }

  public recoverHostedInteractionWork(now: string): number {
    assertIsoCutoff(now, "hosted recovery time");
    return this.database.transaction(() => {
      const acknowledgements = this.database
        .prepare(
          `
          UPDATE hosted_event_acknowledgements SET
            state = 'retry',
            next_attempt_at = ?,
            last_error_code = 'daemon-interrupted',
            updated_at = ?
          WHERE state = 'acknowledging'
        `,
        )
        .run(now, now).changes;
      const updates = this.database
        .prepare(
          `
          UPDATE hosted_message_updates SET
            state = 'retry',
            next_attempt_at = ?,
            last_error_code = 'daemon-interrupted',
            updated_at = ?
          WHERE state = 'updating'
        `,
        )
        .run(now, now).changes;
      return acknowledgements + updates;
    })();
  }

  public requeueBlockedHostedConnectionWork(input: {
    streamKey: string;
    errorCodes: readonly string[];
    now: string;
  }): number {
    if (!/^[a-f0-9]{64}$/u.test(input.streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    if (input.errorCodes.length < 1 || input.errorCodes.length > 32) {
      throw new Error(
        "hosted reconnect error-code set must contain between 1 and 32 entries",
      );
    }
    const errorCodes = [...new Set(input.errorCodes)];
    for (const code of errorCodes) {
      assertHostedOpaque(code, "hosted reconnect error", 128);
    }
    assertIsoCutoff(input.now, "hosted reconnect time");
    const placeholders = errorCodes.map(() => "?").join(", ");
    return this.database.transaction(() => {
      const acknowledgements = this.database
        .prepare(
          `
          UPDATE hosted_event_acknowledgements SET
            state = 'retry',
            next_attempt_at = ?,
            updated_at = ?
          WHERE stream_key = ?
            AND state = 'blocked'
            AND last_error_code IN (${placeholders})
        `,
        )
        .run(input.now, input.now, input.streamKey, ...errorCodes).changes;
      const updates = this.database
        .prepare(
          `
          UPDATE hosted_message_updates SET
            state = 'retry',
            next_attempt_at = ?,
            updated_at = ?
          WHERE stream_key = ?
            AND state = 'blocked'
            AND last_error_code IN (${placeholders})
        `,
        )
        .run(input.now, input.now, input.streamKey, ...errorCodes).changes;
      return acknowledgements + updates;
    })();
  }

  public markHostedAcknowledgementFailed(input: {
    streamKey: string;
    eventId: string;
    errorCode: string;
    retryAt: string;
    retryable: boolean;
    now: string;
  }): void {
    assertHostedOpaque(input.errorCode, "hosted acknowledgement error", 128);
    assertIsoCutoff(input.retryAt, "hosted acknowledgement retry time");
    assertIsoCutoff(input.now, "hosted acknowledgement failure time");
    const state = input.retryable ? "retry" : "blocked";
    const update = this.database
      .prepare(
        `
        UPDATE hosted_event_acknowledgements SET
          state = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE stream_key = ? AND event_id = ? AND state = 'acknowledging'
      `,
      )
      .run(
        state,
        input.retryAt,
        input.errorCode,
        input.now,
        input.streamKey,
        input.eventId,
      );
    if (update.changes !== 1) {
      throw new Error("hosted acknowledgement is not claimed");
    }
    this.recordHostedPollFailure(input.streamKey, input.errorCode, input.now);
  }

  public markHostedAcknowledgementSucceeded(input: {
    streamKey: string;
    eventId: string;
    cursor: string;
    disposition: HostedAcknowledgementDisposition;
    committedCursor: string;
    now: string;
  }): void {
    assertIsoCutoff(input.now, "hosted acknowledgement completion time");
    this.database.transaction(() => {
      const barrier = this.getHostedAcknowledgementBarrier(input.streamKey);
      if (
        barrier === undefined ||
        barrier.eventId !== input.eventId ||
        barrier.state !== "acknowledging" ||
        barrier.cursor !== input.cursor ||
        barrier.disposition !== input.disposition ||
        input.committedCursor !== input.cursor
      ) {
        throw new Error(
          "hosted acknowledgement response did not match durable work",
        );
      }
      this.database
        .prepare(
          `
          UPDATE hosted_event_acknowledgements SET
            state = 'acknowledged',
            acknowledged_at = ?,
            last_error_code = NULL,
            updated_at = ?
          WHERE stream_key = ? AND event_id = ?
        `,
        )
        .run(input.now, input.now, input.streamKey, input.eventId);
      this.database
        .prepare(
          `
          INSERT INTO hosted_poll_state (
            stream_key, committed_cursor, last_successful_poll_at,
            updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(stream_key) DO UPDATE SET
            committed_cursor = excluded.committed_cursor,
            last_successful_poll_at = excluded.last_successful_poll_at,
            last_error_code = NULL,
            last_error_at = NULL,
            updated_at = excluded.updated_at
        `,
        )
        .run(input.streamKey, input.committedCursor, input.now, input.now);
    })();
  }

  public recordHostedPollSucceeded(input: {
    streamKey: string;
    committedCursor?: string;
    observedCommittedCursor?: string;
    now: string;
  }): void {
    if (!/^[a-f0-9]{64}$/u.test(input.streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertIsoCutoff(input.now, "hosted poll completion time");
    if (input.committedCursor !== input.observedCommittedCursor) {
      throw new Error(
        "hosted stream committed cursor disagrees with local authority",
      );
    }
    this.database.transaction(() => {
      const row = this.database
        .prepare(
          `
          SELECT committed_cursor
          FROM hosted_poll_state
          WHERE stream_key = ?
        `,
        )
        .get(input.streamKey) as
        { committed_cursor: string | null } | undefined;
      const durableCursor = row?.committed_cursor ?? undefined;
      if (durableCursor !== input.committedCursor) {
        throw new Error(
          "hosted stream cursor changed while a poll was in flight",
        );
      }
      this.database
        .prepare(
          `
          INSERT INTO hosted_poll_state (
            stream_key, committed_cursor, last_successful_poll_at, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(stream_key) DO UPDATE SET
            last_successful_poll_at = excluded.last_successful_poll_at,
            last_error_code = NULL,
            last_error_at = NULL,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          input.streamKey,
          input.committedCursor ?? null,
          input.now,
          input.now,
        );
    })();
  }

  public recordHostedPollFailure(
    streamKey: string,
    errorCode: string,
    now: string,
  ): void {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    assertHostedOpaque(errorCode, "hosted poll error", 128);
    assertIsoCutoff(now, "hosted poll failure time");
    this.database
      .prepare(
        `
        INSERT INTO hosted_poll_state (
          stream_key, last_error_code, last_error_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(stream_key) DO UPDATE SET
          last_error_code = excluded.last_error_code,
          last_error_at = excluded.last_error_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(streamKey, errorCode, now, now);
  }

  public hostedPollStatus(streamKey: string): HostedPollStatus {
    if (!/^[a-f0-9]{64}$/u.test(streamKey)) {
      throw new Error("hosted stream key must be a full SHA-256 digest");
    }
    const state = this.database
      .prepare(
        `
        SELECT
          committed_cursor, last_successful_poll_at, last_error_code,
          last_error_at
        FROM hosted_poll_state
        WHERE stream_key = ?
      `,
      )
      .get(streamKey) as
      | {
          committed_cursor: string | null;
          last_successful_poll_at: string | null;
          last_error_code: string | null;
          last_error_at: string | null;
        }
      | undefined;
    const count = this.database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM hosted_event_acknowledgements
        WHERE stream_key = ? AND state <> 'acknowledged'
      `,
      )
      .get(streamKey) as { count: number };
    const messageUpdateCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM hosted_message_updates
        WHERE stream_key = ?
        GROUP BY state
      `,
      )
      .all(streamKey) as Array<{
      key: HostedMessageUpdateRecord["state"];
      count: number;
    }>;
    const messageUpdates: HostedMessageUpdateSummary = {
      pending: 0,
      updating: 0,
      retry: 0,
      updated: 0,
      blocked: 0,
    };
    for (const row of messageUpdateCounts) {
      messageUpdates[row.key] = row.count;
    }
    const lastMessageUpdateError = this.database
      .prepare(
        `
        SELECT last_error_code, updated_at
        FROM hosted_message_updates
        WHERE stream_key = ? AND last_error_code IS NOT NULL
        ORDER BY updated_at DESC, event_id DESC
        LIMIT 1
      `,
      )
      .get(streamKey) as
      { last_error_code: string; updated_at: string } | undefined;
    if (lastMessageUpdateError !== undefined) {
      messageUpdates.lastError = {
        at: lastMessageUpdateError.updated_at,
        code: lastMessageUpdateError.last_error_code,
      };
    }
    return {
      ...(state?.committed_cursor == null
        ? {}
        : { committedCursor: state.committed_cursor }),
      ...(state?.last_successful_poll_at == null
        ? {}
        : { lastSuccessfulPollAt: state.last_successful_poll_at }),
      ...(state?.last_error_code == null || state.last_error_at == null
        ? {}
        : {
            lastError: {
              at: state.last_error_at,
              code: state.last_error_code,
            },
          }),
      unacknowledgedEventCount: count.count,
      messageUpdates,
    };
  }

  public status(): StoreStatus {
    const eventCounts = this.database
      .prepare(
        `
        SELECT status AS key, COUNT(*) AS count
        FROM events GROUP BY status
      `,
      )
      .all() as CountRow[];
    const sessionCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM sessions GROUP BY state
      `,
      )
      .all() as CountRow[];
    const topicCounts = this.database
      .prepare(
        `
        SELECT provisioning_status AS key, COUNT(*) AS count
        FROM session_topics GROUP BY provisioning_status
      `,
      )
      .all() as CountRow[];
    const resumeCommandCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM resume_commands GROUP BY state
      `,
      )
      .all() as CountRow[];
    const topicCleanupCounts = this.database
      .prepare(
        `
        SELECT state AS key, COUNT(*) AS count
        FROM topic_cleanup_operations GROUP BY state
      `,
      )
      .all() as CountRow[];
    const diagnosticCounts = this.database
      .prepare(
        `
        SELECT level AS key, COUNT(*) AS count
        FROM diagnostics GROUP BY level
      `,
      )
      .all() as CountRow[];
    const eventActivity = this.database
      .prepare(
        `
        SELECT inserted_count, deleted_count
        FROM event_activity_counters
        WHERE singleton = 1
      `,
      )
      .get() as { inserted_count: number; deleted_count: number };
    const events: StoreStatus["events"] = {
      queued: 0,
      retry: 0,
      delivering: 0,
      delivered: 0,
      dead_letter: 0,
    };
    const sessions: StoreStatus["sessions"] = {
      active: 0,
      waiting: 0,
      stopped: 0,
      suspected_stalled: 0,
      exited: 0,
    };
    const topics: StoreStatus["topics"] = {
      pending: 0,
      creating: 0,
      ready: 0,
      retry: 0,
      failed: 0,
    };
    const resumeCommands: StoreStatus["resumeCommands"] = {
      claimed: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      unsupported: 0,
    };
    const topicCleanups: StoreStatus["topicCleanups"] = {
      previewed: 0,
      claimed: 0,
      completed: 0,
      "completed-with-errors": 0,
      cancelled: 0,
      expired: 0,
      superseded: 0,
      "preview-failed": 0,
    };
    const diagnostics: StoreStatus["diagnostics"] = {
      info: 0,
      warn: 0,
      error: 0,
      total: 0,
    };
    for (const row of eventCounts) {
      if (row.key in events) {
        events[row.key as DeliveryStatus] = row.count;
      }
    }
    for (const row of sessionCounts) {
      if (row.key in sessions) {
        sessions[row.key as SessionRecord["state"]] = row.count;
      }
    }
    for (const row of topicCounts) {
      if (row.key in topics) {
        topics[row.key as TopicProvisioningStatus] = row.count;
      }
    }
    for (const row of resumeCommandCounts) {
      if (row.key in resumeCommands) {
        resumeCommands[row.key as ResumeCommandState] = row.count;
      }
    }
    for (const row of topicCleanupCounts) {
      if (row.key in topicCleanups) {
        topicCleanups[row.key as TopicCleanupOperationState] = row.count;
      }
    }
    for (const row of diagnosticCounts) {
      if (row.key === "info" || row.key === "warn" || row.key === "error") {
        diagnostics[row.key] = row.count;
        diagnostics.total += row.count;
      }
    }
    return {
      events,
      eventActivity: {
        inserted: eventActivity.inserted_count,
        deleted: eventActivity.deleted_count,
      },
      sessions,
      topics,
      topicCleanups,
      resumeCommands,
      diagnostics,
      pendingDeliveryCount: events.queued + events.retry + events.delivering,
    };
  }

  public transportDeliverySummary(
    transportName: string,
    errorCodePrefix = `${transportName}-`,
  ): TransportDeliverySummary {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/u.test(transportName) ||
      !/^[a-z][a-z0-9-]{0,119}$/u.test(errorCodePrefix)
    ) {
      throw new Error("transport delivery summary identity is invalid");
    }
    const delivered = this.database
      .prepare(
        `
        SELECT MAX(delivered_at) AS delivered_at
        FROM events
        WHERE transport_name = ?
          AND status = 'delivered'
          AND delivered_at IS NOT NULL
      `,
      )
      .get(transportName) as { delivered_at: string | null };
    const failed = this.database
      .prepare(
        `
        SELECT error_code, finished_at
        FROM delivery_attempts
        WHERE error_code LIKE ?
          AND error_code IS NOT NULL
          AND finished_at IS NOT NULL
        ORDER BY finished_at DESC, id DESC
        LIMIT 1
      `,
      )
      .get(`${errorCodePrefix}%`) as
      { error_code: string; finished_at: string } | undefined;
    return {
      ...(delivered.delivered_at === null
        ? {}
        : { lastSuccessfulSendAt: delivered.delivered_at }),
      ...(failed === undefined
        ? {}
        : {
            lastError: {
              at: failed.finished_at,
              code: failed.error_code,
            },
          }),
    };
  }
}
