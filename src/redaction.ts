const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|private[_-]?key)\s*[:=]\s*["']?)(?!\[REDACTED)[^"'\s,;]+/gi;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[REDACTED_TOKEN]"],
  [SECRET_ASSIGNMENT, "$1[REDACTED]"],
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
