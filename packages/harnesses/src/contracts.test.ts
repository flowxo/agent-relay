import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HARNESS_CAPABILITIES, capabilityFor } from "./capabilities.js";
import { renderStopContinuation } from "./continuation.js";
import { parseHarnessJson } from "./parsers.js";
import { buildLateResumeInvocation } from "./resume.js";

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
      args: ["exec", "resume", "session_12345678", answer],
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
  it("covers every supported harness and distinguishes Cursor surfaces", () => {
    expect(new Set(HARNESS_CAPABILITIES.map((entry) => entry.harness))).toEqual(
      new Set(["codex", "claude", "cursor"]),
    );
    expect(capabilityFor("cursor", "cli")?.detail.lateResume).toBe(true);
    expect(capabilityFor("cursor", "ide")?.detail.lateResume).toBe(false);
    expect(
      HARNESS_CAPABILITIES.every(
        (entry) => entry.processExitObservation === false,
      ),
    ).toBe(true);
  });
});
