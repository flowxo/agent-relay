import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  capabilityFor,
  classifyObservedHarnessVersion,
  HARNESS_CAPABILITIES,
  HARNESS_COMPATIBILITY,
  PUBLIC_COMPATIBILITY_RECORD,
  VERIFIED_CLI_HARNESS_EVIDENCE,
} from "./capabilities.js";
import { renderStopContinuation } from "./continuation.js";
import { parseHarnessJson } from "./parsers.js";
import { buildLateResumeInvocation, deriveLateResumePolicy } from "./resume.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

function fixture(path: string): string {
  return readFileSync(join(fixtures, path), "utf8");
}

function context(
  surface: "cli" | "ide" = "cli",
  harnessVersion = "test-version",
) {
  return {
    machineId: "machine_12345678",
    bridgeSessionId: "bridge_12345678",
    harnessVersion,
    surface,
    sequence: 1,
    occurredAt: "2026-07-24T12:00:00.000Z",
  } as const;
}

describe.each([
  ["codex", "codex/stop.json", "cli"],
  ["claude", "claude/stop.json", "cli"],
  ["cursor", "cursor/stop.json", "cli"],
] as const)("%s stop contract", (harness, path, surface) => {
  it("normalizes the sanitized official fixture", () => {
    const result = parseHarnessJson(harness, fixture(path), context(surface));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.harness).toBe(harness);
      expect(result.event.type).toBe("turn.stopped");
      expect(result.event.project.cwdHash).toMatch(/^sha256:/);
      expect(JSON.stringify(result.event)).not.toContain("/workspace/example");
    }
  });

  it("renders the documented native continuation output", () => {
    const output = renderStopContinuation(harness, "Continue from Telegram");
    expect(output.stdout).toEqual(
      harness === "cursor"
        ? { followup_message: "Continue from Telegram" }
        : { decision: "block", reason: "Continue from Telegram" },
    );
  });
});

describe("Claude structured background-work Stop contract", () => {
  it("keeps the lane active and retains only bounded counts", () => {
    const raw = fixture("claude/stop-background-work.json");
    const result = parseHarnessJson("claude", raw, context());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        type: "turn.activity",
        summary: "Background work continues: 1 in flight, 1 scheduled",
        backgroundWork: {
          inFlightCount: 1,
          scheduledCount: 1,
        },
      });
      expect(result.event).not.toHaveProperty("lastAssistantMessage");
      const normalized = JSON.stringify(result.event);
      expect(normalized).not.toContain("task-synthetic-0001");
      expect(normalized).not.toContain("synthetic-reviewer");
      expect(normalized).not.toContain("synthetic scheduled check");
      expect(normalized).not.toContain("A final review is still running");
    }
  });

  it("preserves ordinary Stop behavior for empty or missing collections", () => {
    const withEmptyCollections = JSON.parse(
      fixture("claude/stop.json"),
    ) as Record<string, unknown>;
    withEmptyCollections["background_tasks"] = [];
    withEmptyCollections["session_crons"] = [];

    for (const raw of [
      fixture("claude/stop.json"),
      JSON.stringify(withEmptyCollections),
    ]) {
      const result = parseHarnessJson("claude", raw, context());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.type).toBe("turn.stopped");
        expect(result.event.backgroundWork).toBeUndefined();
      }
    }
  });

  it("diagnoses malformed or oversized collections instead of guessing", () => {
    const base = JSON.parse(fixture("claude/stop.json")) as Record<
      string,
      unknown
    >;
    for (const background_tasks of [
      "not-an-array",
      Array.from({ length: 1_001 }, () => null),
    ]) {
      const result = parseHarnessJson(
        "claude",
        JSON.stringify({ ...base, background_tasks }),
        context(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          code: "malformed-payload",
          safeBehavior: "native-prompt",
        });
      }
    }
  });
});

describe.each([
  ["codex", "codex/session-start.json"],
  ["claude", "claude/session-start.json"],
] as const)("%s session lifecycle contract", (harness, path) => {
  it("normalizes a sanitized session-open event without transcript data", () => {
    const result = parseHarnessJson(harness, fixture(path), context());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        harness,
        type: "session.started",
        summary: "Session opened (resume).",
      });
      expect(JSON.stringify(result.event)).not.toContain("transcript");
    }
  });
});

