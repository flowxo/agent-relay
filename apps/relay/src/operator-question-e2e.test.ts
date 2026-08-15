import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  FakeNotificationTransport,
  RelayService,
  RelayStore,
  sessionActivityInputsForAttentionEvent,
  sessionPublicKey,
} from "@agent-relay/core";
import { parseHarnessJson } from "@agent-relay/harnesses";
import type { Harness } from "@agent-relay/protocol";

import { RelayClient } from "./client.js";
import { runHook } from "./hook-runner.js";
import { createRelayHttpServer } from "./http-server.js";
import { RelayMcpServer } from "./mcp-server.js";
import type { WebCredential } from "./web-credential.js";

const machineId = "machine_operator_e2e_12345678";
const now = "2026-08-15T18:00:00.000Z";
const webCredential: WebCredential = {
  schema: "agent-relay-web-credential.v1",
  token: "synthetic-local-web-token-operator-e2e",
  csrfToken: "synthetic-local-csrf-token-operator-e2e",
  createdAt: now,
};

const harnessVersions: Record<Harness, string> = {
  codex: "codex-cli 0.145.0",
  claude: "2.1.219 (Claude Code)",
  cursor: "2026.07.23-e383d2b",
};

function sessionStartRaw(harness: Harness, sessionId: string): string {
  if (harness === "cursor") {
    return JSON.stringify({
      hook_event_name: "sessionStart",
      session_id: sessionId,
      conversation_id: sessionId,
      workspace_roots: ["/workspace/example"],
    });
  }
  return JSON.stringify({
    session_id: sessionId,
    cwd: "/workspace/example",
    hook_event_name: "SessionStart",
    source: "startup",
  });
}

async function setup() {
  const store = new RelayStore();
  const transport = new FakeNotificationTransport();
  const service = new RelayService(store, transport, {
    now: () => new Date(now),
  });
  const server = createRelayHttpServer(service, { webCredential });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new RelayClient({ baseUrl });
  const fallbackRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-operator-e2e-"),
  );
  const close = async () => {
    server.close();
    await once(server, "close");
    store.close();
  };
  return { store, service, transport, client, baseUrl, fallbackRoot, close };
}

function webHeaders(baseUrl: string): Record<string, string> {
  return {
    authorization: `Bearer ${webCredential.token}`,
    origin: baseUrl,
    "x-agent-relay-csrf": webCredential.csrfToken,
  };
}

function mcpServer(
  client: RelayClient,
  harness: Harness,
  token: string,
  bridgeSessionId: string,
): RelayMcpServer {
  return new RelayMcpServer({
    bindingToken: token,
    machineId,
    bridgeSessionId,
    harness,
    client,
  });
}

async function claimSession(
  runtime: Awaited<ReturnType<typeof setup>>,
  harness: Harness,
  session: { token: string; bridgeSessionId: string; sessionId: string },
  sequence: number,
): Promise<void> {
  const result = await runHook({
    harness,
    surface: "cli",
    harnessVersion: harnessVersions[harness],
    raw: sessionStartRaw(harness, session.sessionId),
    machineId,
    bridgeSessionId: session.bridgeSessionId,
    sequence,
    occurredAt: now,
    fallbackPath: join(runtime.fallbackRoot, `${session.sessionId}.ndjson`),
    client: runtime.client,
    mcpBindingToken: session.token,
  });
  expect(result).toMatchObject({ daemonAccepted: true });
}

function confirmAsk(requestId: string, suffix: string) {
  return {
    schema: "agent-relay-mcp-ask.v1" as const,
    requestId,
    title: `Synthetic ${suffix} choice`,
    question: {
      questionId: `question_${suffix}_12345678`,
      kind: "confirm" as const,
      prompt: "Confirm this exact synthetic session.",
      confirm: {
        optionId: `option_${suffix}_yes_12345678`,
        label: "Confirm",
      },
      decline: {
        optionId: `option_${suffix}_no_12345678`,
        label: "Decline",
      },
    },
    expiresInMs: 60_000,
    waitTimeoutMs: 0,
  };
}

