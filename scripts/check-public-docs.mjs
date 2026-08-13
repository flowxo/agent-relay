import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");

const focusedDocuments = [
  "docs/architecture.md",
  "docs/install-upgrade-uninstall.md",
  "docs/telegram.md",
  "docs/web-companion.md",
  "docs/troubleshooting.md",
  "docs/compatibility.md",
  "docs/packaging.md",
  "docs/releasing.md",
  "docs/release-readiness.md",
  "docs/fixtures.md",
  "docs/extending-transports.md",
  "docs/outbound-webhooks.md",
  "docs/extending-harnesses.md",
  "docs/hosted-whooshbang.md",
  "docs/runner-bridge.md",
  "docs/v1-release-boundary.md",
  "docs/public-release-walkthrough.md",
  "packaging/release-notes.md",
];

const checkedDocuments = [
  "README.md",
  "CONTRIBUTING.md",
  ...focusedDocuments,
  "docs/onboarding.md",
  "docs/local-web-api.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "packaging/README.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/product/open-source-v1-charter.md",
];

async function text(path) {
  return await readFile(resolve(root, path), "utf8");
}

function requireText(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

async function assertFile(path, from) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new Error(`broken local documentation link in ${from}: ${path}`, {
      cause: error,
    });
  }
}

for (const path of checkedDocuments) {
  const source = await text(path);
  if (source.trim().length === 0) {
    throw new Error(`${path} must not be empty`);
  }

  const links = source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1]?.trim();
    if (
      target === undefined ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
    if (withoutFragment === undefined || withoutFragment.length === 0) {
      continue;
    }
    await assertFile(
      resolve(root, dirname(path), decodeURIComponent(withoutFragment)),
      path,
    );
  }
}

const readme = await text("README.md");
for (const path of focusedDocuments) {
  requireText(
    readme,
    new RegExp(`\\(${path.replaceAll(".", "\\.")}\\)`),
    `README.md must link ${path}`,
  );
}

const onboardingHeadings = [
  "### 1. Evaluate or install",
  "### 2. Inspect, install, and diagnose",
  "### 3. Prove the local loop",
  "### 4. Choose one transport",
  "### 5. Use a supported harness",
  "### 6. Reconcile an upgrade",
  "### 7. Uninstall owned integration",
  "### 8. Optionally erase retained data",
];
let previousOnboardingIndex = -1;
for (const heading of onboardingHeadings) {
  const index = readme.indexOf(heading);
  if (index === -1 || index <= previousOnboardingIndex) {
    throw new Error(`README onboarding order differs at: ${heading}`);
  }
  previousOnboardingIndex = index;
}

for (const [pattern, message] of [
  [/macOS on Apple silicon/, "README must state the supported OS/architecture"],
  [/Node\.js\s+22/, "README must state the supported runtime"],
  [/Cursor IDE\s+resume/i, "README must state Cursor IDE resume limitations"],
  [/~\/\.codex\/hooks\.json/, "README must disclose Codex config changes"],
  [/~\/\.claude\/settings\.json/, "README must disclose Claude config changes"],
  [/~\/\.cursor\/hooks\.json/, "README must disclose Cursor config changes"],
  [/Cloudflare\s+runtime/, "README must state the no-Cloudflare boundary"],
  [
    /private vulnerability reporting/i,
    "README must link private security reporting",
  ],
  [
    /no hosted Agent Relay account or public server/i,
    "README must keep direct Telegram independent of hosted onboarding",
  ],
  [
    /optional hosted WhooshBang account/i,
    "README must keep optional WhooshBang onboarding visible",
  ],
]) {
  requireText(readme, pattern, message);
}

const architecture = await text("docs/architecture.md");
for (const pattern of [
  /Native hook evidence/,
  /Supervised exit evidence/,
  /Inline continuation/,
  /Late CLI resume/,
  /Cursor IDE late resume is unsupported/,
  /SQLite is authoritative/,
]) {
  requireText(
    architecture,
    pattern,
    `architecture guide is missing boundary: ${String(pattern)}`,
  );
}

