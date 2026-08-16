export const CODEX_LOCAL_MARKETPLACE_NAME = "agent-relay-local" as const;
export const CODEX_LOCAL_PLUGIN_ID = "agent-relay@agent-relay-local" as const;

export type CodexEnablementMode = "enable" | "disable" | "uninstall";

const MARKETPLACE_HEADER = `[marketplaces.${CODEX_LOCAL_MARKETPLACE_NAME}]`;
const PLUGIN_HEADER = `[plugins."${CODEX_LOCAL_PLUGIN_ID}"]`;

function ownedTablePattern(header: string): RegExp {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\n[\\s\\S]*?(?=\\n\\[|\\s*$)`, "u");
}

function stripOwnedTables(raw: string): string {
  let next = raw;
  for (const header of [MARKETPLACE_HEADER, PLUGIN_HEADER]) {
    next = next.replace(ownedTablePattern(header), "\n");
  }
  return next.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n");
}

function ownedTables(marketplaceRoot: string, enabled: boolean): string {
  return `${MARKETPLACE_HEADER}
source_type = "local"
source = ${JSON.stringify(marketplaceRoot)}

${PLUGIN_HEADER}
enabled = ${enabled ? "true" : "false"}
`;
}

function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n/gu, "\n");
}

export function applyCodexPluginEnablement(
  raw: string | undefined,
  marketplaceRoot: string,
  mode: CodexEnablementMode,
): string | undefined {
  const base = stripOwnedTables(normalizeNewlines(raw ?? "")).replace(
    /^\n+/u,
    "",
  );
  if (mode === "uninstall") {
    const trimmed = base.replace(/\s+$/u, "");
    return trimmed.length === 0 ? undefined : `${trimmed}\n`;
  }
  const block = ownedTables(marketplaceRoot, mode === "enable");
  if (base.trim().length === 0) {
    return `${block}\n`;
  }
  return `${base.replace(/\s+$/u, "")}\n\n${block}\n`;
}

export function codexPluginEnablementHealthy(
  raw: string | undefined,
  marketplaceRoot: string,
  expected: "enabled" | "disabled" | "absent",
): boolean {
  if (raw === undefined) {
    return expected === "absent";
  }
  const normalized = normalizeNewlines(raw);
  const hasMarketplace = normalized.includes(MARKETPLACE_HEADER);
  const hasPlugin = normalized.includes(PLUGIN_HEADER);
  const hasSource = normalized.includes(
    `source = ${JSON.stringify(marketplaceRoot)}`,
  );
  const enabledTrue = normalized.includes(`${PLUGIN_HEADER}\nenabled = true`);
  const enabledFalse = normalized.includes(`${PLUGIN_HEADER}\nenabled = false`);
  if (expected === "absent") {
    return !hasMarketplace && !hasPlugin;
  }
  if (!hasMarketplace || !hasPlugin || !hasSource) {
    return false;
  }
  return expected === "enabled" ? enabledTrue : enabledFalse;
}
