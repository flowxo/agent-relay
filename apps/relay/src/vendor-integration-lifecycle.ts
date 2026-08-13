import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AGENT_RELAY_SKILL_CONTRACT_VERSION,
  AGENT_RELAY_SKILL_VERSION_RANGE,
  RELAY_MCP_PROTOCOL_VERSION,
  RELAY_MCP_SURFACE_VERSION,
  isAgentRelaySkillVersionCompatible,
} from "@agent-relay/protocol";
import type { Harness } from "@agent-relay/protocol";
import { z } from "zod";

import { isAgentRelayOwnedSkill } from "./agent-skills.js";
import type { InstallationCheck } from "./installer.js";
import { AGENT_RELAY_VERSION } from "./release.js";
import {
  VENDOR_INTEGRATION_OWNER,
  VENDOR_INTEGRATION_SCHEMA,
  VENDOR_INTEGRATION_VERSION,
  codexMarketplaceJson,
  vendorPluginBundle,
  vendorPluginBundles,
} from "./vendor-plugin-artifacts.js";

const LIFECYCLE_SCHEMA = "agent-relay-integration-lifecycle.v1" as const;
const MANAGED_LAUNCHER_MARKER = "# Managed by agent-relay installer.";
const MAX_INSPECT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

type LifecycleOperation =
  | "install"
  | "reinstall"
  | "upgrade"
  | "repair"
  | "disable"
  | "enable"
  | "rollback"
  | "uninstall"
  | "status";

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.startsWith("./"),
    "unsafe relative artifact path",
  );
const SnapshotFileSchema = z
  .object({
    relativePath: SafeRelativePathSchema,
    contentBase64: z
      .string()
      .max(MAX_SNAPSHOT_BYTES * 2)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();
const HarnessStateSchema = z
  .object({
    harness: z.enum(["codex", "claude", "cursor"]),
    disabled: z.boolean(),
    bundleVersion: z.string().min(1).max(80),
    artifactDigests: z.record(
      SafeRelativePathSchema,
      z.string().regex(/^[a-f0-9]{64}$/),
    ),
    rollback: z.array(SnapshotFileSchema).max(100).optional(),
    rollbackBundleVersion: z.string().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.rollback !== undefined &&
      new Set(value.rollback.map((file) => file.relativePath)).size !==
        value.rollback.length
    ) {
      context.addIssue({
        code: "custom",
        message: "duplicate rollback artifact path",
      });
    }
  });
const LifecycleManifestSchema = z
  .object({
    schema: z.literal(LIFECYCLE_SCHEMA),
    owner: z.literal(VENDOR_INTEGRATION_OWNER),
    lifecycleVersion: z.literal("1"),
    agentRelayVersion: z.string().min(1).max(80),
    installedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    harnesses: z.array(HarnessStateSchema).min(1).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.harnesses.map((entry) => entry.harness)).size !==
      value.harnesses.length
    ) {
      context.addIssue({
        code: "custom",
        message: "duplicate harness lifecycle state",
      });
    }
  });

type SnapshotFile = z.infer<typeof SnapshotFileSchema>;
type HarnessState = z.infer<typeof HarnessStateSchema>;
type LifecycleManifest = z.infer<typeof LifecycleManifestSchema>;

const IntegrationMetadataSchema = z
  .object({
    schema: z.literal(VENDOR_INTEGRATION_SCHEMA),
    version: z.string().min(1).max(80),
    owner: z.literal(VENDOR_INTEGRATION_OWNER),
    harness: z.enum(["codex", "claude", "cursor"]),
    compatibility: z
      .object({
        agentRelay: z.string().min(1).max(120),
        mcpSurface: z.string().min(1).max(80),
        mcpProtocol: z.string().min(1).max(80),
        skillContract: z.string().min(1).max(80),
        verifiedHarnessVersion: z.string().min(1).max(120),
        otherHarnessVersions: z.string().min(1).max(80),
      })
      .strict(),
    security: z
      .object({
        networking: z.literal("loopback-only"),
        authorization: z.literal("native-harness-only"),
        exactSessionBinding: z.literal(
          "AGENT_RELAY_MCP_BINDING inherited from Relay supervisor",
        ),
        embeddedCredentials: z.literal(false),
      })
      .strict(),
  })
  .passthrough();
type IntegrationMetadata = z.infer<typeof IntegrationMetadataSchema>;
type HarnessCompatibilityClassification =
  "verified" | "compatible-unverified" | "unsupported" | "disabled";

export interface VendorIntegrationPaths {
  rootDir: string;
  stateDir: string;
  manifestPath: string;
  launcherPath: string;
  targets: Record<Harness, string>;
  disabledTargets: Record<Harness, string>;
  codexMarketplacePath: string;
}

export interface VendorIntegrationOptions {
  rootDir: string;
  entryPath: string;
  nodePath?: string;
  packageVersion?: string;
  harnesses?: readonly Harness[];
  now?: () => Date;
  dryRun?: boolean;
  harnessVersions?: Partial<Record<Harness, string>>;
  harnessClassifications?: Partial<
    Record<Harness, HarnessCompatibilityClassification>
  >;
  /** Test-only interruption point; the public CLI never sets this. */
  failAfterWrites?: number;
}

export interface VendorIntegrationResult {
  operation: LifecycleOperation;
  changed: boolean;
  dryRun: boolean;
  harnesses: Array<{
    harness: Harness;
    state: "installed" | "disabled" | "absent" | "drifted";
    nativeActivation: "automatic" | "marketplace-review" | "plugin-dir";
    compatibility: {
      verifiedVersion: string;
      observedVersion?: string;
      classification: HarnessCompatibilityClassification | "unavailable";
    };
  }>;
  remediation: string[];
}

export interface VendorIntegrationReport {
  installed: boolean;
  healthy: boolean;
  checks: InstallationCheck[];
}

