import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const decoder = new TextDecoder("utf-8", { fatal: true });
const maximumTextBytes = 4 * 1024 * 1024;
const approvedBinary =
  /^(?:vendor\/whooshbang-rc12-rc13-rc15\/whooshbang-(?:contracts-1\.0\.0-rc\.12|sdk-1\.0\.0-rc\.13|contract-mock-1\.0\.0-rc\.15)\.tgz|vendor\/whooshbang-rc4\/whooshbang-(?:contracts|sdk|contract-mock)-1\.0\.0-rc\.4\.tgz|vendor\/notifications-c0\/[^/]+\.tgz|vendor\/runner-protocol-v1\/session-(?:contracts|protocol-runner)-0\.0\.0\.tgz)$/;
const approvedSyntheticUser = /^(?:operator|private|private-owner)$/;

const secretPatterns = [
  {
    label: "Telegram bot token",
    pattern: new RegExp(
      ["\\b", "\\d{6,12}", ":", "[A-Za-z0-9_-]{20,}", "\\b"].join(""),
      "g",
    ),
  },
  {
    label: "GitHub token",
    pattern: new RegExp(
      ["\\b", "gh", "[pousr]_", "[A-Za-z0-9]{12,}", "\\b"].join(""),
      "g",
    ),
  },
  {
    label: "OpenAI API key",
    pattern: new RegExp(
      ["\\b", "sk", "-", "[A-Za-z0-9_-]{12,}", "\\b"].join(""),
      "g",
    ),
  },
  {
    label: "npm token",
    pattern: new RegExp(
      ["\\b", "npm", "_", "[A-Za-z0-9]{20,}", "\\b"].join(""),
      "g",
    ),
  },
  {
    label: "AWS access key",
    pattern: new RegExp(["\\b", "AKIA", "[A-Z0-9]{16}", "\\b"].join(""), "g"),
  },
  {
    label: "Slack token",
    pattern: new RegExp(
      ["\\b", "xox", "[baprs]", "-", "[A-Za-z0-9-]{10,}", "\\b"].join(""),
      "g",
    ),
  },
  {
    label: "private key",
    pattern: new RegExp(
      ["-----BEGIN ", "[A-Z ]*", "PRIVATE KEY-----"].join(""),
      "g",
    ),
  },
];

const sensitiveEnvironmentPattern = new RegExp(
  [
    "\\b(?:",
    [
      "AGENT_RELAY_DAEMON_TOKEN",
      "AGENT_RELAY_TELEGRAM_TOKEN",
      "AGENT_RELAY_TELEGRAM_CHAT_ID",
      "AGENT_RELAY_TELEGRAM_OPERATOR_ID",
      "AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
      "AGENT_RELAY_RECEIVER_SECRET",
      "AGENT_RELAY_WEBHOOK_URL",
      "AGENT_RELAY_WEBHOOK_SECRET",
      "AGENT_RELAY_WHOOSHBANG_BASE_URL",
      "AGENT_RELAY_WHOOSHBANG_PROJECT_CREDENTIAL",
      "AGENT_RELAY_WHOOSHBANG_PROJECT_SELECTOR",
      "AGENT_RELAY_WHOOSHBANG_SUBSCRIBER_ID",
      "AGENT_RELAY_WHOOSHBANG_NOTIFIER_ID",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ].join("|"),
    ")[ \\t]*=(?!=)[ \\t]*([^\\s#]+)",
  ].join(""),
  "g",
);

function fail(path, label) {
  throw new Error(
    `Repository secret boundary violation: ${path} contains ${label}`,
  );
}

function isTestPath(path) {
  return (
    /\.test\.[cm]?[jt]s$/.test(path) ||
    /\.e2e\.[cm]?[jt]s$/.test(path) ||
    /\.node-test\.mjs$/.test(path) ||
    path.endsWith(".snap")
  );
}

