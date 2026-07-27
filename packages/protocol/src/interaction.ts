import { Buffer } from "node:buffer";

import { z } from "zod";

const interactionId = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must be an opaque identifier without whitespace",
  );
const interactionTimestamp = z.iso.datetime({ offset: true });

export const MAX_INTERACTION_QUESTIONS = 10;
export const MAX_INTERACTION_OPTIONS = 20;
export const MAX_INTERACTION_TEXT_LENGTH = 3_000;
export const MAX_INTERACTION_REQUEST_BYTES = 32_768;
export const MAX_INTERACTION_ANSWER_BYTES = 4_000;

function addUniqueIssues(
  values: string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `duplicate ${label}: ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

function addPayloadSizeIssue(
  value: unknown,
  maximum: number,
  context: z.RefinementCtx,
): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    context.addIssue({
      code: "custom",
      message: `serialized payload exceeds ${String(maximum)} bytes`,
      path: [],
    });
  }
}

export const InteractionLifecycleStateSchema = z.enum([
  "pending",
  "drafting",
  "answered",
  "expired",
  "canceled",
  "superseded",
  "failed",
]);

export const InteractionFeatureSchema = z.enum([
  "confirm",
  "single-select",
  "multi-select",
  "free-text",
  "ordered-question-set",
  "durable-drafts",
  "message-updates",
]);

export const InteractionPresentationModeSchema = z.enum([
  "buttons",
  "direct-text",
  "numbered-text",
  "web-handoff",
]);

export const InteractionFallbackPolicySchema = z
  .object({
    preferredMode: InteractionPresentationModeSchema,
    alternativeModes: z
      .array(InteractionPresentationModeSchema)
      .max(3)
      .default([]),
    whenUnavailable: z.enum(["reject", "use-alternative"]),
  })
  .strict()
  .superRefine((policy, context) => {
    addUniqueIssues(
      policy.alternativeModes,
      context,
      ["alternativeModes"],
      "fallback mode",
    );
    if (policy.alternativeModes.includes(policy.preferredMode)) {
      context.addIssue({
        code: "custom",
        message: "preferred mode cannot also be a fallback mode",
        path: ["alternativeModes"],
      });
    }
    if (
      policy.whenUnavailable === "use-alternative" &&
      policy.alternativeModes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "use-alternative requires at least one fallback mode",
        path: ["alternativeModes"],
      });
    }
    if (
      policy.whenUnavailable === "reject" &&
      policy.alternativeModes.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "reject cannot advertise fallback modes",
        path: ["alternativeModes"],
      });
    }
  });

export const InteractionOptionSchema = z
  .object({
    optionId: interactionId,
    label: z.string().trim().min(1).max(120),
  })
  .strict();

const questionBase = {
  questionId: interactionId,
  prompt: z.string().trim().min(1).max(1_000),
};

export const ConfirmInteractionQuestionSchema = z
  .object({
    ...questionBase,
    kind: z.literal("confirm"),
    confirm: InteractionOptionSchema,
    decline: InteractionOptionSchema,
  })
  .strict()
  .superRefine((question, context) => {
    if (question.confirm.optionId === question.decline.optionId) {
      context.addIssue({
        code: "custom",
        message: "confirm and decline option IDs must differ",
        path: ["decline", "optionId"],
      });
    }
  });

export const SingleSelectInteractionQuestionSchema = z
  .object({
    ...questionBase,
    kind: z.literal("single-select"),
    options: z
      .array(InteractionOptionSchema)
      .min(2)
      .max(MAX_INTERACTION_OPTIONS),
  })
  .strict()
  .superRefine((question, context) => {
    addUniqueIssues(
      question.options.map((option) => option.optionId),
      context,
      ["options"],
      "option ID",
    );
  });

export const MultiSelectInteractionQuestionSchema = z
  .object({
    ...questionBase,
    kind: z.literal("multi-select"),
    options: z
      .array(InteractionOptionSchema)
      .min(2)
      .max(MAX_INTERACTION_OPTIONS),
    minSelections: z.number().int().min(0).max(MAX_INTERACTION_OPTIONS),
    maxSelections: z.number().int().min(1).max(MAX_INTERACTION_OPTIONS),
  })
  .strict()
  .superRefine((question, context) => {
    addUniqueIssues(
      question.options.map((option) => option.optionId),
      context,
      ["options"],
      "option ID",
    );
    if (question.minSelections > question.maxSelections) {
      context.addIssue({
        code: "custom",
        message: "minimum selections cannot exceed maximum selections",
        path: ["minSelections"],
      });
    }
    if (question.maxSelections > question.options.length) {
      context.addIssue({
        code: "custom",
        message: "maximum selections cannot exceed the option count",
        path: ["maxSelections"],
      });
    }
  });

export const FreeTextInteractionQuestionSchema = z
  .object({
    ...questionBase,
    kind: z.literal("free-text"),
    minLength: z.number().int().min(1).max(MAX_INTERACTION_TEXT_LENGTH),
    maxLength: z.number().int().min(1).max(MAX_INTERACTION_TEXT_LENGTH),
    multiline: z.boolean(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.minLength > question.maxLength) {
      context.addIssue({
        code: "custom",
        message: "minimum text length cannot exceed maximum text length",
        path: ["minLength"],
      });
    }
  });

export const InteractionQuestionSchema = z.discriminatedUnion("kind", [
  ConfirmInteractionQuestionSchema,
  SingleSelectInteractionQuestionSchema,
  MultiSelectInteractionQuestionSchema,
  FreeTextInteractionQuestionSchema,
]);

function optionIdsForQuestion(
  question: z.infer<typeof InteractionQuestionSchema>,
): string[] {
  switch (question.kind) {
    case "confirm":
      return [question.confirm.optionId, question.decline.optionId];
    case "single-select":
    case "multi-select":
      return question.options.map((option) => option.optionId);
    case "free-text":
      return [];
  }
}

export const OperatorInteractionRequestV1Schema = z
  .object({
    schema: z.literal("agent-interaction-request.v1"),
    requestId: interactionId,
    createdAt: interactionTimestamp,
    expiresAt: interactionTimestamp,
    title: z.string().trim().min(1).max(120),
    lifecycle: z.literal("pending"),
    questions: z
      .array(InteractionQuestionSchema)
      .min(1)
      .max(MAX_INTERACTION_QUESTIONS),
    fallback: InteractionFallbackPolicySchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "interaction expiry must be after creation",
        path: ["expiresAt"],
      });
    }
    addUniqueIssues(
      request.questions.map((question) => question.questionId),
      context,
      ["questions"],
      "question ID",
    );
    const optionIds: string[] = [];
    for (const question of request.questions) {
      optionIds.push(...optionIdsForQuestion(question));
    }
    addUniqueIssues(optionIds, context, ["questions"], "option ID");
    addPayloadSizeIssue(request, MAX_INTERACTION_REQUEST_BYTES, context);
  });

const answerBase = {
  questionId: interactionId,
};

export const InteractionQuestionAnswerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...answerBase,
      kind: z.literal("confirm"),
      optionId: interactionId,
    })
    .strict(),
  z
    .object({
      ...answerBase,
      kind: z.literal("single-select"),
      optionId: interactionId,
    })
    .strict(),
  z
    .object({
      ...answerBase,
      kind: z.literal("multi-select"),
      optionIds: z.array(interactionId).max(MAX_INTERACTION_OPTIONS),
    })
    .strict()
    .superRefine((answer, context) => {
      addUniqueIssues(
        answer.optionIds,
        context,
        ["optionIds"],
        "selected option ID",
      );
    }),
  z
    .object({
      ...answerBase,
      kind: z.literal("free-text"),
      text: z
        .string()
        .min(1)
        .max(MAX_INTERACTION_TEXT_LENGTH)
        .refine((value) => value.trim().length > 0, {
          message: "free-text answer cannot be blank",
        }),
    })
    .strict(),
]);

export const OperatorInteractionAnswerV1Schema = z
  .object({
    schema: z.literal("agent-interaction-answer.v1"),
    answerId: interactionId,
    requestId: interactionId,
    submittedAt: interactionTimestamp,
    answers: z
      .array(InteractionQuestionAnswerSchema)
      .min(1)
      .max(MAX_INTERACTION_QUESTIONS),
  })
  .strict()
  .superRefine((answer, context) => {
    addUniqueIssues(
      answer.answers.map((item) => item.questionId),
      context,
      ["answers"],
      "answered question ID",
    );
    addPayloadSizeIssue(answer, MAX_INTERACTION_ANSWER_BYTES, context);
  });

export const InteractionLifecycleV1Schema = z
  .object({
    schema: z.literal("agent-interaction-lifecycle.v1"),
    requestId: interactionId,
    state: InteractionLifecycleStateSchema,
    occurredAt: interactionTimestamp,
    answerId: interactionId.optional(),
    supersededByRequestId: interactionId.optional(),
    failure: z
      .object({
        code: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[a-z0-9][a-z0-9._-]*$/i),
        message: z.string().trim().min(1).max(1_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((lifecycle, context) => {
    if (
      (lifecycle.state === "answered") !==
      (lifecycle.answerId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "only answered lifecycle records require an answer ID",
        path: ["answerId"],
      });
    }
    if (
      (lifecycle.state === "superseded") !==
      (lifecycle.supersededByRequestId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "only superseded lifecycle records require a replacement request ID",
        path: ["supersededByRequestId"],
      });
    }
    if ((lifecycle.state === "failed") !== (lifecycle.failure !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "only failed lifecycle records require failure details",
        path: ["failure"],
      });
    }
  });

export const InteractionProviderCapabilitiesV1Schema = z
  .object({
    schema: z.literal("agent-interaction-capabilities.v1"),
    providerId: interactionId,
    providerKind: z.enum(["transport", "harness"]),
    observedAt: interactionTimestamp,
    features: z.array(InteractionFeatureSchema).max(7),
    presentationModes: z.array(InteractionPresentationModeSchema).max(4),
    limits: z
      .object({
        maxQuestions: z.number().int().min(1).max(MAX_INTERACTION_QUESTIONS),
        maxOptionsPerQuestion: z
          .number()
          .int()
          .min(2)
          .max(MAX_INTERACTION_OPTIONS),
        maxTextLength: z.number().int().min(1).max(MAX_INTERACTION_TEXT_LENGTH),
        maxPayloadBytes: z
          .number()
          .int()
          .min(1_024)
          .max(MAX_INTERACTION_REQUEST_BYTES),
      })
      .strict(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    addUniqueIssues(
      capabilities.features,
      context,
      ["features"],
      "interaction feature",
    );
    addUniqueIssues(
      capabilities.presentationModes,
      context,
      ["presentationModes"],
      "presentation mode",
    );
  });

export const InteractionCapabilityEvidenceSchema = z.enum([
  "official-docs",
  "official-docs+local-help",
  "live-canary",
  "event-contract",
  "configured",
  "fake",
]);

export const InteractionProviderObservationV1Schema = z
  .object({
    schema: z.literal("agent-interaction-provider-observation.v1"),
    capabilities: InteractionProviderCapabilitiesV1Schema,
    status: z.enum(["proven", "assumed"]),
    evidence: InteractionCapabilityEvidenceSchema,
    observedVersion: z.string().trim().min(1).max(120).optional(),
    fixture: z.string().trim().min(1).max(240).optional(),
    documentation: z.url().max(500).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.capabilities.providerKind === "harness" &&
      observation.observedVersion === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "harness observations require an observed version",
        path: ["observedVersion"],
      });
    }
  });

export type InteractionLifecycleState = z.infer<
  typeof InteractionLifecycleStateSchema
>;
export type InteractionFeature = z.infer<typeof InteractionFeatureSchema>;
export type InteractionPresentationMode = z.infer<
  typeof InteractionPresentationModeSchema
>;
export type InteractionFallbackPolicy = z.infer<
  typeof InteractionFallbackPolicySchema
>;
export type InteractionOption = z.infer<typeof InteractionOptionSchema>;
export type InteractionQuestion = z.infer<typeof InteractionQuestionSchema>;
export type OperatorInteractionRequestV1 = z.infer<
  typeof OperatorInteractionRequestV1Schema
>;
export type InteractionQuestionAnswer = z.infer<
  typeof InteractionQuestionAnswerSchema
>;
export type OperatorInteractionAnswerV1 = z.infer<
  typeof OperatorInteractionAnswerV1Schema
>;
export type InteractionLifecycleV1 = z.infer<
  typeof InteractionLifecycleV1Schema
>;
export type InteractionProviderCapabilitiesV1 = z.infer<
  typeof InteractionProviderCapabilitiesV1Schema
>;
export type InteractionCapabilityEvidence = z.infer<
  typeof InteractionCapabilityEvidenceSchema
>;
export type InteractionProviderObservationV1 = z.infer<
  typeof InteractionProviderObservationV1Schema
>;

export interface InteractionContractIssue {
  code: string;
  path: string;
  message: string;
}

export type InteractionAnswerValidation =
  | {
      ok: true;
      request: OperatorInteractionRequestV1;
      answer: OperatorInteractionAnswerV1;
    }
  | {
      ok: false;
      issues: InteractionContractIssue[];
    };

function zodIssues(
  prefix: "request" | "answer",
  error: z.ZodError,
): InteractionContractIssue[] {
  return error.issues.map((issue) => ({
    code: `invalid-${prefix}`,
    path: [prefix, ...issue.path].join("."),
    message: issue.message,
  }));
}

function compatibilityIssue(
  code: string,
  path: string,
  message: string,
): InteractionContractIssue {
  return { code, path, message };
}

export function validateInteractionAnswer(
  requestInput: unknown,
  answerInput: unknown,
): InteractionAnswerValidation {
  const parsedRequest =
    OperatorInteractionRequestV1Schema.safeParse(requestInput);
  const parsedAnswer = OperatorInteractionAnswerV1Schema.safeParse(answerInput);
  const schemaIssues = [
    ...(parsedRequest.success ? [] : zodIssues("request", parsedRequest.error)),
    ...(parsedAnswer.success ? [] : zodIssues("answer", parsedAnswer.error)),
  ];
  if (
    !parsedRequest.success ||
    !parsedAnswer.success ||
    schemaIssues.length !== 0
  ) {
    return { ok: false, issues: schemaIssues };
  }

  const request = parsedRequest.data;
  const answer = parsedAnswer.data;
  const issues: InteractionContractIssue[] = [];
  if (answer.requestId !== request.requestId) {
    issues.push(
      compatibilityIssue(
        "request-id-mismatch",
        "answer.requestId",
        "answer request ID does not match the interaction request",
      ),
    );
  }
  if (Date.parse(answer.submittedAt) < Date.parse(request.createdAt)) {
    issues.push(
      compatibilityIssue(
        "answer-before-request",
        "answer.submittedAt",
        "answer cannot precede the interaction request",
      ),
    );
  }
  if (Date.parse(answer.submittedAt) >= Date.parse(request.expiresAt)) {
    issues.push(
      compatibilityIssue(
        "answer-expired",
        "answer.submittedAt",
        "answer was submitted at or after interaction expiry",
      ),
    );
  }

  const answersByQuestion = new Map(
    answer.answers.map((item) => [item.questionId, item]),
  );
  const questionIds = new Set(
    request.questions.map((question) => question.questionId),
  );
  for (const [index, item] of answer.answers.entries()) {
    if (!questionIds.has(item.questionId)) {
      issues.push(
        compatibilityIssue(
          "unknown-question",
          `answer.answers.${String(index)}.questionId`,
          "answer references a question outside this request",
        ),
      );
    }
  }
  for (const [index, question] of request.questions.entries()) {
    const item = answersByQuestion.get(question.questionId);
    if (item === undefined) {
      issues.push(
        compatibilityIssue(
          "missing-answer",
          `answer.answers.${String(index)}`,
          `question ${question.questionId} requires an answer`,
        ),
      );
      continue;
    }
    if (item.kind !== question.kind) {
      issues.push(
        compatibilityIssue(
          "answer-kind-mismatch",
          `answer.answers.${String(index)}.kind`,
          `answer kind ${item.kind} does not match ${question.kind}`,
        ),
      );
      continue;
    }

    switch (question.kind) {
      case "confirm": {
        if (
          item.kind === "confirm" &&
          item.optionId !== question.confirm.optionId &&
          item.optionId !== question.decline.optionId
        ) {
          issues.push(
            compatibilityIssue(
              "unknown-option",
              `answer.answers.${String(index)}.optionId`,
              "confirm answer does not identify a request option",
            ),
          );
        }
        break;
      }
      case "single-select": {
        if (
          item.kind === "single-select" &&
          !question.options.some((option) => option.optionId === item.optionId)
        ) {
          issues.push(
            compatibilityIssue(
              "unknown-option",
              `answer.answers.${String(index)}.optionId`,
              "single-select answer does not identify a request option",
            ),
          );
        }
        break;
      }
      case "multi-select": {
        if (item.kind !== "multi-select") {
          break;
        }
        if (
          item.optionIds.length < question.minSelections ||
          item.optionIds.length > question.maxSelections
        ) {
          issues.push(
            compatibilityIssue(
              "selection-count",
              `answer.answers.${String(index)}.optionIds`,
              `multi-select answer requires ${String(
                question.minSelections,
              )} through ${String(question.maxSelections)} selections`,
            ),
          );
        }
        const allowed = new Set(
          question.options.map((option) => option.optionId),
        );
        for (const [optionIndex, optionId] of item.optionIds.entries()) {
          if (!allowed.has(optionId)) {
            issues.push(
              compatibilityIssue(
                "unknown-option",
                `answer.answers.${String(index)}.optionIds.${String(
                  optionIndex,
                )}`,
                "multi-select answer contains an option outside the request",
              ),
            );
          }
        }
        break;
      }
      case "free-text": {
        if (item.kind !== "free-text") {
          break;
        }
        if (
          item.text.length < question.minLength ||
          item.text.length > question.maxLength
        ) {
          issues.push(
            compatibilityIssue(
              "text-length",
              `answer.answers.${String(index)}.text`,
              `free-text answer requires ${String(
                question.minLength,
              )} through ${String(question.maxLength)} characters`,
            ),
          );
        }
        if (!question.multiline && /[\r\n]/.test(item.text)) {
          issues.push(
            compatibilityIssue(
              "text-multiline",
              `answer.answers.${String(index)}.text`,
              "free-text answer does not permit multiple lines",
            ),
          );
        }
        break;
      }
    }
  }

  const expectedOrder = request.questions
    .map((question) => question.questionId)
    .join("\u001f");
  const actualOrder = answer.answers
    .map((item) => item.questionId)
    .join("\u001f");
  if (expectedOrder !== actualOrder) {
    issues.push(
      compatibilityIssue(
        "answer-order-mismatch",
        "answer.answers",
        "question answers must use the request's deterministic order",
      ),
    );
  }

  return issues.length === 0
    ? { ok: true, request, answer }
    : { ok: false, issues };
}

export class InteractionContractError extends Error {
  public override readonly name = "InteractionContractError";

  public constructor(public readonly issues: InteractionContractIssue[]) {
    super(
      issues.length === 0
        ? "interaction contract validation failed"
        : issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
  }
}

export function parseInteractionAnswer(
  requestInput: unknown,
  answerInput: unknown,
): {
  request: OperatorInteractionRequestV1;
  answer: OperatorInteractionAnswerV1;
} {
  const validation = validateInteractionAnswer(requestInput, answerInput);
  if (!validation.ok) {
    throw new InteractionContractError(validation.issues);
  }
  return {
    request: validation.request,
    answer: validation.answer,
  };
}

export function encodeInteractionAnswer(
  requestInput: unknown,
  answerInput: unknown,
): string {
  return JSON.stringify(
    parseInteractionAnswer(requestInput, answerInput).answer,
  );
}

const TERMINAL_INTERACTION_STATES = new Set<InteractionLifecycleState>([
  "answered",
  "expired",
  "canceled",
  "superseded",
  "failed",
]);

export function isInteractionLifecycleTransition(
  from: InteractionLifecycleState,
  to: InteractionLifecycleState,
): boolean {
  if (TERMINAL_INTERACTION_STATES.has(from) || from === to) {
    return false;
  }
  if (from === "pending") {
    return to === "drafting" || TERMINAL_INTERACTION_STATES.has(to);
  }
  return from === "drafting" && TERMINAL_INTERACTION_STATES.has(to);
}
