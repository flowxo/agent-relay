import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertSafeTrackedPath,
  checkTrackedRepository,
  scanTrackedText,
} from "../check-repository-secrets.mjs";

const runFile = promisify(execFile);

test("accepts ordinary source and blank environment examples", () => {
  assert.doesNotThrow(() =>
    scanTrackedText(
      ".env.example",
      [
        "AGENT_RELAY_TELEGRAM_TOKEN",
        "=",
        "\n",
        "AGENT_RELAY_TELEGRAM_CHAT_ID",
        "=",
        "\n",
      ].join(""),
    ),
  );
  assert.doesNotThrow(() =>
    scanTrackedText(
      "docs/setup.md",
      "AGENT_RELAY_TELEGRAM_TOKEN=<bot token>\n",
    ),
  );
  assert.doesNotThrow(() =>
    scanTrackedText(
      "docs/setup.md",
      "AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID='<subscriber-id>'\n",
    ),
  );
  assert.doesNotThrow(() =>
    scanTrackedText("src/example.ts", "const value = 'synthetic';\n"),
  );
  assert.doesNotThrow(() =>
    scanTrackedText(
      "src/example.ts",
      "environment.AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL === undefined;\n",
    ),
  );
});

test("rejects secret-shaped values while allowing explicit synthetic tests", () => {
  const prefix = ["123456", ":"].join("");
  const token = `${prefix}${"a".repeat(24)}`;
  assert.throws(
    () => scanTrackedText("src/example.ts", `const token = "${token}";`),
    /Telegram bot token shape/,
  );
  assert.doesNotThrow(() =>
    scanTrackedText(
      "src/example.test.ts",
      'const token = "123456:synthetic-token-value";',
    ),
  );
});

test("rejects populated sensitive environment assignments", () => {
  for (const assignment of [
    ["NPM", "_TOKEN", "=", "actual-value"].join(""),
    ["AGENT_RELAY_WEBHOOK", "_SECRET=actual-value"].join(""),
    ["AGENT_RELAY_RECEIVER", "_SECRET=actual-value"].join(""),
    ["AGENT_RELAY_WEBHOOK", "_URL=https://private.example.test/events"].join(
      "",
    ),
    ["AGENT_RELAY_WHOOSHBANG_PROJECT", "_CREDENTIAL=actual-value"].join(""),
    ["AGENT_RELAY_WHOOSHBANG_SUBSCRIBER", "_ID=private-subscriber"].join(""),
  ]) {
    assert.throws(
      () => scanTrackedText("release.txt", assignment),
      /populated sensitive environment assignment/,
    );
  }
});

test("rejects machine user paths except bounded redaction tests", () => {
  const actual = ["", "Users", "real-person", "project"].join("/");
  assert.throws(
    () => scanTrackedText("src/example.ts", actual),
    /machine-specific macOS user path/,
  );
  const synthetic = ["", "Users", "operator", "private"].join("/");
  assert.doesNotThrow(() =>
    scanTrackedText("src/redaction.test.ts", synthetic),
  );
});

test("rejects the active checkout and home paths without echoing them", () => {
  assert.throws(
    () =>
      scanTrackedText("evidence.txt", "prefix/private/root/suffix", {
        cwd: "/private/root",
        home: "/private/home",
      }),
    /current checkout path/,
  );
});

test("rejects credential, database, key, and local-state filenames", () => {
  for (const path of [
    ".env.activation",
    ".npmrc",
    "state/relay.sqlite",
    "logs/relay.log",
    "keys/release.pem",
    ".agent-relay/web-credential.json",
  ]) {
    assert.throws(() => assertSafeTrackedPath(path), /forbidden tracked path/);
  }
  assert.doesNotThrow(() => assertSafeTrackedPath(".env.example"));
});

test("scans a dirty tree without reopening intentionally deleted files", async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "agent-relay-secret-scan-"),
  );
  try {
    await runFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await writeFile(
      join(repositoryRoot, "retired-fixture.json"),
      '{"synthetic":true}\n',
    );
    await runFile("git", ["add", "retired-fixture.json"], {
      cwd: repositoryRoot,
    });
    await unlink(join(repositoryRoot, "retired-fixture.json"));
    await writeFile(
      join(repositoryRoot, "replacement-fixture.json"),
      '{"synthetic":true}\n',
    );

    const result = await checkTrackedRepository({
      repositoryRoot,
      currentHome: "/private/home",
    });

    assert.deepEqual(result, {
      binaryFiles: 0,
      textFiles: 1,
      trackedFiles: 1,
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
