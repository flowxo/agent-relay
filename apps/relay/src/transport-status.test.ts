import { RelayService, RelayStore } from "@agent-relay/core";
import {
  TransportError,
  type NotificationTransport,
} from "@agent-relay/notification-contracts";
import { describe, expect, it } from "vitest";

import {
  buildDaemonTransportStatus,
  classifyWhooshBangErrorCode,
  classifyWebhookErrorCode,
} from "./transport-status.js";

describe("safe transport runtime status", () => {
  it.each([
    ["whooshbang-credential-invalid", "authentication"],
    ["whooshbang-scope-forbidden", "authorization"],
    ["whooshbang-stream-identity-failure", "authorization"],
    ["whooshbang-subscriber-unbound", "configuration"],
    ["whooshbang-connection-inactive", "configuration"],
    ["whooshbang-contract-invalid", "contract"],
    ["whooshbang-protocol-malformed", "contract"],
    ["whooshbang-stream-order-invalid", "contract"],
    ["whooshbang-provider-outcome-unknown", "outcome-unknown"],
    ["whooshbang-provider-terminal", "terminal"],
    ["whooshbang-request-not-found", "terminal"],
    ["whooshbang-resolution-update-unsupported", "terminal"],
    ["whooshbang-transport-unavailable", "transient"],
    ["whooshbang-future-additive-error", "transient"],
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyWhooshBangErrorCode(code)).toBe(expected);
  });

  it.each([
    ["webhook-timeout", "retryable"],
    ["webhook-network-failure", "retryable"],
    ["webhook-http-408", "retryable"],
    ["webhook-http-429", "retryable"],
    ["webhook-http-503", "retryable"],
    ["webhook-http-400", "terminal"],
    ["webhook-redirect-refused", "terminal"],
    ["webhook-ack-invalid", "terminal"],
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyWebhookErrorCode(code)).toBe(expected);
  });

  it("reports a classified code and counts without retaining the failure message", async () => {
    const store = new RelayStore();
    const privateFailureText = "private provider diagnostic must not escape";
    const transport: NotificationTransport = {
      name: "whooshbang",
      deliver: async () => {
        throw new TransportError(
          privateFailureText,
          "whooshbang-credential-invalid",
          false,
        );
      },
    };
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-26T22:30:00.000Z"),
    });
    service.ingest({
      schema: "agent-attention.v1",
      eventId: "evt_whooshbang_status_error_12345678",
      occurredAt: "2026-07-26T22:30:00.000Z",
      sequence: 1,
      machineId: "machine_whooshbang_status_12345678",
      bridgeSessionId: "bridge_whooshbang_status_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_whooshbang_status_12345678",
      project: {
        displayName: "synthetic-status",
        cwdHash: `sha256:${"d".repeat(64)}`,
      },
      type: "turn.stopped",
      summary: "Synthetic status failure",
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    });
    await expect(service.drain()).resolves.toMatchObject({
      deadLettered: 1,
    });

    const status = buildDaemonTransportStatus({
      service,
      selection: {
        configured: true,
        selected: "whooshbang",
        source: "durable",
      },
    });
    expect(status).toMatchObject({
      selectedTransport: "whooshbang",
      transportRuntime: {
        whooshbang: {
          delivery: {
            lastSuccessfulSendAt: null,
            lastError: {
              category: "terminal-configuration",
              classification: "authentication",
              code: "whooshbang-credential-invalid",
            },
          },
          presentation: {
            capability: "not-selected",
            blocked: 0,
            pending: 0,
            retrying: 0,
            updated: 0,
            lastError: null,
          },
          spool: {
            deadLetter: 1,
            pending: 0,
            retrying: 0,
          },
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain(privateFailureText);
    store.close();
  });
});
