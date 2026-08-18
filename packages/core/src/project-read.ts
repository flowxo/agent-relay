import { z } from "zod";

import { HarnessSchema } from "@agent-relay/protocol";

import {
  SESSION_ACTIVITY_FIXTURE_SET_VERSION,
  SESSION_ACTIVITY_POLICY_VERSION,
  SESSION_ACTIVITY_SCHEMA,
  SessionActivityConfidenceSchema,
  SessionActivityReasonSchema,
  SessionActivitySourceSchema,
  SessionActivityStateSchema,
} from "./activity.js";

export const PROJECT_READ_SCHEMA = "agent-relay-project-read.v1" as const;
export const PROJECT_CHANGE_SCHEMA = "agent-relay-project-changes.v1" as const;
export const PROJECT_INVALIDATION_SCHEMA =
  "agent-relay-project-invalidation.v1" as const;

export const PROJECT_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const PROJECT_HISTORY_MAX_PAGE_SIZE = 100;
export const PROJECT_COMPLETE_SET_MAX = 1_000;
export const PROJECT_SUMMARY_MAX = 200;
export const PROJECT_CHANGE_DEFAULT_BATCH_SIZE = 100;
export const PROJECT_CHANGE_MAX_BATCH_SIZE = 200;
export const PROJECT_CURSOR_MAX_AGE_MS = 24 * 60 * 60_000;
export const PROJECT_SEARCH_MAX_LENGTH = 64;
export const PROJECT_SEARCH_MAX_TERMS = 8;
/** Upper bound on recent rows scanned while filling one search page. */
export const PROJECT_SEARCH_SCAN_MAX = 5_000;

const PROJECT_SEARCH_HARNESS_LABELS: Record<
  z.infer<typeof HarnessSchema>,
  string
> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};

export const ProjectKeySchema = z.union([
  z.literal("all"),
  z.string().regex(/^prj_[a-f0-9]{48}$/u),
]);

export const ProjectReadSessionActivitySchema = z
  .object({
    schema: z.literal(SESSION_ACTIVITY_SCHEMA),
    policyVersion: z.literal(SESSION_ACTIVITY_POLICY_VERSION),
    fixtureSetVersion: z.literal(SESSION_ACTIVITY_FIXTURE_SET_VERSION),
    state: SessionActivityStateSchema,
    stateLabel: z.enum([
      "Working",
      "Needs input",
      "Background work",
      "Idle",
      "Done",
      "Failed",
      "Unknown",
      "Ended",
    ]),
    confidence: SessionActivityConfidenceSchema,
    reason: SessionActivityReasonSchema,
    reasonText: z.string().min(1).max(120),
    source: SessionActivitySourceSchema,
    lastObservedAt: z.iso.datetime({ offset: true }),
    idleSince: z.iso.datetime({ offset: true }).optional(),
    inFlightCount: z.number().int().nonnegative().max(1_000),
    requestCount: z.number().int().nonnegative().max(1_000),
    muted: z.boolean(),
    epoch: z.number().int().nonnegative(),
    lastAppliedSequence: z.number().int().nonnegative(),
  })
  .strict();

const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const timestamp = z.iso.datetime({ offset: true });

export const ProjectSummaryV1Schema = z
  .object({
    schema: z.literal("agent-relay-project-summary.v1"),
    projectKey: ProjectKeySchema,
    label: z.string().min(1).max(96),
    currentCount: boundedCount,
    needsAttentionCount: boundedCount,
    needsInputCount: boundedCount,
    failedOrUnknownCount: boundedCount,
    recentCount: boundedCount,
    totalCount: boundedCount,
    lastActivityAt: timestamp.optional(),
  })
  .strict();

export const ProjectReadSessionV1Schema = z
  .object({
    schema: z.literal("agent-relay-project-session.v1"),
    sessionKey: z.string().regex(/^[a-f0-9]{24}$/u),
    /** Shared readable name; pure function of sessionKey across all surfaces. */
    sessionName: z
      .string()
      .regex(/^[a-z]+-[a-z]+-\d{2}$/u)
      .max(48),
    projectKey: z.string().regex(/^prj_[a-f0-9]{48}$/u),
    projectLabel: z.string().min(1).max(96),
    harness: HarnessSchema,
    surface: z.enum(["cli", "ide", "sdk", "app-server"]),
    activity: ProjectReadSessionActivitySchema,
    lastSeenAt: timestamp,
    knownInFlightWork: z
      .object({ count: z.number().int().nonnegative().max(1_000) })
      .strict(),
    pendingInteraction: z
      .object({
        state: z.enum(["none", "waiting"]),
        count: z.number().int().nonnegative().max(1_000),
      })
      .strict(),
    deliveryHealth: z.object({ muted: z.boolean() }).strict(),
  })
  .strict();

export const ProjectCurrentGroupV1Schema = z
  .object({
    harness: HarnessSchema,
    sessions: z.array(ProjectReadSessionV1Schema).max(PROJECT_COMPLETE_SET_MAX),
  })
  .strict();