describe.each([
  [
    "codex",
    "codex/user-prompt-submit.json",
    "SYNTHETIC_PRIVATE_CODEX_PROMPT_MUST_NOT_PERSIST",
  ],
  [
    "claude",
    "claude/user-prompt-submit.json",
    "SYNTHETIC_PRIVATE_CLAUDE_PROMPT_MUST_NOT_PERSIST",
  ],
] as const)(
  "%s prompt-submit lifecycle contract",
  (harness, path, privatePrompt) => {
    it("marks the turn working without retaining the operator prompt", () => {
      const result = parseHarnessJson(harness, fixture(path), context());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event).toMatchObject({
          harness,
          type: "turn.started",
          summary: "Operator submitted a prompt; the agent is working.",
        });
        expect(JSON.stringify(result.event)).not.toContain(privatePrompt);
      }
    });

    it("rejects a malformed lifecycle payload instead of guessing", () => {
      const payload = JSON.parse(fixture(path)) as Record<string, unknown>;
      delete payload["prompt"];
      const result = parseHarnessJson(
        harness,
        JSON.stringify(payload),
        context(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          code: "malformed-payload",
          safeBehavior: "native-prompt",
        });
        expect(result.diagnostic.issues).toContainEqual(
          expect.objectContaining({ path: "prompt" }),
        );
      }
    });
  },
);

describe("failure and diagnostic contracts", () => {
  it("normalizes Claude StopFailure without claiming a process crash", () => {
    const result = parseHarnessJson(
      "claude",
      fixture("claude/stop-failure.json"),
      context(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("turn.failed");
      expect(result.event.failure?.class).toBe("rate_limit");
    }
  });

  it("returns field-level diagnostics for malformed payloads", () => {
    const result = parseHarnessJson(
      "codex",
      fixture("malformed/missing-session.json"),
      context(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("malformed-payload");
      expect(result.diagnostic.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "session_id" }),
        ]),
      );
      expect(result.diagnostic.safeBehavior).toBe("native-prompt");
    }
  });

  it("diagnoses invalid JSON without throwing", () => {
    const result = parseHarnessJson("cursor", "{not-json", context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("invalid-json");
    }
  });

  it("diagnoses unknown events", () => {
    const result = parseHarnessJson(
      "claude",
      JSON.stringify({ hook_event_name: "FutureHook" }),
      context(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("unsupported-event");
      expect(result.diagnostic.message).toContain("FutureHook");
    }
  });
});

