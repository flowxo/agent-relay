import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { Harness } from "@agent-relay/protocol";
import { z } from "zod";

const INSTALL_SCHEMA = "agent-relay-install.v1";
const INSTALL_VERSION = "1";
const OWNER_MARKER = "AGENT_RELAY_HOOK_OWNER=agent-relay-v1";
const MAX_CONFIG_BYTES = 1024 * 1024;

const HarnessVersionMapSchema = z
  .object({
    codex: z.string().min(1).max(120),
    claude: z.string().min(1).max(120),
    cursor: z.string().min(1).max(120),
  })
  .strict();

const InstallManifestSchema = z
  .object({
    schema: z.literal(INSTALL_SCHEMA),
    version: z.literal(INSTALL_VERSION),
    installedAt: z.iso.datetime({ offset: true }),
    launcherPath: z.string().min(1),
    entryPath: z.string().min(1),
    nodePath: z.string().min(1),
    cursorSurface: z.enum(["cli", "ide"]),
    harnessVersions: HarnessVersionMapSchema,
    targets: z.array(
      z
        .object({
          harness: z.enum(["codex", "claude", "cursor"]),
          configPath: z.string().min(1),
          created: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

type InstallManifest = z.infer<typeof InstallManifestSchema>;
export type HarnessVersionMap = z.infer<typeof HarnessVersionMapSchema>;

export interface InstallerPaths {
  rootDir: string;
  stateDir: string;
  launcherPath: string;
  manifestPath: string;
  configs: Record<Harness, string>;
}

export interface InstallOptions {
  rootDir: string;
  entryPath: string;
  nodePath?: string;
  cursorSurface?: "cli" | "ide";
  harnessVersions?: Partial<HarnessVersionMap>;
  now?: () => Date;
  dryRun?: boolean;
}

export interface InstallFileAction {
  path: string;
  kind: "create" | "update" | "delete" | "unchanged";
  backupPath?: string;
}

export interface InstallResult {
  operation: "install" | "uninstall";
  changed: boolean;
  dryRun: boolean;
  paths: InstallerPaths;
  actions: InstallFileAction[];
}

export interface InstallationCheck {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  detail: string;
}

export interface InstallationReport {
  healthy: boolean;
  installed: boolean;
  checks: InstallationCheck[];
  paths: InstallerPaths;
}

interface FileSnapshot {
  exists: boolean;
  content?: string;
  mode?: number;
}

interface PlannedFile {
  path: string;
  desired?: string;
  mode: number;
  backup: boolean;
}

interface MutableJsonObject {
  [key: string]: unknown;
}

const TARGET_EVENTS: Record<Harness, readonly string[]> = {
  codex: ["Stop", "PermissionRequest"],
  claude: ["Stop", "StopFailure", "PermissionRequest"],
  cursor: ["stop"],
};

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertSafeRoot(rootInput: string): string {
  const rootDir = resolve(rootInput);
  if (rootDir === parse(rootDir).root) {
    throw new Error("installer root cannot be the filesystem root");
  }
  if (/[\0\r\n]/.test(rootDir)) {
    throw new Error("installer root contains unsupported control characters");
  }
  return rootDir;
}

export function installerPaths(rootInput: string): InstallerPaths {
  const rootDir = assertSafeRoot(rootInput);
  const stateDir = join(rootDir, ".agent-relay");
  return {
    rootDir,
    stateDir,
    launcherPath: join(stateDir, "bin", "agent-relay"),
    manifestPath: join(stateDir, "install.json"),
    configs: {
      codex: join(rootDir, ".codex", "hooks.json"),
      claude: join(rootDir, ".claude", "settings.json"),
      cursor: join(rootDir, ".cursor", "hooks.json"),
    },
  };
}

function quoteShellArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("hook command argument contains unsupported characters");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizedVersions(
  input: Partial<HarnessVersionMap> | undefined,
): HarnessVersionMap {
  return HarnessVersionMapSchema.parse({
    codex: input?.codex ?? "unknown",
    claude: input?.claude ?? "unknown",
    cursor: input?.cursor ?? "unknown",
  });
}

function hookCommand(
  paths: InstallerPaths,
  harness: Harness,
  harnessVersion: string,
  cursorSurface: "cli" | "ide",
): string {
  const surface = harness === "cursor" ? ` --surface ${cursorSurface}` : "";
  return [
    OWNER_MARKER,
    `AGENT_RELAY_STATE_DIR=${quoteShellArgument(paths.stateDir)}`,
    quoteShellArgument(paths.launcherPath),
    "hook",
    harness,
    surface.trim(),
    "--harness-version",
    quoteShellArgument(harnessVersion),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function commandHandler(command: string): MutableJsonObject {
  return {
    type: "command",
    command,
    timeout: 5,
    statusMessage: "Relaying agent attention",
  };
}

function cursorHandler(command: string): MutableJsonObject {
  return {
    command,
    timeout: 5,
    failClosed: false,
  };
}

function isObject(value: unknown): value is MutableJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedHandler(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value["command"] === "string" &&
    value["command"].startsWith(`${OWNER_MARKER} `)
  );
}

function ensureHooksObject(root: MutableJsonObject): MutableJsonObject {
  const hooks = root["hooks"];
  if (hooks === undefined) {
    const created: MutableJsonObject = {};
    root["hooks"] = created;
    return created;
  }
  if (!isObject(hooks)) {
    throw new Error("config hooks field must be a JSON object");
  }
  return hooks;
}

function filterNestedEvent(hooks: MutableJsonObject, eventName: string): void {
  const groups = hooks[eventName];
  if (groups === undefined) {
    return;
  }
  if (!Array.isArray(groups)) {
    throw new Error(`${eventName} hook groups must be an array`);
  }
  const filteredGroups: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group)) {
      filteredGroups.push(group);
      continue;
    }
    const handlers = group["hooks"];
    if (!Array.isArray(handlers)) {
      filteredGroups.push(group);
      continue;
    }
    const filteredHandlers = handlers.filter(
      (handler) => !isOwnedHandler(handler),
    );
    if (filteredHandlers.length > 0) {
      filteredGroups.push({ ...group, hooks: filteredHandlers });
      continue;
    }
    const otherKeys = Object.keys(group).filter((key) => key !== "hooks");
    if (otherKeys.length > 0) {
      filteredGroups.push({ ...group, hooks: [] });
    }
  }
  if (filteredGroups.length === 0) {
    delete hooks[eventName];
  } else {
    hooks[eventName] = filteredGroups;
  }
}

function patchNestedConfig(
  input: MutableJsonObject,
  harness: "codex" | "claude",
  command: string | undefined,
): MutableJsonObject {
  const root = structuredClone(input);
  const existingHooks = root["hooks"];
  if (existingHooks !== undefined && !isObject(existingHooks)) {
    throw new Error("config hooks field must be a JSON object");
  }
  if (existingHooks !== undefined) {
    for (const eventName of TARGET_EVENTS[harness]) {
      filterNestedEvent(existingHooks, eventName);
    }
  }
  if (command !== undefined) {
    const hooks = ensureHooksObject(root);
    for (const eventName of TARGET_EVENTS[harness]) {
      const groups = hooks[eventName];
      const existingGroups = groups === undefined ? [] : groups;
      if (!Array.isArray(existingGroups)) {
        throw new Error(`${eventName} hook groups must be an array`);
      }
      hooks[eventName] = [
        ...existingGroups,
        { hooks: [commandHandler(command)] },
      ];
    }
  }
  if (isObject(root["hooks"]) && Object.keys(root["hooks"]).length === 0) {
    delete root["hooks"];
  }
  return root;
}

function patchCursorConfig(
  input: MutableJsonObject,
  command: string | undefined,
): MutableJsonObject {
  const root = structuredClone(input);
  const version = root["version"];
  if (version !== undefined && version !== 1) {
    throw new Error("Cursor hooks config version must be 1");
  }
  const existingHooks = root["hooks"];
  if (existingHooks !== undefined && !isObject(existingHooks)) {
    throw new Error("Cursor hooks field must be a JSON object");
  }
  if (existingHooks !== undefined) {
    for (const eventName of TARGET_EVENTS.cursor) {
      const handlers = existingHooks[eventName];
      if (handlers === undefined) {
        continue;
      }
      if (!Array.isArray(handlers)) {
        throw new Error(`Cursor ${eventName} hooks must be an array`);
      }
      const filtered = handlers.filter((handler) => !isOwnedHandler(handler));
      if (filtered.length === 0) {
        delete existingHooks[eventName];
      } else {
        existingHooks[eventName] = filtered;
      }
    }
  }
  if (command !== undefined) {
    root["version"] = 1;
    const hooks = ensureHooksObject(root);
    for (const eventName of TARGET_EVENTS.cursor) {
      const handlers = hooks[eventName];
      const existingHandlers = handlers === undefined ? [] : handlers;
      if (!Array.isArray(existingHandlers)) {
        throw new Error(`Cursor ${eventName} hooks must be an array`);
      }
      hooks[eventName] = [...existingHandlers, cursorHandler(command)];
    }
  }
  if (isObject(root["hooks"]) && Object.keys(root["hooks"]).length === 0) {
    delete root["hooks"];
  }
  return root;
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(
        `${basename(path)} is ${metadata.size} bytes; installer limit is ${MAX_CONFIG_BYTES}`,
      );
    }
    return {
      exists: true,
      content: await readFile(path, "utf8"),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { exists: false };
    }
    throw error;
  }
}

function parseConfig(path: string, file: FileSnapshot): MutableJsonObject {
  if (!file.exists) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content ?? "") as unknown;
  } catch (error) {
    throw new Error(`${basename(path)} is not valid JSON`, { cause: error });
  }
  if (!isObject(parsed)) {
    throw new Error(`${basename(path)} must contain a JSON object`);
  }
  return parsed;
}

