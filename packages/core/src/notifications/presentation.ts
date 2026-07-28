import type {
  AgentAttentionEventV1,
  InteractionQuestion,
  InteractionQuestionAnswer,
} from "@agent-relay/protocol";
import type {
  CardActionKind,
  DeliveryAction,
  DeliveryInteraction,
  DeliveryMessage,
} from "@agent-relay/notification-contracts";

import { cardActionToken } from "./action.js";
import { COMPACT_BUTTON_OPTION_LIMIT } from "./interaction-negotiation.js";
import { redactText } from "../redaction.js";
import type {
  MultiSelectDraftRecord,
  PendingRequestRecord,
  QuestionSetDraftRecord,
} from "../store.js";
import { sessionTopicMetadata } from "../topic.js";

export const DELIVERY_MESSAGE_LIMIT = 4_096;
const CARD_SUMMARY_LIMIT = 480;
const TRUNCATION_MARKER = " …[truncated]";

function shortOpaqueId(value: string): string {
  const characters = [...value];
  return characters.length <= 12 ? value : characters.slice(-8).join("");
}

export type AttentionCardResolutionState =
  "answered" | "cancelled" | "expired" | "superseded" | "failed";

export interface AttentionCardOptions {
  now?: Date;
  resolutionState?: AttentionCardResolutionState;
  forceDetails?: boolean;
  coalesced?: {
    count: number;
    latestAt: string;
  };
}

const EVENT_STATE_LABELS: Record<AgentAttentionEventV1["type"], string> = {
  "session.started": "Session started",
  "turn.started": "Working",
  "turn.activity": "Activity",
  "turn.stopped": "Waiting for your next instruction",
  "turn.failed": "Turn failed",
  "input.required": "Input required",
  "permission.required": "Approval required",
  "process.exited": "Process exited",
  "process.stale": "Process may be stale",
  "session.ended": "Session ended",
};

const RESOLUTION_STATE_LABELS: Record<AttentionCardResolutionState, string> = {
  answered: "Answered",
  cancelled: "Canceled",
  expired: "Expired",
  superseded: "Superseded",
  failed: "Failed",
};

const ACTION_LABELS: Record<CardActionKind, string> = {
  continue: "Continue",
  details: "Details",
  mute: "Mute",
  end: "End",
};

function harnessName(event: AgentAttentionEventV1): string {
  if (event.harness === "codex") {
    return "Codex";
  }
  if (event.harness === "claude") {
    return "Claude";
  }
  return "Cursor";
}