export const ProjectReadSnapshotV1Schema = z
  .object({
    schema: z.literal(PROJECT_READ_SCHEMA),
    generatedAt: timestamp,
    selectedProjectKey: ProjectKeySchema,
    filters: z
      .object({
        harness: HarnessSchema.optional(),
        state: SessionActivityStateSchema.optional(),
        search: z.string().min(1).max(PROJECT_SEARCH_MAX_LENGTH).optional(),
      })
      .strict(),
    changeCursor: z.string().min(16).max(1_024),
    projects: z
      .object({
        all: ProjectSummaryV1Schema,
        items: z.array(ProjectSummaryV1Schema).max(PROJECT_SUMMARY_MAX),
        totalCount: boundedCount,
        truncated: z.boolean(),
      })
      .strict(),
    needsAttention: z
      .array(ProjectReadSessionV1Schema)
      .max(PROJECT_COMPLETE_SET_MAX),
    currentByHarness: z.array(ProjectCurrentGroupV1Schema).max(3),
    recent: z
      .object({
        items: z
          .array(ProjectReadSessionV1Schema)
          .max(PROJECT_HISTORY_MAX_PAGE_SIZE),
        nextCursor: z.string().min(16).max(1_024).optional(),
      })
      .strict(),
    empty: z.boolean(),
    limits: z
      .object({
        historyPageSize: z
          .number()
          .int()
          .min(1)
          .max(PROJECT_HISTORY_MAX_PAGE_SIZE),
        historyPageSizeMax: z.literal(PROJECT_HISTORY_MAX_PAGE_SIZE),
        completeSetMax: z.literal(PROJECT_COMPLETE_SET_MAX),
        projectSummaryMax: z.literal(PROJECT_SUMMARY_MAX),
        changeBatchMax: z.literal(PROJECT_CHANGE_MAX_BATCH_SIZE),
      })
      .strict(),
  })
  .strict();

export const ProjectReadChangeKindSchema = z.enum([
  "session",
  "activity",
  "event",
  "request",
  "diagnostic",
  "session-control",
]);

export const ProjectInvalidationV1Schema = z
  .object({
    schema: z.literal(PROJECT_INVALIDATION_SCHEMA),
    cursor: z.string().min(16).max(1_024),
    changedAt: timestamp,
    kinds: z.array(ProjectReadChangeKindSchema).min(1).max(6),
    coalescedCount: z.number().int().min(1).max(PROJECT_CHANGE_MAX_BATCH_SIZE),
  })
  .strict();

export const ProjectReadChangesV1Schema = z
  .object({
    schema: z.literal(PROJECT_CHANGE_SCHEMA),
    cursor: z.string().min(16).max(1_024),
    invalidations: z.array(ProjectInvalidationV1Schema).max(1),
    hasMore: z.boolean(),
  })
  .strict();

export type ProjectKey = z.infer<typeof ProjectKeySchema>;
export type ProjectSummaryV1 = z.infer<typeof ProjectSummaryV1Schema>;
export type ProjectReadSessionV1 = z.infer<typeof ProjectReadSessionV1Schema>;
export type ProjectReadSnapshotV1 = z.infer<typeof ProjectReadSnapshotV1Schema>;
export type ProjectReadChangesV1 = z.infer<typeof ProjectReadChangesV1Schema>;
export type ProjectReadChangeKind = z.infer<typeof ProjectReadChangeKindSchema>;

export interface ProjectReadQuery {
  projectKey?: ProjectKey;
  harness?: z.infer<typeof HarnessSchema>;
  state?: z.infer<typeof SessionActivityStateSchema>;
  /** Normalized whitespace-collapsed search; omit when unused. */
  search?: string;
  historyLimit?: number;
  historyCursor?: string;
  now?: string;
}

export type ProjectReadErrorCode =
  | "invalid_cursor"
  | "stale_cursor"
  | "project_not_found"
  | "complete_set_capacity_exceeded"
  | "invalid_search";

export class ProjectReadError extends Error {
  public override readonly name = "ProjectReadError";

  public constructor(
    public readonly code: ProjectReadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalize an operator search string for cursor scope. Empty input clears
 * search. Invalid bounds throw without echoing the query.
 */
export function normalizeProjectSearch(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.trim().replace(/\s+/gu, " ");
  if (collapsed.length === 0) return undefined;
  if (collapsed.length > PROJECT_SEARCH_MAX_LENGTH) {
    throw new ProjectReadError(
      "invalid_search",
      "project search query is invalid",
    );
  }
  const terms = parseProjectSearchTerms(collapsed);
  if (terms.length > PROJECT_SEARCH_MAX_TERMS) {
    throw new ProjectReadError(
      "invalid_search",
      "project search query is invalid",
    );
  }
  return collapsed;
}

export function parseProjectSearchTerms(search: string): string[] {
  return search
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
}

/**
 * Match only already-safe projected fields. Never matches paths, remotes,
 * branches, prompts, transcripts, or private identifiers.
 */
export function projectSessionMatchesSearch(
  session: ProjectReadSessionV1,
  terms: string[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    session.sessionName,
    session.projectLabel,
    session.harness,
    PROJECT_SEARCH_HARNESS_LABELS[session.harness],
    session.activity.state,
    session.activity.stateLabel,
    session.sessionKey,
  ]
    .map((value) => value.toLocaleLowerCase())
    .join(" ");
  return terms.every((term) => haystack.includes(term));
}
