import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  FakeNotificationTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

import { RelayClient } from "./client.js";
import { createRelayHttpServer } from "./http-server.js";
import { RelayMcpServer } from "./mcp-server.js";

const token = `mcpbind_${"I".repeat(43)}`;
const machineId = "machine_mcp_integration_12345678";
const bridgeSessionId = "bridge_mcp_integration_12345678";
const sessionId = "session_mcp_integration_12345678";
const requestId = "request_mcp_integration_12345678";
const now = "2026-08-13T15:00:00.000Z";

describe("local MCP to durable Relay integration", () => {
  it("delivers through the daemon and returns a retained answer after reconnect", async () => {
    const store = new RelayStore();
    const transport = new FakeNotificationTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date(now),
    });
    store.registerSession({
      schema: "agent-session.v1",
      machineId,
      bridgeSessionId,
      harness: "codex",
      surface: "cli",
      harnessVersion: "synthetic-mcp-integration",
      sessionId,
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
      registeredAt: now,
    });
    const httpServer = createRelayHttpServer(service);
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    const client = new RelayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    await client.registerMcpBinding(token, {
      machineId,
      bridgeSessionId,
      harness: "codex",
    });
    await expect(
      client.claimMcpBinding(token, {
        machineId,
        bridgeSessionId,
        harness: "codex",
        sessionId,
      }),
    ).resolves.toMatchObject({ outcome: "bound", bindingState: "bound" });

    const input = {
      schema: "agent-relay-mcp-ask.v1",
      requestId,
      title: "Synthetic integration choice",
      question: {
        questionId: "question_mcp_integration_12345678",
        kind: "single-select",
        prompt: "Choose the synthetic integration path.",
        options: [
          {
            optionId: "option_mcp_integration_a_12345678",
            label: "Path A",
          },
          {
            optionId: "option_mcp_integration_b_12345678",
            label: "Path B",
          },
        ],
      },
      expiresInMs: 60_000,
      waitTimeoutMs: 0,
    } as const;
    const firstServer = new RelayMcpServer({
      bindingToken: token,
      machineId,
      bridgeSessionId,
      harness: "codex",
      client,
    });
    await expect(
      firstServer.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "relay_ask", arguments: input },
      }),
    ).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          code: "answer-timeout",
          requestId,
          requestState: "open",
        },
      },
    });
    expect(
      store.getSessionActivity({ machineId, harness: "codex", sessionId }, now),
    ).toMatchObject({
      state: "needs_input",
      requestCount: 1,
    });
    await expect(service.drain()).resolves.toMatchObject({ delivered: 1 });
    expect(transport.deliveries).toHaveLength(1);

    expect(
      store.resolveRequest({
        correlationId: requestId,
        answer: JSON.stringify({
          schema: "agent-interaction-answer.v1",
          answerId: "answer_mcp_integration_12345678",
          requestId,
          submittedAt: now,
          answers: [
            {
              questionId: "question_mcp_integration_12345678",
              kind: "single-select",
              optionId: "option_mcp_integration_a_12345678",
            },
          ],
        }),
        resolvedBy: "web",
        now,
      }),
    ).toMatchObject({ outcome: "answered" });

    const reconnectedServer = new RelayMcpServer({
      bindingToken: token,
      machineId,
      bridgeSessionId,
      harness: "codex",
      client,
    });
    await expect(
      reconnectedServer.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "relay_ask", arguments: input },
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          schema: "agent-relay-mcp-result.v1",
          outcome: "answered",
          requestId,
          answer: {
            schema: "agent-interaction-answer.v1",
            answers: [{ optionId: "option_mcp_integration_a_12345678" }],
          },
        },
      },
    });
    expect(store.getPendingRequest(requestId)).toMatchObject({
      state: "answered",
    });

    httpServer.close();
    await once(httpServer, "close");
    store.close();
  });
});
