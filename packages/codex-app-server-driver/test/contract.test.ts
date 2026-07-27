import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolError,
  decodeCodexAppServerLine,
} from "../src/index.js";

const fixtureRoot = new URL(
  "../fixtures/codex-app-server-0.145.0/",
  import.meta.url,
);

interface ContractFixture {
  readonly codexVersion: string;
  readonly transport: string;
  readonly experimentalApi: boolean;
  readonly generatedSchema: {
    readonly rawByteLength: number;
    readonly canonicalization: string;
    readonly canonicalByteLength: number;
    readonly sha256: string;
  };
  readonly clientRequests: readonly string[];
  readonly serverNotifications: readonly string[];
  readonly serverRequests: readonly string[];
  readonly unsupportedRunnerCommands: readonly string[];
}

interface TranscriptFixture {
  readonly messages: readonly {
    readonly kind: "notification" | "request";
    readonly line: string;
  }[];
}

interface NegativeFixture {
  readonly cases: readonly {
    readonly name: string;
    readonly line: string;
    readonly safeCode: string;
  }[];
}

interface LiveCanaryFixture {
  readonly codexVersion: string;
  readonly schemaSha256: string;
  readonly initialized: boolean;
  readonly sessionStarted: boolean;
  readonly turnStarted: boolean;
  readonly turnCompleted: boolean;
  readonly observationKinds: readonly string[];
  readonly itemKinds: readonly string[];
  readonly processExitObserved: boolean;
  readonly stopped: boolean;
  readonly content: string;
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8")) as T;
}

describe("Codex app-server 0.145.0 contract fixtures", () => {
  test("pins the exact generated structured surface", async () => {
    const contract = await fixture<ContractFixture>("contract.json");
    expect(contract).toMatchObject({
      codexVersion: CODEX_APP_SERVER_VERSION,
      transport: "stdio-jsonl",
      experimentalApi: true,
      generatedSchema: {
        rawByteLength: 584366,
        canonicalization: "recursive-key-sort+compact-json",
        canonicalByteLength: 326909,
        sha256: CODEX_APP_SERVER_SCHEMA_SHA256,
      },
    });
    expect(contract.clientRequests).toEqual(
      expect.arrayContaining([
        "initialize",
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
      ]),
    );
    expect(contract.serverNotifications).toEqual(
      expect.arrayContaining([
        "thread/started",
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "error",
      ]),
    );
    expect(contract.serverRequests).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);
    expect(contract.unsupportedRunnerCommands).toHaveLength(8);
  });

  test("decodes every sanitized positive transcript envelope", async () => {
    const transcript = await fixture<TranscriptFixture>("transcript.json");
    expect(
      transcript.messages.map(
        ({ line }) => decodeCodexAppServerLine(line).kind,
      ),
    ).toEqual(transcript.messages.map(({ kind }) => kind));
    expect(JSON.stringify(transcript)).not.toMatch(
      /(?:token|authorization|sk-[A-Za-z0-9]|\/Users\/)/u,
    );
  });

  test("fails every malformed or future envelope with its safe code", async () => {
    const negative = await fixture<NegativeFixture>("negative.json");
    for (const fixtureCase of negative.cases) {
      try {
        decodeCodexAppServerLine(fixtureCase.line);
        throw new Error(`fixture unexpectedly decoded: ${fixtureCase.name}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CodexAppServerProtocolError);
        expect((error as CodexAppServerProtocolError).safeCode).toBe(
          fixtureCase.safeCode,
        );
      }
    }
  });

  test("retains only bounded exact-version live canary facts", async () => {
    const canary = await fixture<LiveCanaryFixture>("live-canary.json");
    expect(canary).toMatchObject({
      codexVersion: CODEX_APP_SERVER_VERSION,
      schemaSha256: CODEX_APP_SERVER_SCHEMA_SHA256,
      initialized: true,
      sessionStarted: true,
      turnStarted: true,
      turnCompleted: true,
      processExitObserved: true,
      stopped: true,
      content: "sanitized-counts-and-enums-only",
    });
    expect(canary.observationKinds).toEqual(
      expect.arrayContaining([
        "session.started",
        "turn.started",
        "item.started",
        "item.completed",
        "turn.completed",
        "process.exited",
      ]),
    );
    expect(canary.itemKinds).toEqual(["agentMessage", "userMessage"]);
    expect(JSON.stringify(canary)).not.toMatch(
      /(?:prompt|response|nativeSession|nativeTurn|\/Users\/|authorization)/u,
    );
  });
});