interface TreeSnapshot {
  exists: boolean;
  files: SnapshotFile[];
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

function assertContained(rootDir: string, path: string): void {
  const child = relative(rootDir, path);
  if (child === "" || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("integration lifecycle target escapes its isolated root");
  }
}

export function vendorIntegrationPaths(
  rootDir: string,
): VendorIntegrationPaths {
  const root = resolve(rootDir);
  const stateDir = join(root, ".agent-relay");
  const codexMarketplace = join(stateDir, "vendor", "codex-marketplace");
  const paths: VendorIntegrationPaths = {
    rootDir: root,
    stateDir,
    manifestPath: join(stateDir, "integrations.json"),
    launcherPath: join(stateDir, "bin", "agent-relay"),
    targets: {
      codex: join(codexMarketplace, "plugins", "agent-relay"),
      claude: join(stateDir, "vendor", "claude", "agent-relay"),
      cursor: join(root, ".cursor", "plugins", "local", "agent-relay"),
    },
    disabledTargets: {
      codex: join(stateDir, "integrations-disabled", "codex"),
      claude: join(stateDir, "integrations-disabled", "claude"),
      cursor: join(stateDir, "integrations-disabled", "cursor"),
    },
    codexMarketplacePath: join(
      codexMarketplace,
      ".agents",
      "plugins",
      "marketplace.json",
    ),
  };
  for (const path of [
    paths.manifestPath,
    paths.launcherPath,
    paths.codexMarketplacePath,
    ...Object.values(paths.targets),
    ...Object.values(paths.disabledTargets),
  ]) {
    assertContained(root, path);
  }
  return paths;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

async function assertNoSymlink(path: string, rootDir: string): Promise<void> {
  let current = path;
  while (current !== rootDir) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("integration lifecycle refuses an owned-path symlink");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

async function readBounded(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("configuration inspection refuses symlinks");
    }
    if (!metadata.isFile()) {
      throw new Error("configuration inspection requires a regular file");
    }
    if (metadata.size > MAX_INSPECT_BYTES) {
      throw new Error(
        "configuration is too large for safe integration inspection",
      );
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readManifest(
  path: string,
): Promise<LifecycleManifest | undefined> {
  const source = await readBounded(path);
  if (source === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error(
      "Agent Relay integration lifecycle metadata is malformed; restore or remove only that owned metadata before retrying",
    );
  }
  const parsed = LifecycleManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "integration lifecycle metadata has incompatible ownership or schema; do not overwrite it",
    );
  }
  return parsed.data;
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  if (!(await exists(root))) return { exists: false, files: [] };
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("integration target must be a real directory");
  }
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("integration target contains a symlink");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const metadata = await stat(path);
        totalBytes += metadata.size;
        if (files.length >= 100 || totalBytes > MAX_SNAPSHOT_BYTES) {
          throw new Error(
            "integration target exceeds the bounded rollback inventory",
          );
        }
        const content = await readFile(path);
        files.push({
          relativePath: normalizeRelative(relative(root, path)),
          contentBase64: content.toString("base64"),
          mode: metadata.mode & 0o777,
        });
      } else {
        throw new Error(
          "integration target contains an unsupported filesystem entry",
        );
      }
    }
  }
  await visit(root);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return { exists: true, files };
}

async function restoreTree(
  root: string,
  snapshot: TreeSnapshot,
): Promise<void> {
  await rm(root, { recursive: true, force: true });
  if (!snapshot.exists) return;
  for (const file of snapshot.files) {
    const path = join(root, ...file.relativePath.split("/"));
    assertContained(root, path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(file.contentBase64, "base64"), {
      mode: file.mode,
    });
    await chmod(path, file.mode);
  }
}

async function targetIsOwned(
  path: string,
  expectedHarness?: Harness,
): Promise<boolean> {
  const source = await readBounded(join(path, "agent-relay.integration.json"));
  if (source === undefined) return false;
  try {
    const value = JSON.parse(source) as {
      schema?: string;
      owner?: string;
      harness?: string;
    };
    return (
      value.schema === VENDOR_INTEGRATION_SCHEMA &&
      value.owner === VENDOR_INTEGRATION_OWNER &&
      (expectedHarness === undefined || value.harness === expectedHarness)
    );
  } catch {
    return false;
  }
}