async function resolveQuestionSet(options: {
  baseUrl: string;
  requestId: string;
  harness: Harness;
  sessionId: string;
  answers: unknown[];
  operationId: string;
}): Promise<Response> {
  return await fetch(
    `${options.baseUrl}/v1/web/requests/${options.requestId}/resolve`,
    {
      method: "POST",
      headers: {
        ...webHeaders(options.baseUrl),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: "agent-relay-web-resolve.v1",
        operationId: options.operationId,
        sessionKey: sessionPublicKey({
          machineId,
          harness: options.harness,
          sessionId: options.sessionId,
        }),
        response: { kind: "question-set", answers: options.answers },
      }),
    },
  );
}

describe("operator questions across supported harnesses", () => {
  it.each(["codex", "claude", "cursor"] as const)(
    "keeps concurrent %s sessions isolated through MCP, Needs input, fake Telegram, and web",
    async (harness) => {
      const runtime = await setup();
      const sessions = [
        {
          token: `mcpbind_${"A".repeat(43)}`,
          bridgeSessionId: `bridge_${harness}_alpha_12345678`,
          sessionId: `session_${harness}_alpha_12345678`,
          requestId: `request_${harness}_alpha_12345678`,
        },
        {
          token: `mcpbind_${"B".repeat(43)}`,
          bridgeSessionId: `bridge_${harness}_beta_12345678`,
          sessionId: `session_${harness}_beta_12345678`,
          requestId: `request_${harness}_beta_12345678`,
        },
      ] as const;
      await claimSession(runtime, harness, sessions[0], 1);
      await claimSession(runtime, harness, sessions[1], 1);
      await runtime.service.drain();
      if (harness === "cursor") {
        expect(
          runtime.store.getSessionActivity(
            {
              machineId,
              harness,
              sessionId: sessions[0].sessionId,
            },
            now,
          ),
        ).toMatchObject({ state: "idle" });
      }

      const servers = sessions.map((session) =>
        mcpServer(
          runtime.client,
          harness,
          session.token,
          session.bridgeSessionId,
        ),
      );
      for (const [index, session] of sessions.entries()) {
        await expect(
          servers[index]?.handle({
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: {
              name: "relay_ask",
              arguments: confirmAsk(session.requestId, `${harness}_${index}`),
            },
          }),
        ).resolves.toMatchObject({
          result: {
            structuredContent: {
              code: "answer-timeout",
              requestId: session.requestId,
              requestState: "open",
            },
          },
        });
        expect(
          runtime.store.getSessionActivity(
            { machineId, harness, sessionId: session.sessionId },
            now,
          ),
        ).toMatchObject({ state: "needs_input", requestCount: 1 });
      }

      const deliveredBefore = runtime.transport.deliveries.length;
      await expect(runtime.service.drain()).resolves.toMatchObject({
        delivered: 2,
      });
      expect(runtime.transport.name).toBe("fake-telegram");
      const questionDeliveries =
        runtime.transport.deliveries.slice(deliveredBefore);
      expect(questionDeliveries).toHaveLength(2);
      for (const delivery of questionDeliveries) {
        expect(delivery.message.interaction?.options?.length).toBeGreaterThan(
          0,
        );
      }

      const attention = await fetch(
        `${runtime.baseUrl}/v1/web/attention?limit=20`,
        {
          headers: webHeaders(runtime.baseUrl),
        },
      );
      await expect(attention.json()).resolves.toMatchObject({
        attention: expect.arrayContaining([
          expect.objectContaining({ requestId: sessions[0].requestId }),
          expect.objectContaining({ requestId: sessions[1].requestId }),
        ]),
      });

      const alphaAnswers = [
        {
          questionId: `question_${harness}_0_12345678`,
          kind: "confirm",
          optionId: `option_${harness}_0_yes_12345678`,
        },
      ];
      const resolved = await resolveQuestionSet({
        baseUrl: runtime.baseUrl,
        requestId: sessions[0].requestId,
        harness,
        sessionId: sessions[0].sessionId,
        answers: alphaAnswers,
        operationId: `operation_${harness}_alpha_12345678`,
      });
      expect(resolved.status).toBe(200);

      await expect(
        servers[0]?.handle({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "relay_status",
            arguments: {
              schema: "agent-relay-mcp-status.v1",
              requestId: sessions[0].requestId,
            },
          },
        }),
      ).resolves.toMatchObject({
        result: {
          structuredContent: {
            requestState: "answered",
            answer: {
              requestId: sessions[0].requestId,
              answers: alphaAnswers,
            },
          },
        },
      });
      await expect(
        servers[1]?.handle({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "relay_status",
            arguments: {
              schema: "agent-relay-mcp-status.v1",
              requestId: sessions[1].requestId,
            },
          },
        }),
      ).resolves.toMatchObject({
        result: {
          structuredContent: {
            requestState: "open",
          },
        },
      });
      expect(
        runtime.store.getSessionActivity(
          { machineId, harness, sessionId: sessions[0].sessionId },
          now,
        ),
      ).toMatchObject({ state: "idle", requestCount: 0 });
      expect(
        runtime.store.getSessionActivity(
          { machineId, harness, sessionId: sessions[1].sessionId },
          now,
        ),
      ).toMatchObject({ state: "needs_input", requestCount: 1 });
      await runtime.close();
    },
  );

  it("delivers questionnaires and bounded free text, then keeps timeout, cancel, duplicate, and reconnect durable", async () => {
    const runtime = await setup();
    const session = {
      token: `mcpbind_${"Q".repeat(43)}`,
      bridgeSessionId: "bridge_operator_questionnaire_12345678",
      sessionId: "session_operator_questionnaire_12345678",
    };
    await claimSession(runtime, "codex", session, 1);
    await runtime.service.drain();
    const deliveredBefore = runtime.transport.deliveries.length;
    const server = mcpServer(
      runtime.client,
      "codex",
      session.token,
      session.bridgeSessionId,
    );
    const questionnaire = {
      schema: "agent-relay-mcp-questionnaire.v1",
      requestId: "request_operator_questionnaire_12345678",
      title: "Synthetic questionnaire",
      questions: [
        {
          questionId: "question_operator_confirm_12345678",
          kind: "confirm",
          prompt: "Confirm the synthetic questionnaire.",
          confirm: {
            optionId: "option_operator_yes_12345678",
            label: "Confirm",
          },
          decline: {
            optionId: "option_operator_no_12345678",
            label: "Decline",
          },
        },
        {
          questionId: "question_operator_note_1234567890",
          kind: "free-text",
          prompt: "Add a bounded synthetic note.",
          minLength: 1,
          maxLength: 80,
          multiline: false,
        },
      ],
      expiresInMs: 60_000,
      waitTimeoutMs: 0,
    };
    await expect(
      server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "relay_ask_many", arguments: questionnaire },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "answer-timeout" } },
    });
    await expect(
      server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "relay_ask_many", arguments: questionnaire },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "answer-timeout" } },
    });
    await expect(runtime.service.drain()).resolves.toMatchObject({
      delivered: 1,
    });
    const questionnaireDelivery =
      runtime.transport.deliveries[deliveredBefore]?.message;
    expect(
      questionnaireDelivery?.questionSet ?? questionnaireDelivery?.interaction,
    ).toBeDefined();

    const cancelledId = "request_operator_cancel_12345678";
    await expect(
      server.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "relay_ask",
          arguments: confirmAsk(cancelledId, "cancel"),
        },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "answer-timeout" } },
    });
    await expect(
      server.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "relay_cancel",
          arguments: {
            schema: "agent-relay-mcp-cancel.v1",
            requestId: cancelledId,
          },
        },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { requestState: "cancelled" } },
    });
    expect(
      runtime.store.getPendingRequest(cancelledId)?.answer,
    ).toBeUndefined();

    const answers = [
      {
        questionId: "question_operator_confirm_12345678",
        kind: "confirm",
        optionId: "option_operator_yes_12345678",
      },
      {
        questionId: "question_operator_note_1234567890",
        kind: "free-text",
        text: "Ship the synthetic note",
      },
    ];
    expect(
      (
        await resolveQuestionSet({
          baseUrl: runtime.baseUrl,
          requestId: questionnaire.requestId,
          harness: "codex",
          sessionId: session.sessionId,
          answers,
          operationId: "operation_operator_questionnaire_12345678",
        })
      ).status,
    ).toBe(200);

    const reconnected = mcpServer(
      runtime.client,
      "codex",
      session.token,
      session.bridgeSessionId,
    );
    await expect(
      reconnected.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "relay_status",
          arguments: {
            schema: "agent-relay-mcp-status.v1",
            requestId: questionnaire.requestId,
          },
        },
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          requestState: "answered",
          answer: { answers },
        },
      },
    });
    await runtime.close();
  });

  it("keeps unavailable delivery, restart, late answers, and fail-closed binding independent of execution", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "agent-relay-operator-restart-")),
      "relay.sqlite",
    );
    const store = new RelayStore(databasePath);
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(now),
    });
    const server = createRelayHttpServer(service, { webCredential });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new RelayClient({ baseUrl });
    const fallbackRoot = await mkdtemp(
      join(tmpdir(), "agent-relay-operator-restart-hook-"),
    );
    const session = {
      token: `mcpbind_${"R".repeat(43)}`,
      bridgeSessionId: "bridge_operator_restart_12345678",
      sessionId: "session_operator_restart_12345678",
    };
    await runHook({
      harness: "claude",
      surface: "cli",
      harnessVersion: harnessVersions.claude,
      raw: sessionStartRaw("claude", session.sessionId),
      machineId,
      bridgeSessionId: session.bridgeSessionId,
      sequence: 1,
      occurredAt: now,
      fallbackPath: join(fallbackRoot, "fallback.ndjson"),
      client,
      mcpBindingToken: session.token,
    });
    await service.drain();
    transport.setOnline(false);
    const mcp = mcpServer(
      client,
      "claude",
      session.token,
      session.bridgeSessionId,
    );
    const requestId = "request_operator_restart_12345678";
    await expect(
      mcp.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "relay_ask",
          arguments: confirmAsk(requestId, "restart"),
        },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "answer-timeout" } },
    });
    await expect(service.drain()).resolves.toMatchObject({ retrying: 1 });
    await expect(
      mcp.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "relay_status",
          arguments: {
            schema: "agent-relay-mcp-status.v1",
            requestId,
          },
        },
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          delivery: "degraded",
          requestState: "open",
          activityState: "needs_input",
        },
      },
    });

    server.close();
    await once(server, "close");
    store.close();

    const restartedStore = new RelayStore(databasePath);
    const restartedTransport = new FakeNotificationTransport();
    const restartedService = new RelayService(
      restartedStore,
      restartedTransport,
      {
        now: () => new Date(now),
      },
    );
    const restartedHttp = createRelayHttpServer(restartedService, {
      webCredential,
    });
    restartedHttp.listen(0, "127.0.0.1");
    await once(restartedHttp, "listening");
    const restartedUrl = `http://127.0.0.1:${(restartedHttp.address() as AddressInfo).port}`;
    const restartedClient = new RelayClient({ baseUrl: restartedUrl });
    const restartedMcp = mcpServer(
      restartedClient,
      "claude",
      session.token,
      session.bridgeSessionId,
    );
    expect(
      restartedStore.getSessionActivity(
        { machineId, harness: "claude", sessionId: session.sessionId },
        now,
      ),
    ).toMatchObject({ state: "needs_input" });
    expect(
      (
        await resolveQuestionSet({
          baseUrl: restartedUrl,
          requestId,
          harness: "claude",
          sessionId: session.sessionId,
          answers: [
            {
              questionId: "question_restart_12345678",
              kind: "confirm",
              optionId: "option_restart_yes_12345678",
            },
          ],
          operationId: "operation_operator_restart_12345678",
        })
      ).status,
    ).toBe(200);
    await expect(
      restartedMcp.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "relay_status",
          arguments: { schema: "agent-relay-mcp-status.v1", requestId },
        },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { requestState: "answered" } },
    });

    const unbound = new RelayMcpServer({
      bindingToken: `mcpbind_${"U".repeat(43)}`,
      machineId,
      bridgeSessionId: "bridge_operator_unbound_12345678",
      harness: "cursor",
      client: restartedClient,
    });
    await expect(
      unbound.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "relay_ask",
          arguments: confirmAsk("request_operator_unbound_12345678", "unbound"),
        },
      }),
    ).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          code: "binding-pending",
          localFallback:
            "Ask the operator locally with the harness's native question mechanism.",
        },
      },
    });

    const ambiguousToken = `mcpbind_${"Z".repeat(43)}`;
    await runHook({
      harness: "codex",
      surface: "cli",
      harnessVersion: harnessVersions.codex,
      raw: sessionStartRaw("codex", "session_operator_ambiguous_a_12345678"),
      machineId,
      bridgeSessionId: "bridge_operator_ambiguous_a_12345678",
      sequence: 1,
      occurredAt: now,
      fallbackPath: join(fallbackRoot, "ambiguous-a.ndjson"),
      client: restartedClient,
      mcpBindingToken: ambiguousToken,
    });
    await runHook({
      harness: "codex",
      surface: "cli",
      harnessVersion: harnessVersions.codex,
      raw: sessionStartRaw("codex", "session_operator_ambiguous_b_12345678"),
      machineId,
      bridgeSessionId: "bridge_operator_ambiguous_b_12345678",
      sequence: 1,
      occurredAt: now,
      fallbackPath: join(fallbackRoot, "ambiguous-b.ndjson"),
      client: restartedClient,
      mcpBindingToken: ambiguousToken,
    });
    const ambiguous = mcpServer(
      restartedClient,
      "codex",
      ambiguousToken,
      "bridge_operator_ambiguous_a_12345678",
    );
    await expect(
      ambiguous.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "relay_ask",
          arguments: confirmAsk(
            "request_operator_ambiguous_12345678",
            "ambiguous",
          ),
        },
      }),
    ).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "binding-ambiguous" },
      },
    });

    restartedHttp.close();
    await once(restartedHttp, "close");
    restartedStore.close();
  });

  it("does not turn native permission hooks into operator questionnaires", () => {
    const context = {
      machineId,
      bridgeSessionId: "bridge_operator_permission_12345678",
      harnessVersion: "frozen",
      surface: "cli" as const,
      sequence: 1,
      occurredAt: now,
    };
    const payloads: Array<{ harness: Harness; raw: string }> = [
      {
        harness: "codex",
        raw: JSON.stringify({
          session_id: "codex-session-permission-0001",
          cwd: "/workspace/example",
          hook_event_name: "PermissionRequest",
          turn_id: "codex-turn-permission-0001",
          tool_name: "Bash",
          tool_use_id: "codex-tool-permission-0001",
          tool_input: { command: "SYNTHETIC_PRIVATE_COMMAND" },
        }),
      },
      {
        harness: "claude",
        raw: JSON.stringify({
          session_id: "claude-session-permission-0001",
          cwd: "/workspace/example",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_use_id: "claude-tool-permission-0001",
          tool_input: { command: "SYNTHETIC_PRIVATE_COMMAND" },
        }),
      },
      {
        harness: "cursor",
        raw: JSON.stringify({
          hook_event_name: "beforeShellExecution",
          conversation_id: "cursor-conversation-permission-0001",
          workspace_roots: ["/workspace/example"],
          command: "SYNTHETIC_PRIVATE_COMMAND",
        }),
      },
    ];
    for (const payload of payloads) {
      const parsed = parseHarnessJson(payload.harness, payload.raw, context);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.event.type).toBe("permission.required");
      expect(parsed.event.request?.kind).toBe("permission");
      expect(parsed.event.request?.interaction).toBeUndefined();
      expect(sessionActivityInputsForAttentionEvent(parsed.event)).toEqual([]);
      expect(JSON.stringify(parsed.event)).not.toContain(
        "SYNTHETIC_PRIVATE_COMMAND",
      );
    }
    const exitPlan = parseHarnessJson(
      "claude",
      JSON.stringify({
        session_id: "claude-session-exit-plan-0001",
        cwd: "/workspace/example",
        hook_event_name: "ExitPlanMode",
      }),
      context,
    );
    expect(exitPlan.ok).toBe(false);
  });
});
