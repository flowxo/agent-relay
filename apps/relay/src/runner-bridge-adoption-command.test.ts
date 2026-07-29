import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RelayStore } from "@agent-relay/core";
import type { AgentAttentionEventV1 } from "@agent-relay/protocol";
import {
  makeProjectRef,
  sha256 as protocolSha256,
} from "@agent-relay/protocol";
import {
  canonicalJson,
  RunnerBridgeStore,
  sha256,
  type SessionAdoptionRequest,
} from "@agent-relay/runner-bridge";

import {
  LocalRunnerBridgeAdoptionServer,
  runRunnerBridgeAdoptionStdio,
  type LocalRequest,
} from "./runner-bridge-adoption-command.js";
import {
  runnerBridgePaths,
  writeRunnerBridgeConfiguration,
} from "./runner-bridge-config.js";
import { RelayStoreSessionAuthority } from "./runner-bridge-session-authority.js";

const directories: string[] = [];
const capabilitySnapshotDigest = sha256("product-capability-snapshot");
const capabilities = {
  inlineContinue: true,
  lateResume: true,
  activeSteer: false,
  permissionDecision: true,
};
const fixedNow = new Date("2026-07-28T12:02:00.000Z");

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "relay-adoption-command-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function nativeEvent(
  projectPath: string,
  overrides: Partial<AgentAttentionEventV1> = {},
): AgentAttentionEventV1 {
  return {
    schema: "agent-attention.v1",
    eventId: "evt_local_adoption_0001",
    occurredAt: "2026-07-28T12:00:00.000Z",
    sequence: 4,
    machineId: "machine_local_adoption",
    bridgeSessionId: "bridge_local_adoption",
    harness: "codex",
    surface: "cli",
    harnessVersion: "0.145.0",
    sessionId: "native_local_adoption",
    project: makeProjectRef(projectPath),
    type: "turn.stopped",
    capabilities,
    ...overrides,
  };
}

async function seed(
  directory: string,
  input: { readonly enabled?: boolean; readonly projectPath?: string } = {},
): Promise<AgentAttentionEventV1> {
  const enabled = input.enabled ?? true;
  const projectPath = input.projectPath ?? "/workspace/local-adoption";
  await writeRunnerBridgeConfiguration(
    runnerBridgePaths(directory).configuration,
    enabled,
    fixedNow,
  );
  const event = nativeEvent(projectPath);
  const core = new RelayStore(join(directory, "relay.sqlite"));
  core.ingestEvent(event);
  core.close();
  const bridge = new RunnerBridgeStore(runnerBridgePaths(directory).database);
  bridge.saveAuthority({
    workspaceId: "wsp_local_adoption",
    runnerId: "run_local_adoption",
    identityFingerprint: `sha256:${"a".repeat(64)}`,
    revocationEpoch: 0,
    capabilitySnapshotDigest,
    capabilities: [],
    state: "ready",
    updatedAt: fixedNow.toISOString(),
  });
  bridge.close();
  return event;
}

function request(
  type: LocalRequest["type"],
  payload: Readonly<Record<string, unknown>>,
  requestId = `request_${type.replaceAll(".", "_")}`,
): LocalRequest {
  return {
    schema: "runner.session-adoption/local-v1",
    requestId,
    type,
    payload,
  };
}

function offer(projectPath: string) {
  return {
    schema: "runner.session-adoption/offer-v1" as const,
    adoptionId: "adoption_local_command",
    issuedAt: "2026-07-28T12:01:00.000Z",
    expiresAt: "2026-07-28T12:10:00.000Z",
    workspaceId: "wsp_local_adoption",
    runnerId: "run_local_adoption",
    projectId: "prj_local_adoption",
    productSessionId: "ses_local_adoption",
    aggregateRevision: 0 as const,
    harnessProfileId: "hpf_codex_app_server_0_145_0",
    capabilitySnapshotDigest,
    projectCwdHash: `sha256:${protocolSha256(projectPath)}`,
  };
}