const installation = await text("docs/install-upgrade-uninstall.md");
const fakeCanary = installation.indexOf("## Start with the fake canary");
const directTelegram = installation.indexOf("direct Telegram setup");
if (fakeCanary === -1 || directTelegram === -1 || directTelegram < fakeCanary) {
  throw new Error(
    "installation guide must route users through fake canary first",
  );
}
for (const pattern of [
  /install --dry-run/,
  /daemon --transport fake --no-web/,
  /package:lifecycle:check/,
  /Reconcile an upgrade/,
  /refusing unsafe downgrade/,
  /Uninstall safely/,
  /Package-manager removal alone/,
  /Optional erasure/,
  /Roll back a candidate/,
]) {
  requireText(
    installation,
    pattern,
    `installation guide is missing lifecycle guidance: ${String(pattern)}`,
  );
}
const packagedReadme = await text("packaging/README.md");
requireText(
  packagedReadme,
  /agent-relay daemon --transport fake --no-web/,
  "packed onboarding must override retained transport state with fake",
);

const hosted = await text("docs/hosted-whooshbang.md");
for (const pattern of [
  /optional, replaceable/,
  /not required for local SQLite/,
  /does not require a hosted/,
  /Cloudflare runtime/,
  /Credential presence never selects a transport/,
  /no dual\s+send\s+or automatic failover/,
  /must not receive a raw hook payload/,
]) {
  requireText(
    hosted,
    pattern,
    `hosted boundary is missing required statement: ${String(pattern)}`,
  );
}

const localWebApi = await text("docs/local-web-api.md");
for (const pattern of [
  /Only `--port` is configurable/,
  /rejects `--db`, `--log`, and `--host`/,
  /cannot read another\s+database, write another log, or leave the loopback boundary/,
]) {
  requireText(
    localWebApi,
    pattern,
    `local web demo boundary is missing: ${String(pattern)}`,
  );
}

const runnerBridge = await text("docs/runner-bridge.md");
for (const pattern of [
  /default-off/,
  /not a notification transport/i,
  /StructuredHarnessDriver/,
  /no generic executable/,
  /runner-bridge\.sqlite/,
  /outcome_unknown/,
  /exact clean source commit/,
  /release_eligible: true/,
  /contracts:runner:update/,
  /default check mode does not write/i,
  /internal Gate 3 evidence/i,
  /never erases `relay\.sqlite`/,
]) {
  requireText(
    runnerBridge,
    pattern,
    `runner bridge guide is missing boundary: ${String(pattern)}`,
  );
}

const compatibility = await text("docs/compatibility.md");
for (const pattern of [
  /agent-relay-compatibility\.v1/,
  /runtime-validated/,
  /compatible-unverified/,
  /records that exact version as incompatible|known-incompatible/,
  /fail\s+closed/,
  /capabilities:generate/,
  /Runner-bridge compatibility evidence/,
  /internal-until-gate-5/,
]) {
  requireText(
    compatibility,
    pattern,
    `compatibility policy is missing generated-evidence guidance: ${String(pattern)}`,
  );
}

const releaseReadiness = await text("docs/release-readiness.md");
for (const pattern of [
  /What runs locally/,
  /What leaves the machine/,
  /What installation changes/,
  /How to diagnose/,
  /How to remove/,
  /pnpm release:exit/,
  /Node\.js 22\.23\.1/,
  /native arm64/,
  /globally linked workspace package/i,
  /PR #40/,
  /PR #41/,
  /native release-exit is \*\*green\*\*/i,
  /3b81a97c46763008f7831222384d1c89e2f79ffbdba2a920adc9767f02ce1106/,
  /does \*\*not\*\* contain PR #40/,
  /SQLite schema (?:is |version )`?10`?/,
  /does not publish/i,
]) {
  requireText(
    releaseReadiness,
    pattern,
    `release-readiness guide is missing evaluator guidance: ${String(pattern)}`,
  );
}