describe("late resume capability", () => {
  it("uses argv arrays so answers are never shell-interpreted", () => {
    const answer = "continue; $(do-not-run)";
    expect(
      buildLateResumeInvocation("codex", "cli", "session_12345678", answer),
    ).toEqual({
      executable: "codex",
      args: [
        "exec",
        "resume",
        "-c",
        'sandbox_mode="read-only"',
        "session_12345678",
        answer,
      ],
    });
    expect(
      buildLateResumeInvocation("claude", "cli", "session_12345678", answer)
        .args,
    ).toContain(answer);
    expect(
      buildLateResumeInvocation("cursor", "cli", "session_12345678", answer)
        .args,
    ).toContain(answer);
  });

  it("preserves explicit execution authority without widening defaults", () => {
    expect(
      deriveLateResumePolicy("codex", ["exec", "--sandbox", "workspace-write"]),
    ).toEqual({
      harness: "codex",
      sandboxMode: "workspace-write",
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassHookTrust: false,
    });
    expect(
      buildLateResumeInvocation(
        "codex",
        "cli",
        "session_12345678",
        "continue",
        deriveLateResumePolicy("codex", [
          "--dangerously-bypass-hook-trust",
          "exec",
          "--sandbox=workspace-write",
        ]),
      ).args,
    ).toEqual([
      "exec",
      "resume",
      "--dangerously-bypass-hook-trust",
      "-c",
      'sandbox_mode="workspace-write"',
      "session_12345678",
      "continue",
    ]);
    expect(
      deriveLateResumePolicy("claude", [
        "--print",
        "--permission-mode=dontAsk",
      ]),
    ).toEqual({
      harness: "claude",
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
    });
    expect(deriveLateResumePolicy("cursor", ["--print"])).toEqual({
      harness: "cursor",
      executable: "cursor-agent",
      force: false,
      trustWorkspace: false,
      additionalDirectories: [],
    });
    expect(deriveLateResumePolicy("cursor", ["--print", "--force"])).toEqual({
      harness: "cursor",
      executable: "cursor-agent",
      force: true,
      trustWorkspace: false,
      additionalDirectories: [],
    });
    expect(
      buildLateResumeInvocation(
        "cursor",
        "cli",
        "session_12345678",
        "continue",
        deriveLateResumePolicy("cursor", ["--print", "--trust"]),
      ).args,
    ).toEqual([
      "--resume=session_12345678",
      "--print",
      "--trust",
      "--",
      "continue",
    ]);
    expect(deriveLateResumePolicy("cursor", ["--print", "--yolo"])).toEqual({
      harness: "cursor",
      executable: "cursor-agent",
      force: true,
      trustWorkspace: false,
      additionalDirectories: [],
    });
  });

  it("preserves Cursor read-only resume context without duplicating roots", () => {
    const policy = deriveLateResumePolicy(
      "cursor",
      [
        "--print",
        "--plan",
        "--sandbox=enabled",
        "--trust",
        "--workspace",
        "/isolated/workspace",
        "--add-dir=/workspace/repository",
        "--add-dir",
        "/workspace/repository",
        "--add-dir",
        "/workspace/secondary",
      ],
      "/approved/cursor-agent",
    );

    expect(policy).toEqual({
      harness: "cursor",
      executable: "/approved/cursor-agent",
      force: false,
      trustWorkspace: true,
      mode: "plan",
      sandbox: "enabled",
      workspace: "/isolated/workspace",
      additionalDirectories: ["/workspace/repository", "/workspace/secondary"],
    });
    expect(
      buildLateResumeInvocation(
        "cursor",
        "cli",
        "session_12345678",
        "continue",
        policy,
      ),
    ).toEqual({
      executable: "/approved/cursor-agent",
      args: [
        "--resume=session_12345678",
        "--print",
        "--mode",
        "plan",
        "--sandbox",
        "enabled",
        "--workspace",
        "/isolated/workspace",
        "--add-dir",
        "/workspace/repository",
        "--add-dir",
        "/workspace/secondary",
        "--trust",
        "--",
        "continue",
      ],
    });
  });

  it("keeps answers and unrelated Cursor arguments out of resume authority", () => {
    const policy = deriveLateResumePolicy(
      "cursor",
      [
        "--print",
        "--mode=ask",
        "--sandbox=disabled",
        "--api-key",
        "private-value",
        "--plugin-dir=/private/plugin",
        "--",
        "--force",
      ],
      "/approved/cursor-agent",
    );
    expect(policy).toEqual({
      harness: "cursor",
      executable: "/approved/cursor-agent",
      force: false,
      trustWorkspace: false,
      mode: "ask",
      sandbox: "disabled",
      additionalDirectories: [],
    });
    const invocation = buildLateResumeInvocation(
      "cursor",
      "cli",
      "session_12345678",
      "--force",
      policy,
    );
    expect(invocation.args).toEqual([
      "--resume=session_12345678",
      "--print",
      "--mode",
      "ask",
      "--sandbox",
      "disabled",
      "--",
      "--force",
    ]);
    expect(JSON.stringify(invocation)).not.toContain("private-value");
    expect(JSON.stringify(invocation)).not.toContain("/private/plugin");
  });

  it("preserves Cursor force and workspace trust independently", () => {
    const invocation = buildLateResumeInvocation(
      "cursor",
      "cli",
      "session_12345678",
      "continue",
      deriveLateResumePolicy("cursor", ["--force", "--trust"]),
    );
    expect(invocation.args).toEqual([
      "--resume=session_12345678",
      "--print",
      "--force",
      "--trust",
      "--",
      "continue",
    ]);
    for (const args of [
      ["-fp"],
      ["-pf"],
      ["-fH", "header-value"],
      ["-fe", "endpoint-value"],
      ["-fw"],
      ["-pfH", "header-value"],
    ]) {
      expect(deriveLateResumePolicy("cursor", args)).toMatchObject({
        force: true,
      });
    }
    for (const args of [["-Hf"], ["-ef"], ["-wf"], ["-H", "-pf"]]) {
      expect(deriveLateResumePolicy("cursor", args)).toMatchObject({
        force: false,
      });
    }
  });

  it("does not reinterpret unrelated Cursor option values as authority", () => {
    for (const args of [
      ["--plugin-dir", "--sandbox=disabled"],
      ["--model", "--force"],
      ["--plugin-dir", "--mode=plan"],
      ["--header", "--trust"],
      ["--api-key", "-pf"],
      ["-H", "--force"],
      ["-e", "--sandbox=disabled"],
    ]) {
      expect(deriveLateResumePolicy("cursor", args)).toEqual({
        harness: "cursor",
        executable: "cursor-agent",
        force: false,
        trustWorkspace: false,
        additionalDirectories: [],
      });
    }
    expect(
      deriveLateResumePolicy("cursor", ["--workspace", "--trust"]),
    ).toEqual({
      harness: "cursor",
      executable: "cursor-agent",
      force: false,
      trustWorkspace: false,
      workspace: "--trust",
      additionalDirectories: [],
    });
  });

  it("rejects conflicting or malformed Cursor resume context", () => {
    expect(() =>
      deriveLateResumePolicy("cursor", ["--plan", "--mode=ask"]),
    ).toThrow("conflicting Cursor mode values");
    expect(() =>
      deriveLateResumePolicy("cursor", ["--mode=unsupported"]),
    ).toThrow("unsupported Cursor mode");
    expect(() =>
      deriveLateResumePolicy("cursor", ["--sandbox=unknown"]),
    ).toThrow("unsupported Cursor sandbox mode");
    expect(() =>
      deriveLateResumePolicy("cursor", [
        "--sandbox=enabled",
        "--sandbox=disabled",
      ]),
    ).toThrow("conflicting Cursor sandbox mode values");
    expect(() => deriveLateResumePolicy("cursor", ["--mode"])).toThrow(
      "Cursor mode requires a value",
    );
    expect(() =>
      deriveLateResumePolicy("cursor", ["--mode", "--trust"]),
    ).toThrow("unsupported Cursor mode");
    expect(() =>
      deriveLateResumePolicy("cursor", [
        "--workspace=/first",
        "--workspace=/second",
      ]),
    ).toThrow("conflicting Cursor workspace values");
    expect(() => deriveLateResumePolicy("cursor", ["--add-dir="])).toThrow(
      "Cursor additional directory requires a value",
    );
    expect(() => deriveLateResumePolicy("cursor", ["--workspace"])).toThrow(
      "Cursor workspace requires a value",
    );
    expect(() => deriveLateResumePolicy("cursor", ["--future-option"])).toThrow(
      "unsupported Cursor option",
    );
    expect(() => deriveLateResumePolicy("cursor", ["-z"])).toThrow(
      "unsupported Cursor short option",
    );
  });

  it("rejects Cursor IDE late resume explicitly", () => {
    expect(() =>
      buildLateResumeInvocation(
        "cursor",
        "ide",
        "session_12345678",
        "continue",
      ),
    ).toThrow("unsupported");
  });
});

