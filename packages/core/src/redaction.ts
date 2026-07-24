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
