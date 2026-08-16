import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RelayMcpAskV1 } from "@agent-relay/protocol";

import type { LogRecord, RelayLogger } from "./logger.js";
import { FakeNotificationTransport } from "./notifications/adapters/fake.js";
import { RelayService } from "./service.js";
import { RELAY_STORE_SCHEMA_VERSION, RelayStore } from "./store.js";

const bindingA = `mcpbind_${"A".repeat(43)}`;
const bindingB = `mcpbind_${"B".repeat(43)}`;
const machineId = "machine_mcp_fixture_12345678";
const bridgeSessionId = "bridge_mcp_fixture_12345678";
const baseAt = "2026-08-13T12:00:00.000Z";

function sessionId(suffix: string): string {
  return `session_mcp_fixture_${suffix}_12345678`;
}

function registerSession(store: RelayStore, suffix: string): void {
  store.registerSession({
    schema: "agent-session.v1",
    machineId,
    bridgeSessionId,
    harness: "codex",
    surface: "cli",
    harnessVersion: "synthetic-mcp-fixture",
    sessionId: sessionId(suffix),
    project: {
      displayName: "same-synthetic-project",
      cwdHash: `sha256:${"a".repeat(64)}`,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: false,
    },
    registeredAt: baseAt,
  });
}

function ask(overrides: Partial<RelayMcpAskV1> = {}): RelayMcpAskV1 {
  return {
    schema: "agent-relay-mcp-ask.v1",
    requestId: "request_mcp_core_12345678",
    title: "Synthetic rollout",
    question: {
      questionId: "question_mcp_core_12345678",
      kind: "single-select",
      prompt: "Choose a synthetic rollout.",
      options: [
        { optionId: "option_mcp_alpha_12345678", label: "Alpha" },
        { optionId: "option_mcp_beta_12345678", label: "Beta" },
      ],
    },
    expiresInMs: 60_000,
    waitTimeoutMs: 10_000,
    ...overrides,
  };
}

function bind(store: RelayStore, token = bindingA, suffix = "a"): void {
  expect(
    store.registerMcpSessionBinding({
      token,
      machineId,
      bridgeSessionId,
      harness: "codex",
      now: baseAt,
    }).outcome,
  ).toMatch(/created|duplicate/u);
  expect(
    store.claimMcpSessionBinding({
      token,
      machineId,
      bridgeSessionId,
      harness: "codex",
      sessionId: sessionId(suffix),
      now: baseAt,
    }).outcome,
  ).toMatch(/bound|duplicate/u);
}

