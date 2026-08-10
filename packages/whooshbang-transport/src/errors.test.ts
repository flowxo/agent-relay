import {
  WhooshBangContractError,
  WhooshBangProblemError,
  WhooshBangProtocolError,
  WhooshBangTransportError,
} from "@whooshbang/sdk";
import { describe, expect, it } from "vitest";

import {
  asWhooshBangDeliveryError,
  WhooshBangDeliveryError,
  whooshbangFailurePolicy,
} from "./errors.js";
import { WhooshBangMappingError } from "./mapping.js";

import type { Problem } from "@whooshbang/sdk";
import type { ProblemCode } from "@whooshbang/contracts";

function problem(
  code: ProblemCode,
  retryable: boolean,
  status = retryable ? 503 : 400,
): Problem {
  return {
    type: `https://whooshbang.flowxo.com/problems/${code}`,
    title: "Synthetic problem",
    status,
    detail: "credential secret_value and /private/path",
    code,
    diagnostic_id: "diagnostic_safe_12345678",
    retryable,
  } as unknown as Problem;
}

describe("WhooshBang error classification", () => {
  it.each([
    ["provider_retryable", true, "retry_same_operation"],
    ["rate_limited", true, "retry_same_operation"],
    ["credential_invalid", false, "terminal"],
    ["scope_forbidden", false, "terminal"],
    ["subscriber_unbound", false, "terminal"],
    ["provider_terminal", false, "terminal"],
    ["idempotency_conflict", false, "terminal"],
    ["provider_outcome_unknown", false, "outcome_unknown"],
  ] as const)(
    "maps %s to the bounded local policy",
    (code, retryable, disposition) => {
      const mapped = asWhooshBangDeliveryError(
        new WhooshBangProblemError(
          problem(
            code,
            code === "provider_outcome_unknown" ? false : retryable,
          ),
        ),
      );
      expect(mapped).toMatchObject({
        code: `whooshbang-${code.replaceAll("_", "-")}`,
        retryable,
        disposition,
        diagnosticId: "diagnostic_safe_12345678",
      });
      expect(mapped.message).not.toContain("secret_value");
      expect(mapped.message).not.toContain("/private/path");
    },
  );

  it("classifies the concrete removed-resource code as operator action", () => {
    expect(
      whooshbangFailurePolicy(
        new WhooshBangDeliveryError(
          "The hosted resource no longer exists.",
          "whooshbang-resource-not-found",
          false,
          "terminal",
          { status: 404 },
        ),
      ),
    ).toEqual({
      category: "operator-action",
      retrySameOperation: false,
      permitNewIdentity: false,
    });
  });

  it("bounds the additive replay-unavailable problem without reflecting detail", () => {
    const mapped = asWhooshBangDeliveryError(
      new WhooshBangProblemError(problem("replay_unavailable", false, 409)),
    );
    expect(mapped).toMatchObject({
      code: "whooshbang-replay-unavailable",
      disposition: "terminal",
      retryable: false,
      status: 409,
    });
    expect(mapped.message).toBe(
      "WhooshBang cannot replay the requested customer event.",
    );
    expect(mapped.message).not.toContain("secret_value");
    expect(mapped.message).not.toContain("/private/path");
    expect(whooshbangFailurePolicy(mapped)).toEqual({
      category: "operator-action",
      retrySameOperation: false,
      permitNewIdentity: false,
    });
  });

  it("permits uncertain connection replay only through the same operation", () => {
    const mapped = asWhooshBangDeliveryError(
      new WhooshBangTransportError("createMessage", true),
    );
    expect(mapped).toMatchObject({
      code: "whooshbang-transport-outcome-unknown",
      retryable: true,
      disposition: "retry_same_operation",
    });
  });

  it("fails closed on contract-integrity errors", () => {
    const mapped = asWhooshBangDeliveryError(
      new WhooshBangContractError("pollMachineEvents", []),
    );
    expect(mapped).toMatchObject({
      code: "whooshbang-contract-invalid",
      retryable: false,
      disposition: "terminal",
    });
  });

  it("classifies local projection failures as terminal without reflecting values", () => {
    const mapped = asWhooshBangDeliveryError(
      new WhooshBangMappingError(
        "Unsafe value private-secret",
        "whooshbang-select-capability-unsupported",
      ),
    );
    expect(mapped).toMatchObject({
      code: "whooshbang-select-capability-unsupported",
      retryable: false,
      disposition: "terminal",
    });
    expect(mapped.message).not.toContain("private-secret");
  });

  it("bounds unknown protocol and implementation failures without reflecting secrets", () => {
    const protocol = asWhooshBangDeliveryError(
      new WhooshBangProtocolError(
        "createMessage",
        "Bearer private-secret",
        502,
      ),
    );
    const unknown = asWhooshBangDeliveryError(
      new Error("credential private-secret"),
    );
    expect(protocol).toMatchObject({
      code: "whooshbang-protocol-unclassified",
      retryable: true,
      status: 502,
    });
    expect(unknown).toMatchObject({
      code: "whooshbang-unclassified",
      retryable: true,
    });
    expect(`${protocol.message}${unknown.message}`).not.toContain(
      "private-secret",
    );
  });

  it.each([
    [401, "terminal-configuration"],
    [403, "dead-letter-security"],
    [404, "operator-action"],
    [409, "dead-letter-security"],
    [429, "retry"],
    [503, "retry"],
  ] as const)(
    "maps HTTP %s to stable %s diagnosis",
    (status, expectedCategory) => {
      const failure = new WhooshBangDeliveryError(
        "Safe synthetic response.",
        "whooshbang-protocol-unclassified",
        status === 429 || status >= 500,
        status === 429 || status >= 500 ? "retry_same_operation" : "terminal",
        { status },
      );
      expect(whooshbangFailurePolicy(failure)).toEqual({
        category: expectedCategory,
        retrySameOperation: expectedCategory === "retry",
        permitNewIdentity: false,
      });
    },
  );

  it("quarantines malformed/schema responses and requires operator action for explicit ambiguity", () => {
    const schema = asWhooshBangDeliveryError(
      new WhooshBangContractError("pollMachineEvents", []),
    );
    const malformed = asWhooshBangDeliveryError(
      new WhooshBangProtocolError(
        "pollMachineEvents",
        "private malformed body",
        200,
      ),
    );
    const redirect = asWhooshBangDeliveryError(
      new WhooshBangProtocolError(
        "pollMachineEvents",
        "https://private.example.test",
        307,
      ),
    );
    const ambiguous = asWhooshBangDeliveryError(
      new WhooshBangProblemError(
        problem("provider_outcome_unknown", false, 502),
      ),
    );
    expect(whooshbangFailurePolicy(schema).category).toBe("quarantine");
    expect(malformed).toMatchObject({
      code: "whooshbang-protocol-malformed",
      retryable: false,
    });
    expect(whooshbangFailurePolicy(malformed).category).toBe("quarantine");
    expect(redirect).toMatchObject({
      code: "whooshbang-redirect-refused",
      retryable: false,
    });
    expect(whooshbangFailurePolicy(redirect).category).toBe(
      "dead-letter-security",
    );
    expect(whooshbangFailurePolicy(ambiguous)).toEqual({
      category: "operator-action",
      retrySameOperation: false,
      permitNewIdentity: false,
    });
  });

  it("preserves an already classified local failure", () => {
    const failure = new WhooshBangDeliveryError(
      "Safe",
      "whooshbang-safe",
      false,
      "terminal",
    );
    expect(asWhooshBangDeliveryError(failure)).toBe(failure);
  });
});
