import { appendFile, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FakeTelegramTransport,
  MemoryLogger,
  RelayService,
  RelayStore,
} from "@agent-relay/core";
import type {
  AgentAttentionEventV1,
  RelayDiagnosticV1,
} from "@agent-relay/protocol";
import { makeProjectRef } from "@agent-relay/protocol";

import { appendFallbackRecord, replayFallbackSpool } from "./fallback-spool.js";
import type { FallbackReplayClient } from "./fallback-spool.js";
import { startDaemon } from "./daemon.js";

function event(
  eventId = "evt_fallback_replay_12345678",
  summary = "Synthetic fallback event",
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId,
    occurredAt: "2026-07-24T12:00:00.000Z",
    sequence: 1,
    machineId: "machine_fallback_12345678",
    bridgeSessionId: "bridge_fallback_12345678",
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: "session_fallback_12345678",
    project: makeProjectRef("/workspace/fallback"),
    type: "turn.stopped",
    summary,
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function serviceClient(service: RelayService): FallbackReplayClient {
  return {
    ingest: async (input) => service.ingest(input),
    reportDiagnostic: async (diagnostic) =>
      service.reportDiagnostic(diagnostic),
  };
}

describe("fallback spool replay", () => {
  it("redacts records and rotates into lossless segments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-fallback-"));
    const spoolPath = join(directory, "fallback.ndjson");
    const secret = "sk-syntheticSecretToken123456789";
    const record = {
      schema: "agent-relay-fallback.v1" as const,
      recordedAt: "2026-07-24T12:00:00.000Z",
      kind: "event" as const,
      payload: event(
        "evt_fallback_rotate_12345678",
        `${secret} ${"x".repeat(1_800)}`,
      ),
    };

    await appendFallbackRecord(spoolPath, record, {
      maxRecordBytes: 4_096,
      maxSegmentBytes: 4_096,
    });
    await appendFallbackRecord(spoolPath, record, {
      maxRecordBytes: 4_096,
      maxSegmentBytes: 4_096,
    });

    const names = await readdir(directory);
    expect(
      names.some((name) => name.startsWith("fallback.ndjson.segment-")),
    ).toBe(true);
    const stored = await Promise.all(
      names
        .filter((name) => !name.endsWith(".lock"))
        .map(async (name) => await readFile(join(directory, name), "utf8")),
    );
    expect(stored.join("")).not.toContain(secret);
    expect(stored.join("")).toContain("[REDACTED_OPENAI_KEY]");
  });

  it("replays events and parser failures idempotently into SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-fallback-"));
    const spoolPath = join(directory, "fallback.ndjson");
    const store = new RelayStore();
    const transport = new FakeTelegramTransport();
    const service = new RelayService(store, transport);
    const input = event();

    for (let index = 0; index < 2; index += 1) {
      await appendFallbackRecord(spoolPath, {
        schema: "agent-relay-fallback.v1",
        recordedAt: "2026-07-24T12:00:00.000Z",
        kind: "event",
        payload: input,
      });
    }
    await appendFallbackRecord(spoolPath, {
      schema: "agent-relay-fallback.v1",
      recordedAt: "2026-07-24T12:00:01.000Z",
      kind: "diagnostic",
      payload: {
        code: "invalid-hook-payload",
        message: "Synthetic parser failure",
      },
    });
    await appendFile(spoolPath, "{not-json}\n", "utf8");

    const replay = await replayFallbackSpool(spoolPath, serviceClient(service));
    expect(replay).toMatchObject({
      filesClaimed: 1,
      filesCompleted: 1,
      filesPending: 0,
      records: 4,
      events: 2,
      diagnostics: 2,
      malformed: 1,
      failures: [],
    });
    expect(store.status()).toMatchObject({
      events: { queued: 1 },
      diagnostics: { error: 2, total: 2 },
    });
    expect(await service.drain()).toMatchObject({ delivered: 1 });
    expect(transport.deliveries).toHaveLength(1);
    expect(
      await replayFallbackSpool(spoolPath, serviceClient(service)),
    ).toMatchObject({ filesClaimed: 0, records: 0 });
    store.close();
  });

  it("retains only failed lines and recovers on the next replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-fallback-"));
    const spoolPath = join(directory, "fallback.ndjson");
    const input = event("evt_fallback_retry_12345678");
    await appendFallbackRecord(spoolPath, {
      schema: "agent-relay-fallback.v1",
      recordedAt: "2026-07-24T12:00:00.000Z",
      kind: "event",
      payload: input,
    });
    await appendFallbackRecord(spoolPath, {
      schema: "agent-relay-fallback.v1",
      recordedAt: "2026-07-24T12:00:01.000Z",
      kind: "diagnostic",
      payload: {
        code: "synthetic-diagnostic",
        message: "This line should succeed",
      },
    });

    const diagnostics: RelayDiagnosticV1[] = [];
    const unavailable: FallbackReplayClient = {
      ingest: async () => {
        throw new Error("synthetic daemon unavailable");
      },
      reportDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    };
    const first = await replayFallbackSpool(spoolPath, unavailable);
    expect(first).toMatchObject({
      filesPending: 1,
      events: 0,
      diagnostics: 1,
      records: 2,
    });
    expect(first.failures[0]).toMatchObject({
      line: 1,
      code: "replay-send-failed",
    });
    expect(diagnostics).toHaveLength(1);

    const store = new RelayStore();
    const service = new RelayService(store, new FakeTelegramTransport());
    const second = await replayFallbackSpool(spoolPath, serviceClient(service));
    expect(second).toMatchObject({
      filesCompleted: 1,
      filesPending: 0,
      records: 1,
      events: 1,
      diagnostics: 0,
    });
    expect(store.getEvent(input.eventId)).toBeDefined();
    store.close();
  });

  it("isolates concurrent replay workers with atomic file claims", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const directory = await mkdtemp(
          join(tmpdir(), "agent-relay-fallback-"),
        );
        const spoolPath = join(directory, "fallback.ndjson");
        await appendFallbackRecord(spoolPath, {
          schema: "agent-relay-fallback.v1",
          recordedAt: "2026-07-24T12:00:00.000Z",
          kind: "event",
          payload: event(
            `evt_fallback_concurrent_${String(index).padStart(8, "0")}`,
          ),
        });
        const store = new RelayStore();
        const service = new RelayService(store, new FakeTelegramTransport());
        try {
          const [first, second] = await Promise.all([
            replayFallbackSpool(spoolPath, serviceClient(service)),
            replayFallbackSpool(spoolPath, serviceClient(service)),
          ]);
          return {
            filesClaimed: first.filesClaimed + second.filesClaimed,
            events: first.events + second.events,
            queued: store.status().events.queued,
          };
        } finally {
          store.close();
        }
      }),
    );

    expect(outcomes).toEqual(
      Array.from({ length: 8 }, () => ({
        filesClaimed: 1,
        events: 1,
        queued: 1,
      })),
    );
  });

  it("automatically replays the offline spool when the daemon starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-fallback-"));
    const spoolPath = join(directory, "fallback.ndjson");
    const databasePath = join(directory, "relay.sqlite");
    const input = event("evt_fallback_daemon_start_12345678");
    await appendFallbackRecord(spoolPath, {
      schema: "agent-relay-fallback.v1",
      recordedAt: "2026-07-24T12:00:00.000Z",
      kind: "event",
      payload: input,
    });

    const daemon = await startDaemon({
      databasePath,
      host: "127.0.0.1",
      port: 0,
      fallbackPath: spoolPath,
      fallbackReplayIntervalMs: 60_000,
      logger: new MemoryLogger(),
    });
    expect(daemon.initialFallbackReplay).toMatchObject({
      records: 1,
      events: 1,
      filesCompleted: 1,
    });
    expect(daemon.service.store.getEvent(input.eventId)).toBeDefined();
    await daemon.close();
  });
});
