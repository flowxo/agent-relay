import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  releaseArtifactNames,
  verifyReleaseBundle,
} from "./lib/release-bundle.mjs";
import { assertPublishContext } from "./lib/release-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, process.argv[2] ?? ".artifacts/release");
const execute = process.argv.includes("--execute");
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

const npmVersion = await new Promise((resolvePromise, reject) => {
  const child = spawn("npm", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-1000);
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) {
      resolvePromise(output.trim());
    } else {
      reject(new Error("npm --version failed"));
    }
  });
});

const action = assertPublishContext(release, {
  githubActions: process.env.GITHUB_ACTIONS,
  eventName: process.env.GITHUB_EVENT_NAME,
  publishInput: process.env.AGENT_RELAY_PUBLISH_INPUT,
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  repositoryVisibility: process.env.AGENT_RELAY_REPOSITORY_VISIBILITY,
  repository: process.env.GITHUB_REPOSITORY,
  workflow: process.env.AGENT_RELAY_RELEASE_WORKFLOW,
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
  environment: process.env.AGENT_RELAY_RELEASE_ENVIRONMENT,
  trustedPublisherConfigured:
    process.env.AGENT_RELAY_TRUSTED_PUBLISHER_CONFIGURED,
  npmVersion,
});
await verifyReleaseBundle({
  root,
  release,
  rootPackage,
  directory,
  expectedCommit: process.env.GITHUB_SHA,
  allowTagPromotion: true,
});

if (!execute) {
  process.stdout.write(
    `Registry ${action} is approved by policy but was not executed.\n`,
  );
  process.exit(0);
}

const names = releaseArtifactNames(release);
const tarball = resolve(directory, names.tarball);
const args =
  action === "stage"
    ? [
        "stage",
        "publish",
        tarball,
        "--tag",
        release.distTag,
        "--access",
        "public",
        "--registry",
        release.publication.registry,
      ]
    : [
        "publish",
        tarball,
        "--tag",
        release.distTag,
        "--access",
        "public",
        "--registry",
        release.publication.registry,
      ];

await new Promise((resolvePromise, reject) => {
  const child = spawn("npm", args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolvePromise();
    } else {
      reject(
        new Error(
          `npm ${action} failed (${String(code ?? signal ?? "unknown")})`,
        ),
      );
    }
  });
});
