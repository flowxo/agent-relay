import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FakeTelegramTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

import { RelayClient } from "./client.js";
import { runHook } from "./hook-runner.js";

const codexStop = JSON.stringify({
  session_id: "codex-hook-session-0001",
  transcript_path: null,
  cwd: "/workspace/example",
  hook_event_name: "Stop",
  turn_id: "codex-hook-turn-0001",
  stop_hook_active: false,
  last_assistant_message: "Synthetic hook completion.",
});

function options(fallbackPath: string) {
  return {
    harness: "codex" as const,
    surface: "cli" as const,
    harnessVersion: "0.145.0",
    raw: codexStop,
    machineId: "machine_hook_12345678",
    bridgeSessionId: "bridge_hook_12345678",
    sequence: 1,
    occurredAt: "2026-07-24T12:00:00.000Z",
    fallbackPath,
  };
}

describe("hook entrypoint", () => {
  it("returns safe native JSON and queues the event through the client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const client = new RelayClient({
      fetch: async (_input, init) => {
        const event = JSON.parse(String(init?.body)) as Parameters<
          typeof service.ingest
        >[0];
        const result = service.ingest(event);
        return new Response(JSON.stringify(result), {
          status: result.inserted ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await runHook({
      ...options(join(directory, "fallback.ndjson")),
      client,
    });
    expect(result).toMatchObject({
      stdout: "{}\n",
      exitCode: 0,
      daemonAccepted: true,
    });
    expect(await service.drain()).toMatchObject({
      delivered: 1,
    });
    store.close();
  });

  it("durably records an event and diagnostic when the daemon is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const fallbackPath = join(directory, "fallback.ndjson");
    const client = new RelayClient({
      fetch: async () => {
        throw new TypeError("synthetic connection refused");
      },
    });
    const result = await runHook({
      ...options(fallbackPath),
      client,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      daemonAccepted: false,
      diagnostic: {
        code: "daemon-ingest-failed",
        fallbackRecorded: true,
      },
    });
    const record = JSON.parse(
      (await readFile(fallbackPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      schema: "agent-relay-fallback.v1",
      kind: "event",
    });
    expect(JSON.stringify(record)).not.toContain(
      "synthetic connection refused",
    );
  });

  it("records malformed input diagnostics without storing raw payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const fallbackPath = join(directory, "fallback.ndjson");
    const result = await runHook({
      ...options(fallbackPath),
      raw: '{"secret":"must-not-be-stored"',
    });
    expect(result.diagnostic).toMatchObject({
      code: "invalid-json",
      fallbackRecorded: true,
    });
    const stored = await readFile(fallbackPath, "utf8");
    expect(stored).not.toContain("must-not-be-stored");
  });

  it("returns the documented inline continuation when a correlated answer wins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    let ingested: Parameters<typeof service.ingest>[0] | undefined;
    const client = new RelayClient({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/events") {
          ingested = JSON.parse(String(init?.body)) as Parameters<
            typeof service.ingest
          >[0];
          const result = service.ingest(ingested);
          return new Response(JSON.stringify(result), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        const correlationId = decodeURIComponent(path.split("/").at(-1) ?? "");
        const request = service.getRequest(correlationId);
        if (request?.state === "open" && ingested !== undefined) {
          service.resolveTerminal({
            correlationId,
            answer: "Continue from the correlated reply",
            expected: {
              machineId: ingested.machineId,
              harness: ingested.harness,
              sessionId: ingested.sessionId,
              ...(ingested.turnId === undefined
                ? {}
                : { turnId: ingested.turnId }),
            },
          });
        }
        return new Response(
          JSON.stringify({
            request: service.getRequest(correlationId),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const result = await runHook({
      ...options(join(directory, "fallback.ndjson")),
      client,
      waitMs: 100,
      pollIntervalMs: 1,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "block",
      reason: "Continue from the correlated reply",
    });
    expect(result).toMatchObject({
      daemonAccepted: true,
      requestState: "answered",
    });
    store.close();
  });

  it("times out safely without inventing an answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport(), {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    const client = new RelayClient({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/events") {
          const result = service.ingest(
            JSON.parse(String(init?.body)) as Parameters<
              typeof service.ingest
            >[0],
          );
          return new Response(JSON.stringify(result), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        const correlationId = decodeURIComponent(path.split("/").at(-1) ?? "");
        return new Response(
          JSON.stringify({
            request: service.getRequest(correlationId),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const result = await runHook({
      ...options(join(directory, "fallback.ndjson")),
      client,
      waitMs: 5,
      pollIntervalMs: 1,
    });

    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result).toMatchObject({
      daemonAccepted: true,
      requestState: "open",
    });
    store.close();
  });

  it("keeps event identity stable across whitespace and timestamp-only retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-hook-"));
    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport());
    const inserted: boolean[] = [];
    const client = new RelayClient({
      fetch: async (_input, init) => {
        const result = service.ingest(
          JSON.parse(String(init?.body)) as Parameters<
            typeof service.ingest
          >[0],
        );
        inserted.push(result.inserted);
        return new Response(JSON.stringify(result), {
          status: result.inserted ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const parsedPayload = JSON.parse(codexStop) as unknown;
    const shared = {
      harness: "codex" as const,
      surface: "cli" as const,
      harnessVersion: "0.145.0",
      machineId: "machine_hook_12345678",
      bridgeSessionId: "bridge_hook_12345678",
      fallbackPath: join(directory, "fallback.ndjson"),
      client,
    };
    const first = await runHook({
      ...shared,
      raw: JSON.stringify(parsedPayload),
      occurredAt: "2026-07-24T12:00:00.000Z",
    });
    const retry = await runHook({
      ...shared,
      raw: JSON.stringify(parsedPayload, null, 2),
      occurredAt: "2026-07-24T12:00:01.000Z",
    });

    expect(retry.eventId).toBe(first.eventId);
    expect(inserted).toEqual([true, false]);
    expect(store.status().events.queued).toBe(1);
    store.close();
  });
});
