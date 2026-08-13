import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSupportedRuntimeObservation,
  type RuntimeSupportObservation,
} from "@agent-relay/harnesses";

import {
  harnessObservationLevel,
  observeHarnessVersions,
  runDoctor,
  TESTED_HARNESS_VERSIONS,
} from "./doctor.js";
import { installAgentRelay } from "./installer.js";

import type { TransportReadinessReport } from "./transport-config.js";

async function executable(directory: string, name: string, version: string) {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' '${version.replaceAll("'", "")}'\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

async function verifiedHarnessExecutables() {
  const directory = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
  return {
    codex: await executable(directory, "codex", TESTED_HARNESS_VERSIONS.codex),
    claude: await executable(
      directory,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    ),
    cursor: await executable(
      directory,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    ),
  };
}

describe("doctor version and installation checks", () => {
  it("reports local MCP availability and fails closed correlation", async () => {
    const executables = await verifiedHarnessExecutables();
    const bound = await runDoctor({
      executables,
      mcp: {
        serverAvailable: true,
        daemonAvailable: true,
        correlationState: "bound",
      },
    });
    expect(bound.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "relay-mcp-server", level: "pass" }),
        expect.objectContaining({
          name: "relay-mcp-correlation",
          level: "pass",
        }),
      ]),
    );

    const pending = await runDoctor({
      executables,
      mcp: {
        serverAvailable: true,
        daemonAvailable: true,
        correlationState: "pending",
      },
    });
    expect(pending.checks).toContainEqual(
      expect.objectContaining({
        name: "relay-mcp-correlation",
        level: "warn",
      }),
    );

    const ambiguous = await runDoctor({
      executables,
      mcp: {
        serverAvailable: true,
        daemonAvailable: true,
        correlationState: "ambiguous",
      },
    });
    expect(ambiguous.healthy).toBe(false);
    expect(ambiguous.checks).toContainEqual(
      expect.objectContaining({
        name: "relay-mcp-correlation",
        level: "fail",
      }),
    );
  });

  it("distinguishes compatible versions, drift, and missing harnesses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const codex = await executable(
      directory,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(directory, "claude", "2.2.0 (Claude Code)");
    const missingCursor = join(directory, "missing-cursor");

    expect(
      observeHarnessVersions({
        codex,
        claude,
        cursor: missingCursor,
      }),
    ).toMatchObject([
      {
        harness: "codex",
        available: true,
        classification: "verified",
        drifted: false,
      },
      {
        harness: "claude",
        available: true,
        classification: "compatible-unverified",
        drifted: true,
      },
      {
        harness: "cursor",
        available: false,
        classification: "unsupported",
        drifted: false,
      },
    ]);
    const report = await runDoctor({
      executables: { codex, claude, cursor: missingCursor },
    });
    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "codex", level: "pass" }),
        expect.objectContaining({ name: "claude", level: "warn" }),
        expect.objectContaining({ name: "cursor", level: "warn" }),
        expect.objectContaining({
          name: "harness-availability",
          level: "pass",
        }),
      ]),
    );
  });

  it("fails when no supported harness executable is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const report = await runDoctor({
      executables: {
        codex: join(directory, "missing-codex"),
        claude: join(directory, "missing-claude"),
        cursor: join(directory, "missing-cursor"),
      },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "harness-availability", level: "fail" }),
    );
  });

  it("does not count a successful empty version probe as a harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const blank = await executable(directory, "blank", "");
    const observations = observeHarnessVersions({
      codex: blank,
      claude: blank,
      cursor: blank,
    });

    expect(observations.every((observation) => !observation.available)).toBe(
      true,
    );
    const report = await runDoctor({
      executables: { codex: blank, claude: blank, cursor: blank },
    });
    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "harness-availability", level: "fail" }),
    );
  });

  it("does not count arbitrary successful output as a harness version", async () => {
    const report = await runDoctor({
      executables: {
        codex: "/bin/echo",
        claude: "/bin/echo",
        cursor: "/bin/echo",
      },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "harness-availability", level: "fail" }),
    );
  });

  it("checks the frozen operating-system, architecture, and Node boundary", async () => {
    const executables = await verifiedHarnessExecutables();
    const supported = await runDoctor({
      executables,
      runtime: {
        platform: "darwin",
        architecture: "arm64",
        nodeVersion: "22.23.1",
      },
    });
    const unsupported = await runDoctor({
      executables,
      runtime: {
        platform: "darwin",
        architecture: "x64",
        nodeVersion: "22.23.1",
      },
    });
    const rosetta = await runDoctor({
      executables,
      runtime: {
        platform: "darwin",
        architecture: "x64",
        nodeVersion: "22.23.1",
        appleSiliconHardware: true,
      },
    });

    expect(supported.checks).toContainEqual(
      expect.objectContaining({ name: "runtime-target", level: "pass" }),
    );
    expect(unsupported.healthy).toBe(false);
    expect(unsupported.checks).toContainEqual(
      expect.objectContaining({ name: "runtime-target", level: "fail" }),
    );
    expect(rosetta.checks).toContainEqual(
      expect.objectContaining({ name: "runtime-target", level: "pass" }),
    );
  });

  it("keeps doctor runtime support equivalent to package proof policy", async () => {
    const policyModulePath = "../../../scripts/lib/release-policy.mjs";
    const { isSupportedReleaseRuntime } = (await import(policyModulePath)) as {
      isSupportedReleaseRuntime: (
        release: Record<string, unknown>,
        observation: RuntimeSupportObservation,
      ) => boolean;
    };
    const release = JSON.parse(
      await readFile(
        new URL("../../../packaging/release.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const observations: RuntimeSupportObservation[] = [
      {
        platform: "darwin",
        architecture: "arm64",
        nodeVersion: "22.23.1",
        appleSiliconHardware: true,
      },
      {
        platform: "darwin",
        architecture: "x64",
        nodeVersion: "22.23.1",
        appleSiliconHardware: true,
      },
      {
        platform: "darwin",
        architecture: "x64",
        nodeVersion: "22.23.1",
        appleSiliconHardware: false,
      },
      {
        platform: "darwin",
        architecture: "arm64",
        nodeVersion: "21.9.0",
        appleSiliconHardware: true,
      },
      {
        platform: "linux",
        architecture: "arm64",
        nodeVersion: "22.23.1",
        appleSiliconHardware: true,
      },
    ];

    for (const observation of observations) {
      expect(isSupportedRuntimeObservation(observation)).toBe(
        isSupportedReleaseRuntime(release, observation),
      );
    }
  });

  it("fails a version recorded as contract-incompatible", () => {
    expect(
      harnessObservationLevel({
        available: true,
        classification: "unsupported",
      }),
    ).toBe("fail");
  });

  it("reports a complete verified-version installation as healthy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const entryPath = join(rootDir, "entry.js");
    await writeFile(entryPath, "process.exitCode = 0;\n", "utf8");
    const codex = await executable(
      rootDir,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(
      rootDir,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    );
    const cursor = await executable(
      rootDir,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    );
    await installAgentRelay({
      rootDir,
      entryPath,
      harnessVersions: TESTED_HARNESS_VERSIONS,
    });

    const report = await runDoctor({
      rootDir,
      executables: { codex, claude, cursor },
    });
    expect(report.healthy).toBe(true);
    expect(report.checks.every((check) => check.level === "pass")).toBe(true);
  });

  it("fails when installed hook version stamps differ from current binaries", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-relay-doctor-"));
    const entryPath = join(rootDir, "entry.js");
    await writeFile(entryPath, "process.exitCode = 0;\n", "utf8");
    const codex = await executable(rootDir, "codex", "codex-cli 0.146.0");
    const claude = await executable(
      rootDir,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    );
    const cursor = await executable(
      rootDir,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    );
    await installAgentRelay({
      rootDir,
      entryPath,
      harnessVersions: TESTED_HARNESS_VERSIONS,
    });

    const report = await runDoctor({
      rootDir,
      executables: { codex, claude, cursor },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "codex-installed-version",
        level: "fail",
      }),
    );
  });

  it("turns an unreadable installation shape into a failed diagnostic", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-relay-doctor-bad-"));
    const oversizedConfig = join(rootDir, ".codex", "hooks.json");
    await mkdir(dirname(oversizedConfig), { recursive: true });
    await writeFile(oversizedConfig, "x".repeat(1024 * 1024 + 1), "utf8");
    const codex = await executable(
      rootDir,
      "codex",
      TESTED_HARNESS_VERSIONS.codex,
    );
    const claude = await executable(
      rootDir,
      "claude",
      TESTED_HARNESS_VERSIONS.claude,
    );
    const cursor = await executable(
      rootDir,
      "cursor",
      TESTED_HARNESS_VERSIONS.cursor,
    );

    const report = await runDoctor({
      rootDir,
      executables: { codex, claude, cursor },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "installation-inspection",
        level: "fail",
        detail: expect.stringContaining("installer limit"),
      }),
    );
  });

  it("reports only safe selected WhooshBang readiness details", async () => {
    const readiness = {
      schema: "agent-relay-transport-readiness.v1",
      selectedTransport: "whooshbang",
      selection: {
        configured: true,
        selected: "whooshbang",
        source: "durable",
        updatedAt: "2026-07-26T22:00:00.000Z",
      },
      transports: {
        fake: { ready: true },
        whooshbang: {
          apiOrigin: "https://whooshbang.example.test",
          binding: "verified-at-connect",
          canaryRef: "canary_safe12",
          configured: true,
          connectionStatus: "active",
          contractVersion: "1.0.0-rc.12",
          credentialPermissions: "pinned-machine-scopes",
          credentialPresent: true,
          environment: "test",
          issueCodes: [],
          machineClientRef: "client_safe12",
          pendingRevocations: 0,
          ready: true,
          resolutionPresentation: "unsupported-in-pinned-contract",
        },
        telegram: {
          configured: "delivery",
          deliveryReady: true,
          issueCodes: [],
          replyReady: false,
          ready: true,
          updateMode: "poll",
          webhookReady: true,
        },
        webhook: {
          configured: false,
          issueCodes: ["webhook-not-configured"],
          ready: false,
          secretPresent: false,
          source: "none",
        },
      },
    } satisfies TransportReadinessReport;
    const report = await runDoctor({
      transportReadiness: readiness,
      executables: await verifiedHarnessExecutables(),
    });
    const serialized = JSON.stringify(report);

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "transport-selection",
          level: "pass",
          detail: "whooshbang selected from durable configuration",
        }),
        expect.objectContaining({
          name: "selected-transport-readiness",
          level: "pass",
        }),
        expect.objectContaining({
          name: "whooshbang-transport",
          level: "pass",
          detail: expect.stringContaining("client_safe12"),
        }),
        expect.objectContaining({
          name: "telegram-transport",
          level: "pass",
        }),
      ]),
    );
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("subscriber");
    expect(serialized).not.toContain("binding_private");
  });

  it("fails doctor when the selected hosted credential is revoked", async () => {
    const readiness = {
      schema: "agent-relay-transport-readiness.v1",
      selectedTransport: "whooshbang",
      selection: {
        configured: true,
        selected: "whooshbang",
        source: "durable",
      },
      transports: {
        fake: { ready: true },
        whooshbang: {
          binding: "inactive",
          configured: true,
          connectionStatus: "revoked",
          credentialPermissions: "inactive",
          credentialPresent: false,
          issueCodes: ["whooshbang-revoked", "whooshbang-credential-missing"],
          pendingRevocations: 0,
          ready: false,
          resolutionPresentation: "unsupported-in-pinned-contract",
        },
        telegram: {
          configured: "none",
          deliveryReady: false,
          issueCodes: [],
          replyReady: false,
          ready: false,
          updateMode: "poll",
          webhookReady: true,
        },
        webhook: {
          configured: false,
          issueCodes: ["webhook-not-configured"],
          ready: false,
          secretPresent: false,
          source: "none",
        },
      },
    } satisfies TransportReadinessReport;
    const report = await runDoctor({
      transportReadiness: readiness,
      executables: await verifiedHarnessExecutables(),
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "selected-transport-readiness",
          level: "fail",
          detail: expect.stringContaining("whooshbang-revoked"),
        }),
        expect.objectContaining({
          name: "whooshbang-transport",
          level: "fail",
        }),
      ]),
    );
  });

  it("proves the running hosted send, poll, acknowledgement, and presentation capability", async () => {
    const readiness = {
      schema: "agent-relay-transport-readiness.v1",
      selectedTransport: "whooshbang",
      selection: {
        configured: true,
        selected: "whooshbang",
        source: "durable",
      },
      transports: {
        fake: { ready: true },
        whooshbang: {
          binding: "verified-at-connect",
          canaryEvidence: {
            committedCursorRef: "cursor_0123456789ab",
            completedAt: "2026-08-10T18:20:02.000Z",
            connectedAt: "2026-08-10T18:00:00.000Z",
            credentialGeneration: 1,
            lastSuccessfulPollAt: "2026-08-10T18:20:01.000Z",
            lastSuccessfulSendAt: "2026-08-10T18:20:00.000Z",
          },
          canaryRef: "canary_safe12",
          configured: true,
          connectionStatus: "active",
          credentialGeneration: 1,
          credentialPermissions: "pinned-machine-scopes",
          credentialPresent: true,
          issueCodes: [],
          pendingRevocations: 0,
          ready: true,
          resolutionPresentation: "unsupported-in-pinned-contract",
        },
        telegram: {
          configured: "none",
          deliveryReady: false,
          issueCodes: [],
          replyReady: false,
          ready: false,
          updateMode: "poll",
          webhookReady: true,
        },
        webhook: {
          configured: false,
          issueCodes: ["webhook-not-configured"],
          ready: false,
          secretPresent: false,
          source: "none",
        },
      },
    } satisfies TransportReadinessReport;
    const report = await runDoctor({
      executables: await verifiedHarnessExecutables(),
      transportReadiness: readiness,
      liveWhooshBang: {
        selectedTransport: "whooshbang",
        runtime: {
          circuit: { blocked: false },
          delivery: {
            lastSuccessfulSendAt: "2026-08-10T18:20:00.000Z",
          },
          polling: {
            committedCursorRef: "cursor_0123456789ab",
            lastSuccessfulPollAt: "2026-08-10T18:20:01.000Z",
            state: "active",
            unacknowledgedEventCount: 0,
          },
          presentation: { capability: "unsupported" },
        },
      },
    });

    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "whooshbang-live-selection",
          level: "pass",
        }),
        expect.objectContaining({
          name: "whooshbang-hosted-canary",
          level: "pass",
        }),
        expect.objectContaining({
          name: "whooshbang-live-send",
          level: "pass",
        }),
        expect.objectContaining({
          name: "whooshbang-live-poll",
          level: "pass",
        }),
        expect.objectContaining({ name: "whooshbang-live-ack", level: "pass" }),
        expect.objectContaining({
          name: "whooshbang-resolution-presentation",
          level: "pass",
          detail: expect.stringContaining("unsupported"),
        }),
      ]),
    );
  });

  it("fails live hosted diagnosis before delivery and acknowledgement are proven", async () => {
    const report = await runDoctor({
      executables: await verifiedHarnessExecutables(),
      liveWhooshBang: {
        selectedTransport: "telegram",
        runtime: {
          circuit: { blocked: true },
          delivery: { lastSuccessfulSendAt: null },
          polling: {
            committedCursorRef: null,
            lastSuccessfulPollAt: null,
            state: "not-started",
            unacknowledgedEventCount: 1,
          },
          presentation: { capability: "not-selected" },
        },
      },
    });

    expect(report.healthy).toBe(false);
    expect(
      report.checks.filter((check) => check.name.startsWith("whooshbang-live")),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "fail" })]),
    );
  });

  it("rejects canary evidence from an older credential generation", async () => {
    const readiness = {
      schema: "agent-relay-transport-readiness.v1",
      selectedTransport: "whooshbang",
      selection: {
        configured: true,
        selected: "whooshbang",
        source: "durable",
      },
      transports: {
        fake: { ready: true },
        whooshbang: {
          binding: "verified-at-connect",
          canaryEvidence: {
            committedCursorRef: "cursor_0123456789ab",
            completedAt: "2026-08-10T18:20:02.000Z",
            connectedAt: "2026-08-10T18:00:00.000Z",
            credentialGeneration: 1,
            lastSuccessfulPollAt: "2026-08-10T18:20:01.000Z",
            lastSuccessfulSendAt: "2026-08-10T18:20:00.000Z",
          },
          canaryRef: "canary_safe12",
          configured: true,
          connectionStatus: "active",
          credentialGeneration: 2,
          credentialPermissions: "pinned-machine-scopes",
          credentialPresent: true,
          issueCodes: [],
          pendingRevocations: 0,
          ready: true,
          resolutionPresentation: "unsupported-in-pinned-contract",
        },
        telegram: {
          configured: "none",
          deliveryReady: false,
          issueCodes: [],
          replyReady: false,
          ready: false,
          updateMode: "poll",
          webhookReady: true,
        },
        webhook: {
          configured: false,
          issueCodes: ["webhook-not-configured"],
          ready: false,
          secretPresent: false,
          source: "none",
        },
      },
    } satisfies TransportReadinessReport;
    const report = await runDoctor({
      executables: await verifiedHarnessExecutables(),
      transportReadiness: readiness,
      liveWhooshBang: {
        selectedTransport: "whooshbang",
        runtime: {
          circuit: { blocked: false },
          delivery: {
            lastSuccessfulSendAt: "2026-08-10T18:21:00.000Z",
          },
          polling: {
            committedCursorRef: "cursor_ffffffffffff",
            lastSuccessfulPollAt: "2026-08-10T18:21:01.000Z",
            state: "active",
            unacknowledgedEventCount: 0,
          },
          presentation: { capability: "unsupported" },
        },
      },
    });

    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "whooshbang-hosted-canary",
        level: "fail",
      }),
    );
  });
});
