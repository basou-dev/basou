import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import type { GitSnapshotEvent } from "../schemas/event.schema.js";
import { findErrorCode } from "../storage/status.js";

/**
 * Build a {@link SimpleGit} instance bound to `repoRoot`. Production callers
 * use this single helper so any future tightening (additional safety opts,
 * environment scrubbing, ...) lands in one place. Test fixtures that need
 * `unsafe.allowUnsafeConfigPaths` for isolated `GIT_CONFIG_*` paths build
 * their own SimpleGit locally and intentionally bypass this helper.
 */
export function safeSimpleGit(repoRoot: string): SimpleGit {
  return simpleGit({ baseDir: repoRoot });
}

/**
 * Detect "git executable not found" across error wrappers used by simple-git.
 * simple-git surfaces spawn errors as `GitError` instances which discard the
 * original errno `code` property — only the underlying `"spawn git ENOENT"`
 * text survives in the message string. We therefore check both the errno
 * `code` (via {@link findErrorCode}) and the message chain.
 */
export function isGitNotFound(error: unknown): boolean {
  if (findErrorCode(error, "ENOENT")) return true;
  let cur: unknown = error;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    if (/\bENOENT\b/.test(cur.message)) return true;
    cur = (cur as Error).cause;
  }
  return false;
}

/**
 * Payload subset of `git_snapshot` event, mechanically derived from the
 * zod-inferred event type. The wrapping event-shape fields
 * (schema_version, id, session_id, occurred_at, source, type) are added by
 * the caller (session lifecycle in later steps) when constructing the
 * event, so the schema remains the single source of truth.
 *
 * `ahead` / `behind` are omitted when there is no remote or no upstream
 * tracking; the schema declares both as optional non-negative integers.
 */
export type GitSnapshot = Omit<
  GitSnapshotEvent,
  "schema_version" | "id" | "session_id" | "occurred_at" | "source" | "type"
>;

/**
 * Resolve the absolute path of the Git repository root that contains `cwd`.
 * Equivalent to `git rev-parse --show-toplevel`.
 *
 * Throws `Error("Git executable not found in PATH. Install git first.")`
 * with the spawn error attached as `cause` when git itself is missing.
 * Throws `Error("Not a git repository")` (without command-specific suffix)
 * when `cwd` is not inside a repository — callers MAY wrap with their own
 * "Run 'git init' first, then re-run 'basou XXX'." suffix.
 *
 * Pathless contract: the thrown message never embeds `cwd` or any absolute
 * path; native errors are kept on `error.cause` for verbose surfacing.
 */
export async function resolveRepositoryRoot(cwd: string): Promise<string> {
  const git = safeSimpleGit(cwd);
  try {
    const root = (await git.revparse(["--show-toplevel"])).trimEnd();
    if (root.length === 0) {
      throw new Error("Not a git repository");
    }
    return root;
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    if (error instanceof Error && error.message === "Not a git repository") {
      throw error;
    }
    throw new Error("Not a git repository", { cause: error });
  }
}

/**
 * Resolve the repository root that owns the `.basou/` store for `cwd`, with a
 * fallback for agents-workspace "view" directories. A workspace view (e.g.
 * `~/projects/foo-workspace`) is intentionally OUTSIDE git and holds no `.basou/`
 * of its own; it aggregates sibling repos through symlinks (`foo-planning ->
 * ../foo-planning`). Running `basou orient` / `refresh` from there would
 * otherwise die with "Not a git repository" even though the view IS the
 * operator's daily cwd.
 *
 * Resolution:
 *  1. If `cwd` is inside a git repo, return its toplevel (unchanged behavior).
 *  2. Otherwise inspect `cwd`'s direct symlinks; if exactly one points at a
 *     directory that has a `.basou/` store, redirect to that repo (firing
 *     `onRedirect`). Zero candidates re-throws the original "Not a git
 *     repository"; two or more throws an ambiguity error naming them so the
 *     operator can `cd` into the right one.
 */
export async function resolveBasouRepositoryRoot(
  cwd: string,
  opts?: { onRedirect?: (info: { via: string; root: string }) => void },
): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== "Not a git repository") throw error;
    const linked = await findLinkedBasouRepos(cwd);
    const only = linked[0];
    if (only !== undefined && linked.length === 1) {
      opts?.onRedirect?.({ via: only.name, root: only.root });
      return only.root;
    }
    if (linked.length > 1) {
      const names = linked.map((l) => l.name).join(", ");
      throw new Error(
        `Ambiguous workspace view: ${linked.length} linked repos have a .basou store (${names}). cd into the one you want and re-run.`,
      );
    }
    throw error;
  }
}