function ageLabel(occurredAt: string, now: Date): string {
  const occurred = Date.parse(occurredAt);
  if (!Number.isFinite(occurred)) {
    return "time unknown";
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - occurred) / 1_000));
  if (seconds < 5) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function oneLineUntrusted(value: string): string {
  return [...redactText(value, 8_000)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSummary(value: string): {
  summary: string;
  truncated: boolean;
} {
  const characters = [...value];
  if (characters.length <= CARD_SUMMARY_LIMIT) {
    return { summary: value, truncated: false };
  }
  const markerLength = [...TRUNCATION_MARKER].length;
  return {
    summary: `${characters
      .slice(0, CARD_SUMMARY_LIMIT - markerLength)
      .join("")
      .trimEnd()}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function eventContent(event: AgentAttentionEventV1): string {
  const summary =
    (event.type === "turn.stopped" ? event.lastAssistantMessage : undefined) ??
    event.summary ??
    event.failure?.message ??
    event.lastAssistantMessage ??
    "No bounded summary was supplied.";
  return event.request === undefined || event.request.question === summary
    ? summary
    : `${summary} Question: ${event.request.question}`;
}

function actionKinds(
  event: AgentAttentionEventV1,
  detailsAvailable: boolean,
): CardActionKind[] {
  const kinds: CardActionKind[] = [];
  if (
    event.type === "turn.stopped" &&
    event.request?.kind === "continuation" &&
    (event.capabilities.inlineContinue || event.capabilities.lateResume)
  ) {
    kinds.push("continue");
  }
  if (detailsAvailable) {
    kinds.push("details");
  }
  if (event.type !== "session.ended" && event.type !== "process.exited") {
    kinds.push("mute", "end");
  }
  return kinds;
}

function actionsFor(
  event: AgentAttentionEventV1,
  detailsAvailable: boolean,
): DeliveryAction[] {
  return actionKinds(event, detailsAvailable).map((kind) => ({
    kind,
    label: ACTION_LABELS[kind],
    token: cardActionToken(event.eventId, kind),
  }));
}

function interactionOptions(
  event: AgentAttentionEventV1,
  request: PendingRequestRecord | undefined,
): Array<{ value: string; label: string }> {
  if (request !== undefined) {
    return request.options.map((option) => ({
      value: option.token,
      label: option.label,
    }));
  }
  const attentionRequest = event.request;
  if (attentionRequest === undefined) {
    return [];
  }
  if (attentionRequest.kind === "confirm") {
    return [
      { value: "yes_option", label: "Yes" },
      { value: "no_option", label: "No" },
    ];
  }
  if (attentionRequest.kind === "permission") {
    return [
      { value: "allow_once", label: "Allow once" },
      { value: "deny_request", label: "Deny" },
      { value: "terminal_only", label: "Handle at terminal" },
    ];
  }
  if (
    attentionRequest.kind === "select" ||
    attentionRequest.kind === "multi-select"
  ) {
    return (attentionRequest.options ?? []).map((option) => ({
      value: option.id,
      label: option.label,
    }));
  }
  const question = attentionRequest.interaction?.questions[0];
  if (question?.kind === "confirm") {
    return [
      {
        value: question.confirm.optionId,
        label: question.confirm.label,
      },
      {
        value: question.decline.optionId,
        label: question.decline.label,
      },
    ];
  }
  return question?.kind === "single-select"
    ? question.options.map((option) => ({
        value: option.optionId,
        label: option.label,
      }))
    : [];
}

export function renderDeliveryInteraction(
  event: AgentAttentionEventV1,
  request?: PendingRequestRecord,
): DeliveryInteraction | undefined {
  const attentionRequest = event.request;
  if (attentionRequest === undefined) {
    return undefined;
  }
  const base = {
    correlationId: attentionRequest.correlationId,
    expiresAt: attentionRequest.expiresAt,
  };
  if (attentionRequest.kind === "confirm") {
    return {
      ...base,
      type: "confirm",
      prompt: attentionRequest.question,
      options: interactionOptions(event, request),
    };
  }
  if (
    attentionRequest.kind === "select" ||
    attentionRequest.kind === "permission"
  ) {
    return {
      ...base,
      type: "select",
      prompt: attentionRequest.question,
      options: interactionOptions(event, request),
    };
  }
  if (
    attentionRequest.kind === "input" ||
    attentionRequest.kind === "continuation"
  ) {
    return {
      ...base,
      type: "input",
      prompt: attentionRequest.question,
    };
  }
  if (
    attentionRequest.kind !== "question-set" ||
    attentionRequest.interaction?.questions.length !== 1
  ) {
    return undefined;
  }
  const question = attentionRequest.interaction.questions[0];
  if (question === undefined || question.kind === "multi-select") {
    return undefined;
  }
  if (question.kind === "free-text") {
    return {
      ...base,
      type: "input",
      prompt: question.prompt,
    };
  }
  return {
    ...base,
    type: question.kind === "confirm" ? "confirm" : "select",
    prompt: question.prompt,
    options: interactionOptions(event, request),
  };
}

export function renderDeliveryMessage(
  event: AgentAttentionEventV1,
  options: AttentionCardOptions = {},
): DeliveryMessage {
  const metadata = sessionTopicMetadata(event);
  const content = oneLineUntrusted(eventContent(event));
  const { summary, truncated } = truncateSummary(
    content.length === 0 ? "No bounded summary was supplied." : content,
  );
  const state =
    options.resolutionState === undefined
      ? EVENT_STATE_LABELS[event.type]
      : RESOLUTION_STATE_LABELS[options.resolutionState];
  const now = options.now ?? new Date();
  const stateLine =
    options.coalesced === undefined
      ? `${state} · ${ageLabel(event.occurredAt, now)}`
      : `${state} · ${String(options.coalesced.count)} equivalent events · latest ${options.coalesced.latestAt}`;
  const text = [
    stateLine,
    `${
      metadata.branch === undefined ? "branch unknown" : metadata.branch
    } · session ${metadata.shortSessionId}`,
    `${event.harness}/${event.surface} · ${event.type}`,
    "",
    `Summary: ${summary}`,
  ].join("\n");
  const actions = actionsFor(event, truncated || options.forceDetails === true);
  const interaction =
    options.resolutionState === undefined
      ? renderDeliveryInteraction(event)
      : undefined;

  return {
    eventId: event.eventId,
    title: `${harnessName(event)} · ${metadata.repository}`,
    text,
    ...(interaction === undefined ? {} : { interaction }),
    ...(actions.length === 0 ? {} : { actions }),
  };
}

export function renderDeliveryText(message: DeliveryMessage): string {
  const choices =
    message.multiSelect === undefined && message.questionSet === undefined
      ? (message.interaction?.options ?? [])
      : [];
  const numberedChoices =
    choices.length > COMPACT_BUTTON_OPTION_LIMIT
      ? [
          "",
          "Reply with one option number:",
          ...choices.map(
            (choice, index) =>
              `${String(index + 1)}. ${oneLineUntrusted(choice.label)}`,
          ),
        ].join("\n")
      : "";
  const multiSelectSummary =
    message.multiSelect === undefined
      ? ""
      : `\n\nSelection draft: ${String(
          message.multiSelect.options.filter((option) => option.selected)
            .length,
        )} selected · choose ${String(
          message.multiSelect.minSelections,
        )}–${String(message.multiSelect.maxSelections)}.`;
  const questionSetSummary =
    message.questionSet === undefined
      ? ""
      : `\n\nRequest: ${oneLineUntrusted(
          message.questionSet.requestTitle,
        )} · ${oneLineUntrusted(
          shortOpaqueId(message.questionSet.requestId),
        )}\nQuestion ${String(message.questionSet.position)} of ${String(
          message.questionSet.total,
        )}: ${oneLineUntrusted(message.questionSet.prompt)}${
          message.questionSet.textInput === undefined
            ? ""
            : `\nSend ${String(
                message.questionSet.textInput.minLength,
              )}–${String(
                message.questionSet.textInput.maxLength,
              )} characters ${
                message.questionSet.textInput.multiline
                  ? "(multiple lines allowed)"
                  : "(one line)"
              } in this topic, or reply to this card.${
                message.questionSet.textInput.hasDraft
                  ? " A draft answer is saved; new text replaces it."
                  : ""
              }`
        }`;
  const questionSetNumberedChoices =
    message.questionSet?.presentationMode === "numbered-text"
      ? [
          "",
          "Reply with one option number:",
          ...message.questionSet.options.map(
            (option, index) =>
              `${String(index + 1)}. ${oneLineUntrusted(
                `${option.selected ? "✓ " : ""}${option.label}`,
              )}`,
          ),
        ].join("\n")
      : "";
  return redactText(
    `${message.title}\n\n${message.text}${multiSelectSummary}${questionSetSummary}${numberedChoices}${questionSetNumberedChoices}`,
    DELIVERY_MESSAGE_LIMIT,
  );
}

export function renderMultiSelectDeliveryMessage(
  event: AgentAttentionEventV1,
  request: PendingRequestRecord,
  draft: MultiSelectDraftRecord,
  options: AttentionCardOptions = {},
): DeliveryMessage {
  const selected = new Set(draft.selectedOptionIds);
  return {
    ...renderDeliveryMessage(event, options),
    multiSelect: {
      options: request.options.map((option) => ({
        value: option.token,
        label: option.label,
        selected: selected.has(option.optionId),
      })),
      minSelections: draft.minSelections,
      maxSelections: draft.maxSelections,
      submitToken: draft.submitToken,
      cancelToken: draft.cancelToken,
    },
  };
}

export function renderMultiSelectResolutionMessage(
  event: AgentAttentionEventV1,
  request: PendingRequestRecord,
  draft: MultiSelectDraftRecord,
  resolutionState: AttentionCardResolutionState,
  now = new Date(),
): DeliveryMessage {
  const selected = new Set(draft.selectedOptionIds);
  const labels = request.options
    .filter((option) => selected.has(option.optionId))
    .map((option) => oneLineUntrusted(option.label));
  const rendered = renderDeliveryMessage(event, {
    now,
    resolutionState,
  });
  return {
    ...rendered,
    text: `${rendered.text}\n\nSelected: ${
      labels.length === 0 ? "none" : labels.join(", ")
    }`,
  };
}

function questionOptionIds(question: InteractionQuestion): string[] {
  if (question.kind === "confirm") {
    return [question.confirm.optionId, question.decline.optionId];
  }
  return question.kind === "single-select" || question.kind === "multi-select"
    ? question.options.map((option) => option.optionId)
    : [];
}

function selectedQuestionOptionIds(
  answer: InteractionQuestionAnswer | undefined,
): Set<string> {
  if (answer === undefined || answer.kind === "free-text") {
    return new Set();
  }
  return new Set(
    answer.kind === "multi-select" ? answer.optionIds : [answer.optionId],
  );
}

export function renderQuestionSetDeliveryMessage(
  event: AgentAttentionEventV1,
  request: PendingRequestRecord,
  draft: QuestionSetDraftRecord,
  options: AttentionCardOptions = {},
): DeliveryMessage {
  const question = draft.interaction.questions[draft.currentIndex];
  if (question === undefined) {
    throw new Error("question-set draft points outside its question order");
  }
  const optionIds = new Set(questionOptionIds(question));
  const answer = draft.answers.find(
    (candidate) => candidate.questionId === question.questionId,
  );
  const selected = selectedQuestionOptionIds(answer);
  const presentationMode = draft.presentationMode ?? "buttons";
  const questionOptions = request.options
    .filter((option) => optionIds.has(option.optionId))
    .map((option) => ({
      value: option.token,
      label: option.label,
      selected: selected.has(option.optionId),
    }));
  const interaction = renderDeliveryInteraction(event, request);
  return {
    ...renderDeliveryMessage(event, options),
    ...(interaction === undefined ? {} : { interaction }),
    questionSet: {
      requestId: draft.interaction.requestId,
      questionId: question.questionId,
      kind: question.kind,
      presentationMode,
      requestTitle: draft.interaction.title,
      prompt: question.prompt,
      position: draft.currentIndex + 1,
      total: draft.interaction.questions.length,
      options: questionOptions,
      ...(draft.backToken === undefined ? {} : { backToken: draft.backToken }),
      ...(draft.nextToken === undefined ? {} : { nextToken: draft.nextToken }),
      submitToken: draft.submitToken,
      cancelToken: draft.cancelToken,
      ...(question.kind === "free-text"
        ? {
            textInput: {
              minLength: question.minLength,
              maxLength: question.maxLength,
              multiline: question.multiline,
              hasDraft: answer?.kind === "free-text",
            },
          }
        : {}),
    },
  };
}

function questionAnswerSummary(
  request: PendingRequestRecord,
  answer: InteractionQuestionAnswer | undefined,
): string {
  if (answer === undefined) {
    return "not answered";
  }
  if (answer.kind === "free-text") {
    return `text saved (${String(answer.text.length)} characters)`;
  }
  const optionIds =
    answer.kind === "multi-select" ? answer.optionIds : [answer.optionId];
  const labels = optionIds.map(
    (optionId) =>
      request.options.find((option) => option.optionId === optionId)?.label ??
      optionId,
  );
  return labels.length === 0
    ? "none"
    : labels.map((label) => oneLineUntrusted(label)).join(", ");
}

export function renderQuestionSetResolutionMessage(
  event: AgentAttentionEventV1,
  request: PendingRequestRecord,
  draft: QuestionSetDraftRecord,
  resolutionState: AttentionCardResolutionState,
  now = new Date(),
): DeliveryMessage {
  const rendered = renderDeliveryMessage(event, {
    now,
    resolutionState,
  });
  const answers = draft.interaction.questions.map((question, index) => {
    const answer = draft.answers.find(
      (candidate) => candidate.questionId === question.questionId,
    );
    return `${String(index + 1)}. ${oneLineUntrusted(
      question.prompt,
    )}: ${questionAnswerSummary(request, answer)}`;
  });
  return {
    ...rendered,
    text: `${rendered.text}\n\n${answers.join("\n")}`,
  };
}

const DETAILS_PAGE_CONTENT_LIMIT = 3_500;
const DETAILS_MAX_PAGES = 8;

function sanitizedDetails(event: AgentAttentionEventV1): string {
  return [...redactText(eventContent(event), 8_000)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || (code >= 11 && code <= 31) || code === 127
        ? " "
        : character;
    })
    .join("")
    .trim();
}

export function renderDetailsMessages(
  events: AgentAttentionEventV1[],
  totalCount = events.length,
): DeliveryMessage[] {
  if (events.length === 0) {
    throw new Error("details require at least one event");
  }
  const anchor = events[0] as AgentAttentionEventV1;
  const metadata = sessionTopicMetadata(anchor);
  const combined =
    events.length === 1 && totalCount === 1
      ? sanitizedDetails(anchor)
      : events
          .map((event, index) => {
            const details = sanitizedDetails(event);
            const ordinal = Math.max(1, totalCount - events.length + 1) + index;
            return [
              `Event ${String(ordinal)} of ${String(totalCount)} · ${event.occurredAt} · ${event.type}`,
              details.length === 0
                ? "No additional details are available."
                : details,
            ].join("\n");
          })
          .join("\n\n");
  const characters = [
    ...(combined.length === 0
      ? "No additional details are available."
      : combined),
  ];
  const maximumCharacters =
    DETAILS_PAGE_CONTENT_LIMIT * DETAILS_MAX_PAGES -
    [...TRUNCATION_MARKER].length;
  const bounded =
    characters.length <= maximumCharacters
      ? characters
      : [...characters.slice(0, maximumCharacters), ...TRUNCATION_MARKER];
  const pages: string[] = [];
  for (
    let index = 0;
    index < bounded.length;
    index += DETAILS_PAGE_CONTENT_LIMIT
  ) {
    pages.push(
      bounded.slice(index, index + DETAILS_PAGE_CONTENT_LIMIT).join(""),
    );
  }
  return (pages.length === 0 ? ["No additional details are available."] : pages)
    .slice(0, DETAILS_MAX_PAGES)
    .map((text, index, allPages) => ({
      eventId: anchor.eventId,
      title: `Details ${String(index + 1)}/${String(allPages.length)} · ${harnessName(anchor)} · ${metadata.repository}`,
      text,
    }));
}
