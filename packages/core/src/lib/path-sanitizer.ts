import { posix as path } from "node:path";

/**
 * Options for {@link sanitizePath}. Both `workingDirectory` and `homedir`
 * are absolute POSIX paths the caller has already resolved (typically via
 * `process.cwd()` and `os.homedir()`). Callers are responsible for passing
 * fully normalised values; the sanitizer normalises them again internally
 * so a trailing slash or `.`-segment does not corrupt the prefix match.
 */
export type SanitizePathOptions = {
  /**
   * The session's working directory (= the `working_directory` field the
   * caller is about to write). Paths under this directory are rewritten
   * relative to it so the operator-private absolute prefix never leaks
   * into the workspace's persistent state.
   */
  workingDirectory: string;
  /**
   * The operator's home directory. Paths under this directory (but NOT
   * under `workingDirectory`) are rewritten with a `~/` prefix.
   */
  homedir: string;
};

/**
 * Rewrite an absolute path into a workspace-friendly form so the persisted
 * state of `.basou/` does not leak the operator's machine layout:
 *
 *   1. Paths under `opts.workingDirectory` become repository-relative
 *      (e.g. `<wd>/src/x.ts` → `src/x.ts`, `<wd>` itself → `.`).
 *   2. Paths under `opts.homedir` (but not workingDirectory) become
 *      tilde-prefixed (`/Users/u/notes/x.md` → `~/notes/x.md`,
 *      `/Users/u` → `~`).
 *   3. Anything else — relative paths, system paths under `/etc/*`,
 *      `..`-escapes from either base, paths that simply do not share a
 *      prefix with either option — is returned verbatim (after `..`
 *      normalisation). The sanitizer is intentionally non-redacting on
 *      system paths so an operator who deliberately recorded a system
 *      file (e.g. `/etc/hosts`) is not silently stripped of context.
 *
 * Hardening:
 *   - A null byte in the input is rejected with `Invalid path: contains
 *     null byte` (= POSIX path APIs treat \0 as terminator and any path
 *     containing one is malformed; we never accept it on the write side).
 *   - `..` segments are resolved purely (no fs access) so the prefix
 *     match cannot be defeated by `<wd>/../escape/x.ts` masquerading as
 *     workingDirectory-internal.
 *   - Backslashes are folded to forward slashes so a Windows-style input
 *     can still be matched against POSIX bases. v0.3 targets macOS /
 *     Linux only; full Windows support is a v0.4+ task.
 */
export function sanitizePath(rawPath: string, opts: SanitizePathOptions): string {
  if (rawPath.includes("\0")) {
    throw new Error("Invalid path: contains null byte");
  }
  const normalized = path.normalize(rawPath.replace(/\\/g, "/"));
  const wd = path.normalize(opts.workingDirectory.replace(/\\/g, "/"));
  const home = path.normalize(opts.homedir.replace(/\\/g, "/"));

  // Only attempt prefix matching for absolute inputs; an already-relative
  // path stays as-is so write paths that pre-relativised do not get
  // mangled.
  if (!path.isAbsolute(normalized)) {
    return normalized;
  }

  // (1) workingDirectory 配下 → repo-relative.
  if (normalized === wd) return ".";
  const wdRel = path.relative(wd, normalized);
  if (wdRel !== "" && !wdRel.startsWith("..")) {
    return wdRel;
  }

  // (2) homedir 配下 → ~/...
  if (normalized === home) return "~";
  const homeRel = path.relative(home, normalized);
  if (homeRel !== "" && !homeRel.startsWith("..")) {
    return `~/${homeRel}`;
  }

  // (3) preserve as-is.
  return normalized;
}

/**
 * Convenience wrapper around {@link sanitizePath} for the
 * `working_directory` field. Functionally identical: the same sanitization
 * rules apply whether the path is being stored as a directory itself or
 * referenced from an array. Exists so call-sites read clearly and a
 * future divergence (e.g. a stricter rule on working directories) can be
 * applied in one place.
 */
export function sanitizeWorkingDirectory(rawPath: string, opts: SanitizePathOptions): string {
  return sanitizePath(rawPath, opts);
}

/** Result of {@link sanitizeRelatedFiles}. */
export type SanitizeRelatedFilesResult = {
  /** Sanitized path list (same length as the input). */
  sanitized: string[];
  /** Number of entries whose sanitized form differs from the input. */
  mutationCount: number;
};

/**
 * Apply {@link sanitizePath} to every entry of a `related_files[]` array
 * and report how many entries actually changed shape so callers (e.g. the
 * session-import CLI) can surface a single-line warning. The helper does
 * not deduplicate — callers already collect related_files into a Set
 * before serialising.
 */
export function sanitizeRelatedFiles(
  paths: ReadonlyArray<string>,
  opts: SanitizePathOptions,
): SanitizeRelatedFilesResult {
  const sanitized: string[] = [];
  let mutationCount = 0;
  for (const p of paths) {
    const next = sanitizePath(p, opts);
    sanitized.push(next);
    if (next !== p) mutationCount += 1;
  }
  return { sanitized, mutationCount };
}