describe("local runner bridge adoption command", () => {
  it("lists a privacy-safe candidate, commits once, and recovers idempotently", async () => {
    const directory = await temporaryDirectory();
    const projectPath = "/workspace/local-adoption";
    const event = await seed(directory, { projectPath });
    const server = new LocalRunnerBridgeAdoptionServer({
      stateDirectory: directory,
      now: () => fixedNow,
    });

    await expect(
      server.handle(request("adoption.status", {})),
    ).resolves.toMatchObject({
      type: "adoption.status",
      payload: { status: "ready" },
    });
    const listed = await server.handle(
      request("candidate.list", {
        projectCwdHash: offer(projectPath).projectCwdHash,
      }),
    );
    expect(listed).toMatchObject({
      type: "candidate.listed",
      payload: {
        candidates: [
          {
            projectName: "local-adoption",
            harness: "codex",
            surface: "cli",
            harnessVersion: "0.145.0",
            state: "waiting",
          },
        ],
      },
    });
    const encodedList = JSON.stringify(listed);
    for (const hidden of [
      event.machineId,
      event.bridgeSessionId,
      event.sessionId,
      event.project.cwdHash,
      capabilitySnapshotDigest,
    ]) {
      expect(encodedList).not.toContain(hidden);
    }
    const candidates = listed.payload["candidates"] as Array<{
      selectionKey: string;
    }>;
    const productOffer = offer(projectPath);
    const committed = await server.handle(
      request("adoption.commit", {
        standaloneSelectionKey: candidates[0]?.selectionKey,
        offer: productOffer,
        offerFingerprint: sha256(canonicalJson(productOffer)),
      }),
    );
    expect(committed).toMatchObject({
      type: "adoption.complete",
      payload: { duplicate: false },
    });

    const recovered = await new LocalRunnerBridgeAdoptionServer({
      stateDirectory: directory,
      now: () => fixedNow,
    }).handle(
      request("adoption.recover", {
        offer: productOffer,
        offerFingerprint: sha256(canonicalJson(productOffer)),
      }),
    );
    expect(recovered).toMatchObject({
      type: "adoption.complete",
      payload: { duplicate: true },
    });

    const core = new RelayStore(join(directory, "relay.sqlite"));
    expect(
      core.sessionActuatorOwner({
        machineId: event.machineId,
        harness: event.harness,
        sessionId: event.sessionId,
      }),
    ).toBe("product-managed");
    core.close();
    const bridge = new RunnerBridgeStore(runnerBridgePaths(directory).database);
    expect(bridge.binding(productOffer.productSessionId)).toMatchObject({
      actuatorOwner: "product-managed",
      nativeSessionReference: event.sessionId,
    });
    bridge.close();
  });

  it("invalidates changed, substituted, and expired process-local handles", async () => {
    const directory = await temporaryDirectory();
    const projectPath = "/workspace/local-adoption";
    const event = await seed(directory, { projectPath });
    let now = fixedNow;
    const server = new LocalRunnerBridgeAdoptionServer({
      stateDirectory: directory,
      now: () => now,
    });
    const listed = await server.handle(
      request("candidate.list", {
        projectCwdHash: offer(projectPath).projectCwdHash,
      }),
    );
    const candidates = listed.payload["candidates"] as Array<{
      selectionKey: string;
    }>;
    const productOffer = offer(projectPath);
    await expect(
      server.handle(
        request("adoption.commit", {
          standaloneSelectionKey: "selection_substitution_attempt",
          offer: productOffer,
          offerFingerprint: sha256(canonicalJson(productOffer)),
        }),
      ),
    ).resolves.toMatchObject({
      type: "adoption.rejected",
      payload: { safeCode: "candidate_not_found" },
    });

    const core = new RelayStore(join(directory, "relay.sqlite"));
    core.ingestEvent({
      ...event,
      eventId: "evt_local_adoption_0002",
      occurredAt: "2026-07-28T12:03:00.000Z",
      sequence: 5,
      type: "turn.started",
    });
    core.close();
    await expect(
      server.handle(
        request("adoption.commit", {
          standaloneSelectionKey: candidates[0]?.selectionKey,
          offer: productOffer,
          offerFingerprint: sha256(canonicalJson(productOffer)),
        }),
      ),
    ).resolves.toMatchObject({
      type: "adoption.rejected",
      payload: { safeCode: "candidate_changed" },
    });

    const relisted = await server.handle(
      request("candidate.list", {
        projectCwdHash: offer(projectPath).projectCwdHash,
      }),
    );
    const relistedCandidates = relisted.payload["candidates"] as Array<{
      selectionKey: string;
    }>;
    now = new Date("2026-07-28T12:20:00.000Z");
    await expect(
      server.handle(
        request("adoption.commit", {
          standaloneSelectionKey: relistedCandidates[0]?.selectionKey,
          offer: productOffer,
          offerFingerprint: sha256(canonicalJson(productOffer)),
        }),
      ),
    ).resolves.toMatchObject({
      type: "adoption.rejected",
      payload: { safeCode: "candidate_not_found" },
    });
  });

  it("recovers forward after the exact claim outlives its offer", async () => {
    const directory = await temporaryDirectory();
    const projectPath = "/workspace/local-adoption";
    const event = await seed(directory, { projectPath });
    const productOffer = offer(projectPath);
    const core = new RelayStore(join(directory, "relay.sqlite"));
    const checkpoint = core.inspectSessionAdoptionCandidate({
      machineId: event.machineId,
      nativeSessionReference: event.sessionId,
      projectCwdHash: productOffer.projectCwdHash,
      harnessVersion: event.harnessVersion,
    });
    if (checkpoint === undefined) {
      throw new Error("Generated adoption checkpoint is missing");
    }
    const adoption: SessionAdoptionRequest = {
      schema: "agent-relay-session-adoption.v1",
      adoptionId: productOffer.adoptionId,
      issuedAt: productOffer.issuedAt as SessionAdoptionRequest["issuedAt"],
      expiresAt: productOffer.expiresAt as SessionAdoptionRequest["expiresAt"],
      machineId: checkpoint.machineId,
      harness: checkpoint.harness,
      surface: checkpoint.surface,
      harnessVersion: checkpoint.harnessVersion,
      nativeSessionReference: checkpoint.nativeSessionReference,
      bridgeSessionId: checkpoint.bridgeSessionId,
      expectedSequence: checkpoint.expectedSequence,
      projectAuthorityDigest: checkpoint.projectAuthorityDigest,
      standaloneCapabilityDigest:
        checkpoint.standaloneCapabilityDigest as SessionAdoptionRequest["standaloneCapabilityDigest"],
      standaloneCapabilityEvidenceId: "codex-cli-0.145.0-2026-07-25",
      workspaceId: productOffer.workspaceId,
      runnerId: productOffer.runnerId,
      projectId: productOffer.projectId,
      productSessionId: productOffer.productSessionId,
      aggregateRevision: productOffer.aggregateRevision,
      harnessProfileId: productOffer.harnessProfileId,
      capabilitySnapshotDigest:
        productOffer.capabilitySnapshotDigest as SessionAdoptionRequest["capabilitySnapshotDigest"],
    };
    const fingerprint = sha256(canonicalJson(adoption));
    const bridge = new RunnerBridgeStore(runnerBridgePaths(directory).database);
    bridge.putBinding({
      workspaceId: adoption.workspaceId,
      runnerId: adoption.runnerId,
      projectId: adoption.projectId,
      sessionId: adoption.productSessionId,
      harnessProfileId: adoption.harnessProfileId,
      nativeSessionReference: adoption.nativeSessionReference,
      capabilitySnapshotDigest: adoption.capabilitySnapshotDigest,
      actuatorOwner: "standalone-attention",
      aggregateRevision: adoption.aggregateRevision,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    });
    bridge.proposeAdoption({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      requestJson: canonicalJson(adoption),
      state: "proposed",
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    });
    const authority = new RelayStoreSessionAuthority(core);
    await authority.claim({
      adoptionId: adoption.adoptionId,
      requestFingerprint: fingerprint,
      machineId: adoption.machineId,
      harness: adoption.harness,
      surface: adoption.surface,
      nativeSessionReference: adoption.nativeSessionReference,
      bridgeSessionId: adoption.bridgeSessionId,
      expectedSequence: adoption.expectedSequence,
      projectAuthorityDigest: adoption.projectAuthorityDigest,
      standaloneCapabilityDigest: adoption.standaloneCapabilityDigest,
      harnessVersion: adoption.harnessVersion,
      productSessionId: adoption.productSessionId,
      claimedAt: fixedNow.toISOString() as SessionAdoptionRequest["issuedAt"],
    });
    bridge.transitionAdoption(
      adoption.adoptionId,
      "proposed",
      "standalone_claimed",
      fixedNow.toISOString(),
    );
    bridge.close();
    core.close();

    const expired = new LocalRunnerBridgeAdoptionServer({
      stateDirectory: directory,
      now: () => new Date("2026-07-28T13:00:00.000Z"),
    });
    await expect(
      expired.handle(request("adoption.status", {})),
    ).resolves.toMatchObject({
      payload: {
        status: "recovery_required",
        safeCode: "recovery_required",
      },
    });
    await expect(
      expired.handle(
        request("adoption.recover", {
          offer: productOffer,
          offerFingerprint: sha256(canonicalJson(productOffer)),
        }),
      ),
    ).resolves.toMatchObject({
      type: "adoption.complete",
      payload: { duplicate: true },
    });
  });

  it("reports disabled state without creating or widening authority", async () => {
    const directory = await temporaryDirectory();
    await writeRunnerBridgeConfiguration(
      runnerBridgePaths(directory).configuration,
      false,
      fixedNow,
    );
    const server = new LocalRunnerBridgeAdoptionServer({
      stateDirectory: directory,
      now: () => fixedNow,
    });
    await expect(
      server.handle(request("adoption.status", {})),
    ).resolves.toMatchObject({
      type: "adoption.status",
      payload: {
        status: "unavailable",
        safeCode: "agent_relay_bridge_disabled",
      },
    });
    await expect(
      server.handle(
        request("candidate.list", {
          projectCwdHash: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).resolves.toMatchObject({
      type: "candidate.listed",
      payload: { candidates: [] },
    });
  });
});

describe("local runner bridge adoption stdio", () => {
  it("uses strict bounded newline-delimited JSON", async () => {
    const directory = await temporaryDirectory();
    const outputs: string[] = [];
    const document = `${JSON.stringify(
      request("adoption.status", {}, "request_stdio_status"),
    )}\n`;
    await runRunnerBridgeAdoptionStdio({
      stateDirectory: directory,
      input: (async function* () {
        yield Buffer.from(document);
      })(),
      write: (value) => {
        outputs.push(value);
      },
      now: () => fixedNow,
    });
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0] ?? "")).toMatchObject({
      schema: "runner.session-adoption/local-v1",
      requestId: "request_stdio_status",
      type: "adoption.status",
    });

    await expect(
      runRunnerBridgeAdoptionStdio({
        stateDirectory: directory,
        input: (async function* () {
          yield Uint8Array.from([0xff, 0x0a]);
        })(),
        write: () => undefined,
      }),
    ).rejects.toThrow("not UTF-8");
    await expect(
      runRunnerBridgeAdoptionStdio({
        stateDirectory: directory,
        input: (async function* () {
          yield JSON.stringify(
            request("adoption.status", {}, "request_trailing_data"),
          );
        })(),
        write: () => undefined,
      }),
    ).rejects.toThrow("trailing data");
  });
});