async function readIntegrationMetadata(
  path: string,
): Promise<IntegrationMetadata | undefined> {
  const source = await readBounded(join(path, "agent-relay.integration.json"));
  if (source === undefined) return undefined;
  try {
    const parsed = IntegrationMetadataSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function launcherContent(nodePath: string, entryPath: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    MANAGED_LAUNCHER_MARKER,
    `exec ${quote(nodePath)} ${quote(entryPath)} "$@"`,
    "",
  ].join("\n");
}

function launcherIsOwned(source: string | undefined): boolean {
  return source?.startsWith(`#!/bin/sh\n${MANAGED_LAUNCHER_MARKER}\n`) ?? false;
}

async function assertManualConfigurationDoesNotConflict(
  rootDir: string,
): Promise<void> {
  const containsAgentRelayMcp = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsAgentRelayMcp);
    if (value === null || typeof value !== "object") return false;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "mcpServers" &&
        child !== null &&
        typeof child === "object" &&
        Object.entries(child).some(
          ([serverName, config]) =>
            /agent[-_]relay/i.test(serverName) ||
            /agent[-_]relay/i.test(JSON.stringify(config)),
        )
      ) {
        return true;
      }
      if (containsAgentRelayMcp(child)) return true;
    }
    return false;
  };
  const legacySkills = [
    join(rootDir, ".agents", "skills", "agent-relay", "SKILL.md"),
    join(rootDir, ".claude", "skills", "agent-relay", "SKILL.md"),
    join(rootDir, ".cursor", "skills", "agent-relay", "SKILL.md"),
  ];
  for (const path of legacySkills) {
    const source = await readBounded(path);
    if (source !== undefined) {
      const kind = isAgentRelayOwnedSkill(source)
        ? "legacy Agent Relay-owned"
        : "manually configured";
      throw new Error(
        `${kind} skill duplicates the vendor integration; run the matching legacy cleanup or move that skill before retrying`,
      );
    }
  }

  for (const path of [
    join(rootDir, ".codex", "hooks.json"),
    join(rootDir, ".claude", "settings.json"),
    join(rootDir, ".cursor", "hooks.json"),
  ]) {
    const source = await readBounded(path);
    if (source === undefined) continue;
    try {
      JSON.parse(source);
    } catch {
      throw new Error(
        "a vendor hook configuration is malformed; repair it before installing Agent Relay so no user configuration is rewritten or lost",
      );
    }
    if (
      source.includes("agent-relay hook") ||
      source.includes("AGENT_RELAY_HOOK_OWNER")
    ) {
      throw new Error(
        "an existing Agent Relay hook would duplicate the plugin hook; remove the owned legacy hook or reconcile the manual hook before retrying",
      );
    }
  }

  for (const path of [
    join(rootDir, ".claude.json"),
    join(rootDir, ".cursor", "mcp.json"),
  ]) {
    const source = await readBounded(path);
    if (source === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error(
        "a vendor MCP configuration is malformed; repair it before installing Agent Relay so no user configuration is rewritten or lost",
      );
    }
    if (containsAgentRelayMcp(parsed)) {
      throw new Error(
        "an existing Agent Relay MCP declaration conflicts with the plugin declaration; remove or disable exactly one declaration before retrying",
      );
    }
  }
  const codexConfig = await readBounded(join(rootDir, ".codex", "config.toml"));
  const codexMcpConflict =
    codexConfig !== undefined &&
    (/\[\s*mcp_servers\s*\.\s*["']?agent[-_]relay["']?\s*\]/i.test(
      codexConfig,
    ) ||
      /\[\s*mcp_servers\s*\][\s\S]*?^\s*["']?agent[-_]relay["']?\s*=/im.test(
        codexConfig,
      ));
  if (codexMcpConflict) {
    throw new Error(
      "an existing Codex Agent Relay MCP declaration conflicts with the plugin declaration; remove or disable exactly one declaration before retrying",
    );
  }

  const claudePlugins = await readBounded(
    join(rootDir, ".claude", "plugins", "installed_plugins.json"),
  );
  if (claudePlugins !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(claudePlugins) as unknown;
    } catch {
      throw new Error(
        "the Claude Code plugin registry is malformed; repair it through Claude Code before installing Agent Relay",
      );
    }
    if (/agent[-_]relay/i.test(JSON.stringify(parsed))) {
      throw new Error(
        "an installed Claude Code Agent Relay plugin would duplicate the local plugin; remove exactly one through Claude Code before retrying",
      );
    }
  }
}

async function writeBundle(
  target: string,
  harness: Harness,
  counter: { value: number; failAfter?: number },
): Promise<void> {
  await rm(target, { recursive: true, force: true });
  for (const file of vendorPluginBundle(harness).artifacts) {
    const path = join(target, ...file.relativePath.split("/"));
    assertContained(target, path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { encoding: "utf8", mode: file.mode });
    await chmod(path, file.mode);
    counter.value += 1;
    if (counter.failAfter !== undefined && counter.value >= counter.failAfter) {
      throw new Error("synthetic interrupted integration update");
    }
  }
}

function artifactDigests(harness: Harness): Record<string, string> {
  return Object.fromEntries(
    vendorPluginBundle(harness).artifacts.map((file) => [
      file.relativePath,
      file.sha256,
    ]),
  );
}

async function treeMatches(harness: Harness, path: string): Promise<boolean> {
  return treeMatchesDigests(path, artifactDigests(harness), harness);
}

async function treeMatchesDigests(
  path: string,
  expected: Record<string, string>,
  harness?: Harness,
): Promise<boolean> {
  if (!(await targetIsOwned(path, harness))) return false;
  const snapshot = await snapshotTree(path);
  if (snapshot.files.length !== Object.keys(expected).length) return false;
  return snapshot.files.every((file) => {
    const digest = createHash("sha256")
      .update(Buffer.from(file.contentBase64, "base64"))
      .digest("hex");
    return expected[file.relativePath] === digest;
  });
}

function nativeActivation(
  harness: Harness,
): VendorIntegrationResult["harnesses"][number]["nativeActivation"] {
  if (harness === "codex") return "marketplace-review";
  return "plugin-dir";
}

function harnessCompatibility(
  harness: Harness,
  versions: Partial<Record<Harness, string>> | undefined,
  classifications:
    Partial<Record<Harness, HarnessCompatibilityClassification>> | undefined,
): VendorIntegrationResult["harnesses"][number]["compatibility"] {
  const verifiedVersion = vendorPluginBundle(harness).verifiedVersion;
  const observedVersion = versions?.[harness];
  return {
    verifiedVersion,
    ...(observedVersion === undefined ? {} : { observedVersion }),
    classification:
      observedVersion === undefined
        ? "unavailable"
        : (classifications?.[harness] ??
          (observedVersion === verifiedVersion
            ? "verified"
            : "compatible-unverified")),
  };
}

function activationRemediation(
  harnesses: readonly Harness[],
  operation: LifecycleOperation,
): string[] {
  const remediation: string[] = [];
  if (operation === "disable" || operation === "uninstall") {
    if (harnesses.includes("codex")) {
      remediation.push(
        "If the Codex snapshot is activated, remove it through the native action using agent-relay@agent-relay-local; remove the native marketplace registration after plugin removal when uninstalling.",
      );
    }
    if (harnesses.includes("claude")) {
      remediation.push(
        "Stop passing the Claude Code Agent Relay --plugin-dir after disable or uninstall.",
      );
    }
    if (harnesses.includes("cursor")) {
      remediation.push(
        "Stop passing the Cursor Agent Relay --plugin-dir and restart native discovery after disable or uninstall.",
      );
    }
    return remediation;
  }
  if (harnesses.includes("codex")) {
    remediation.push(
      "Review the Agent Relay local marketplace, then install or refresh the plugin with Codex's native plugin action.",
    );
  }
  if (harnesses.includes("claude")) {
    remediation.push(
      "Load the reviewed Claude Code local plugin with the frozen CLI's native --plugin-dir option.",
    );
  }
  if (harnesses.includes("cursor")) {
    remediation.push(
      "Load the reviewed Cursor local plugin with the frozen CLI's native --plugin-dir option.",
    );
  }
  return remediation;
}

