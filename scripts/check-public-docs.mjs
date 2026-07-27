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
  "docs/fixtures.md",
  "docs/extending-transports.md",
  "docs/extending-harnesses.md",
  "docs/hosted-notifications.md",
];

const checkedDocuments = [
  "README.md",
  "CONTRIBUTING.md",
  ...focusedDocuments,
  "docs/onboarding.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
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
  /package:lifecycle:check/,
  /Reconcile an upgrade/,
  /refusing unsafe downgrade/,
  /Uninstall safely/,
  /Package-manager removal alone/,
  /Optional erasure/,
]) {
  requireText(
    installation,
    pattern,
    `installation guide is missing lifecycle guidance: ${String(pattern)}`,
  );
}

const hosted = await text("docs/hosted-notifications.md");
for (const pattern of [
  /optional, replaceable/,
  /not required for local SQLite/,
  /does not require a hosted/,
  /Cloudflare runtime/,
  /not selected by the production daemon/,
  /must not receive a raw hook payload/,
]) {
  requireText(
    hosted,
    pattern,
    `hosted boundary is missing required statement: ${String(pattern)}`,
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
]) {
  requireText(
    compatibility,
    pattern,
    `compatibility policy is missing generated-evidence guidance: ${String(pattern)}`,
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