const support = await text("SUPPORT.md");
for (const pattern of [
  /agent-relay capabilities/,
  /compatibility classifications/,
  /evidence IDs/,
  /diagnostic IDs/,
  /without raw log lines/,
]) {
  requireText(
    support,
    pattern,
    `SUPPORT.md is missing safe compatibility-report guidance: ${String(pattern)}`,
  );
}

const releaseNotes = await text("packaging/release-notes.md");
for (const pattern of [
  /FXO-1574[\s\S]*approved one bounded[\s\S]*FXO-1164[\s\S]*publication/,
  /manifest's[\s\S]*build-time[\s\S]*`tagStatus`/,
  /Start here/,
  /Configuration, installer, schema, and privacy changes/,
  /Upgrade and rollback/,
  /Known limitations and publication gates/,
  /Exact artifact and provenance boundary/,
  /native release-exit is \*\*not green\*\*/i,
  /contains none of PR #40, PR #41, or PR #42/,
  /interactive 2FA bootstrap/,
  /no token is retained/,
]) {
  requireText(
    releaseNotes,
    pattern,
    `release notes are missing release boundary: ${String(pattern)}`,
  );
}

for (const path of [
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/docs.yml",
  ".github/ISSUE_TEMPLATE/security-change.yml",
]) {
  await assertFile(resolve(root, path), "public reporting paths");
}
const security = await text("SECURITY.md");
const issueConfig = await text(".github/ISSUE_TEMPLATE/config.yml");
const releasing = await text("docs/releasing.md");
for (const [source, pattern, message] of [
  [
    security,
    /security\/advisories\/new/,
    "private vulnerability path is missing",
  ],
  [support, /sanitized/i, "sanitized support-report path is missing"],
  [
    support,
    /https:\/\/github\.com\/flowxo\/agent-relay\/issues\/new\/choose/,
    "support issue-chooser route is missing",
  ],
  [
    issueConfig,
    /blank_issues_enabled:\s*false/,
    "blank public issues are not disabled",
  ],
  [
    issueConfig,
    /security\/advisories\/new/,
    "issue chooser private-security route is missing",
  ],
  [
    issueConfig,
    /https:\/\/github\.com\/flowxo\/agent-relay\/blob\/main\/SUPPORT\.md/,
    "issue chooser support route is missing",
  ],
  [
    issueConfig,
    /https:\/\/github\.com\/flowxo\/agent-relay\/blob\/main\/CONTRIBUTING\.md/,
    "issue chooser contribution route is missing",
  ],
  [
    releasing,
    /Rollback, deprecation, and compromise/,
    "release rollback path is missing",
  ],
  [
    releasing,
    /Do not delete or unpublish a normal bad prerelease/,
    "release yank policy is missing",
  ],
]) {
  requireText(source, pattern, message);
}

const combined = (
  await Promise.all(checkedDocuments.map(async (path) => await text(path)))
).join("\n");

const forbiddenPatterns = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/, "Telegram token shape"],
  [/\bgh[pousr]_[A-Za-z0-9]{12,}\b/, "GitHub token shape"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/, "OpenAI key shape"],
  [/\/Users\/[^./\s][^\s]*/, "macOS user path"],
  [/[A-Za-z]:\\Users\\[^\\\s]+/i, "Windows user path"],
  [
    /AGENT_RELAY_TELEGRAM_(?:CHAT_ID|OPERATOR_ID)\s*=\s*-?\d+/,
    "numeric Telegram identity",
  ],
];

for (const [pattern, label] of forbiddenPatterns) {
  if (pattern.test(combined)) {
    throw new Error(`public documentation contains a forbidden ${label}`);
  }
}

process.stdout.write(
  `Public documentation verified (${String(checkedDocuments.length)} files, ${String(focusedDocuments.length)} focused guides).\n`,
);
