import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  SESSION_NAME_ADJECTIVES,
  SESSION_NAME_COLLISION_SPACE,
  SESSION_NAME_NOUNS,
  sessionName,
} from "./session-name.js";
import { sessionPublicKey } from "./topic.js";

describe("sessionName", () => {
  it("is a pure deterministic function of the opaque session key", () => {
    const key = "0123456789abcdef01234567";
    expect(sessionName(key)).toBe("lucid-maple-43");
    expect(sessionName(key)).toBe(sessionName(key));
  });

  it("stays stable for the same machine/harness/session identity", () => {
    const key = sessionPublicKey({
      machineId: "machine-a",
      harness: "codex",
      sessionId: "native-session-12345678",
    });
    const first = sessionName(key);
    expect(first).toMatch(/^[a-z]+-[a-z]+-\d{2}$/u);
    expect(sessionName(key)).toBe(first);
    expect(
      sessionName(
        sessionPublicKey({
          machineId: "machine-a",
          harness: "codex",
          sessionId: "native-session-12345678",
        }),
      ),
    ).toBe(first);
  });

  it("never embeds the native session id or machine id", () => {
    const machineId = "machine-secret-path-/Users/private";
    const sessionId = "sess_ABCDEFGH_private";
    const name = sessionName(
      sessionPublicKey({
        machineId,
        harness: "claude",
        sessionId,
      }),
    );
    expect(name).not.toContain("ABCDEFGH");
    expect(name).not.toContain("private");
    expect(name).not.toContain("Users");
    expect(name).not.toContain(machineId);
    expect(name).not.toContain(sessionId);
  });

  it("documents the bounded collision space and fixed word lists", () => {
    expect(SESSION_NAME_ADJECTIVES).toHaveLength(64);
    expect(SESSION_NAME_NOUNS).toHaveLength(64);
    expect(SESSION_NAME_COLLISION_SPACE).toBe(409_600);
    expect(new Set(SESSION_NAME_ADJECTIVES).size).toBe(64);
    expect(new Set(SESSION_NAME_NOUNS).size).toBe(64);
  });

  it("can collide across distinct opaque keys within the bounded space", () => {
    const names = new Map<string, string>();
    let collision: { left: string; right: string; name: string } | undefined;
    for (let index = 0; index < 50_000; index += 1) {
      const key = createHash("sha256")
        .update(`collision-probe:${String(index)}`)
        .digest("hex")
        .slice(0, 24);
      const name = sessionName(key);
      const prior = names.get(name);
      if (prior !== undefined && prior !== key) {
        collision = { left: prior, right: key, name };
        break;
      }
      names.set(name, key);
    }
    expect(collision).toBeDefined();
    expect(collision!.left).not.toBe(collision!.right);
    expect(sessionName(collision!.left)).toBe(collision!.name);
    expect(sessionName(collision!.right)).toBe(collision!.name);
  });
});
