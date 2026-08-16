export const CLAUDE_LOCAL_MARKETPLACE_NAME = "agent-relay-local" as const;
export const CLAUDE_LOCAL_PLUGIN_ID = "agent-relay@agent-relay-local" as const;

export type ClaudeEnablementMode = "enable" | "disable" | "uninstall";

interface ClaudeSettingsObject {
  extraKnownMarketplaces?: Record<string, unknown>;
  enabledPlugins?: Record<string, unknown>;
  [key: string]: unknown;
}

export function claudeMarketplaceEnablement(marketplaceRoot: string): {
  source: { source: "directory"; path: string };
} {
  return {
    source: {
      source: "directory",
      path: marketplaceRoot,
    },
  };
}

export function parseClaudeUserSettings(raw: string | undefined): {
  settings: ClaudeSettingsObject;
  created: boolean;
} {
  if (raw === undefined || raw.trim().length === 0) {
    return { settings: {}, created: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "Claude user settings are not valid JSON; preserve the file and reconcile it before retrying",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Claude user settings must be a JSON object; preserve the file and reconcile it before retrying",
    );
  }
  return { settings: parsed as ClaudeSettingsObject, created: false };
}

export function applyClaudePluginEnablement(
  raw: string | undefined,
  marketplaceRoot: string,
  mode: ClaudeEnablementMode,
): string | undefined {
  const { settings } = parseClaudeUserSettings(raw);
  const marketplaces =
    settings.extraKnownMarketplaces !== undefined &&
    typeof settings.extraKnownMarketplaces === "object" &&
    !Array.isArray(settings.extraKnownMarketplaces)
      ? { ...settings.extraKnownMarketplaces }
      : {};
  const enabled =
    settings.enabledPlugins !== undefined &&
    typeof settings.enabledPlugins === "object" &&
    !Array.isArray(settings.enabledPlugins)
      ? { ...settings.enabledPlugins }
      : {};

  if (
    (settings.extraKnownMarketplaces !== undefined &&
      (typeof settings.extraKnownMarketplaces !== "object" ||
        Array.isArray(settings.extraKnownMarketplaces))) ||
    (settings.enabledPlugins !== undefined &&
      (typeof settings.enabledPlugins !== "object" ||
        Array.isArray(settings.enabledPlugins)))
  ) {
    throw new Error(
      "Claude plugin enablement keys are not objects; preserve the file and reconcile it before retrying",
    );
  }

  if (mode === "uninstall") {
    delete marketplaces[CLAUDE_LOCAL_MARKETPLACE_NAME];
    delete enabled[CLAUDE_LOCAL_PLUGIN_ID];
  } else if (mode === "disable") {
    marketplaces[CLAUDE_LOCAL_MARKETPLACE_NAME] =
      claudeMarketplaceEnablement(marketplaceRoot);
    enabled[CLAUDE_LOCAL_PLUGIN_ID] = false;
  } else {
    marketplaces[CLAUDE_LOCAL_MARKETPLACE_NAME] =
      claudeMarketplaceEnablement(marketplaceRoot);
    enabled[CLAUDE_LOCAL_PLUGIN_ID] = true;
  }

  const next: ClaudeSettingsObject = { ...settings };
  if (Object.keys(marketplaces).length === 0) {
    delete next.extraKnownMarketplaces;
  } else {
    next.extraKnownMarketplaces = marketplaces;
  }
  if (Object.keys(enabled).length === 0) {
    delete next.enabledPlugins;
  } else {
    next.enabledPlugins = enabled;
  }

  if (Object.keys(next).length === 0) {
    return undefined;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function claudePluginEnablementHealthy(
  raw: string | undefined,
  marketplaceRoot: string,
  expected: "enabled" | "disabled" | "absent",
): boolean {
  if (raw === undefined) {
    return expected === "absent";
  }
  const { settings } = parseClaudeUserSettings(raw);
  const marketplace =
    settings.extraKnownMarketplaces?.[CLAUDE_LOCAL_MARKETPLACE_NAME];
  const plugin = settings.enabledPlugins?.[CLAUDE_LOCAL_PLUGIN_ID];
  if (expected === "absent") {
    return marketplace === undefined && plugin === undefined;
  }
  const marketplaceExact =
    JSON.stringify(marketplace) ===
    JSON.stringify(claudeMarketplaceEnablement(marketplaceRoot));
  return expected === "enabled"
    ? marketplaceExact && plugin === true
    : marketplaceExact && plugin === false;
}
