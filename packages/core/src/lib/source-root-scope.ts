import { promises as fs } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

/**
 * Cross-project boundary classification: split a session's `related_files`
 * into those that resolve INSIDE the project's declared `source_roots` and
 * those that confidently resolve OUTSIDE all of them.
 *
 * Why this exists: the claude-code adapter records every file a transcript
 * edited, regardless of where the file lives. A session is attributed to a
 * project by its recorded cwd (the import-time cwd guard), but a session that
 * legitimately belongs to project A can still have edited files under an
 * unrelated repo B. Those B paths then surface in `basou orient`'s "recent
 * files" and can mislead a resuming agent into continuing the wrong project's
 * work. This helper is the read-only primitive both the import warning and the
 * orientation advisory use to flag that boundary crossing — it never mutates
 * the trail.
 *
 * Resolution is realpath-aware so a file recorded through a workspace-view
 * symlink (e.g. `~/projects/foo-workspace/foo -> ../foo`) is NOT mis-flagged as
 * out-of-root. The bias is deliberately toward NOT crying wolf: a path is only
 * reported out-of-root when it confidently resolves outside every source root.
 * Anything that cannot be resolved with confidence stays classified in-root.
 */

/**
 * The agent's / basou's own tooling directories. Edits here (plans, memory,
 * the trail store itself) are routine infrastructure, not another project's
 * work, so callers pass these as `extraInRoot` to keep them out of the
 * cross-project out-of-root flag.
 */
export const AGENT_INFRA_DIRS: readonly string[] = ["~/.claude", "~/.codex", "~/.basou"];

/** Result of {@link classifyFilesBySourceRoot}: a partition of the input. */
export type SourceRootScope = {
  /** Entries (verbatim, as passed in) that resolve under a source root, or that could not be resolved with confidence. */
  inRoot: string[];
  /** Entries (verbatim) that confidently resolve outside every source root. */
  outOfRoot: string[];
};

/**
 * Resolve a `realpath`, tolerating a non-existent tail: realpath the longest
 * existing ANCESTOR and re-append the missing segments. A file recorded in a
 * past session may have since moved or been deleted, but we still want to
 * classify the LOCATION it referred to (and resolve any symlink in its
 * existing ancestry). Falls back to the lexical input on any non-ENOENT error
 * or once the filesystem root is reached without an existing ancestor.
 */
async function realpathBestEffort(absPath: string): Promise<string> {
  let current = normalize(absPath);
  const tail: string[] = [];
  // Bound the walk by path depth so a pathological input cannot loop forever.
  for (let guard = 0; guard < 4096; guard += 1) {
    try {
      const real = await fs.realpath(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // Permission error etc.: do not guess, fall back to the lexical path.
        return normalize(absPath);
      }
      const parent = dirname(current);
      if (parent === current) return normalize(absPath); // reached root, nothing existed
      tail.push(basename(current));
      current = parent;
    }
  }
  return normalize(absPath);
}

/** Expand a leading `~` / `~/` to the home directory; leave other forms as-is. */
function expandTilde(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/")) return join(homedir, p.slice(2));
  return p;
}

/**
 * Resolve a stored (sanitized) path to an absolute path before realpath:
 *   - `~` / `~/x`     → under homedir
 *   - absolute        → as-is
 *   - relative        → resolved against the session working directory
 * `workingDirectory` is itself sanitized (typically `~/...`), so it is
 * tilde-expanded first.
 */
function toAbsolute(p: string, workingDirAbs: string, homedir: string): string {
  const expanded = expandTilde(p, homedir);
  if (isAbsolute(expanded)) return normalize(expanded);
  return normalize(resolve(workingDirAbs, expanded));
}

/**
 * True when `child` is `parent` itself or lives underneath it. Uses
 * `path.relative` rather than raw `startsWith` so a trailing separator or a
 * `..`/`.` segment in either operand cannot defeat the prefix match (the
 * `startsWith` form is a known foot-gun this codebase moved away from in
 * realpath comparisons elsewhere).
 */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Partition `files` into in-root / out-of-root against the project's
 * `source_roots`.
 *
 * - `sourceRoots` are the manifest's `import.source_roots` (relative to
 *   `masterRoot`). An absent/empty list means "the whole repo root" — matching
 *   the effective-source-roots rule elsewhere — so a solo project never reports
 *   anything out-of-root.
 * - `masterRoot` is the absolute repository root the source roots resolve
 *   against (the parent of `.basou`).
 *
 * Returns `{ inRoot, outOfRoot }` preserving the original entry strings. Empty
 * input or zero resolvable roots yields everything in-root (no false alarms).
 */
export async function classifyFilesBySourceRoot(input: {
  files: readonly string[];
  workingDirectory: string;
  sourceRoots: readonly string[] | null | undefined;
  masterRoot: string;
  /**
   * Extra directories (absolute or `~`-prefixed) that also count as in-root.
   * Callers pass the agent's own tooling dirs (`~/.claude`, `~/.codex`,
   * `~/.basou`) so routine plan / memory / store edits are NOT flagged as
   * another project's work — they are infrastructure, not a cross-project
   * crossing. Resolved against the home directory, not `masterRoot`.
   */
  extraInRoot?: readonly string[];
  homedir?: string;
}): Promise<SourceRootScope> {
  const inRoot: string[] = [];
  const outOfRoot: string[] = [];
  if (input.files.length === 0) return { inRoot, outOfRoot };

  const homedir = input.homedir ?? osHomedir();
  const workingDirAbs = toAbsolute(input.workingDirectory, homedir, homedir);

  // Effective roots: a declared list is used verbatim; absent/empty means the
  // whole repo root (mirrors `effectiveSourceRoots`). Resolve + realpath each;
  // drop any that fail to resolve so a single bad entry does not void the rest.
  const declared =
    input.sourceRoots && input.sourceRoots.length > 0 ? [...input.sourceRoots] : ["."];
  const rootsAbs: string[] = [];
  for (const r of declared) {
    const expanded = expandTilde(r, homedir);
    const abs = isAbsolute(expanded)
      ? normalize(expanded)
      : normalize(resolve(input.masterRoot, expanded));
    rootsAbs.push(await realpathBestEffort(abs));
  }
  // Extra in-root dirs (agent/tool infra) resolve against the home directory.
  for (const e of input.extraInRoot ?? []) {
    const expanded = expandTilde(e, homedir);
    const abs = isAbsolute(expanded) ? normalize(expanded) : normalize(resolve(homedir, expanded));
    rootsAbs.push(await realpathBestEffort(abs));
  }
  // No resolvable roots → cannot judge; keep everything in-root.
  if (rootsAbs.length === 0) {
    return { inRoot: [...input.files], outOfRoot };
  }

  for (const file of input.files) {
    try {
      const abs = toAbsolute(file, workingDirAbs, homedir);
      const real = await realpathBestEffort(abs);
      const within = rootsAbs.some((root) => isUnder(real, root));
      (within ? inRoot : outOfRoot).push(file);
    } catch {
      // Any unexpected resolution failure: bias to in-root (do not cry wolf).
      inRoot.push(file);
    }
  }

  return { inRoot, outOfRoot };
}
