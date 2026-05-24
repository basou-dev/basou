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

  // (1) workingDirectory-internal -> repo-relative.
  if (normalized === wd) return ".";
  const wdRel = path.relative(wd, normalized);
  if (wdRel !== "" && !wdRel.startsWith("..")) {
    return wdRel;
  }

  // (2) homedir-internal -> ~/...
  if (normalized === home) return "~";
  const homeRel = path.relative(home, normalized);
  if (homeRel !== "" && !homeRel.startsWith("..")) {
    return `~/${homeRel}`;
  }

  // (3) preserve as-is.
  return normalized;
}

/**
 * Sanitize the `working_directory` field itself. This is a distinct entry
 * point because the field's own value is the workingDirectory of every
 * `related_files[]` entry written alongside it — running it through
 * {@link sanitizePath} with `opts.workingDirectory = rawPath` would
 * collapse the result to `"."` and lose the homedir-relative form the
 * spec requires.
 *
 * Strategy: bypass the workingDirectory rule entirely by passing a
 * sentinel that no real path can match. The homedir rule (rule 2) and
 * the preserve-as-is rule (rule 3) still apply, so:
 *   - `/Users/u/projects/foo` → `~/projects/foo`
 *   - `/Users/u` → `~`
 *   - `/srv/work` → `/srv/work` (preserved, off-tree)
 *
 * Callers should still pass the live `homedir` so the rewrite uses the
 * real operator-private prefix.
 */
export function sanitizeWorkingDirectory(
  rawPath: string,
  opts: Pick<SanitizePathOptions, "homedir">,
): string {
  // A sentinel that no real absolute path on disk can equal or be under.
  // `path.posix.normalize` collapses leading `/` so any sentinel must
  // remain non-prefixing post-normalisation; the sentinel below survives
  // normalisation as itself and never matches a real path.
  return sanitizePath(rawPath, {
    workingDirectory: "/__basou_sentinel_never_match__",
    homedir: opts.homedir,
  });
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
