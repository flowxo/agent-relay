import {
  RelayService,
  RelayStore,
  TransportError,
  type NotificationTransport,
} from "@agent-relay/core";
import { describe, expect, it } from "vitest";

import {
  buildDaemonTransportStatus,
  classifyNotificationsErrorCode,
} from "./transport-status.js";

describe("safe transport runtime status", () => {
  it.each([
    ["notifications-credential-invalid", "authentication"],
    ["notifications-scope-forbidden", "authorization"],
    ["notifications-stream-identity-failure", "authorization"],
    ["notifications-subscriber-unbound", "configuration"],
    ["notifications-contract-invalid", "contract"],
    ["notifications-stream-order-invalid", "contract"],
    ["notifications-provider-outcome-unknown", "outcome-unknown"],
    ["notifications-provider-terminal", "terminal"],
    ["notifications-request-not-found", "terminal"],
    ["notifications-transport-unavailable", "transient"],
    ["notifications-future-additive-error", "transient"],
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyNotificationsErrorCode(code)).toBe(expected);
  });

  it("reports a classified code and counts without retaining the failure message", async () => {
    const store = new RelayStore();
    const privateFailureText = "private provider diagnostic must not escape";
    const transport: NotificationTransport = {
      name: "notifications",
      deliver: async () => {
        throw new TransportError(
          privateFailureText,
          "notifications-credential-invalid",
          false,
        );
      },
    };
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-26T22:30:00.000Z"),
    });
    service.ingest({
      schema: "agent-attention.v1",
      eventId: "evt_notifications_status_error_12345678",
      occurredAt: "2026-07-26T22:30:00.000Z",
      sequence: 1,
      machineId: "machine_notifications_status_12345678",
      bridgeSessionId: "bridge_notifications_status_12345678",
      harness: "codex",
      surface: "cli",
      harnessVersion: "test",
      sessionId: "session_notifications_status_12345678",
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
        selected: "notifications",
        source: "durable",
      },
    });
    expect(status).toMatchObject({
      selectedTransport: "notifications",
      transportRuntime: {
        notifications: {
          delivery: {
            lastSuccessfulSendAt: null,
            lastError: {
              classification: "authentication",
              code: "notifications-credential-invalid",
            },
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
