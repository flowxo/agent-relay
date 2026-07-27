import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");

const requiredDocuments = [
  "LICENSE",
  "SECURITY.md",
  "PRIVACY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "MAINTAINERS.md",
];

const packageManifests = [
  "package.json",
  "apps/relay/package.json",
  "packages/core/package.json",
  "packages/harnesses/package.json",
  "packages/notifications-transport/package.json",
  "packages/protocol/package.json",
];

async function text(path) {
  return await readFile(resolve(root, path), "utf8");
}

function requireText(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

for (const path of requiredDocuments) {
  const source = await text(path);
  if (source.trim().length === 0) {
    throw new Error(`${path} must not be empty`);
  }
}

const license = await text("LICENSE");
requireText(license, /^MIT License$/m, "LICENSE must contain the MIT heading");
requireText(
  license,
  /^Copyright \(c\) 2026 Flow XO, LLC$/m,
  "LICENSE must contain the approved copyright notice",
);
requireText(
  license,
  /Permission is hereby granted, free of charge/,
  "LICENSE must contain the standard MIT grant",
);

for (const path of packageManifests) {
  const manifest = JSON.parse(await text(path));
  if (manifest.license !== "MIT") {
    throw new Error(`${path} must declare license MIT`);
  }
}

const security = await text("SECURITY.md");
requireText(
  security,
  /https:\/\/github\.com\/flowxo\/agent-relay\/security\/advisories\/new/,
  "SECURITY.md must link to GitHub private vulnerability reporting",
);
requireText(
  security,
  /required public-promotion gate/i,
  "SECURITY.md must preserve the private-reporting promotion gate",
);
if (/mailto:/i.test(security)) {
  throw new Error("SECURITY.md must not advertise an unverified email address");
}

const privacy = await text("PRIVACY.md");
for (const [pattern, message] of [
  [/no product\s+analytics/i, "PRIVACY.md must state the telemetry default"],
  [/relay\.sqlite/, "PRIVACY.md must describe SQLite state"],
  [/bounded agent summaries/i, "PRIVACY.md must describe stored agent content"],
  [/direct Telegram sends/i, "PRIVACY.md must describe Telegram outbound data"],
  [
    /agent-relay uninstall/,
    "PRIVACY.md must describe uninstall before erasure",
  ],
  [
    /package-manager removal alone/i,
    "PRIVACY.md must distinguish package removal",
  ],
]) {
  requireText(privacy, pattern, message);
}

const support = await text("SUPPORT.md");
for (const pattern of [
  /macOS on Apple silicon/,
  /Node\.js 22/,
  /relay\.sqlite/,
  /tokens/,
  /transcripts/,
  /working paths/,
]) {
  requireText(
    support,
    pattern,
    `SUPPORT.md is missing required safe-report guidance: ${String(pattern)}`,
  );
}

const maintainers = await text("MAINTAINERS.md");
for (const pattern of [
  /protocol schemas/,
  /execution-authority/,
  /installer paths/,
  /SQLite migrations/,
  /transport authentication/,
  /supported capability/,
]) {
  requireText(
    maintainers,
    pattern,
    `MAINTAINERS.md is missing a required review gate: ${String(pattern)}`,
  );
}

const issueConfig = await text(".github/ISSUE_TEMPLATE/config.yml");
requireText(
  issueConfig,
  /^blank_issues_enabled: false$/m,
  "public blank issues must remain disabled",
);
requireText(
  issueConfig,
  /security\/advisories\/new/,
  "issue chooser must link private vulnerability reporting",
);

const bugTemplate = await text(".github/ISSUE_TEMPLATE/bug.yml");
for (const pattern of [
  /Never paste tokens/,
  /SQLite data/,
  /raw logs/,
  /transcripts/,
  /machine-specific\s+paths/,
  /Redacted doctor result/,
  /Safe capability record/,
  /Relevant diagnostic IDs/,
  /exact version/,
  /This is not a vulnerability/,
]) {
  requireText(
    bugTemplate,
    pattern,
    `bug template is missing required privacy guidance: ${String(pattern)}`,
  );
}

const readme = await text("README.md");
for (const path of requiredDocuments) {
  requireText(
    readme,
    new RegExp(`\\(${path.replaceAll(".", "\\.")}\\)`),
    `README.md must link ${path}`,
  );
}

process.stdout.write(
  `Governance boundary verified (${String(requiredDocuments.length)} policies, ${String(packageManifests.length)} package manifests).\n`,
);
