const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]"],
  [
    /\b(api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    "$1=[REDACTED]",
  ],
];

export function redactText(value: string, limit = 4_000): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

export function redactValue(
  value: unknown,
  options: {
    stringLimit?: number;
    arrayLimit?: number;
    objectLimit?: number;
    depthLimit?: number;
  } = {},
  depth = 0,
): unknown {
  const stringLimit = options.stringLimit ?? 2_000;
  const arrayLimit = options.arrayLimit ?? 20;
  const objectLimit = options.objectLimit ?? 40;
  const depthLimit = options.depthLimit ?? 8;
  if (typeof value === "string") {
    return redactText(value, stringLimit);
  }
  if (depth >= depthLimit) {
    return "[REDACTED_DEPTH_LIMIT]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimit)
      .map((child) => redactValue(child, options, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/token|secret|credential|authorization/i.test(key))
        .slice(0, objectLimit)
        .map(([key, child]) => [key, redactValue(child, options, depth + 1)]),
    );
  }
  return value;
}