function serializeManifest(manifest: LifecycleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function runVendorIntegrationLifecycle(
  operation: LifecycleOperation,
  options: VendorIntegrationOptions,
): Promise<VendorIntegrationResult> {
  const paths = vendorIntegrationPaths(options.rootDir);
  const rootMetadata = await lstat(paths.rootDir);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      "integration lifecycle root must be an existing real directory",
    );
  }
  if (!isAbsolute(options.entryPath))
    throw new Error("integration entryPath must be absolute");
  if (options.nodePath !== undefined && !isAbsolute(options.nodePath)) {
    throw new Error("integration nodePath must be absolute");
  }
  for (const path of [
    paths.stateDir,
    paths.manifestPath,
    paths.launcherPath,
    paths.codexMarketplacePath,
    ...Object.values(paths.targets),
    ...Object.values(paths.disabledTargets),
  ]) {
    await assertNoSymlink(path, paths.rootDir);
  }
  const entryPath = await realpath(resolve(options.entryPath));
  const nodePath = await realpath(
    resolve(options.nodePath ?? process.execPath),
  );
  await access(entryPath, constants.R_OK);
  await access(nodePath, constants.X_OK);
  const selected = [
    ...new Set(options.harnesses ?? (["codex", "claude", "cursor"] as const)),
  ];
  const now = (options.now ?? (() => new Date()))().toISOString();
  const priorManifest = await readManifest(paths.manifestPath);

  if (operation === "status") {
    return integrationStatus(
      paths,
      priorManifest,
      selected,
      options.harnessVersions,
      options.harnessClassifications,
    );
  }

  if (
    ["install", "reinstall", "upgrade", "repair", "enable"].includes(operation)
  ) {
    await assertManualConfigurationDoesNotConflict(paths.rootDir);
  }

  for (const harness of selected) {
    const target = paths.targets[harness];
    const targetExists = await exists(target);
    const disabledTarget = paths.disabledTargets[harness];
    const disabledTargetExists = await exists(disabledTarget);
    const lifecycleState = priorManifest?.harnesses.find(
      (entry) => entry.harness === harness,
    );
    if (targetExists && disabledTargetExists) {
      throw new Error(
        `${harness} has both active and disabled Agent Relay plugin trees; preserve the lifecycle metadata and remove the duplicate owned tree before retrying`,
      );
    }
    if (targetExists && !(await targetIsOwned(target, harness))) {
      throw new Error(
        `${harness} plugin target contains non-Agent Relay material; move it or choose the native vendor conflict remediation before retrying`,
      );
    }
    if (
      disabledTargetExists &&
      !(await targetIsOwned(disabledTarget, harness))
    ) {
      throw new Error(
        `${harness} disabled plugin target contains non-Agent Relay material; preserve it and resolve the ownership conflict before retrying`,
      );
    }
    if (operation === "disable" || operation === "enable") {
      if (lifecycleState === undefined) {
        throw new Error(
          `${harness} has no Agent Relay lifecycle state; install it before changing its enabled state`,
        );
      }
      const expectedTreeExists = lifecycleState.disabled
        ? disabledTargetExists
        : targetExists;
      if (!expectedTreeExists) {
        throw new Error(
          `${harness} lifecycle state and owned plugin tree disagree; run integrations repair before changing its enabled state`,
        );
      }
    }
  }

  const manifestSnapshot = await readBounded(paths.manifestPath);
  const launcherSnapshot = await readBounded(paths.launcherPath);
  if (launcherSnapshot !== undefined && !launcherIsOwned(launcherSnapshot)) {
    throw new Error(
      "Agent Relay launcher target contains non-Agent Relay material; preserve or move it before retrying",
    );
  }
  const treeSnapshots = new Map<string, TreeSnapshot>();
  for (const harness of selected) {
    treeSnapshots.set(
      paths.targets[harness],
      await snapshotTree(paths.targets[harness]),
    );
    treeSnapshots.set(
      paths.disabledTargets[harness],
      await snapshotTree(paths.disabledTargets[harness]),
    );
  }
  const marketplaceSnapshot = await readBounded(paths.codexMarketplacePath);
  const marketplacePathExists = await exists(paths.codexMarketplacePath);
  if (
    selected.includes("codex") &&
    marketplacePathExists &&
    marketplaceSnapshot === undefined
  ) {
    throw new Error(
      "the Codex local marketplace target is not a regular Agent Relay-owned manifest; preserve it and resolve the conflict before retrying",
    );
  }
  if (
    selected.includes("codex") &&
    marketplaceSnapshot !== undefined &&
    marketplaceSnapshot !== codexMarketplaceJson()
  ) {
    throw new Error(
      "the Codex local marketplace manifest contains drift or non-Agent Relay material; preserve it and reconcile that conflict before retrying",
    );
  }
  if (options.dryRun) {
    let wouldChange = false;
    if (operation === "reinstall" || operation === "upgrade") {
      wouldChange = selected.length > 0;
    } else if (operation === "disable") {
      for (const harness of selected) {
        const state = priorManifest?.harnesses.find(
          (entry) => entry.harness === harness,
        );
        if ((await exists(paths.targets[harness])) || state?.disabled === false)
          wouldChange = true;
      }
      if (selected.includes("codex") && marketplaceSnapshot !== undefined)
        wouldChange = true;
    } else if (operation === "uninstall") {
      for (const harness of selected) {
        if (
          (await exists(paths.targets[harness])) ||
          (await exists(paths.disabledTargets[harness])) ||
          priorManifest?.harnesses.some(
            (entry) => entry.harness === harness,
          ) === true
        ) {
          wouldChange = true;
        }
      }
      if (selected.includes("codex") && marketplaceSnapshot !== undefined)
        wouldChange = true;
    } else if (operation === "rollback") {
      wouldChange = selected.some(
        (harness) =>
          priorManifest?.harnesses.find((entry) => entry.harness === harness)
            ?.rollback !== undefined,
      );
    } else {
      for (const harness of selected) {
        const state = priorManifest?.harnesses.find(
          (entry) => entry.harness === harness,
        );
        const staysDisabled =
          operation !== "enable" && state?.disabled === true;
        const target = staysDisabled
          ? paths.disabledTargets[harness]
          : paths.targets[harness];
        if (
          (operation === "enable" && state?.disabled === true) ||
          !(await treeMatches(harness, target)) ||
          state?.bundleVersion !== VENDOR_INTEGRATION_VERSION
        ) {
          wouldChange = true;
        }
      }
      const codexState = priorManifest?.harnesses.find(
        (entry) => entry.harness === "codex",
      );
      const expectsCodexMarketplace =
        selected.includes("codex") &&
        !(codexState?.disabled === true && operation !== "enable");
      if (
        launcherSnapshot !== launcherContent(nodePath, entryPath) ||
        priorManifest?.agentRelayVersion !==
          (options.packageVersion ?? AGENT_RELAY_VERSION) ||
        (expectsCodexMarketplace
          ? marketplaceSnapshot !== codexMarketplaceJson()
          : selected.includes("codex") && marketplaceSnapshot !== undefined)
      ) {
        wouldChange = true;
      }
    }
    return {
      operation,
      changed: wouldChange,
      dryRun: true,
      harnesses: selected.map((harness) => ({
        harness,
        state:
          operation === "uninstall"
            ? "absent"
            : operation === "disable"
              ? "disabled"
              : priorManifest?.harnesses.find(
                    (entry) => entry.harness === harness,
                  )?.disabled === true && operation !== "enable"
                ? "disabled"
                : "installed",
        nativeActivation: nativeActivation(harness),
        compatibility: harnessCompatibility(
          harness,
          options.harnessVersions,
          options.harnessClassifications,
        ),
      })),
      remediation: activationRemediation(selected, operation),
    };
  }

  const manifest: LifecycleManifest = priorManifest ?? {
    schema: LIFECYCLE_SCHEMA,
    owner: VENDOR_INTEGRATION_OWNER,
    lifecycleVersion: "1",
    agentRelayVersion: options.packageVersion ?? AGENT_RELAY_VERSION,
    installedAt: now,
    updatedAt: now,
    harnesses: [],
  };
  const counter = {
    value: 0,
    ...(options.failAfterWrites === undefined
      ? {}
      : { failAfter: options.failAfterWrites }),
  };
  let changed = false;
  try {
    if (operation === "uninstall") {
      for (const harness of selected) {
        const existingState = manifest.harnesses.find(
          (entry) => entry.harness === harness,
        );
        for (const target of [
          paths.targets[harness],
          paths.disabledTargets[harness],
        ]) {
          if (await exists(target)) {
            if (!(await targetIsOwned(target, harness)))
              throw new Error(
                "integration uninstall lost ownership proof and stopped safely",
              );
            await rm(target, { recursive: true, force: true });
            changed = true;
          }
        }
        manifest.harnesses = manifest.harnesses.filter(
          (entry) => entry.harness !== harness,
        );
        if (existingState !== undefined) changed = true;
      }
    } else if (operation === "disable") {
      for (const harness of selected) {
        const target = paths.targets[harness];
        const disabled = paths.disabledTargets[harness];
        if (await exists(target)) {
          await mkdir(dirname(disabled), { recursive: true, mode: 0o700 });
          await rm(disabled, { recursive: true, force: true });
          await rename(target, disabled);
          changed = true;
        }
        const state = manifest.harnesses.find(
          (entry) => entry.harness === harness,
        );
        if (state !== undefined && !state.disabled) {
          state.disabled = true;
          changed = true;
        }
      }
    } else if (operation === "rollback") {
      for (const harness of selected) {
        const state = manifest.harnesses.find(
          (entry) => entry.harness === harness,
        );
        if (state?.rollback === undefined) continue;
        const target = state.disabled
          ? paths.disabledTargets[harness]
          : paths.targets[harness];
        const current = await snapshotTree(target);
        const rollback = state.rollback;
        const currentBundleVersion = state.bundleVersion;
        await restoreTree(target, { exists: true, files: rollback });
        state.rollback = current.files;
        state.bundleVersion =
          state.rollbackBundleVersion ?? state.bundleVersion;
        state.rollbackBundleVersion = currentBundleVersion;
        state.artifactDigests = Object.fromEntries(
          rollback.map((file) => [
            file.relativePath,
            createHash("sha256")
              .update(Buffer.from(file.contentBase64, "base64"))
              .digest("hex"),
          ]),
        );
        changed = true;
      }
    } else {
      for (const harness of selected) {
        const activeTarget = paths.targets[harness];
        const disabled = paths.disabledTargets[harness];
        const oldState = manifest.harnesses.find(
          (entry) => entry.harness === harness,
        );
        if (operation === "enable" && (await exists(disabled))) {
          await rm(activeTarget, { recursive: true, force: true });
          await mkdir(dirname(activeTarget), {
            recursive: true,
            mode: 0o700,
          });
          await rename(disabled, activeTarget);
          changed = true;
        }
        const staysDisabled =
          operation !== "enable" && oldState?.disabled === true;
        const target = staysDisabled ? disabled : activeTarget;
        const current = await snapshotTree(target);
        const isCurrent = await treeMatches(harness, target);
        if (
          !isCurrent ||
          operation === "reinstall" ||
          operation === "upgrade"
        ) {
          await writeBundle(target, harness, counter);
          changed = true;
        }
        if (operation === "enable" && oldState?.disabled === true)
          changed = true;
        const nextState: HarnessState = {
          harness,
          disabled: staysDisabled,
          bundleVersion: VENDOR_INTEGRATION_VERSION,
          artifactDigests: artifactDigests(harness),
          ...((operation === "upgrade" || operation === "reinstall") &&
          current.exists
            ? {
                rollback: current.files,
                rollbackBundleVersion:
                  oldState?.bundleVersion ?? VENDOR_INTEGRATION_VERSION,
              }
            : oldState?.rollback === undefined
              ? {}
              : {
                  rollback: oldState.rollback,
                  ...(oldState.rollbackBundleVersion === undefined
                    ? {}
                    : {
                        rollbackBundleVersion: oldState.rollbackBundleVersion,
                      }),
                }),
        };
        manifest.harnesses = [
          ...manifest.harnesses.filter((entry) => entry.harness !== harness),
          nextState,
        ];
      }
    }

    const codexState = manifest.harnesses.find(
      (entry) => entry.harness === "codex",
    );
    if (
      selected.includes("codex") &&
      (operation === "uninstall" || codexState?.disabled === true)
    ) {
      const currentMarketplace = await readBounded(paths.codexMarketplacePath);
      if (currentMarketplace !== undefined) {
        await rm(paths.codexMarketplacePath, { force: true });
        changed = true;
      }
    } else if (selected.includes("codex")) {
      await mkdir(dirname(paths.codexMarketplacePath), {
        recursive: true,
        mode: 0o700,
      });
      const desired = codexMarketplaceJson();
      if ((await readBounded(paths.codexMarketplacePath)) !== desired) {
        await writeFile(paths.codexMarketplacePath, desired, {
          encoding: "utf8",
          mode: 0o600,
        });
        changed = true;
      }
    }
    const launcher = launcherContent(nodePath, entryPath);
    if (manifest.harnesses.length > 0) {
      await mkdir(dirname(paths.launcherPath), {
        recursive: true,
        mode: 0o700,
      });
      if (launcherSnapshot !== launcher) {
        await writeFile(paths.launcherPath, launcher, {
          encoding: "utf8",
          mode: 0o700,
        });
        await chmod(paths.launcherPath, 0o700);
        changed = true;
      }
      manifest.updatedAt = changed ? now : manifest.updatedAt;
      manifest.agentRelayVersion =
        options.packageVersion ?? AGENT_RELAY_VERSION;
      manifest.harnesses.sort((left, right) =>
        left.harness.localeCompare(right.harness),
      );
      await mkdir(dirname(paths.manifestPath), {
        recursive: true,
        mode: 0o700,
      });
      const source = serializeManifest(manifest);
      if (manifestSnapshot !== source) {
        await writeFile(paths.manifestPath, source, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    } else {
      if (launcherSnapshot !== undefined)
        await rm(paths.launcherPath, { force: true });
      await rm(paths.manifestPath, { force: true });
    }
  } catch (error) {
    for (const [path, snapshot] of treeSnapshots)
      await restoreTree(path, snapshot);
    if (manifestSnapshot === undefined)
      await rm(paths.manifestPath, { force: true });
    else {
      await mkdir(dirname(paths.manifestPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(paths.manifestPath, manifestSnapshot, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (launcherSnapshot === undefined)
      await rm(paths.launcherPath, { force: true });
    else {
      await mkdir(dirname(paths.launcherPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(paths.launcherPath, launcherSnapshot, {
        encoding: "utf8",
        mode: 0o700,
      });
    }
    if (marketplaceSnapshot === undefined)
      await rm(paths.codexMarketplacePath, { force: true });
    else {
      await mkdir(dirname(paths.codexMarketplacePath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(paths.codexMarketplacePath, marketplaceSnapshot, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    throw new Error(
      "integration lifecycle transaction failed and was rolled back",
      { cause: error },
    );
  }

  return {
    operation,
    changed,
    dryRun: false,
    harnesses: await Promise.all(
      selected.map(async (harness) => ({
        harness,
        state: await observedIntegrationState(paths, manifest, harness),
        nativeActivation: nativeActivation(harness),
        compatibility: harnessCompatibility(
          harness,
          options.harnessVersions,
          options.harnessClassifications,
        ),
      })),
    ),
    remediation: activationRemediation(selected, operation),
  };
}

async function observedIntegrationState(
  paths: VendorIntegrationPaths,
  manifest: LifecycleManifest | undefined,
  harness: Harness,
): Promise<VendorIntegrationResult["harnesses"][number]["state"]> {
  const state = manifest?.harnesses.find((entry) => entry.harness === harness);
  const active = await exists(paths.targets[harness]);
  const disabled = await exists(paths.disabledTargets[harness]);
  if (active && disabled) return "drifted";
  if (active) {
    if (state?.disabled !== false) return "drifted";
    return (await treeMatchesDigests(
      paths.targets[harness],
      state.artifactDigests,
      harness,
    ))
      ? "installed"
      : "drifted";
  }
  if (disabled) {
    if (state?.disabled !== true) return "drifted";
    return (await treeMatchesDigests(
      paths.disabledTargets[harness],
      state.artifactDigests,
      harness,
    ))
      ? "disabled"
      : "drifted";
  }
  return state === undefined ? "absent" : "drifted";
}

async function integrationStatus(
  paths: VendorIntegrationPaths,
  manifest: LifecycleManifest | undefined,
  harnesses: readonly Harness[],
  harnessVersions: Partial<Record<Harness, string>> | undefined,
  harnessClassifications:
    Partial<Record<Harness, HarnessCompatibilityClassification>> | undefined,
): Promise<VendorIntegrationResult> {
  return {
    operation: "status",
    changed: false,
    dryRun: false,
    harnesses: await Promise.all(
      harnesses.map(async (harness) => ({
        harness,
        state: await observedIntegrationState(paths, manifest, harness),
        nativeActivation: nativeActivation(harness),
        compatibility: harnessCompatibility(
          harness,
          harnessVersions,
          harnessClassifications,
        ),
      })),
    ),
    remediation:
      manifest === undefined
        ? [
            "Run agent-relay integrations install to create the vendor-native bundles.",
          ]
        : [],
  };
}

export async function inspectVendorIntegrations(
  rootDir: string,
  options: {
    harnessVersions?: Partial<Record<Harness, string>>;
    harnessClassifications?: Partial<
      Record<Harness, HarnessCompatibilityClassification>
    >;
    hookTrust?: Partial<Record<Harness, "approved" | "denied" | "unknown">>;
  } = {},
): Promise<VendorIntegrationReport> {
  const paths = vendorIntegrationPaths(rootDir);
  const manifest = await readManifest(paths.manifestPath);
  if (manifest === undefined) {
    const orphanedBundle = (
      await Promise.all(
        [
          ...Object.values(paths.targets),
          ...Object.values(paths.disabledTargets),
          paths.codexMarketplacePath,
        ].map(exists),
      )
    ).some(Boolean);
    if (!orphanedBundle)
      return { installed: false, healthy: false, checks: [] };
    return {
      installed: true,
      healthy: false,
      checks: [
        {
          name: "integration-lifecycle-manifest",
          ok: false,
          level: "fail",
          detail:
            "vendor integration artifacts exist without compatible Agent Relay lifecycle ownership; preserve conflicts, then reinstall or remove only proven owned material",
        },
      ],
    };
  }
  const checks: InstallationCheck[] = [];
  const selectedMetadata: Array<{
    metadata: IntegrationMetadata | undefined;
    state: HarnessState | undefined;
  }> = [];
  const launcher = await readBounded(paths.launcherPath);
  const launcherOwned = launcherIsOwned(launcher);
  const launcherExecutable = launcherOwned
    ? ((await stat(paths.launcherPath)).mode & 0o111) !== 0
    : false;
  checks.push({
    name: "integration-launcher",
    ok: launcherOwned && launcherExecutable,
    level: launcherOwned && launcherExecutable ? "pass" : "fail",
    detail:
      launcherOwned && launcherExecutable
        ? "Agent Relay-owned launcher is present and executable"
        : "Agent Relay-owned executable launcher is missing or drifted; run integrations repair",
  });
  const codexState = manifest.harnesses.find(
    (entry) => entry.harness === "codex",
  );
  const marketplace = await readBounded(paths.codexMarketplacePath);
  const marketplaceExists = await exists(paths.codexMarketplacePath);
  const marketplaceExpected = codexState !== undefined && !codexState.disabled;
  const marketplaceHealthy = marketplaceExpected
    ? marketplaceExists && marketplace === codexMarketplaceJson()
    : !marketplaceExists;
  checks.push({
    name: "integration-codex-marketplace",
    ok: marketplaceHealthy,
    level: marketplaceHealthy ? "pass" : "fail",
    detail: marketplaceHealthy
      ? marketplaceExpected
        ? "Agent Relay-owned Codex local marketplace declaration is exact"
        : "Codex local marketplace declaration is absent while not selected or disabled"
      : marketplaceExpected
        ? "Codex local marketplace declaration is absent or drifted; preserve conflicts and reconcile it before repair"
        : "an unexpected Codex local marketplace declaration conflicts with lifecycle state; preserve it and reconcile the conflict",
  });
  for (const bundle of vendorPluginBundles()) {
    const state = manifest.harnesses.find(
      (entry) => entry.harness === bundle.harness,
    );
    const active = await exists(paths.targets[bundle.harness]);
    const disabled = await exists(paths.disabledTargets[bundle.harness]);
    const selected = state !== undefined || active || disabled;
    const duplicateState = active && disabled;
    const owned = active
      ? await targetIsOwned(paths.targets[bundle.harness], bundle.harness)
      : disabled
        ? await targetIsOwned(
            paths.disabledTargets[bundle.harness],
            bundle.harness,
          )
        : false;
    const driftFree = active
      ? await treeMatchesDigests(
          paths.targets[bundle.harness],
          state?.artifactDigests ?? {},
          bundle.harness,
        )
      : disabled
        ? await treeMatchesDigests(
            paths.disabledTargets[bundle.harness],
            state?.artifactDigests ?? {},
            bundle.harness,
          )
        : false;
    if (selected) {
      selectedMetadata.push({
        metadata: await readIntegrationMetadata(
          active
            ? paths.targets[bundle.harness]
            : paths.disabledTargets[bundle.harness],
        ),
        state,
      });
    }
    const locationConsistent =
      state !== undefined &&
      (state.disabled ? disabled && !active : active && !disabled);
    checks.push({
      name: `integration-${bundle.harness}-artifacts`,
      ok:
        !selected ||
        (state !== undefined &&
          owned &&
          driftFree &&
          locationConsistent &&
          !duplicateState),
      level:
        !selected ||
        (state !== undefined &&
          owned &&
          driftFree &&
          locationConsistent &&
          !duplicateState)
          ? "pass"
          : "fail",
      detail: !selected
        ? `${bundle.displayName} integration was not selected for installation`
        : duplicateState
          ? `${bundle.displayName} has duplicate active and disabled owned trees; resolve the conflict before repair`
          : state === undefined
            ? `${bundle.displayName} integration lifecycle state is absent; resolve ownership before repair`
            : !owned
              ? `${bundle.displayName} integration ownership cannot be proven; resolve the conflict before repair`
              : !locationConsistent
                ? `${bundle.displayName} enabled state and owned plugin location disagree; run integrations repair`
                : driftFree
                  ? `${bundle.nativeKind} artifacts and ownership are intact`
                  : `${bundle.displayName} integration drift detected; run integrations repair`,
    });
    checks.push({
      name: `integration-${bundle.harness}-disabled`,
      ok: state === undefined || !state.disabled,
      level: state?.disabled === true ? "warn" : "pass",
      detail: !selected
        ? `${bundle.displayName} integration was not selected for installation`
        : state?.disabled
          ? `${bundle.displayName} integration is explicitly disabled; run integrations enable when ready`
          : `${bundle.displayName} integration is enabled`,
    });
    const observed = options.harnessVersions?.[bundle.harness];
    const observedClassification =
      options.harnessClassifications?.[bundle.harness];
    const incompatible =
      observedClassification === "unsupported" ||
      observedClassification === "disabled";
    checks.push({
      name: `integration-${bundle.harness}-compatibility`,
      ok:
        !selected ||
        (!incompatible &&
          (observed === undefined || observed === bundle.verifiedVersion)),
      level: !selected
        ? "pass"
        : incompatible
          ? "fail"
          : observed === undefined
            ? "warn"
            : observed === bundle.verifiedVersion
              ? "pass"
              : "warn",
      detail: !selected
        ? `${bundle.displayName} integration was not selected for installation`
        : incompatible
          ? `${bundle.displayName} version is incompatible with the reviewed integration contract; disable it or install a supported version`
          : observed === undefined
            ? `${bundle.displayName} version was not observed; exact reviewed version is ${bundle.verifiedVersion}`
            : observed === bundle.verifiedVersion
              ? `${bundle.displayName} matches exact reviewed version ${bundle.verifiedVersion}`
              : `${bundle.displayName} is recognizable but compatible-unverified; exact reviewed version is ${bundle.verifiedVersion}`,
    });
    const trust = options.hookTrust?.[bundle.harness] ?? "unknown";
    checks.push({
      name: `integration-${bundle.harness}-hook-trust`,
      ok: !selected || trust === "approved",
      level: !selected
        ? "pass"
        : trust === "denied"
          ? "warn"
          : trust === "approved"
            ? "pass"
            : "warn",
      detail: !selected
        ? `${bundle.displayName} integration was not selected for installation`
        : trust === "approved"
          ? `${bundle.displayName} native hook trust is approved`
          : trust === "denied"
            ? `${bundle.displayName} native hook trust was denied; hooks remain inactive until approved through the native trust path`
            : `${bundle.displayName} hook trust was not observed; review it through the native trust path`,
    });
  }
  const agentRelayCompatible =
    isAgentRelaySkillVersionCompatible(manifest.agentRelayVersion) &&
    selectedMetadata.every(
      ({ metadata, state }) =>
        metadata?.compatibility.agentRelay ===
          AGENT_RELAY_SKILL_VERSION_RANGE &&
        metadata.version === state?.bundleVersion,
    );
  checks.push({
    name: "integration-agent-relay-compatibility",
    ok: agentRelayCompatible,
    level: agentRelayCompatible ? "pass" : "fail",
    detail: agentRelayCompatible
      ? `Agent Relay ${manifest.agentRelayVersion} is compatible with every selected bundle`
      : "Agent Relay or bundle-version compatibility is outside the installed integration contract; upgrade or roll back to a compatible owned bundle",
  });
  const mcpCompatible = selectedMetadata.every(
    ({ metadata }) =>
      metadata?.compatibility.mcpSurface === RELAY_MCP_SURFACE_VERSION &&
      metadata.compatibility.mcpProtocol === RELAY_MCP_PROTOCOL_VERSION,
  );
  checks.push({
    name: "integration-mcp-compatibility",
    ok: mcpCompatible,
    level: mcpCompatible ? "pass" : "fail",
    detail: mcpCompatible
      ? `${RELAY_MCP_SURFACE_VERSION} over MCP ${RELAY_MCP_PROTOCOL_VERSION} is exact for every selected bundle`
      : "MCP surface or protocol metadata is incompatible; upgrade, roll back, or reinstall the owned bundle",
  });
  const skillContractCompatible = selectedMetadata.every(
    ({ metadata }) =>
      metadata?.compatibility.skillContract ===
      AGENT_RELAY_SKILL_CONTRACT_VERSION,
  );
  checks.push({
    name: "integration-skill-contract-compatibility",
    ok: skillContractCompatible,
    level: skillContractCompatible ? "pass" : "fail",
    detail: skillContractCompatible
      ? `skill contract ${AGENT_RELAY_SKILL_CONTRACT_VERSION} is exact for every selected bundle`
      : "skill-contract metadata is incompatible; upgrade, roll back, or reinstall the owned bundle",
  });
  const securityBoundaryCompatible = selectedMetadata.every(
    ({ metadata }) =>
      metadata?.security.networking === "loopback-only" &&
      metadata.security.authorization === "native-harness-only" &&
      metadata.security.exactSessionBinding ===
        "AGENT_RELAY_MCP_BINDING inherited from Relay supervisor" &&
      metadata.security.embeddedCredentials === false,
  );
  checks.push({
    name: "integration-security-boundary",
    ok: securityBoundaryCompatible,
    level: securityBoundaryCompatible ? "pass" : "fail",
    detail: securityBoundaryCompatible
      ? "loopback networking, exact supervisor binding, secret-free manifests, and native authorization are intact"
      : "integration security metadata is incompatible; disable the bundle and reinstall or roll back before use",
  });
  const contractCompatible =
    agentRelayCompatible &&
    mcpCompatible &&
    skillContractCompatible &&
    securityBoundaryCompatible;
  checks.push({
    name: "integration-contract-compatibility",
    ok: contractCompatible,
    level: contractCompatible ? "pass" : "fail",
    detail: contractCompatible
      ? `Agent Relay ${manifest.agentRelayVersion}, ${RELAY_MCP_SURFACE_VERSION}, MCP ${RELAY_MCP_PROTOCOL_VERSION}, and skill contract ${AGENT_RELAY_SKILL_CONTRACT_VERSION} metadata are exact and secret-free`
      : "one or more installed integration contracts are incompatible; follow the component-specific repair result",
  });
  let conflict: string | undefined;
  try {
    await assertManualConfigurationDoesNotConflict(paths.rootDir);
  } catch (error) {
    conflict =
      error instanceof Error
        ? error.message
        : "manual Agent Relay component conflict detected";
  }
  for (const bundle of vendorPluginBundles()) {
    if (
      (await exists(paths.targets[bundle.harness])) &&
      (await exists(paths.disabledTargets[bundle.harness]))
    ) {
      conflict = `${bundle.displayName} has both active and disabled Agent Relay plugin trees; remove the duplicate owned tree before repair`;
      break;
    }
  }
  checks.push({
    name: "integration-conflicts",
    ok: conflict === undefined,
    level: conflict === undefined ? "pass" : "fail",
    detail:
      conflict ??
      "no owned-target conflict is present; manual configuration is never copied into this report",
  });
  return {
    installed: true,
    healthy: checks.every((check) => check.level !== "fail"),
    checks,
  };
}
