import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  InteractionLifecycleV1Schema,
  InteractionProviderCapabilitiesV1Schema,
  OperatorInteractionAnswerV1Schema,
  OperatorInteractionRequestV1Schema,
  encodeInteractionAnswer,
  isInteractionLifecycleTransition,
  parseInteractionAnswer,
  validateInteractionAnswer,
} from "./interaction.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "interactions",
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

function requestFixture() {
  return OperatorInteractionRequestV1Schema.parse(
    fixture("request-question-set.v1.json"),
  );
}

function answerFixture() {
  return OperatorInteractionAnswerV1Schema.parse(
    fixture("answer-question-set.v1.json"),
  );
}

describe("structured operator interaction contracts", () => {
  it("validates the sanitized mixed question-set fixtures", () => {
    const request = requestFixture();
    const answer = answerFixture();
    const validation = validateInteractionAnswer(request, answer);

    expect(validation).toMatchObject({ ok: true });
    expect(request.questions.map((question) => question.kind)).toEqual([
      "confirm",
      "single-select",
      "multi-select",
      "free-text",
    ]);
    expect(encodeInteractionAnswer(request, answer)).toBe(
      JSON.stringify(answer),
    );
    expect(JSON.stringify({ request, answer })).not.toMatch(
      /callback|transcript|credential|machine.path/i,
    );
  });

  it("rejects duplicate question and option IDs with field-level issues", () => {
    const duplicateQuestion = structuredClone(requestFixture());
    duplicateQuestion.questions[1]!.questionId =
      duplicateQuestion.questions[0]!.questionId;
    const questionResult =
      OperatorInteractionRequestV1Schema.safeParse(duplicateQuestion);
    expect(questionResult.success).toBe(false);
    if (!questionResult.success) {
      expect(questionResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("duplicate question ID"),
          }),
        ]),
      );
    }

    const duplicateOption = structuredClone(requestFixture());
    const confirm = duplicateOption.questions.find(
      (question) => question.kind === "confirm",
    );
    const single = duplicateOption.questions.find(
      (question) => question.kind === "single-select",
    );
    expect(confirm?.kind).toBe("confirm");
    expect(single?.kind).toBe("single-select");
    if (confirm?.kind === "confirm" && single?.kind === "single-select") {
      single.options[0]!.optionId = confirm.confirm.optionId;
    }
    const optionResult =
      OperatorInteractionRequestV1Schema.safeParse(duplicateOption);
    expect(optionResult.success).toBe(false);
    if (!optionResult.success) {
      expect(optionResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("duplicate option ID"),
          }),
        ]),
      );
    }
  });

  it("rejects empty option sets, invalid bounds, and oversized payloads", () => {
    const emptyOptions = structuredClone(requestFixture());
    const single = emptyOptions.questions.find(
      (question) => question.kind === "single-select",
    );
    if (single?.kind === "single-select") {
      single.options = [];
    }
    expect(
      OperatorInteractionRequestV1Schema.safeParse(emptyOptions).success,
    ).toBe(false);

    const invalidBounds = structuredClone(requestFixture());
    const multi = invalidBounds.questions.find(
      (question) => question.kind === "multi-select",
    );
    if (multi?.kind === "multi-select") {
      multi.minSelections = 3;
      multi.maxSelections = 2;
    }
    expect(
      OperatorInteractionRequestV1Schema.safeParse(invalidBounds).success,
    ).toBe(false);

    const oversized = {
      ...requestFixture(),
      questions: Array.from({ length: 10 }, (_, questionIndex) => ({
        questionId: `question_${String(questionIndex).padStart(4, "0")}`,
        kind: "single-select" as const,
        prompt: "p".repeat(1_000),
        options: Array.from({ length: 20 }, (_, optionIndex) => ({
          optionId: `option_${String(questionIndex).padStart(
            2,
            "0",
          )}_${String(optionIndex).padStart(2, "0")}`,
          label: "l".repeat(120),
        })),
      })),
    };
    const oversizedResult =
      OperatorInteractionRequestV1Schema.safeParse(oversized);
    expect(oversizedResult.success).toBe(false);
    if (!oversizedResult.success) {
      expect(oversizedResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("serialized payload exceeds"),
          }),
        ]),
      );
    }
  });

  it("diagnoses incompatible, stale, missing, and out-of-order answers", () => {
    const request = requestFixture();

    const unknownOption = structuredClone(answerFixture());
    const single = unknownOption.answers.find(
      (answer) => answer.kind === "single-select",
    );
    if (single?.kind === "single-select") {
      single.optionId = "option_unknown_0001";
    }
    expect(validateInteractionAnswer(request, unknownOption)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unknown-option" }),
      ]),
    });

    const tooFewSelections = structuredClone(answerFixture());
    const multi = tooFewSelections.answers.find(
      (answer) => answer.kind === "multi-select",
    );
    if (multi?.kind === "multi-select") {
      multi.optionIds = [];
    }
    expect(validateInteractionAnswer(request, tooFewSelections)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "selection-count" }),
      ]),
    });

    const stale = {
      ...answerFixture(),
      submittedAt: request.expiresAt,
    };
    expect(validateInteractionAnswer(request, stale)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "answer-expired" }),
      ]),
    });

    const missing = structuredClone(answerFixture());
    missing.answers.pop();
    expect(validateInteractionAnswer(request, missing)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing-answer" }),
      ]),
    });

    const outOfOrder = structuredClone(answerFixture());
    outOfOrder.answers.reverse();
    expect(validateInteractionAnswer(request, outOfOrder)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "answer-order-mismatch" }),
      ]),
    });
  });

  it("rejects malformed answer IDs, kinds, text, and duplicate selections", () => {
    const duplicateQuestions = structuredClone(answerFixture());
    duplicateQuestions.answers[1]!.questionId =
      duplicateQuestions.answers[0]!.questionId;
    expect(
      OperatorInteractionAnswerV1Schema.safeParse(duplicateQuestions).success,
    ).toBe(false);

    const duplicateSelections = structuredClone(answerFixture());
    const multi = duplicateSelections.answers.find(
      (answer) => answer.kind === "multi-select",
    );
    if (multi?.kind === "multi-select") {
      multi.optionIds = ["option_unit_0001", "option_unit_0001"];
    }
    expect(
      OperatorInteractionAnswerV1Schema.safeParse(duplicateSelections).success,
    ).toBe(false);

    const oversizedText = structuredClone(answerFixture());
    const text = oversizedText.answers.find(
      (answer) => answer.kind === "free-text",
    );
    if (text?.kind === "free-text") {
      text.text = "x".repeat(4_001);
    }
    expect(
      OperatorInteractionAnswerV1Schema.safeParse(oversizedText).success,
    ).toBe(false);

    const blankText = structuredClone(answerFixture());
    const blank = blankText.answers.find(
      (answer) => answer.kind === "free-text",
    );
    if (blank?.kind === "free-text") {
      blank.text = "   ";
    }
    expect(OperatorInteractionAnswerV1Schema.safeParse(blankText).success).toBe(
      false,
    );

    const singleLineRequest = structuredClone(requestFixture());
    const singleLineQuestion = singleLineRequest.questions.find(
      (question) => question.kind === "free-text",
    );
    if (singleLineQuestion?.kind === "free-text") {
      singleLineQuestion.multiline = false;
    }
    const multilineAnswer = structuredClone(answerFixture());
    const multilineText = multilineAnswer.answers.find(
      (answer) => answer.kind === "free-text",
    );
    if (multilineText?.kind === "free-text") {
      multilineText.text = "line one\nline two";
    }
    expect(
      validateInteractionAnswer(singleLineRequest, multilineAnswer),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "text-multiline" }),
      ]),
    });

    const oversizedEnvelope = structuredClone(answerFixture());
    const envelopeText = oversizedEnvelope.answers.find(
      (answer) => answer.kind === "free-text",
    );
    if (envelopeText?.kind === "free-text") {
      envelopeText.text = "x".repeat(3_000);
    }
    oversizedEnvelope.answers.push({
      questionId: "question_extra_text_0001",
      kind: "free-text",
      text: "y".repeat(1_000),
    });
    const oversizedEnvelopeResult =
      OperatorInteractionAnswerV1Schema.safeParse(oversizedEnvelope);
    expect(oversizedEnvelopeResult.success).toBe(false);
    if (!oversizedEnvelopeResult.success) {
      expect(oversizedEnvelopeResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("serialized payload exceeds"),
          }),
        ]),
      );
    }

    const wrongKind = structuredClone(answerFixture());
    wrongKind.answers[0] = {
      questionId: "question_confirm_0001",
      kind: "single-select",
      optionId: "option_confirm_0001",
    };
    expect(
      validateInteractionAnswer(requestFixture(), wrongKind),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "answer-kind-mismatch" }),
      ]),
    });
  });

  it("keeps lifecycle transitions explicit and terminal states immutable", () => {
    const base = {
      schema: "agent-interaction-lifecycle.v1",
      requestId: "request_fixture_0001",
      occurredAt: "2026-07-25T12:05:00.000Z",
    } as const;
    const valid = [
      { ...base, state: "pending" },
      { ...base, state: "drafting" },
      {
        ...base,
        state: "answered",
        answerId: "answer_fixture_0001",
      },
      { ...base, state: "expired" },
      { ...base, state: "canceled" },
      {
        ...base,
        state: "superseded",
        supersededByRequestId: "request_fixture_0002",
      },
      {
        ...base,
        state: "failed",
        failure: {
          code: "synthetic-failure",
          message: "Synthetic bounded failure",
        },
      },
    ];
    for (const lifecycle of valid) {
      expect(InteractionLifecycleV1Schema.safeParse(lifecycle).success).toBe(
        true,
      );
    }

    expect(
      InteractionLifecycleV1Schema.safeParse({
        schema: "agent-interaction-lifecycle.v1",
        requestId: "request_fixture_0001",
        state: "answered",
        occurredAt: "2026-07-25T12:05:00.000Z",
      }).success,
    ).toBe(false);
    expect(isInteractionLifecycleTransition("pending", "drafting")).toBe(true);
    expect(isInteractionLifecycleTransition("drafting", "answered")).toBe(true);
    expect(isInteractionLifecycleTransition("answered", "failed")).toBe(false);
    expect(isInteractionLifecycleTransition("canceled", "answered")).toBe(
      false,
    );
  });

  it("validates provider capabilities and deterministic fallback metadata", () => {
    const capabilities = InteractionProviderCapabilitiesV1Schema.parse(
      fixture("provider-capabilities.v1.json"),
    );
    expect(capabilities.features).toContain("ordered-question-set");

    expect(
      InteractionProviderCapabilitiesV1Schema.safeParse({
        ...capabilities,
        features: ["confirm", "confirm"],
      }).success,
    ).toBe(false);

    expect(
      OperatorInteractionRequestV1Schema.safeParse({
        ...requestFixture(),
        fallback: {
          preferredMode: "buttons",
          alternativeModes: [],
          whenUnavailable: "use-alternative",
        },
      }).success,
    ).toBe(false);
  });

  it("strictly rejects provider callbacks and private transcript fields", () => {
    expect(
      OperatorInteractionRequestV1Schema.safeParse({
        ...requestFixture(),
        telegramCallbackData: "must-not-enter-the-contract",
      }).success,
    ).toBe(false);
    expect(
      OperatorInteractionAnswerV1Schema.safeParse({
        ...answerFixture(),
        transcript: "private transcript",
      }).success,
    ).toBe(false);
    expect(() =>
      parseInteractionAnswer(requestFixture(), {
        ...answerFixture(),
        requestId: "request_different_0001",
      }),
    ).toThrow("answer request ID does not match");
  });
});