export function assertSafeTrackedPath(path) {
  const file = basename(path);
  if (file === ".env.example") {
    return;
  }
  if (
    file.startsWith(".env") ||
    [".npmrc", ".netrc", "web-credential.json", "credentials"].includes(file) ||
    ["id_rsa", "id_dsa", "id_ed25519"].includes(file) ||
    [".sqlite", ".db", ".log", ".pem", ".key", ".p12", ".pfx"].includes(
      extname(file).toLowerCase(),
    ) ||
    path.startsWith(".agent-relay/") ||
    path.includes("/.agent-relay/")
  ) {
    throw new Error(
      `Repository secret boundary violation: forbidden tracked path ${path}`,
    );
  }
}

export function scanTrackedText(path, source, environment = {}) {
  for (const { label, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const value = match[0];
      if (isTestPath(path) && /synthetic/i.test(value)) {
        continue;
      }
      fail(path, `a ${label} shape`);
    }
  }

  sensitiveEnvironmentPattern.lastIndex = 0;
  for (const match of source.matchAll(sensitiveEnvironmentPattern)) {
    const value = match[1];
    if (value !== undefined && /^(?:["']?<)/.test(value)) {
      continue;
    }
    if (
      path === ".env.example" &&
      (value === undefined || value.length === 0)
    ) {
      continue;
    }
    fail(path, "a populated sensitive environment assignment");
  }

  const macUserPattern = new RegExp(
    ["/", "Users", "/", "([A-Za-z0-9._-]+)"].join(""),
    "g",
  );
  for (const match of source.matchAll(macUserPattern)) {
    const user = match[1];
    if (isTestPath(path) && approvedSyntheticUser.test(user)) {
      continue;
    }
    fail(path, "a machine-specific macOS user path");
  }

  const windowsUserPattern = new RegExp(
    ["[A-Za-z]:", "\\\\", "Users", "\\\\", "([A-Za-z0-9._-]+)"].join(""),
    "gi",
  );
  for (const match of source.matchAll(windowsUserPattern)) {
    const user = match[1];
    if (isTestPath(path) && approvedSyntheticUser.test(user)) {
      continue;
    }
    fail(path, "a machine-specific Windows user path");
  }

  for (const [label, value] of [
    ["current checkout path", environment.cwd],
    ["current home path", environment.home],
  ]) {
    if (
      typeof value === "string" &&
      value.length > 1 &&
      source.includes(value)
    ) {
      fail(path, label);
    }
  }
}

export async function checkTrackedRepository({
  repositoryRoot = root,
  currentHome = homedir(),
} = {}) {
  const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
    runFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
    runFile("git", ["ls-files", "-z", "--deleted"], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const deletedPaths = new Set(
    deletedStdout
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0),
  );
  const paths = stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !deletedPaths.has(path))
    .sort();

  let textFiles = 0;
  let binaryFiles = 0;
  for (const path of paths) {
    assertSafeTrackedPath(path);
    const contents = await readFile(resolve(repositoryRoot, path));
    if (contents.length > maximumTextBytes) {
      if (approvedBinary.test(path)) {
        binaryFiles += 1;
        continue;
      }
      throw new Error(
        `Repository secret boundary violation: ${path} exceeds the reviewable text limit`,
      );
    }
    let source;
    try {
      source = decoder.decode(contents);
    } catch {
      if (approvedBinary.test(path)) {
        binaryFiles += 1;
        continue;
      }
      throw new Error(
        `Repository secret boundary violation: unexpected binary file ${path}`,
      );
    }
    if (source.includes("\0")) {
      if (approvedBinary.test(path)) {
        binaryFiles += 1;
        continue;
      }
      throw new Error(
        `Repository secret boundary violation: unexpected binary file ${path}`,
      );
    }
    scanTrackedText(path, source, {
      cwd: repositoryRoot,
      home: currentHome,
    });
    textFiles += 1;
  }

  return { binaryFiles, textFiles, trackedFiles: paths.length };
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const result = await checkTrackedRepository();
  process.stdout.write(
    `Repository secret boundary verified (${String(result.trackedFiles)} tracked/unignored files; ${String(result.textFiles)} text, ${String(result.binaryFiles)} pinned binary artifacts).\n`,
  );
}