function serializeConfig(config: MutableJsonObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function atomicWrite(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode,
    flag: "wx",
  });
  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          "atomic config write and cleanup both failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

async function restoreSnapshot(
  path: string,
  file: FileSnapshot,
): Promise<void> {
  if (!file.exists) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    return;
  }
  await atomicWrite(path, file.content ?? "", file.mode ?? 0o600);
}

function backupSuffix(now: Date): string {
  return now.toISOString().replaceAll(/[-:.]/g, "");
}

async function applyPlan(
  plans: PlannedFile[],
  now: Date,
  dryRun: boolean,
): Promise<InstallFileAction[]> {
  const snapshots = new Map<string, FileSnapshot>();
  const actions: InstallFileAction[] = [];
  for (const plan of plans) {
    const before = await snapshot(plan.path);
    snapshots.set(plan.path, before);
    const unchanged =
      plan.desired === undefined
        ? !before.exists
        : before.exists && before.content === plan.desired;
    actions.push({
      path: plan.path,
      kind: unchanged
        ? "unchanged"
        : plan.desired === undefined
          ? "delete"
          : before.exists
            ? "update"
            : "create",
    });
  }
  if (dryRun) {
    return actions;
  }

  for (const [index, plan] of plans.entries()) {
    const action = actions[index];
    const before = snapshots.get(plan.path);
    if (
      action === undefined ||
      before === undefined ||
      action.kind === "unchanged" ||
      !plan.backup ||
      !before.exists
    ) {
      continue;
    }
    const backupPath =
      `${plan.path}.agent-relay-backup-${backupSuffix(now)}-` +
      randomUUID().slice(0, 8);
    await copyFile(plan.path, backupPath, constants.COPYFILE_EXCL);
    await chmod(backupPath, 0o600);
    action.backupPath = backupPath;
  }

  const mutated: PlannedFile[] = [];
  try {
    for (const [index, plan] of plans.entries()) {
      const action = actions[index];
      if (action === undefined || action.kind === "unchanged") {
        continue;
      }
      if (plan.desired === undefined) {
        await unlink(plan.path);
      } else {
        await atomicWrite(plan.path, plan.desired, plan.mode);
      }
      mutated.push(plan);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const plan of mutated.reverse()) {
      try {
        await restoreSnapshot(
          plan.path,
          snapshots.get(plan.path) ?? { exists: false },
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "installer failed and rollback was incomplete",
        { cause: error },
      );
    }
    throw new Error("installer transaction failed and was rolled back", {
      cause: error,
    });
  }
  return actions;
}

function launcherContent(nodePath: string, entryPath: string): string {
  return [
    "#!/bin/sh",
    "# Managed by agent-relay installer.",
    `exec ${quoteShellArgument(nodePath)} ${quoteShellArgument(entryPath)} "$@"`,
    "",
  ].join("\n");
}

async function existingManifest(
  path: string,
): Promise<InstallManifest | undefined> {
  const file = await snapshot(path);
  if (!file.exists) {
    return undefined;
  }
  try {
    return InstallManifestSchema.parse(
      JSON.parse(file.content ?? "") as unknown,
    );
  } catch {
    return undefined;
  }
}

function manifestsEquivalent(
  left: InstallManifest,
  right: InstallManifest,
): boolean {
  return (
    JSON.stringify({ ...left, installedAt: "" }) ===
    JSON.stringify({ ...right, installedAt: "" })
  );
}

export async function installAgentRelay(
  options: InstallOptions,
): Promise<InstallResult> {
  const paths = installerPaths(options.rootDir);
  const entryPath = resolve(options.entryPath);
  const nodePath = resolve(options.nodePath ?? process.execPath);
  if (!isAbsolute(options.entryPath)) {
    throw new Error("installer entryPath must be absolute");
  }
  await access(entryPath, constants.R_OK);
  await access(nodePath, constants.X_OK);
  const cursorSurface = options.cursorSurface ?? "ide";
  const harnessVersions = normalizedVersions(options.harnessVersions);
  const now = (options.now ?? (() => new Date()))();
  if (options.nodePath !== undefined && !isAbsolute(options.nodePath)) {
    throw new Error("installer nodePath must be absolute");
  }
  const configSnapshots = {
    codex: await snapshot(paths.configs.codex),
    claude: await snapshot(paths.configs.claude),
    cursor: await snapshot(paths.configs.cursor),
  };
  const configs = {
    codex: patchNestedConfig(
      parseConfig(paths.configs.codex, configSnapshots.codex),
      "codex",
      hookCommand(paths, "codex", harnessVersions.codex, cursorSurface),
    ),
    claude: patchNestedConfig(
      parseConfig(paths.configs.claude, configSnapshots.claude),
      "claude",
      hookCommand(paths, "claude", harnessVersions.claude, cursorSurface),
    ),
    cursor: patchCursorConfig(
      parseConfig(paths.configs.cursor, configSnapshots.cursor),
      hookCommand(paths, "cursor", harnessVersions.cursor, cursorSurface),
    ),
  };

  const priorManifest = await existingManifest(paths.manifestPath);
  const manifestCandidate: InstallManifest = {
    schema: INSTALL_SCHEMA,
    version: INSTALL_VERSION,
    installedAt: now.toISOString(),
    launcherPath: paths.launcherPath,
    entryPath,
    nodePath,
    cursorSurface,
    harnessVersions,
    targets: (["codex", "claude", "cursor"] as const).map((harness) => ({
      harness,
      configPath: paths.configs[harness],
      created:
        priorManifest?.targets.find((target) => target.harness === harness)
          ?.created ?? !configSnapshots[harness].exists,
    })),
  };
  const manifest =
    priorManifest !== undefined &&
    manifestsEquivalent(priorManifest, manifestCandidate)
      ? priorManifest
      : manifestCandidate;
  const plans: PlannedFile[] = [
    {
      path: paths.configs.codex,
      desired: serializeConfig(configs.codex),
      mode: 0o600,
      backup: true,
    },
    {
      path: paths.configs.claude,
      desired: serializeConfig(configs.claude),
      mode: 0o600,
      backup: true,
    },
    {
      path: paths.configs.cursor,
      desired: serializeConfig(configs.cursor),
      mode: 0o600,
      backup: true,
    },
    {
      path: paths.launcherPath,
      desired: launcherContent(nodePath, entryPath),
      mode: 0o700,
      backup: false,
    },
    {
      path: paths.manifestPath,
      desired: `${JSON.stringify(manifest, null, 2)}\n`,
      mode: 0o600,
      backup: false,
    },
  ];
  const actions = await applyPlan(plans, now, options.dryRun ?? false);
  return {
    operation: "install",
    changed: actions.some((action) => action.kind !== "unchanged"),
    dryRun: options.dryRun ?? false,
    paths,
    actions,
  };
}

function objectIsEmpty(value: MutableJsonObject): boolean {
  return Object.keys(value).length === 0;
}

function configIsOwnedScaffold(
  harness: Harness,
  value: MutableJsonObject,
): boolean {
  if (objectIsEmpty(value)) {
    return true;
  }
  return (
    harness === "cursor" &&
    value["version"] === 1 &&
    Object.keys(value).every((key) => key === "version")
  );
}

export async function uninstallAgentRelay(options: {
  rootDir: string;
  now?: () => Date;
  dryRun?: boolean;
}): Promise<InstallResult> {
  const paths = installerPaths(options.rootDir);
  const now = (options.now ?? (() => new Date()))();
  const manifest = await existingManifest(paths.manifestPath);
  const createdByHarness = new Map(
    manifest?.targets.map((target) => [target.harness, target.created]) ?? [],
  );
  const snapshots = {
    codex: await snapshot(paths.configs.codex),
    claude: await snapshot(paths.configs.claude),
    cursor: await snapshot(paths.configs.cursor),
  };
  const parsed = {
    codex: parseConfig(paths.configs.codex, snapshots.codex),
    claude: parseConfig(paths.configs.claude, snapshots.claude),
    cursor: parseConfig(paths.configs.cursor, snapshots.cursor),
  };
  const configs = {
    codex: patchNestedConfig(parsed.codex, "codex", undefined),
    claude: patchNestedConfig(parsed.claude, "claude", undefined),
    cursor: patchCursorConfig(parsed.cursor, undefined),
  };
  const plans: PlannedFile[] = (["codex", "claude", "cursor"] as const).map(
    (harness) => ({
      path: paths.configs[harness],
      ...(!snapshots[harness].exists ||
      (createdByHarness.get(harness) === true &&
        configIsOwnedScaffold(harness, configs[harness]))
        ? {}
        : { desired: serializeConfig(configs[harness]) }),
      mode: 0o600,
      backup: true,
    }),
  );

  const launcher = await snapshot(paths.launcherPath);
  const launcherOwned =
    launcher.exists &&
    launcher.content?.includes("# Managed by agent-relay installer.") === true;
  plans.push({
    path: paths.launcherPath,
    ...(launcherOwned ? {} : { desired: launcher.content }),
    mode: launcher.mode ?? 0o700,
    backup: false,
  });
  plans.push({
    path: paths.manifestPath,
    mode: 0o600,
    backup: false,
  });

  const actions = await applyPlan(plans, now, options.dryRun ?? false);
  return {
    operation: "uninstall",
    changed: actions.some((action) => action.kind !== "unchanged"),
    dryRun: options.dryRun ?? false,
    paths,
    actions,
  };
}

function countOwnedNested(
  config: MutableJsonObject,
  eventName: string,
): number {
  const hooks = config["hooks"];
  if (!isObject(hooks) || !Array.isArray(hooks[eventName])) {
    return 0;
  }
  return hooks[eventName].reduce<number>((count, group) => {
    if (!isObject(group) || !Array.isArray(group["hooks"])) {
      return count;
    }
    return (
      count + group["hooks"].filter((handler) => isOwnedHandler(handler)).length
    );
  }, 0);
}

function countOwnedCursor(
  config: MutableJsonObject,
  eventName: string,
): number {
  const hooks = config["hooks"];
  if (!isObject(hooks) || !Array.isArray(hooks[eventName])) {
    return 0;
  }
  return hooks[eventName].filter((handler) => isOwnedHandler(handler)).length;
}

export async function inspectAgentRelayInstallation(
  rootDir: string,
): Promise<InstallationReport> {
  const paths = installerPaths(rootDir);
  const checks: InstallationCheck[] = [];
  const manifest = await existingManifest(paths.manifestPath);
  checks.push({
    name: "install-manifest",
    ok: manifest !== undefined,
    level: manifest === undefined ? "warn" : "pass",
    detail:
      manifest === undefined
        ? "Agent Relay install manifest is absent or invalid"
        : `install manifest ${manifest.version} is valid`,
  });

  const launcher = await snapshot(paths.launcherPath);
  const launcherExecutable =
    launcher.exists &&
    (await stat(paths.launcherPath)).isFile() &&
    ((await stat(paths.launcherPath)).mode & 0o111) !== 0;
  checks.push({
    name: "hook-launcher",
    ok: launcherExecutable,
    level: launcherExecutable ? "pass" : "fail",
    detail: launcherExecutable
      ? "managed exact-path hook launcher is executable"
      : "managed hook launcher is missing or not executable",
  });

  for (const harness of ["codex", "claude", "cursor"] as const) {
    const file = await snapshot(paths.configs[harness]);
    if (!file.exists) {
      checks.push({
        name: `${harness}-hooks`,
        ok: false,
        level: "fail",
        detail: `${harness} hook config is missing`,
      });
      continue;
    }
    try {
      const config = parseConfig(paths.configs[harness], file);
      const eventCounts = TARGET_EVENTS[harness].map((eventName) => ({
        eventName,
        count:
          harness === "cursor"
            ? countOwnedCursor(config, eventName)
            : countOwnedNested(config, eventName),
      }));
      const ok = eventCounts.every((event) => event.count === 1);
      checks.push({
        name: `${harness}-hooks`,
        ok,
        level: ok ? "pass" : "fail",
        detail: eventCounts
          .map((event) => `${event.eventName}=${event.count}`)
          .join(", "),
      });
    } catch (error) {
      checks.push({
        name: `${harness}-hooks`,
        ok: false,
        level: "fail",
        detail:
          error instanceof Error
            ? error.message
            : `${harness} hook config is invalid`,
      });
    }
  }

  return {
    healthy: checks.every((check) => check.level !== "fail"),
    installed: manifest !== undefined,
    checks,
    paths,
  };
}
