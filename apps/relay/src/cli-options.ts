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
