import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { makeProjectRef, sha256 } from "@agent-relay/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { RelayStore } from "./store.js";

import type { AgentAttentionEventV1 } from "@agent-relay/protocol";

const occurredAt = "2026-07-26T18:00:00.000Z";
const handledAt = "2026-07-26T18:01:00.000Z";
const expiresAt = "2026-07-26T18:30:00.000Z";
const streamKey = sha256("whooshbang-hosted-test-stream");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function event(suffix: string): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: `event_hosted_store_${suffix}_12345678`,
    occurredAt,
    sequence: 1,
    machineId: "machine_hosted_store_12345678",
    bridgeSessionId: `bridge_hosted_store_${suffix}_12345678`,
    harness: "codex",
    surface: "cli",
    harnessVersion: "test",
    sessionId: `session_hosted_store_${suffix}_12345678`,
    turnId: `turn_hosted_store_${suffix}_12345678`,
    project: makeProjectRef("/workspace/hosted-store-test"),
    type: "input.required",
    request: {
      correlationId: `request_hosted_store_${suffix}_12345678`,
      kind: "select",
      question: "Choose a bounded synthetic option.",
      options: [
        { id: "option_hosted_alpha_12345678", label: "Alpha" },
        { id: "option_hosted_beta_12345678", label: "Beta" },
      ],
      expiresAt,
    },
    capabilities: {
      inlineContinue: true,
      lateResume: true,
      activeSteer: false,
      permissionDecision: true,
    },
  };
}

function deliver(
  store: RelayStore,
  input: AgentAttentionEventV1,
  suffix: string,
  scope = streamKey,
  messageId = `message_hosted_store_${suffix}_12345678`,
): void {
  store.ingestEvent(input);
  const [claimed] = store.claimDueEvents("2026-07-26T18:00:01.000Z", 1);
  if (claimed === undefined) {
    throw new Error("synthetic hosted event was not claimed");
  }
  store.markDelivered(
    input.eventId,
    claimed.attemptNumber,
    "whooshbang",
    messageId,
    "2026-07-26T18:00:02.000Z",
    {
      id: `interaction_hosted_store_${suffix}_12345678`,
      streamKey: scope,
      type: "select",
    },
  );
}

