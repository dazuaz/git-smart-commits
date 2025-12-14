export function isDebugEnabled(): boolean {
  const v = process.env.GIT_SMART_DEBUG?.trim();
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function debugLog(message: string): void {
  if (!isDebugEnabled()) return;
  const ts = new Date().toISOString();
  // stderr so it won't interfere with message output piping.
  console.error(`[git-smart-commit debug ${ts}] ${message}`);
}

