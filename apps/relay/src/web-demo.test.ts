import { describe, expect, it } from "vitest";

import {
  FakeTelegramTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

import { makeWebDemoEvents, seedWebDemo } from "./web-demo.js";

describe("credential-free local web demo data", () => {
  it("creates concurrent sanitized lanes without transcript content", async () => {
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport, {
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    const seed = await seedWebDemo(service, {
      now: new Date("2026-07-25T12:00:00.000Z"),
      runId: "synthetic123",
    });

    expect(seed.sessionIds).toHaveLength(4);
    expect(store.listSessions()).toHaveLength(4);
    expect(store.listPendingRequests()).toHaveLength(2);
    expect(transport.deliveries).toHaveLength(4);
    expect(
      new Set(
        store
          .listSessions()
          .map((session) => store.getSessionLaneState(session)),
      ),
    ).toEqual(new Set(["running", "waiting", "crashed"]));
    expect(
      JSON.stringify(makeWebDemoEvents({ runId: "synthetic123" })),
    ).not.toContain("lastAssistantMessage");
    expect(
      JSON.stringify(
        seed.eventIds.map((eventId) => store.getEvent(eventId)?.event),
      ),
    ).not.toContain("private transcript");
    store.close();
  });

  it("rejects unsafe caller-provided run identifiers", () => {
    expect(() => makeWebDemoEvents({ runId: "../../private" })).toThrow(
      "web demo run ID",
    );
  });
});
