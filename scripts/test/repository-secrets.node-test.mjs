import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeTrackedPath,
  scanTrackedText,
} from "../check-repository-secrets.mjs";

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
    scanTrackedText("src/example.ts", "const value = 'synthetic';\n"),
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
  const assignment = ["NPM", "_TOKEN", "=", "actual-value"].join("");
  assert.throws(
    () => scanTrackedText("release.txt", assignment),
    /populated sensitive environment assignment/,
  );
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
