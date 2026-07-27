export function resolveHookHarnessVersion(options: {
  flagVersion: string | undefined;
  environmentVersion: string | undefined;
  supervised: boolean;
}): string {
  const preferred = options.supervised
    ? (options.environmentVersion ?? options.flagVersion)
    : (options.flagVersion ?? options.environmentVersion);
  return preferred ?? "unknown";
}

export function resolveWebEnabled(options: {
  environmentValue: string | undefined;
  disabledByFlag: boolean;
}): boolean {
  if (options.disabledByFlag) {
    return false;
  }
  if (options.environmentValue === undefined) {
    return true;
  }
  const normalized = options.environmentValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(
    "AGENT_RELAY_WEB_ENABLED must be one of 1, 0, true, false, yes, no, on, or off",
  );
}
