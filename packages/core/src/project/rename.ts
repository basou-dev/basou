/**
 * Rename (re-path) a repo in a project's declared roster. When a repo's
 * directory is moved or renamed on disk, its declared `path` (and the matching
 * `source_roots` capture entry) must follow, or the roster drifts from reality.
 * This is the saddle model's maintenance counterpart to `archive` — it mutates
 * the manifest's path references rather than removing them.
 *
 * Pure: it computes the mutation from the DECLARED lists alone — no filesystem
 * or git I/O — so it works regardless of whether the move has happened on disk
 * yet. The repo-side wiring that embeds the old basename (the anchor canonical
 * `agents/<basename>/AGENTS.md`, the workspace-view symlink, the relative
 * targets of the repo's own instruction symlinks) is the caller's separate
 * concern; this only re-paths the declaration.
 */

import { normalizeRelativePath as normalize } from "./relative-path.js";
import type { RepoEntry } from "./roster.js";

export type RenamePlan = {
  /** The normalized source path being renamed. */
  oldTarget: string;
  /** The normalized destination path. */
  newTarget: string;
  /** True when old and new normalize to the same path (nothing to do). */
  noop: boolean;
  /**
   * True when the source resolves to the anchor/host (`.`). Renaming the
   * project's own root is refused; the caller writes nothing.
   */
  isAnchor: boolean;
  /** True when the source path is declared in the roster. */
  found: boolean;
  /** True when the destination path is ALREADY declared (a distinct entry) — refused to avoid a duplicate. */
  collision: boolean;
  /** The roster entry being renamed (echoed for the report); set only in the actionable case. */
  rosterEntry?: RepoEntry | undefined;
  /** The roster after re-pathing the entry (other fields preserved). */
  nextRepos: RepoEntry[];
  /** True when the roster changed. */
  reposChanged: boolean;
  /** The old normalized path that was re-pathed in `source_roots`; set only when it was captured. */
  sourceRootRenamed?: string | undefined;
  /** The `source_roots` after re-pathing; set only when a rename happened. */
  nextSourceRoots?: string[] | undefined;
  /** True when the basename changes (old/new last segment differ) — the repo-side canonical/view names need renaming too. */
  basenameChanged: boolean;
};

/** The last path segment of a normalized relative path (e.g. "../a/x" => "x", "." => "."). */
export function pathBasename(p: string): string {
  const parts = normalize(p).split("/");
  return parts[parts.length - 1] as string;
}

/** Dedup roster entries by normalized path (first wins). */
function dedupRepos(entries: RepoEntry[]): RepoEntry[] {
  const seen = new Set<string>();
  const out: RepoEntry[] = [];
  for (const e of entries) {
    const k = normalize(e.path);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Dedup source-root strings by normalized form (first occurrence wins, original form kept). */
function dedupNorm(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const k = normalize(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Compute the {@link RenamePlan} for re-pathing `oldPath` to `newPath`. Pure: it
 * re-maps the declared `repos` and `source_roots` by normalized path.
 *
 * - A no-op (old === new), renaming the anchor, a source not in the roster, or a
 *   destination that already exists as a distinct entry (collision) all change
 *   nothing — the caller writes nothing and the report explains.
 * - Otherwise EVERY roster entry matching the old path is re-pathed to the new
 *   path (preserving its visibility/language/publishes), and the result is
 *   deduped (so an old path declared twice collapses to one new entry). The
 *   matching `source_roots` entry (commonly the same path) is re-pathed and
 *   deduped likewise; all other entries (the host `.`, a view source root) keep
 *   their position and form.
 */
export function planRename(input: {
  repos?: RepoEntry[];
  sourceRoots?: string[];
  oldPath: string;
  newPath: string;
  oldIsAnchor?: boolean;
}): RenamePlan {
  const oldTarget = normalize(input.oldPath);
  const newTarget = normalize(input.newPath);
  const repos = input.repos ?? [];
  const basenameChanged = pathBasename(oldTarget) !== pathBasename(newTarget);
  const noop = oldTarget === newTarget;
  const isAnchor = input.oldIsAnchor === true || oldTarget === ".";
  const found = repos.some((r) => normalize(r.path) === oldTarget);
  const collision = !noop && repos.some((r) => normalize(r.path) === newTarget);

  if (noop || isAnchor || !found || collision) {
    return {
      oldTarget,
      newTarget,
      noop,
      isAnchor,
      found,
      collision,
      nextRepos: repos,
      reposChanged: false,
      basenameChanged,
    };
  }

  // FIRST match wins, consistently: dedupRepos below also keeps the first, so the
  // echoed entry and the written entry are the same object when a path is
  // (malformed-ly) declared twice with differing metadata.
  const rosterEntry = repos.find((r) => normalize(r.path) === oldTarget);
  const nextRepos = dedupRepos(
    repos.map((r) => (normalize(r.path) === oldTarget ? { ...r, path: newTarget } : r)),
  );

  let sourceRootRenamed: string | undefined;
  let nextSourceRoots: string[] | undefined;
  if (
    input.sourceRoots !== undefined &&
    input.sourceRoots.some((s) => normalize(s) === oldTarget)
  ) {
    nextSourceRoots = dedupNorm(
      input.sourceRoots.map((s) => (normalize(s) === oldTarget ? newTarget : s)),
    );
    sourceRootRenamed = oldTarget;
  }

  return {
    oldTarget,
    newTarget,
    noop: false,
    isAnchor: false,
    found: true,
    collision: false,
    rosterEntry,
    nextRepos,
    reposChanged: true,
    ...(sourceRootRenamed !== undefined ? { sourceRootRenamed } : {}),
    ...(nextSourceRoots !== undefined ? { nextSourceRoots } : {}),
    basenameChanged,
  };
}
