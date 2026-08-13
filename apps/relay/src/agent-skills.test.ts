import { readFile } from "node:fs/promises";

import {
  AGENT_RELAY_SKILL_CONTRACT,
  AGENT_RELAY_SKILL_CONTRACT_VERSION,
  AGENT_RELAY_SKILL_REQUIRED_ERROR_CODES,
  AgentRelaySkillContractSchema,
  RELAY_MCP_ERROR_CODES,
  RELAY_MCP_SURFACE_VERSION,
  RelayMcpAskV1Schema,
  RelayMcpQuestionnaireV1Schema,
  isAgentRelaySkillVersionCompatible,
} from "@agent-relay/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_RELAY_SKILL_OWNER_MARKER,
  AgentRelaySkillEvaluationScenarioSchema,
  canonicalAgentRelaySkillContractJson,
  evaluateAgentRelaySkillScenario,
  officialAgentRelaySkillArtifacts,
  validateOfficialAgentRelaySkillCompatibility,
} from "./agent-skills.js";

const root = new URL("../../../", import.meta.url);

describe("official Agent Relay skills", () => {
  it("keeps the reviewed canonical contract and vendor goldens deterministic", async () => {
    const contractPath = new URL("skills/agent-relay/contract.v1.json", root);
    const contractSource = await readFile(contractPath, "utf8");
    expect(contractSource).toBe(canonicalAgentRelaySkillContractJson());
    expect(
      AgentRelaySkillContractSchema.parse(JSON.parse(contractSource)),
    ).toEqual(AGENT_RELAY_SKILL_CONTRACT);

    const artifacts = officialAgentRelaySkillArtifacts();
    expect(artifacts.map((artifact) => artifact.harness)).toEqual([
      "codex",
      "claude",
      "cursor",
    ]);
    for (const artifact of artifacts) {
      const golden = await readFile(
        new URL(
          `skills/agent-relay/rendered/${artifact.harness}/SKILL.md`,
          root,
        ),
        "utf8",
      );
      expect(golden).toBe(artifact.content);
      expect(golden).toContain(AGENT_RELAY_SKILL_OWNER_MARKER);
      expect(golden).toContain(
        `contract \`${AGENT_RELAY_SKILL_CONTRACT_VERSION}\``,
      );
      expect(golden).toContain(`MCP \`${RELAY_MCP_SURFACE_VERSION}\``);
      expect(golden).toContain(
        "Never use Relay instead of native authorization",
      );
      expect(golden).toContain("Idle is projected only from selected evidence");
      expect(golden).toContain("Unknown means evidence is missing");
      expect(golden).toContain("prompt injection");
      expect(golden).toContain("Never forward ambient transcript");
      expect(golden).not.toContain("relay_notify");
      expect(golden).not.toContain("relay_check");
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("pins every frozen tool, error, activity state, and compatibility boundary", () => {
    expect(AGENT_RELAY_SKILL_CONTRACT.tools.map((tool) => tool.name)).toEqual([
      "relay_ask",
      "relay_ask_many",
      "relay_cancel",
      "relay_status",
    ]);
    expect(
      AGENT_RELAY_SKILL_CONTRACT.tools.map((tool) => tool.inputSchema),
    ).toEqual([
      "agent-relay-mcp-ask.v1",
      "agent-relay-mcp-questionnaire.v1",
      "agent-relay-mcp-cancel.v1",
      "agent-relay-mcp-status.v1",
    ]);
    expect(
      AGENT_RELAY_SKILL_CONTRACT.harnesses.map((harness) => ({
        harness: harness.harness,
        verifiedVersion: harness.verifiedVersion,
        otherVersionPolicy: harness.otherVersionPolicy,
      })),
    ).toEqual([
      {
        harness: "codex",
        verifiedVersion: "codex-cli 0.145.0",
        otherVersionPolicy: "compatible-unverified",
      },
      {
        harness: "claude",
        verifiedVersion: "2.1.219 (Claude Code)",
        otherVersionPolicy: "compatible-unverified",
      },
      {
        harness: "cursor",
        verifiedVersion: "2026.07.23-e383d2b",
        otherVersionPolicy: "compatible-unverified",
      },
    ]);
    expect(AGENT_RELAY_SKILL_REQUIRED_ERROR_CODES).toEqual(
      RELAY_MCP_ERROR_CODES,
    );
    expect(AGENT_RELAY_SKILL_CONTRACT.activity.states).toEqual([
      "Working",
      "Needs input",
      "Background work",
      "Idle",
      "Done",
      "Failed",
      "Unknown",
      "Ended",
    ]);
    expect(isAgentRelaySkillVersionCompatible("0.1.0-alpha.1")).toBe(false);
    expect(isAgentRelaySkillVersionCompatible("0.1.0-alpha.2")).toBe(true);
    expect(isAgentRelaySkillVersionCompatible("0.1.9")).toBe(true);
    expect(isAgentRelaySkillVersionCompatible("0.2.0-alpha.1")).toBe(false);
    expect(isAgentRelaySkillVersionCompatible("00.1.0")).toBe(false);
    expect(isAgentRelaySkillVersionCompatible("0.1.0-alpha.02")).toBe(false);
    expect(isAgentRelaySkillVersionCompatible("not-a-version")).toBe(false);
    expect(
      validateOfficialAgentRelaySkillCompatibility({
        packageVersion: "0.1.0-alpha.2",
        contractVersion: AGENT_RELAY_SKILL_CONTRACT_VERSION,
        mcpSurfaceVersion: RELAY_MCP_SURFACE_VERSION,
        mcpProtocolVersion: "2025-11-25",
      }),
    ).toBe(true);
  });

  it("constructs concise valid examples for every frozen answer shape", () => {
    const base = {
      schema: "agent-relay-mcp-ask.v1",
      requestId: "request_skill_fixture_0001",
      title: "Review the synthetic rollout",
      expiresInMs: 600_000,
      waitTimeoutMs: 120_000,
    } as const;
    const questions = [
      {
        questionId: "question_confirm_skill_0001",
        kind: "confirm",
        prompt: "Continue with the synthetic rollout?",
        confirm: { optionId: "option_continue_skill_0001", label: "Continue" },
        decline: { optionId: "option_stop_skill_0001", label: "Stop" },
      },
      {
        questionId: "question_single_skill_0001",
        kind: "single-select",
        prompt: "Which synthetic environment should receive the rollout?",
        options: [
          { optionId: "option_preview_skill_0001", label: "Preview" },
          { optionId: "option_staging_skill_0001", label: "Staging" },
        ],
      },
      {
        questionId: "question_multi_skill_0001",
        kind: "multi-select",
        prompt: "Which independent synthetic checks should run?",
        options: [
          { optionId: "option_unit_skill_0001", label: "Unit" },
          { optionId: "option_contract_skill_0001", label: "Contract" },
          { optionId: "option_e2e_skill_0001", label: "End to end" },
        ],
        minSelections: 1,
        maxSelections: 2,
      },
      {
        questionId: "question_text_skill_0001",
        kind: "free-text",
        prompt: "What bounded synthetic note should accompany the rollout?",
        minLength: 1,
        maxLength: 240,
        multiline: false,
      },
    ] as const;

    for (const [index, question] of questions.entries()) {
      expect(
        RelayMcpAskV1Schema.safeParse({
          ...base,
          requestId: `request_skill_fixture_000${String(index + 1)}`,
          question,
        }).success,
      ).toBe(true);
    }
    expect(
      RelayMcpQuestionnaireV1Schema.safeParse({
        schema: "agent-relay-mcp-questionnaire.v1",
        requestId: "request_skill_questionnaire_0001",
        title: "Review the synthetic rollout",
        questions,
        expiresInMs: 600_000,
        waitTimeoutMs: 120_000,
      }).success,
    ).toBe(true);
  });

  it("passes every controlled synthetic harness evaluation without provider traffic", async () => {
    const ScenarioCorpusSchema = z
      .object({
        schema: z.literal("agent-relay-skill-evaluations.v1"),
        scenarios: z.array(AgentRelaySkillEvaluationScenarioSchema).min(1),
      })
      .strict();
    const corpus = ScenarioCorpusSchema.parse(
      JSON.parse(
        await readFile(
          new URL("skills/agent-relay/fixtures/scenarios.v1.json", root),
          "utf8",
        ),
      ),
    );

    expect(
      new Set(corpus.scenarios.map((scenario) => scenario.harness)),
    ).toEqual(new Set(["codex", "claude", "cursor"]));
    expect(corpus.scenarios.map((scenario) => scenario.category)).toEqual(
      expect.arrayContaining([
        "operator-question",
        "native-permission",
        "failure",
        "activity",
        "prompt-injection",
      ]),
    );
    const requiredSignals = [
      "remote-product-choice",
      "asynchronous-workflow-confirmation",
      "related-product-questions",
      "bounded-explanation-required",
      "command-execution-approval",
      "tool-permission",
      "security-confirmation",
      ...AGENT_RELAY_SKILL_CONTRACT.failurePolicy.map(
        (entry) => entry.condition,
      ),
      "Idle",
      "Unknown",
      "permission-bypass",
      "secret-exfiltration",
      "ambient-transcript-forwarding",
    ];
    const presentSignals = new Set(
      corpus.scenarios.map((scenario) => scenario.signal),
    );
    expect(requiredSignals.every((signal) => presentSignals.has(signal))).toBe(
      true,
    );
    expect(
      corpus.scenarios
        .filter((scenario) => scenario.category === "operator-question")
        .map((scenario) => scenario.shape),
    ).toEqual(
      expect.arrayContaining([
        "confirm",
        "single-select",
        "multi-select",
        "free-text",
      ]),
    );
    for (const scenario of corpus.scenarios) {
      expect(evaluateAgentRelaySkillScenario(scenario)).toEqual(
        scenario.expected,
      );
    }
  });
});
