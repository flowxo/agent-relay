import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const manifestPath = resolve(repositoryRoot, "sdlc/checks.json");

export async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function manifestDigest(manifest) {
  return createHash("sha256")
    .update(`${JSON.stringify(manifest)}\n`)
    .digest("hex");
}

function globExpression(glob) {
  let expression = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

export function matchesAny(path, patterns) {
  return patterns.some((pattern) => globExpression(pattern).test(path));
}

export function normalizeChangedPath(input) {
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error(
      `SDLC classification refused unsafe changed path ${JSON.stringify(input)}`,
    );
  }
  return path;
}

export function classifyFiles(manifest, inputs) {
  const files = [...new Set(inputs.map(normalizeChangedPath))].sort();
  const documentationOnly =
    files.length > 0 &&
    files.every((path) => matchesAny(path, manifest.documentationOnly));
  const risks = new Set();
  const matches = {};
  const unrecognized = [];

  if (documentationOnly) {
    risks.add("docs");
    for (const path of files) {
      matches[path] = ["documentation-only"];
    }
  } else {
    for (const path of files) {
      const matchedRules = manifest.rules.filter((rule) =>
        matchesAny(path, rule.patterns),
      );
      matches[path] = matchedRules.map((rule) => rule.id);
      if (matchedRules.length === 0) {
        unrecognized.push(path);
        for (const risk of manifest.fallbackRisks) {
          risks.add(risk);
        }
      } else {
        for (const rule of matchedRules) {
          for (const risk of rule.risks) {
            risks.add(risk);
          }
        }
      }
    }
  }

  if (files.length === 0) {
    risks.add("shared");
  }

  const riskList = [...risks].sort();
  const selectedGroups = selectedChecks(manifest, "pr", riskList).reduce(
    (groups, check) => {
      groups.add(check.group);
      return groups;
    },
    new Set(),
  );
  return {
    schema: "agent-relay-change-classification.v1",
    files,
    documentationOnly,
    risks: riskList,
    matches,
    unrecognized,
    groups: [...selectedGroups].sort(),
    uxEvidenceRequired: riskList.includes("ux"),
  };
}

export function selectedChecks(manifest, phase, risks, options = {}) {
  if (!["fast", "pr", "release"].includes(phase)) {
    throw new Error(`unknown SDLC phase ${phase}`);
  }
  const riskSet = new Set(risks);
  const requestedGroups =
    options.groups === undefined ? undefined : new Set(options.groups);
  const requestedChecks =
    options.only === undefined ? undefined : new Set(options.only);
  const selected = manifest.checks.filter((check) => {
    if (!check.phases.includes(phase)) return false;
    if (requestedGroups !== undefined && !requestedGroups.has(check.group)) {
      return false;
    }
    if (requestedChecks !== undefined && !requestedChecks.has(check.id)) {
      return false;
    }
    if (phase === "release" || check.always === true) return true;
    return check.whenRisks?.some((risk) => riskSet.has(risk)) === true;
  });
  const superseded = new Set(
    selected.flatMap((check) => check.supersedes ?? []),
  );
  return selected.filter((check) => !superseded.has(check.id));
}

async function runGit(
  args,
  { allowFailure = false, cwd = repositoryRoot } = {},
) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code, stdout: Buffer.concat(stdout), stderr });
      } else {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
      }
    });
  });
}

function nullSeparated(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

async function resolvesCommit(reference, root = repositoryRoot) {
  const result = await runGit(
    ["rev-parse", "--verify", `${reference}^{commit}`],
    {
      allowFailure: true,
      cwd: root,
    },
  );
  return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

export async function defaultComparisonBase(
  head = "HEAD",
  root = repositoryRoot,
) {
  for (const reference of ["origin/dev", "origin/main", "dev", "main"]) {
    const commit = await resolvesCommit(reference, root);
    if (commit !== undefined) {
      const mergeBase = await runGit(["merge-base", commit, head], {
        cwd: root,
      });
      return mergeBase.stdout.toString("utf8").trim();
    }
  }
  const parent = await resolvesCommit(`${head}^`, root);
  return parent ?? (await resolvesCommit(head, root));
}

export async function changedFiles({
  base,
  head = "HEAD",
  includeWorkingTree,
  root = repositoryRoot,
}) {
  const resolvedHead = await resolvesCommit(head, root);
  if (resolvedHead === undefined) {
    throw new Error(`SDLC classification could not resolve head ${head}`);
  }
  const resolvedBase =
    base === undefined
      ? await defaultComparisonBase(resolvedHead, root)
      : await resolvesCommit(base, root);
  if (resolvedBase === undefined) {
    throw new Error(
      `SDLC classification could not resolve base ${base ?? "automatically"}; fetch origin/dev and origin/main, then retry`,
    );
  }
  const mergeBase = await runGit(["merge-base", resolvedBase, resolvedHead], {
    cwd: root,
  });
  const comparisonBase = mergeBase.stdout.toString("utf8").trim();
  const committed = await runGit(
    [
      "diff",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      "-z",
      `${comparisonBase}...${resolvedHead}`,
    ],
    { cwd: root },
  );
  const paths = nullSeparated(committed.stdout);

  if (includeWorkingTree === true && head === "HEAD") {
    const [working, staged, untracked] = await Promise.all([
      runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z"], {
        cwd: root,
      }),
      runGit(
        ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"],
        { cwd: root },
      ),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: root,
      }),
    ]);
    paths.push(
      ...nullSeparated(working.stdout),
      ...nullSeparated(staged.stdout),
      ...nullSeparated(untracked.stdout),
    );
  }
  return {
    base: comparisonBase,
    head: resolvedHead,
    files: [...new Set(paths)].sort(),
  };
}

export async function appendGithubOutput(path, values) {
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${String(value)}`,
  );
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
