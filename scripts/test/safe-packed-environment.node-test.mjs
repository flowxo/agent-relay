import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

import {
  packageProofToolEnvironment,
  safePackedRuntimeEnvironment,
} from "../lib/safe-packed-environment.mjs";

test("package-proof tools strip provider and registry credential variables", () => {
  const environment = packageProofToolEnvironment({
    ambientEnvironment: {
      PATH: "/isolated/bin:/usr/bin",
      HOME: "/real/home",
      AGENT_RELAY_TRANSPORT: "webhook",
      AGENT_RELAY_WEBHOOK_SECRET: "synthetic-private-material",
      NPM_TOKEN: "synthetic-registry-material",
      "npm_config_//registry.npmjs.org/:_authToken": "synthetic-auth-material",
      HTTPS_PROXY: "https://synthetic-private-material@example.test",
      SENTRY_AUTH_TOKEN: "synthetic-unlisted-material",
      GITLAB_TOKEN: "synthetic-unlisted-material",
      GOOGLE_API_KEY: "synthetic-unlisted-material",
      AWS_PROFILE: "synthetic-private-profile",
      DYLD_INSERT_LIBRARIES: "/synthetic/private-hook.dylib",
    },
    home: "/isolated/home",
    temporaryRoot: "/isolated/tmp",
    userConfigPath: "/isolated/home/empty-npmrc",
    overrides: { SOURCE_DATE_EPOCH: "123" },
  });

  assert.equal(environment.PATH, "/isolated/bin:/usr/bin");
  assert.equal(environment.HOME, "/isolated/home");
  assert.equal(environment.USERPROFILE, "/isolated/home");
  assert.equal(environment.NPM_CONFIG_USERCONFIG, "/isolated/home/empty-npmrc");
  assert.equal(environment.CI, "1");
  assert.equal(environment.SOURCE_DATE_EPOCH, "123");
  assert.equal(environment.AGENT_RELAY_TRANSPORT, undefined);
  assert.equal(environment.AGENT_RELAY_WEBHOOK_SECRET, undefined);
  assert.equal(environment.NPM_TOKEN, undefined);
  assert.equal(
    environment["npm_config_//registry.npmjs.org/:_authToken"],
    undefined,
  );
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.SENTRY_AUTH_TOKEN, undefined);
  assert.equal(environment.GITLAB_TOKEN, undefined);
  assert.equal(environment.GOOGLE_API_KEY, undefined);
  assert.equal(environment.AWS_PROFILE, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.notEqual(environment.HOME, "/real/home");
});

test("packed proofs use an explicit fake-only environment", () => {
  const hostileAmbientEnvironment = {
    AGENT_RELAY_TRANSPORT: "webhook",
    AGENT_RELAY_WEBHOOK_URL: "https://receiver.example.test/events",
    AGENT_RELAY_WEBHOOK_SECRET: "synthetic-private-material",
    AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL: "synthetic-project-material",
    AGENT_RELAY_TELEGRAM_TOKEN: "synthetic-telegram-material",
  };
  Object.assign(process.env, hostileAmbientEnvironment);
  try {
    const environment = safePackedRuntimeEnvironment({
      home: "/isolated/home",
      pathEntries: ["/isolated/bin", "/usr/bin"],
      stateDirectory: "/isolated/home/.agent-relay",
      temporaryRoot: "/isolated/tmp",
      webEnabled: false,
    });

    assert.equal(environment.AGENT_RELAY_TRANSPORT, "fake");
    assert.equal(environment.AGENT_RELAY_WEB_ENABLED, "0");
    for (const name of Object.keys(hostileAmbientEnvironment)) {
      if (name !== "AGENT_RELAY_TRANSPORT") {
        assert.equal(environment[name], undefined);
      }
    }
  } finally {
    for (const name of Object.keys(hostileAmbientEnvironment)) {
      delete process.env[name];
    }
  }
});

test("package proofs retain the allowlisted fake-only runtime boundary", async () => {
  for (const path of [
    "../check-package.mjs",
    "../check-package-lifecycle.mjs",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /safePackedRuntimeEnvironment\(/);
    assert.match(source, /packageProofToolEnvironment\(\{/);
    assert.doesNotMatch(source, /\.\.\.process\.env/);
    assert.match(
      source,
      /\["daemon", "--transport", "fake", "--port", String\(port\)\]/,
    );
  }

  const releaseBundle = await readFile(
    new URL("../lib/release-bundle.mjs", import.meta.url),
    "utf8",
  );
  assert.match(releaseBundle, /packageProofToolEnvironment\(\{/);
  assert.match(releaseBundle, /sanitizedReleaseOutput\(/);
  assert.doesNotMatch(releaseBundle, /\.\.\.process\.env/);
  assert.doesNotMatch(releaseBundle, /\$\{executable\} \$\{args\.join/);
});

test("offline package proofs vendor the complete runtime dependency graph", async () => {
  for (const path of [
    "../check-package.mjs",
    "../check-package-lifecycle.mjs",
    "../check-hosted-package.mjs",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /runtimeDependencyGraph\(root, release\)/);
    assert.match(source, /dependencyOverrides\[dependency\.name\]/);
    assert.match(source, /resolve\(prefix, "pnpm-workspace\.yaml"\)/);
    assert.match(source, /"--offline"/);
  }
});
