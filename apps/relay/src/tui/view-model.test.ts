import { describe, expect, it } from "vitest";

import {
  applyFormToggle,
  buildResponse,
  filterLoadedSessions,
  formFields,
  incompleteFormStatus,
  sessionName,
  shouldHoldUpdates,
  withFocusedChoice,
} from "./view-model.js";

describe("terminal dashboard view-model", () => {
  it("renders stable safe session names from the opaque public key", () => {
    expect(sessionName("0123456789abcdef01234567")).toMatch(
      /^[a-z]+-[a-z]+-\d{2}$/u,
    );
    expect(sessionName("0123456789abcdef01234567")).toBe(
      sessionName("0123456789abcdef01234567"),
    );
  });

  it("filters only already loaded safe fields", () => {
    const sessions = [
      {
        schema: "agent-relay-project-session.v1" as const,
        sessionKey: "0123456789abcdef01234567",
        sessionName: sessionName("0123456789abcdef01234567"),
        projectKey: `prj_${"a".repeat(48)}`,
        projectLabel: "checkout-service",
        harness: "codex" as const,
        surface: "cli" as const,
        lastSeenAt: "2026-08-14T11:59:30.000Z",
        knownInFlightWork: { count: 0 },
        pendingInteraction: { state: "none" as const, count: 0 },
        deliveryHealth: { muted: false },
        activity: {
          schema: "agent-relay-session-activity.v1" as const,
          policyVersion: "ar5.1.v1" as const,
          fixtureSetVersion: "ar5.1-2026-08-13" as const,
          state: "working" as const,
          stateLabel: "Working" as const,
          confidence: "confirmed" as const,
          reason: "foreground_recent" as const,
          reasonText: "A prompt was submitted",
          source: "codex_cli" as const,
          lastObservedAt: "2026-08-14T11:59:30.000Z",
          inFlightCount: 0,
          requestCount: 0,
          muted: false,
          epoch: 1,
          lastAppliedSequence: 4,
        },
      },
    ];
    expect(filterLoadedSessions(sessions, "checkout").length).toBe(1);
    expect(filterLoadedSessions(sessions, "missing").length).toBe(0);
    expect(
      filterLoadedSessions(sessions, sessionName(sessions[0]!.sessionKey))
        .length,
    ).toBe(1);
  });

  it("holds updates while a draft or detail view is open", () => {
    expect(shouldHoldUpdates({ hasUnsentDraft: true })).toBe(true);
    expect(shouldHoldUpdates({ drawerOpen: true })).toBe(true);
    expect(shouldHoldUpdates({})).toBe(false);
  });

  it("binds a single-select answer to the option id", () => {
    const response = buildResponse(
      {
        schema: "agent-relay-web-attention.v1",
        requestId: "request_tui_select_1",
        eventId: "evt_tui_select_1",
        sessionKey: "0123456789abcdef01234567",
        harness: "codex",
        requestKind: "select",
        state: "open",
        promptPreview: "Choose a synthetic path",
        expiresAt: "2026-08-14T13:00:00.000Z",
        supportedActions: ["choose-option"],
        options: [
          { optionId: "option_one", label: "One" },
          { optionId: "option_two", label: "Two" },
        ],
        form: {
          kind: "single-select",
          options: [
            { optionId: "option_one", label: "One" },
            { optionId: "option_two", label: "Two" },
          ],
        },
      },
      { value: "option_two" },
    );
    expect(response).toEqual({ kind: "option", optionId: "option_two" });
  });

  it("walks questionnaire fields and binds each answer to its question", () => {
    const item = {
      schema: "agent-relay-web-attention.v1" as const,
      requestId: "request_tui_set_1",
      eventId: "evt_tui_set_1",
      sessionKey: "0123456789abcdef01234567",
      harness: "codex" as const,
      requestKind: "question-set" as const,
      state: "open" as const,
      promptPreview: "Synthetic release questionnaire",
      expiresAt: "2026-08-14T13:00:00.000Z",
      supportedActions: ["answer-question-set" as const],
      options: [],
      form: {
        kind: "question-set" as const,
        title: "Synthetic release questionnaire",
        questions: [
          {
            questionId: "question_confirm_tui01",
            kind: "confirm" as const,
            prompt: "Proceed with the synthetic release?",
            confirm: { optionId: "option_proceed_tui01", label: "Proceed" },
            decline: { optionId: "option_stop_tui01", label: "Stop" },
          },
          {
            questionId: "question_note_tui01",
            kind: "free-text" as const,
            prompt: "Add a synthetic release note",
            minLength: 3,
            maxLength: 80,
            multiline: false,
          },
        ],
      },
    };
    const fields = formFields(item.form);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({
      kind: "option",
      optionId: "option_proceed_tui01",
    });
    expect(fields[2]).toMatchObject({
      kind: "text",
      key: "question_note_tui01",
    });
    const first = fields[0];
    expect(first?.kind).toBe("option");
    const selected = first?.kind === "option" ? applyFormToggle({}, first) : {};
    const values = withFocusedChoice(
      item.form,
      { ...selected, question_note_tui01: "ship" },
      2,
    );
    expect(buildResponse(item, values)).toEqual({
      kind: "question-set",
      answers: [
        {
          questionId: "question_confirm_tui01",
          kind: "confirm",
          optionId: "option_proceed_tui01",
        },
        {
          questionId: "question_note_tui01",
          kind: "free-text",
          text: "ship",
        },
      ],
    });
    expect(incompleteFormStatus(item.form, selected)).toEqual({
      fieldIndex: 2,
      message: "Add a synthetic release note still needs an answer.",
    });
  });
});