describe("durable hosted interaction authority", () => {
  it("commits resolution before acknowledgement and recovers crash-before-ack exactly once", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-relay-hosted-store-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const input = event("crash");
    let store = new RelayStore(databasePath);
    deliver(store, input, "crash");
    const request = store.getPendingRequest(input.request!.correlationId)!;
    const claim = store.recordHostedEventClaim({
      streamKey,
      eventId: "event_hosted_answer_crash_12345678",
      cursor: "cursor_hosted_answer_crash_12345678",
      payloadHash: sha256("hosted-answer-crash-payload"),
      messageId: "message_hosted_store_crash_12345678",
      interactionId: "interaction_hosted_store_crash_12345678",
      occurredAt: "2026-07-26T18:00:30.000Z",
      handledAt,
      validation: {
        outcome: "ready",
        acknowledgement: "processed",
        resolution: {
          correlationId: request.correlationId,
          answer: "option_hosted_beta_12345678",
          resolvedBy: "whooshbang",
          now: "2026-07-26T18:00:30.000Z",
          expected: {
            machineId: request.machineId,
            harness: request.harness,
            sessionId: request.sessionId,
            ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          },
        },
      },
    });
    expect(claim).toMatchObject({
      outcome: "answered",
      disposition: "processed",
      replayed: false,
    });
    expect(store.getPendingRequest(request.correlationId)).toMatchObject({
      answer: "option_hosted_beta_12345678",
      resolvedBy: "whooshbang",
      state: "answered",
    });
    expect(
      store.recordHostedEventClaim({
        streamKey,
        eventId: claim.eventId,
        cursor: claim.cursor,
        payloadHash: claim.payloadHash,
        messageId: claim.messageId,
        interactionId: claim.interactionId,
        occurredAt: "2026-07-26T18:00:30.000Z",
        handledAt: "2026-07-26T18:01:01.000Z",
        validation: {
          outcome: "duplicate",
          acknowledgement: "processed",
          reasonCode: "already_resolved",
        },
      }),
    ).toMatchObject({
      outcome: "answered",
      replayed: true,
    });
    expect(() =>
      store.recordHostedEventClaim({
        streamKey,
        eventId: claim.eventId,
        cursor: claim.cursor,
        payloadHash: sha256("changed-hosted-answer-crash-payload"),
        messageId: claim.messageId,
        interactionId: claim.interactionId,
        occurredAt: "2026-07-26T18:00:30.000Z",
        handledAt: "2026-07-26T18:01:02.000Z",
        validation: {
          outcome: "duplicate",
          acknowledgement: "processed",
          reasonCode: "already_resolved",
        },
      }),
    ).toThrow("hosted event identity changed after its durable claim");
    expect(
      store.claimHostedAcknowledgement(streamKey, handledAt),
    ).toMatchObject({
      eventId: claim.eventId,
      state: "acknowledging",
      attemptCount: 1,
    });
    store.close();

    store = new RelayStore(databasePath);
    expect(store.recoverHostedInteractionWork("2026-07-26T18:02:00.000Z")).toBe(
      1,
    );
    const recovered = store.claimHostedAcknowledgement(
      streamKey,
      "2026-07-26T18:02:00.000Z",
    );
    expect(recovered).toMatchObject({
      eventId: claim.eventId,
      state: "acknowledging",
      attemptCount: 2,
    });
    store.markHostedAcknowledgementSucceeded({
      streamKey,
      eventId: claim.eventId,
      cursor: claim.cursor,
      disposition: "processed",
      committedCursor: claim.cursor,
      now: "2026-07-26T18:02:01.000Z",
    });
    expect(store.hostedPollStatus(streamKey)).toMatchObject({
      committedCursor: claim.cursor,
      unacknowledgedEventCount: 0,
    });
    expect(store.claimHostedAcknowledgement(streamKey, handledAt)).toBe(
      undefined,
    );
    const messageUpdate = store.claimHostedMessageUpdate(
      streamKey,
      "2026-07-26T18:02:02.000Z",
    );
    expect(messageUpdate).toMatchObject({
      eventId: claim.eventId,
      outcome: "answered",
      resolutionSource: "whooshbang",
      state: "updating",
      attemptCount: 1,
    });
    store.close();
    store = new RelayStore(databasePath);
    expect(store.recoverHostedInteractionWork("2026-07-26T18:02:03.000Z")).toBe(
      1,
    );
    expect(
      store.claimHostedMessageUpdate(streamKey, "2026-07-26T18:02:03.000Z"),
    ).toMatchObject({
      eventId: claim.eventId,
      state: "updating",
      attemptCount: 2,
    });
    store.markHostedMessageUpdateFailed({
      streamKey,
      eventId: claim.eventId,
      errorCode: "whooshbang-provider-retryable",
      retryable: true,
      retryAt: "2026-07-26T18:02:10.000Z",
      now: "2026-07-26T18:02:03.000Z",
    });
    expect(
      store.claimHostedMessageUpdate(streamKey, "2026-07-26T18:02:09.000Z"),
    ).toBeUndefined();
    expect(
      store.claimHostedMessageUpdate(streamKey, "2026-07-26T18:02:10.000Z"),
    ).toMatchObject({
      eventId: claim.eventId,
      state: "updating",
      attemptCount: 3,
    });
    store.markHostedMessageUpdateSucceeded({
      streamKey,
      eventId: claim.eventId,
      now: "2026-07-26T18:02:11.000Z",
    });
    expect(store.getPendingRequest(request.correlationId)).toMatchObject({
      answer: "option_hosted_beta_12345678",
      resolvedBy: "whooshbang",
      state: "answered",
    });
    expect(store.hostedPollStatus(streamKey).messageUpdates).toEqual({
      pending: 0,
      updating: 0,
      retry: 0,
      updated: 1,
      blocked: 0,
    });
    store.close();

    const database = new Database(databasePath, { readonly: true });
    expect(
      database
        .prepare(
          "SELECT state, outcome FROM hosted_message_updates WHERE event_id = ?",
        )
        .get(claim.eventId),
    ).toEqual({ state: "updated", outcome: "answered" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM hosted_event_claims WHERE event_id = ?",
        )
        .get(claim.eventId),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("durably quarantines poison but never acknowledges an integrity stop", () => {
    const store = new RelayStore();
    const quarantineEvent = event("quarantine");
    deliver(store, quarantineEvent, "quarantine");
    expect(
      store.recordHostedEventClaim({
        streamKey,
        eventId: "event_hosted_answer_quarantine_12345678",
        cursor: "cursor_hosted_answer_quarantine_12345678",
        payloadHash: sha256("hosted-answer-quarantine-payload"),
        messageId: "message_hosted_store_quarantine_12345678",
        interactionId: "interaction_hosted_store_quarantine_12345678",
        occurredAt: "2026-07-26T18:00:30.000Z",
        handledAt,
        validation: {
          outcome: "quarantine",
          acknowledgement: "quarantined",
          reasonCode: "invalid_option",
        },
      }),
    ).toMatchObject({
      outcome: "quarantined",
      disposition: "quarantined",
      reasonCode: "invalid_option",
    });
    expect(
      store.getPendingRequest(quarantineEvent.request!.correlationId)?.state,
    ).toBe("open");
    expect(store.getHostedAcknowledgementBarrier(streamKey)).toMatchObject({
      disposition: "quarantined",
      reasonCode: "invalid_option",
    });

    const isolatedStream = sha256("whooshbang-integrity-stop-stream");
    expect(
      store.recordHostedEventClaim({
        streamKey: isolatedStream,
        eventId: "event_hosted_answer_wrong_12345678",
        cursor: "cursor_hosted_answer_wrong_12345678",
        payloadHash: sha256("hosted-answer-wrong-payload"),
        messageId: "message_hosted_store_unknown_12345678",
        interactionId: "interaction_hosted_store_unknown_12345678",
        occurredAt: "2026-07-26T18:00:31.000Z",
        handledAt,
        validation: {
          outcome: "stop",
          acknowledgement: "none",
          reasonCode: "request_not_found",
        },
      }),
    ).toMatchObject({
      outcome: "stopped",
      reasonCode: "request_not_found",
    });
    expect(
      store.getHostedAcknowledgementBarrier(isolatedStream),
    ).toBeUndefined();
    expect(store.hostedPollStatus(isolatedStream)).toMatchObject({
      unacknowledgedEventCount: 0,
    });
    store.close();
  });

  it("projects terminal local outcomes and their resolution source without changing authority", () => {
    const store = new RelayStore();
    const duplicate = event("presentation_duplicate");
    const expired = event("presentation_expired");
    const cancelled = event("presentation_cancelled");
    const unsupported = event("presentation_unsupported");
    for (const [input, suffix] of [
      [duplicate, "presentation_duplicate"],
      [expired, "presentation_expired"],
      [cancelled, "presentation_cancelled"],
    ] as const) {
      deliver(store, input, suffix);
    }
    expect(
      store.resolveRequest({
        correlationId: duplicate.request!.correlationId,
        answer: "option_hosted_alpha_12345678",
        resolvedBy: "terminal",
        now: "2026-07-26T18:01:00.000Z",
      }),
    ).toMatchObject({ outcome: "answered" });
    expect(
      store.cancelRequest(
        cancelled.request!.correlationId,
        "2026-07-26T18:01:01.000Z",
      ),
    ).toMatchObject({ outcome: "cancelled" });
    expect(store.expireRequests("2026-07-26T18:31:00.000Z")).toBe(1);
    deliver(store, unsupported, "presentation_unsupported");

    const claims = [
      {
        local: duplicate,
        suffix: "presentation_duplicate",
        validation: {
          outcome: "duplicate" as const,
          acknowledgement: "processed" as const,
          reasonCode: "already_resolved",
        },
        presentation: "duplicate",
        source: "terminal",
      },
      {
        local: expired,
        suffix: "presentation_expired",
        validation: {
          outcome: "terminal" as const,
          acknowledgement: "processed" as const,
          reasonCode: "locally_expired",
        },
        presentation: "expired",
      },
      {
        local: cancelled,
        suffix: "presentation_cancelled",
        validation: {
          outcome: "terminal" as const,
          acknowledgement: "processed" as const,
          reasonCode: "locally_cancelled",
        },
        presentation: "cancelled",
      },
      {
        local: unsupported,
        suffix: "presentation_unsupported",
        validation: {
          outcome: "quarantine" as const,
          acknowledgement: "quarantined" as const,
          reasonCode: "invalid_option",
        },
        presentation: "unsupported",
      },
    ] as const;
    for (const [index, item] of claims.entries()) {
      const hostedEventId = `event_hosted_${item.suffix}_12345678`;
      store.recordHostedEventClaim({
        streamKey,
        eventId: hostedEventId,
        cursor: `cursor_hosted_presentation_${String(index)}_12345678`,
        payloadHash: sha256(`payload-${item.suffix}`),
        messageId: `message_hosted_store_${item.suffix}_12345678`,
        interactionId: `interaction_hosted_store_${item.suffix}_12345678`,
        occurredAt: "2026-07-26T18:00:30.000Z",
        handledAt,
        validation: item.validation,
      });
      expect(
        store.getHostedMessageUpdate(streamKey, hostedEventId),
      ).toMatchObject({
        outcome: item.presentation,
        ...(!("source" in item) ? {} : { resolutionSource: item.source }),
        state: "pending",
      });
    }
    expect(
      store.getPendingRequest(duplicate.request!.correlationId)?.state,
    ).toBe("answered");
    expect(store.getPendingRequest(expired.request!.correlationId)?.state).toBe(
      "expired",
    );
    expect(
      store.getPendingRequest(cancelled.request!.correlationId)?.state,
    ).toBe("cancelled");
    expect(
      store.getPendingRequest(unsupported.request!.correlationId)?.state,
    ).toBe("open");
    store.close();
  });

  it("scopes provider message identities to the configured machine stream", () => {
    const store = new RelayStore();
    const first = event("scope_first");
    const second = event("scope_second");
    const firstStream = sha256("whooshbang-first-machine-stream");
    const secondStream = sha256("whooshbang-second-machine-stream");
    const sharedMessageId = "message_hosted_shared_12345678";
    deliver(store, first, "scope_first", firstStream, sharedMessageId);
    deliver(store, second, "scope_second", secondStream, sharedMessageId);

    expect(
      store.getHostedDeliveryForMessage(firstStream, sharedMessageId),
    ).toMatchObject({ eventId: first.eventId });
    expect(
      store.getHostedDeliveryForMessage(secondStream, sharedMessageId),
    ).toMatchObject({ eventId: second.eventId });
    store.close();
  });
});
