import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { FakeTelegramTransport } from "./fake-transport.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const now = "2026-07-25T12:00:00.000Z";
const temporaryDirectories: string[] = [];

function event(
  requestKind: "input" | "select" | "multi-select" = "input",
): AgentAttentionEventV1 {
  const request =
    requestKind === "input"
      ? {
          correlationId: "request_web_control_12345678",
          kind: "input" as const,
          question: "Provide the deployment label",
          expiresAt: "2026-07-25T12:10:00.000Z",
        }
      : {
          correlationId: "request_web_control_12345678",
          kind: requestKind,
          question: "Choose the deployment target",
          options: [
            { id: "option_staging_12345678", label: "Staging" },
            { id: "option_prod_1234567890", label: "Production" },
          ],
          ...(requestKind === "multi-select"
            ? { minSelections: 1, maxSelections: 2 }
            : {}),
          expiresAt: "2026-07-25T12:10:00.000Z",
        };
  return {
    schema: "agent-attention.v1",
    eventId: "event_web_control_12345678",
    occurredAt: now,
    sequence: 1,
    machineId: "machine_web_control_12345678",
    bridgeSessionId: "bridge_web_control_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_web_control_12345678",
    turnId: "turn_web_control_12345678",
    project: {
      ...makeProjectRef("/private/workspace/project"),
      branch: "codex/web-control",
    },
    type: "input.required",
    summary: "Agent requires attention",
    lastAssistantMessage: "private transcript text",
    request,
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function runtime(store = new RelayStore()) {
  return {
    store,
    service: new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date(now),
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("durable web control", () => {
  it("lists bounded open attention and emits ordered transcript-free changes", () => {
    const { store, service } = runtime();
    service.ingest(event());

    expect(service.listPendingRequests(1)).toEqual([
      expect.objectContaining({
        correlationId: "request_web_control_12345678",
        state: "open",
      }),
    ]);
    expect(store.listSessions(1)).toEqual([
      expect.objectContaining({
        project: expect.objectContaining({
          displayName: "project",
          branch: "codex/web-control",
        }),
      }),
    ]);
    const changes = store.listWebChanges(0, 100);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.map(({ cursor }) => cursor)).toEqual(
      [...changes.map(({ cursor }) => cursor)].sort(
        (left, right) => left - right,
      ),
    );
    expect(JSON.stringify(changes)).not.toContain("private transcript text");
    expect(JSON.stringify(changes)).not.toContain(
      "Provide the deployment label",
    );
    expect(store.webChangeBounds()).toMatchObject({
      firstCursor: changes[0]?.cursor,
      lastCursor: changes.at(-1)?.cursor,
    });

    store.close();
  });

  it("makes browser resolution idempotent without weakening first-writer wins", () => {
    const { store, service } = runtime();
    service.ingest(event());
    const input = {
      operationId: "operation_web_control_12345678",
      correlationId: "request_web_control_12345678",
      answer: "release-candidate",
    };

    expect(service.resolveBrowser(input)).toMatchObject({
      outcome: "answered",
      replayed: false,
    });
    const afterFirst = store.webChangeBounds().lastCursor;
    expect(service.resolveBrowser(input)).toMatchObject({
      outcome: "answered",
      replayed: true,
    });
    expect(store.webChangeBounds().lastCursor).toBe(afterFirst);
    expect(
      service.resolveBrowser({ ...input, answer: "different-answer" }),
    ).toEqual({
      outcome: "replay_conflict",
      replayed: true,
    });
    expect(
      service.resolveTerminal({
        correlationId: input.correlationId,
        answer: "late-terminal-answer",
        expected: {
          machineId: event().machineId,
          harness: event().harness,
          sessionId: event().sessionId,
          ...(event().turnId === undefined
            ? {}
            : { turnId: event().turnId as string }),
        },
      }),
    ).toMatchObject({ outcome: "duplicate" });
    expect(store.getPendingRequest(input.correlationId)).toMatchObject({
      answer: "release-candidate",
      resolvedBy: "web",
    });

    store.close();
  });

  it("validates choice identifiers and defers structured drafts", () => {
    const selectRuntime = runtime();
    selectRuntime.service.ingest(event("select"));
    expect(
      selectRuntime.service.resolveBrowser({
        operationId: "operation_invalid_choice_12345678",
        correlationId: "request_web_control_12345678",
        answer: "unknown_option_12345678",
      }),
    ).toMatchObject({ outcome: "invalid_answer" });
    expect(
      selectRuntime.service.resolveBrowser({
        operationId: "operation_valid_choice_1234567890",
        correlationId: "request_web_control_12345678",
        answer: "option_staging_12345678",
      }),
    ).toMatchObject({ outcome: "answered" });
    selectRuntime.store.close();

    const structuredRuntime = runtime();
    structuredRuntime.service.ingest(event("multi-select"));
    expect(
      structuredRuntime.service.resolveBrowser({
        operationId: "operation_structured_1234567890",
        correlationId: "request_web_control_12345678",
        answer: "option_staging_12345678",
      }),
    ).toMatchObject({ outcome: "unsupported_request" });
    structuredRuntime.store.close();
  });

  it("resumes the durable cursor after a store restart without duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-web-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const first = runtime(new RelayStore(databasePath));
    first.service.ingest(event());
    const cursor = first.store.listWebChanges(0, 2).at(-1)?.cursor ?? 0;
    first.store.close();

    const second = new RelayStore(databasePath);
    const resumed = second.listWebChanges(cursor, 100);
    expect(resumed.every((change) => change.cursor > cursor)).toBe(true);
    expect(new Set(resumed.map((change) => change.cursor)).size).toBe(
      resumed.length,
    );
    second.close();
  });

  it("isolates concurrent browser requests by correlation and session", () => {
    const { store, service } = runtime();
    const first = event();
    const second: AgentAttentionEventV1 = {
      ...event(),
      eventId: "event_web_second_12345678",
      machineId: "machine_web_second_12345678",
      bridgeSessionId: "bridge_web_second_12345678",
      sessionId: "session_web_second_12345678",
      turnId: "turn_web_second_12345678",
      request: {
        correlationId: "request_web_second_12345678",
        kind: "input",
        question: "Provide the second label",
        expiresAt: "2026-07-25T12:10:00.000Z",
      },
    };
    service.ingest(first);
    service.ingest(second);

    expect(
      service.resolveBrowser({
        operationId: "operation_web_first_12345678",
        correlationId: first.request!.correlationId,
        answer: "first-answer",
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      store.getPendingRequest(second.request!.correlationId),
    ).toMatchObject({
      state: "open",
    });
    expect(
      store.getPendingRequest(second.request!.correlationId)?.answer,
    ).toBeUndefined();
    expect(
      service.resolveBrowser({
        operationId: "operation_web_second_12345678",
        correlationId: second.request!.correlationId,
        answer: "second-answer",
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(store.getPendingRequest(first.request!.correlationId)?.answer).toBe(
      "first-answer",
    );
    expect(store.getPendingRequest(second.request!.correlationId)?.answer).toBe(
      "second-answer",
    );
    store.close();
  });

  it("rejects a stale browser answer without reopening the request", () => {
    const { store, service } = runtime();
    service.ingest(event());
    const lateService = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date("2026-07-25T12:11:00.000Z"),
    });

    expect(
      lateService.resolveBrowser({
        operationId: "operation_web_stale_12345678",
        correlationId: "request_web_control_12345678",
        answer: "late-answer",
      }),
    ).toMatchObject({ outcome: "expired", replayed: false });
    expect(
      store.getPendingRequest("request_web_control_12345678"),
    ).toMatchObject({ state: "expired" });
    expect(
      store.getPendingRequest("request_web_control_12345678")?.answer,
    ).toBeUndefined();
    store.close();
  });
});
