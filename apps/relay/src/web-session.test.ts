import { describe, expect, it } from "vitest";

import {
  WebSessionAuthority,
  WebSessionAuthorityError,
} from "./web-session.js";

const primaryScope = {
  origin: "http://127.0.0.1:4317",
  host: "127.0.0.1:4317",
};

describe("local web bootstrap and browser-session authority", () => {
  it("issues independent grants and permits exactly one concurrent exchange", async () => {
    const authority = new WebSessionAuthority();
    const first = authority.issueGrant(primaryScope);
    const second = authority.issueGrant(primaryScope);
    expect(first.grant).not.toBe(second.grant);

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        authority.exchangeGrant(first.grant, primaryScope),
      ),
      Promise.resolve().then(() =>
        authority.exchangeGrant(first.grant, primaryScope),
      ),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "web-bootstrap-replayed" }),
    });
  });

  it("expires quickly, rejects stale and malformed material, and invalidates replay", () => {
    let now = new Date("2026-08-13T21:00:00.000Z");
    const authority = new WebSessionAuthority({
      now: () => now,
      bootstrapTtlMs: 100,
    });
    const expired = authority.issueGrant(primaryScope);
    now = new Date(now.getTime() + 101);
    expect(() => authority.exchangeGrant(expired.grant, primaryScope)).toThrow(
      expect.objectContaining({ code: "web-bootstrap-expired" }),
    );
    expect(() =>
      authority.exchangeGrant(`webboot_${"A".repeat(43)}`, primaryScope),
    ).toThrow(expect.objectContaining({ code: "web-bootstrap-invalid" }));
    expect(() => authority.exchangeGrant("not-a-grant", primaryScope)).toThrow(
      expect.objectContaining({ code: "web-bootstrap-malformed" }),
    );
  });

  it("consumes grants on exact Host or Origin mismatch and binds sessions to Host", () => {
    const authority = new WebSessionAuthority();
    const wrongHostGrant = authority.issueGrant(primaryScope);
    expect(() =>
      authority.exchangeGrant(wrongHostGrant.grant, {
        origin: "http://localhost:4317",
        host: "localhost:4317",
      }),
    ).toThrow(expect.objectContaining({ code: "web-bootstrap-host-rejected" }));
    expect(() =>
      authority.exchangeGrant(wrongHostGrant.grant, primaryScope),
    ).toThrow(expect.objectContaining({ code: "web-bootstrap-replayed" }));

    const wrongOriginGrant = authority.issueGrant(primaryScope);
    expect(() =>
      authority.exchangeGrant(wrongOriginGrant.grant, {
        origin: "http://localhost:4317",
        host: primaryScope.host,
      }),
    ).toThrow(
      expect.objectContaining({ code: "web-bootstrap-origin-rejected" }),
    );

    const valid = authority.issueGrant(primaryScope);
    const session = authority.exchangeGrant(valid.grant, primaryScope);
    expect(() =>
      authority.authorizeSession(session.sessionToken, "localhost:4317"),
    ).toThrow(expect.objectContaining({ code: "web-session-host-rejected" }));
    expect(
      authority.authorizeSession(session.sessionToken, primaryScope.host),
    ).toMatchObject({ schema: "agent-relay-web-browser-session.v1" });
  });

  it("enforces idle and absolute browser-session lifetimes", () => {
    let now = new Date("2026-08-13T21:00:00.000Z");
    const authority = new WebSessionAuthority({
      now: () => now,
      sessionIdleTtlMs: 100,
      sessionAbsoluteTtlMs: 250,
    });
    const firstGrant = authority.issueGrant(primaryScope);
    const first = authority.exchangeGrant(firstGrant.grant, primaryScope);
    now = new Date(now.getTime() + 101);
    expect(() =>
      authority.authorizeSession(first.sessionToken, primaryScope.host),
    ).toThrow(expect.objectContaining({ code: "web-session-expired" }));

    now = new Date("2026-08-13T21:00:00.000Z");
    const secondGrant = authority.issueGrant(primaryScope);
    const second = authority.exchangeGrant(secondGrant.grant, primaryScope);
    now = new Date(now.getTime() + 90);
    authority.authorizeSession(second.sessionToken, primaryScope.host);
    now = new Date(now.getTime() + 90);
    authority.authorizeSession(second.sessionToken, primaryScope.host);
    now = new Date(now.getTime() + 71);
    expect(() =>
      authority.authorizeSession(second.sessionToken, primaryScope.host),
    ).toThrow(WebSessionAuthorityError);
  });

  it("bounds pending grants without disturbing existing grants", () => {
    const authority = new WebSessionAuthority({ maxActiveGrants: 2 });
    const first = authority.issueGrant(primaryScope);
    authority.issueGrant(primaryScope);
    expect(() => authority.issueGrant(primaryScope)).toThrow(
      expect.objectContaining({ code: "web-bootstrap-capacity" }),
    );
    expect(authority.exchangeGrant(first.grant, primaryScope)).toMatchObject({
      session: { schema: "agent-relay-web-browser-session.v1" },
    });
  });
});
