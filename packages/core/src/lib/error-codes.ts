/**
 * Walk the cause chain (up to `depth` levels) looking for an Error whose
 * errno-style `code` matches `code`. Returns true on the first match.
 * Resilient to wrapper depth changes so that ENOENT detection survives
 * future error-wrapping refactors.
 */
export function findErrorCode(error: unknown, code: string, depth = 4): boolean {
  let cur: unknown = error;
  for (let i = 0; i < depth && cur instanceof Error; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && c === code) return true;
    cur = (cur as Error).cause;
  }
  return false;
}
