import {
  NotificationsContractError,
  NotificationsProblemError,
  NotificationsProtocolError,
  NotificationsTransportError,
} from "@flowxo/notifications";
import { describe, expect, it } from "vitest";

import {
  asNotificationsDeliveryError,
  NotificationsDeliveryError,
} from "./errors.js";
import { NotificationsMappingError } from "./mapping.js";

import type { Problem } from "@flowxo/notifications";
import type { ProblemCode } from "@flowxo/notifications-contracts";

function problem(
  code: ProblemCode,
  retryable: boolean,
  status = retryable ? 503 : 400,
): Problem {
  return {
    type: `https://flowxo.com/notifications/problems/${code}`,
    title: "Synthetic problem",
    status,
    detail: "credential secret_value and /private/path",
    code,
    diagnostic_id: "diagnostic_safe_12345678",
    retryable,
  } as unknown as Problem;
}

describe("Notifications error classification", () => {
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
      const mapped = asNotificationsDeliveryError(
        new NotificationsProblemError(
          problem(
            code,
            code === "provider_outcome_unknown" ? false : retryable,
          ),
        ),
      );
      expect(mapped).toMatchObject({
        code: `notifications-${code.replaceAll("_", "-")}`,
        retryable,
        disposition,
        diagnosticId: "diagnostic_safe_12345678",
      });
      expect(mapped.message).not.toContain("secret_value");
      expect(mapped.message).not.toContain("/private/path");
    },
  );

  it("permits uncertain connection replay only through the same operation", () => {
    const mapped = asNotificationsDeliveryError(
      new NotificationsTransportError("createMessage", true),
    );
    expect(mapped).toMatchObject({
      code: "notifications-transport-outcome-unknown",
      retryable: true,
      disposition: "retry_same_operation",
    });
  });

  it("fails closed on contract-integrity errors", () => {
    const mapped = asNotificationsDeliveryError(
      new NotificationsContractError("pollMachineEvents", []),
    );
    expect(mapped).toMatchObject({
      code: "notifications-contract-invalid",
      retryable: false,
      disposition: "terminal",
    });
  });

  it("classifies local projection failures as terminal without reflecting values", () => {
    const mapped = asNotificationsDeliveryError(
      new NotificationsMappingError(
        "Unsafe value private-secret",
        "notifications-select-capability-unsupported",
      ),
    );
    expect(mapped).toMatchObject({
      code: "notifications-select-capability-unsupported",
      retryable: false,
      disposition: "terminal",
    });
    expect(mapped.message).not.toContain("private-secret");
  });

  it("bounds unknown protocol and implementation failures without reflecting secrets", () => {
    const protocol = asNotificationsDeliveryError(
      new NotificationsProtocolError(
        "createMessage",
        "Bearer private-secret",
        502,
      ),
    );
    const unknown = asNotificationsDeliveryError(
      new Error("credential private-secret"),
    );
    expect(protocol).toMatchObject({
      code: "notifications-protocol-unclassified",
      retryable: true,
      status: 502,
    });
    expect(unknown).toMatchObject({
      code: "notifications-unclassified",
      retryable: true,
    });
    expect(`${protocol.message}${unknown.message}`).not.toContain(
      "private-secret",
    );
  });

  it("preserves an already classified local failure", () => {
    const failure = new NotificationsDeliveryError(
      "Safe",
      "notifications-safe",
      false,
      "terminal",
    );
    expect(asNotificationsDeliveryError(failure)).toBe(failure);
  });
});