describe("capability declarations", () => {
  it("covers every supported harness and distinguishes structured surfaces", () => {
    expect(new Set(HARNESS_CAPABILITIES.map((entry) => entry.harness))).toEqual(
      new Set(["codex", "claude", "cursor"]),
    );
    expect(capabilityFor("cursor", "cli")?.detail.lateResume).toBe(true);
    expect(capabilityFor("cursor", "ide")?.detail.lateResume).toBe(false);
    expect(capabilityFor("cursor", "cli")?.protocol.permissionDecision).toBe(
      false,
    );
    expect(
      capabilityFor("cursor", "ide")?.detail.capabilityClassifications
        .permissionDecision,
    ).toBe("disabled");
    expect(
      capabilityFor("codex", "app-server")?.detail.processExitObservation,
    ).toBe(true);
    expect(
      HARNESS_CAPABILITIES.filter(
        ({ harness, surface }) =>
          harness !== "codex" || surface !== "app-server",
      ).every((entry) => entry.processExitObservation === false),
    ).toBe(true);
    expect(HARNESS_COMPATIBILITY.schema).toBe("agent-relay-compatibility.v1");
    expect(PUBLIC_COMPATIBILITY_RECORD.records).toHaveLength(6);
    expect(JSON.stringify(PUBLIC_COMPATIBILITY_RECORD)).not.toMatch(
      /transcript|cwd|executable|fixturePaths|knownIncompatibleVersions/,
    );
  });

  it("classifies exact, drifted, and known-incompatible versions", () => {
    const codex = VERIFIED_CLI_HARNESS_EVIDENCE.codex;
    expect(classifyObservedHarnessVersion(codex, "codex-cli 0.145.0")).toBe(
      "verified",
    );
    expect(classifyObservedHarnessVersion(codex, "codex-cli 0.146.0")).toBe(
      "compatible-unverified",
    );
    expect(
      classifyObservedHarnessVersion(
        {
          verifiedVersion: "verified-version",
          knownIncompatibleVersions: ["incompatible-version"],
        },
        "incompatible-version",
      ),
    ).toBe("unsupported");
  });
});