describe("durable local MCP interactions", () => {
  it("binds concurrent same-project sessions only by their secret handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-mcp-store-"));
    const databasePath = join(directory, "relay.sqlite");
    const first = new RelayStore(databasePath);
    registerSession(first, "a");
    registerSession(first, "b");
    const second = new RelayStore(databasePath);

    bind(first, bindingA, "a");
    bind(second, bindingB, "b");
    expect(first.getMcpSessionBinding(bindingA)).toMatchObject({
      state: "bound",
      sessionId: sessionId("a"),
    });
    expect(second.getMcpSessionBinding(bindingB)).toMatchObject({
      state: "bound",
      sessionId: sessionId("b"),
    });

    expect(
      second.claimMcpSessionBinding({
        token: bindingA,
        machineId,
        bridgeSessionId,
        harness: "codex",
        sessionId: sessionId("b"),
        now: "2026-08-13T12:00:01.000Z",
      }),
    ).toMatchObject({ outcome: "ambiguous", binding: { state: "ambiguous" } });
    expect(first.getMcpSessionBinding(bindingA)?.state).toBe("ambiguous");
    first.close();
    second.close();

    expect(await readFile(databasePath, "utf8")).not.toContain(bindingA);
    expect(await readFile(databasePath, "utf8")).not.toContain(bindingB);

    const restarted = new RelayStore(databasePath);
    expect(restarted.getMcpSessionBinding(bindingB)).toMatchObject({
      state: "bound",
      sessionId: sessionId("b"),
    });
    expect(RELAY_STORE_SCHEMA_VERSION).toBe(12);
    restarted.close();
  });

  it("retains one open MCP request and exact binding across store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-mcp-store-"));
    const databasePath = join(directory, "relay.sqlite");
    const first = new RelayStore(databasePath);
    registerSession(first, "a");
    bind(first);
    const firstService = new RelayService(
      first,
      new FakeNotificationTransport(),
      { now: () => new Date(baseAt) },
    );
    expect(firstService.openMcpInteraction(bindingA, ask())).toMatchObject({
      outcome: "opened",
    });
    first.close();

    const restarted = new RelayStore(databasePath);
    const restartedService = new RelayService(
      restarted,
      new FakeNotificationTransport(),
      { now: () => new Date("2026-08-13T12:00:01.000Z") },
    );
    expect(
      restartedService.mcpInteractionStatus(bindingA, ask().requestId),
    ).toMatchObject({
      binding: { state: "bound", sessionId: sessionId("a") },
      request: { state: "open" },
      session: { activity: { state: "needs_input", requestCount: 1 } },
    });
    expect(restartedService.openMcpInteraction(bindingA, ask())).toMatchObject({
      outcome: "duplicate",
      request: { state: "open" },
    });
    restarted.close();
  });

  it("keeps an ended binding terminal under later conflicting claims", () => {
    const store = new RelayStore();
    registerSession(store, "a");
    registerSession(store, "b");
    bind(store);
    expect(
      store.endMcpSessionBinding({
        token: bindingA,
        machineId,
        bridgeSessionId,
        harness: "codex",
        sessionId: sessionId("a"),
        now: "2026-08-13T12:00:01.000Z",
      }),
    ).toMatchObject({ outcome: "ended", binding: { state: "ended" } });
    expect(
      store.claimMcpSessionBinding({
        token: bindingA,
        machineId,
        bridgeSessionId,
        harness: "codex",
        sessionId: sessionId("b"),
        now: "2026-08-13T12:00:02.000Z",
      }),
    ).toMatchObject({ outcome: "terminal", binding: { state: "ended" } });
    store.close();
  });

  it("fails a bound authority closed if the native session changes bridge ownership", () => {
    const store = new RelayStore();
    registerSession(store, "a");
    bind(store);
    store.registerSession({
      schema: "agent-session.v1",
      machineId,
      bridgeSessionId: "bridge_mcp_other_owner_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "synthetic-mcp-fixture",
      sessionId: sessionId("a"),
      project: {
        displayName: "same-synthetic-project",
        cwdHash: `sha256:${"a".repeat(64)}`,
      },
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: false,
      },
      registeredAt: "2026-08-13T12:00:01.000Z",
    });
    const service = new RelayService(store, new FakeNotificationTransport(), {
      now: () => new Date("2026-08-13T12:00:02.000Z"),
    });
    expect(service.mcpInteractionStatus(bindingA)).toMatchObject({
      binding: { state: "ambiguous" },
      delivery: "degraded",
    });
    expect(service.openMcpInteraction(bindingA, ask())).toMatchObject({
      outcome: "binding-ambiguous",
    });
    store.close();
  });

  it("retains every typed question kind in one ordered MCP questionnaire", () => {
    const store = new RelayStore();
    registerSession(store, "a");
    bind(store);
    const service = new RelayService(store, new FakeNotificationTransport(), {
      now: () => new Date(baseAt),
    });
    const requestId = "request_mcp_all_kinds_12345678";
    expect(
      service.openMcpInteraction(bindingA, {
        schema: "agent-relay-mcp-questionnaire.v1",
        requestId,
        title: "Synthetic typed questionnaire",
        questions: [
          {
            questionId: "question_mcp_confirm_12345678",
            kind: "confirm",
            prompt: "Confirm the synthetic plan?",
            confirm: {
              optionId: "option_mcp_confirm_yes_12345678",
              label: "Continue",
            },
            decline: {
              optionId: "option_mcp_confirm_no_12345678",
              label: "Stop",
            },
          },
          {
            questionId: "question_mcp_select_12345678",
            kind: "single-select",
            prompt: "Choose one synthetic lane.",
            options: [
              { optionId: "option_mcp_lane_a_12345678", label: "Lane A" },
              { optionId: "option_mcp_lane_b_12345678", label: "Lane B" },
            ],
          },
          {
            questionId: "question_mcp_multi_12345678",
            kind: "multi-select",
            prompt: "Choose synthetic checks.",
            options: [
              {
                optionId: "option_mcp_check_a_12345678",
                label: "Check A",
              },
              {
                optionId: "option_mcp_check_b_12345678",
                label: "Check B",
              },
            ],
            minSelections: 1,
            maxSelections: 2,
          },
          {
            questionId: "question_mcp_text_12345678",
            kind: "free-text",
            prompt: "Add a synthetic note.",
            minLength: 1,
            maxLength: 120,
            multiline: false,
          },
        ],
        expiresInMs: 60_000,
        waitTimeoutMs: 0,
      }),
    ).toMatchObject({ outcome: "opened" });
    const interaction = store.getEvent(
      store.getPendingRequest(requestId)?.eventId ?? "missing",
    )?.event.request?.interaction;
    expect(interaction?.questions.map((question) => question.kind)).toEqual([
      "confirm",
      "single-select",
      "multi-select",
      "free-text",
    ]);
    store.close();
  });

  it("creates one existing durable question and clears Needs input on resolution", () => {
    let now = new Date(baseAt);
    const store = new RelayStore();
    registerSession(store, "a");
    bind(store);
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, { now: () => now });

    const opened = service.openMcpInteraction(bindingA, ask());
    expect(opened).toMatchObject({
      outcome: "opened",
      request: { state: "open" },
    });
    expect(service.openMcpInteraction(bindingA, ask())).toMatchObject({
      outcome: "duplicate",
      request: { state: "open" },
    });
    expect(store.listPendingRequests()).toHaveLength(1);
    expect(
      store.getSessionActivity(
        {
          machineId,
          harness: "codex",
          sessionId: sessionId("a"),
        },
        baseAt,
      ),
    ).toMatchObject({ state: "needs_input", requestCount: 1 });

    now = new Date("2026-08-13T12:00:02.000Z");
    expect(
      store.resolveRequest({
        correlationId: ask().requestId,
        answer: JSON.stringify({
          schema: "agent-interaction-answer.v1",
          answerId: "answer_mcp_core_12345678",
          requestId: ask().requestId,
          submittedAt: now.toISOString(),
          answers: [
            {
              questionId: "question_mcp_core_12345678",
              kind: "single-select",
              optionId: "option_mcp_alpha_12345678",
            },
          ],
        }),
        resolvedBy: "web",
        now: now.toISOString(),
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      service.mcpInteractionStatus(bindingA, ask().requestId),
    ).toMatchObject({
      request: { state: "answered" },
      answer: { schema: "agent-interaction-answer.v1" },
      session: { activity: { state: "idle", requestCount: 0 } },
    });
    store.close();
  });

  it("keeps an offline delivery durable and makes cancel/expiry first-writer-wins", async () => {
    let now = new Date(baseAt);
    const store = new RelayStore();
    registerSession(store, "a");
    bind(store);
    const transport = new FakeNotificationTransport();
    transport.setOnline(false);
    const service = new RelayService(store, transport, { now: () => now });
    expect(service.openMcpInteraction(bindingA, ask())).toMatchObject({
      outcome: "opened",
    });
    await expect(service.drain()).resolves.toMatchObject({ retrying: 1 });
    expect(
      service.mcpInteractionStatus(bindingA, ask().requestId),
    ).toMatchObject({
      delivery: "degraded",
      request: { state: "open" },
      session: { activity: { state: "needs_input" } },
    });

    expect(
      service.cancelMcpInteraction(bindingA, ask().requestId),
    ).toMatchObject({
      outcome: "cancelled",
    });
    expect(
      service.cancelMcpInteraction(bindingA, ask().requestId),
    ).toMatchObject({
      outcome: "cancelled",
      request: { state: "cancelled" },
    });

    const expiring = ask({ requestId: "request_mcp_expiry_12345678" });
    expect(service.openMcpInteraction(bindingA, expiring)).toMatchObject({
      outcome: "opened",
    });
    now = new Date("2026-08-13T12:01:02.000Z");
    expect(
      service.mcpInteractionStatus(bindingA, expiring.requestId),
    ).toMatchObject({ request: { state: "expired" } });
    expect(
      store.resolveRequest({
        correlationId: expiring.requestId,
        answer: "late synthetic answer",
        resolvedBy: "terminal",
        now: now.toISOString(),
      }),
    ).toMatchObject({ outcome: "expired" });
    store.close();
  });

  it("never writes prompt, answer, binding authority, or tool arguments to logs", () => {
    const records: LogRecord[] = [];
    const logger: RelayLogger = { log: (record) => records.push(record) };
    const store = new RelayStore();
    registerSession(store, "a");
    bind(store);
    const service = new RelayService(store, new FakeNotificationTransport(), {
      now: () => new Date(baseAt),
      logger,
    });
    const privatePrompt = "PRIVATE_MCP_PROMPT_SENTINEL";
    service.openMcpInteraction(
      bindingA,
      ask({
        question: {
          questionId: "question_mcp_private_12345678",
          kind: "free-text",
          prompt: privatePrompt,
          minLength: 1,
          maxLength: 120,
          multiline: false,
        },
      }),
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(privatePrompt);
    expect(serialized).not.toContain(bindingA);
    expect(serialized).not.toContain("question_mcp_private_12345678");
    store.close();
  });

  it("binds MCP by harness-stated native session and fails closed across concurrent sessions", () => {
    const store = new RelayStore();
    registerSession(store, "a");
    registerSession(store, "b");
    bind(store, bindingA, "a");
    bind(store, bindingB, "b");
    const service = new RelayService(store, new FakeNotificationTransport(), {
      now: () => new Date(baseAt),
    });
    const nativeA = {
      machineId,
      harness: "codex" as const,
      sessionId: sessionId("a"),
    };
    const nativeB = {
      machineId,
      harness: "codex" as const,
      sessionId: sessionId("b"),
    };
    expect(service.openMcpInteraction(nativeA, ask())).toMatchObject({
      outcome: "opened",
    });
    const other = service.mcpInteractionStatus(nativeB, ask().requestId);
    expect(other.request).toBeUndefined();
    expect(other.binding).toMatchObject({
      state: "bound",
      sessionId: sessionId("b"),
    });
    expect(
      store.verifyMcpSessionBindingByNativeSession(nativeA, baseAt),
    ).toMatchObject({
      state: "bound",
      sessionId: sessionId("a"),
    });
    store.close();
  });
});