/**
 * Direct children of `dir` that are symlinks to a git repository whose toplevel
 * holds a `.basou/` store — the planning repos a workspace view aggregates.
 * Detection keys off the git TOPLEVEL (where basou's store always lives), not
 * the raw link target, so a link into a subdirectory is not mistaken for a root.
 * Deduped by toplevel keeping the lexicographically-smallest link name (stable
 * `via` across runs), and sorted by name. Best-effort: an unreadable dir, a
 * broken link, or a non-git target yields no candidate.
 */
async function findLinkedBasouRepos(dir: string): Promise<{ name: string; root: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const byRoot = new Map<string, string>(); // git toplevel -> chosen link name
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    let root: string;
    try {
      root = await resolveRepositoryRoot(join(dir, entry.name));
    } catch {
      continue; // broken link or not a git repo
    }
    try {
      if (!(await stat(join(root, ".basou"))).isDirectory()) continue;
    } catch {
      continue; // no .basou store at the repo root
    }
    const existing = byRoot.get(root);
    if (existing === undefined || entry.name < existing) byRoot.set(root, entry.name);
  }
  return [...byRoot.entries()]
    .map(([root, name]) => ({ name, root }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read `remote.origin.url` from the local repository config. Returns
 * `undefined` if the remote is unset, the value is empty, or the lookup
 * fails for any reason (best-effort).
 *
 * The `--local` scope is critical: callers MUST NOT pick up the developer's
 * global remote.origin.url, which could leak the wrong repository URL into
 * `manifest.yaml`.
 */
export async function tryRemoteUrl(repositoryRoot: string): Promise<string | undefined> {
  const git = safeSimpleGit(repositoryRoot);
  try {
    const result = await git.getConfig("remote.origin.url", "local");
    const url = (result.value ?? "").trimEnd();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a {@link GitSnapshot} for the repository at `repositoryRoot`. The
 * caller is responsible for ensuring `repositoryRoot` is the canonical root
 * (typically obtained via {@link resolveRepositoryRoot}); this function
 * verifies repo membership via `git rev-parse --is-inside-work-tree` to
 * distinguish a non-git directory from an empty repository.
 *
 * Edge cases:
 * - **non-git directory**: throws `Error("Not a git repository")`
 * - **empty repo (no commits)**: throws `Error("No commits in repository")`
 * - **detached HEAD**: `branch = "HEAD"`, `head = commit hash`,
 *   `ahead`/`behind` omitted
 * - **no remote / no upstream tracking**: `ahead`/`behind` omitted
 *
 * Pathless contract preserved on every throw path.
 */
export async function getSnapshot(repositoryRoot: string): Promise<GitSnapshot> {
  const git = safeSimpleGit(repositoryRoot);

  let inside: boolean;
  try {
    inside = await git.checkIsRepo();
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Failed to read git state", { cause: error });
  }
  if (!inside) {
    throw new Error("Not a git repository");
  }

  let head: string;
  try {
    head = (await git.revparse(["HEAD"])).trimEnd();
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("No commits in repository", { cause: error });
  }
  if (head.length === 0) {
    throw new Error("No commits in repository");
  }

  let branch: string;
  try {
    const raw = (await git.raw(["branch", "--show-current"])).trimEnd();
    branch = raw.length > 0 ? raw : "HEAD";
  } catch (error: unknown) {
    throw new Error("Failed to read git state", { cause: error });
  }

  let dirty: boolean;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  try {
    const status = await git.status();
    dirty = !status.isClean();
    // Walk status.files so deleted / renamed / conflicted entries are
    // classified correctly (StatusResult's top-level `staged` / `modified`
    // / `not_added` arrays exclude D / R / U entries).
    for (const f of status.files) {
      if (f.index === "?" && f.working_dir === "?") {
        untracked.push(f.path);
        continue;
      }
      if (f.index !== " " && f.index !== "?") staged.push(f.path);
      if (f.working_dir !== " " && f.working_dir !== "?") unstaged.push(f.path);
    }
  } catch (error: unknown) {
    throw new Error("Failed to read git state", { cause: error });
  }

  let ahead: number | undefined;
  let behind: number | undefined;
  if (branch !== "HEAD") {
    try {
      const upstream = `${branch}@{upstream}`;
      const counts = (
        await git.raw(["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
      ).trim();
      const [behindStr, aheadStr] = counts.split(/\s+/);
      const parsedBehind = Number.parseInt(behindStr ?? "", 10);
      const parsedAhead = Number.parseInt(aheadStr ?? "", 10);
      if (Number.isFinite(parsedBehind) && parsedBehind >= 0) behind = parsedBehind;
      if (Number.isFinite(parsedAhead) && parsedAhead >= 0) ahead = parsedAhead;
    } catch {
      // No upstream tracking: leave both undefined; the schema allows omission.
    }
  }

  const snapshot: GitSnapshot = {
    head,
    branch,
    dirty,
    staged,
    unstaged,
    untracked,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  };
  return snapshot;
}
