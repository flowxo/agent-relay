import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RELAY_MCP_MAX_WAIT_MS,
  RELAY_MCP_PROTOCOL_VERSION,
  RELAY_MCP_SURFACE_VERSION,
  RELAY_MCP_TOOL_DEFINITIONS,
  RelayMcpAskV1Schema,
  RelayMcpErrorV1Schema,
  RelayMcpQuestionnaireV1Schema,
} from "./mcp.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`../fixtures/interactions/${name}`, import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

describe("versioned Relay MCP contract", () => {
  it("freezes the smallest useful typed tool surface", () => {
    expect(RELAY_MCP_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(RELAY_MCP_SURFACE_VERSION).toBe("agent-relay-mcp.v1");
    expect(RELAY_MCP_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      "relay_ask",
      "relay_ask_many",
      "relay_cancel",
      "relay_status",
    ]);
    expect(JSON.stringify(RELAY_MCP_TOOL_DEFINITIONS)).not.toContain(
      "relay_notify",
    );
    expect(JSON.stringify(RELAY_MCP_TOOL_DEFINITIONS)).not.toContain(
      "relay_check",
    );
  });

  it("validates sanitized one-question and questionnaire fixtures", async () => {
    expect(
      RelayMcpAskV1Schema.parse(await fixture("mcp-ask.v1.json")),
    ).toMatchObject({ schema: "agent-relay-mcp-ask.v1" });
    expect(
      RelayMcpQuestionnaireV1Schema.parse(
        await fixture("mcp-questionnaire.v1.json"),
      ),
    ).toMatchObject({ schema: "agent-relay-mcp-questionnaire.v1" });
  });

  it("bounds waits and returns a content-free local fallback contract", () => {
    expect(() =>
      RelayMcpAskV1Schema.parse({
        ...(RelayMcpAskV1Schema.parse({
          schema: "agent-relay-mcp-ask.v1",
          requestId: "request_mcp_bounds_0001",
          title: "Synthetic question",
          question: {
            questionId: "question_mcp_bounds_0001",
            kind: "free-text",
            prompt: "Provide bounded synthetic text.",
            minLength: 1,
            maxLength: 20,
            multiline: false,
          },
          expiresInMs: 60_000,
          waitTimeoutMs: RELAY_MCP_MAX_WAIT_MS,
        }) as object),
        waitTimeoutMs: RELAY_MCP_MAX_WAIT_MS + 1,
      }),
    ).toThrow();
    expect(
      RelayMcpErrorV1Schema.parse({
        schema: "agent-relay-mcp-error.v1",
        code: "binding-ambiguous",
        retryable: false,
        localFallback:
          "Ask the operator locally with the harness's native question mechanism.",
      }),
    ).toEqual(
      expect.not.objectContaining({ prompt: expect.anything() as unknown }),
    );
  });

  it("rejects cross-question option collisions before the durable boundary", async () => {
    const questionnaire = (await fixture(
      "mcp-questionnaire.v1.json",
    )) as Record<string, unknown>;
    const questions = questionnaire["questions"] as Array<
      Record<string, unknown>
    >;
    const freeText = questions[1];
    expect(freeText).toBeDefined();
    questionnaire["questions"] = [
      questions[0],
      {
        ...freeText,
        kind: "single-select",
        options: [
          { optionId: "option_mcp_yes_0002", label: "Duplicate" },
          { optionId: "option_mcp_unique_0002", label: "Unique" },
        ],
        minLength: undefined,
        maxLength: undefined,
        multiline: undefined,
      },
    ];
    expect(RelayMcpQuestionnaireV1Schema.safeParse(questionnaire).success).toBe(
      false,
    );
  });

  it("warns models not to substitute Relay for permission gates", () => {
    const descriptions = RELAY_MCP_TOOL_DEFINITIONS.map(
      ({ description }) => description,
    ).join(" ");
    expect(descriptions).toContain("operator-mediated");
    expect(descriptions).toContain("Never use it for permission");
    expect(descriptions).toContain("native approval path");
  });
});
