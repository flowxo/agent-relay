import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "codex", level: "pass" }),
        expect.objectContaining({ name: "claude", level: "warn" }),
        expect.objectContaining({ name: "cursor", level: "fail" }),
      ]),
    );
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
          contractVersion: "1.0.0-rc.10",
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
});
