/**
 * Plan the symlinks a project's throwaway "view" needs (the generation step
 * after the instruction-file symlinks in the "saddle" model). When a project
 * has 2+ repos, basou generates a view directory that aggregates every roster
 * repo via one symlink each, named by the repo's basename and pointing at the
 * repo (relative to the view):
 *
 *   <view>/app     -> ../app
 *   <view>/anchor  -> ../anchor   (the anchor's "." entry is aggregated here too,
 *   <view>/app-site -> ../app-site   unlike the instruction symlinks)
 *
 * The view is git-unmanaged and regenerable; its location is declared once
 * (`workspace.view` in the manifest) and its contents are derived from the
 * roster. This is the pure planner: it judges already-gathered, per-repo facts
 * (does the view link exist? does it point at the repo?) and reports only what
 * is MISSING. It never overwrites an existing file or repoints a link that
 * points elsewhere — those surface as conflicts for the operator to resolve by
 * hand (non-destructive). The realpath / readlink / symlink I/O is the caller's
 * job.
 *
 * NOT in scope here: pruning stray entries already in the view (needs an
 * ownership model to tell an orphaned repo link from the view's own instruction
 * files / local state) and generating the view's own instruction files.
 */

/**
 * The on-disk state of one repo's view symlink. `correct` = the expected link
 * exists (idempotent skip); `missing` = nothing there (ENOENT) so it can be
 * created; `mismatch` = a symlink pointing elsewhere; `occupied` = a real file
 * or directory; `blocked` = the path could not be inspected (a non-ENOENT lstat
 * error, e.g. a parent component is a file). Only `missing` is actionable.
 */
export type ViewLinkState = "correct" | "missing" | "mismatch" | "occupied" | "blocked";

/** The gathered facts for one roster repo's place in the view. */
export type ViewRepoFact = {
  /** Roster repo path (relative to the manifest root), e.g. ".", "../basou". */
  path: string;
  /**
   * False when the repo cannot be aggregated into the view: its path did not
   * resolve on disk, or it resolves to the view directory itself (a self-link).
   */
  reachable: boolean;
  /** The view symlink name (the repo's basename), e.g. "basou". Set when reachable. */
  linkName?: string;
  /** The relative target the view link should have, e.g. "../basou". Set when reachable. */
  expectedTarget?: string;
  /** On-disk state of `<view>/<linkName>`. Set when reachable. */
  state?: ViewLinkState;
  /** The link's current target, present only when `state` is `mismatch`. */
  actualTarget?: string;
};

/**
 * An existing view entry that is not what we would generate: a symlink pointing
 * elsewhere (`mismatch`), a real file/directory (`occupied`), or an
 * uninspectable path (`blocked`). Surfaced, never overwritten.
 */
export type ViewConflict = {
  name: string;
  reason: "mismatch" | "occupied" | "blocked";
  /** The conflicting link's current target, present only when `reason` is `mismatch`. */
  actualTarget?: string;
};

/**
 * Two or more DISTINCT roster repos whose basename is the same, so they would
 * collide on a single `<view>/<basename>` link. Neither is auto-wired; the
 * operator must disambiguate.
 */
export type ViewCollision = {
  linkName: string;
  repos: string[];
};

export type WorkspaceViewPlan = {
  /** The view symlinks to create (the `missing` ones), as name + relative target. */
  toCreate: { name: string; target: string }[];
  /** Existing entries that block generation and are left untouched. */
  conflicts: ViewConflict[];
  /** Distinct repos colliding on one view link name (not auto-wired). */
  collisions: ViewCollision[];
  /** Roster repo paths that cannot be aggregated: unresolved on disk, or resolving to the view itself. */
  unreachable: string[];
  /** Count of repos whose view link is already correct (for the report). */
  correctCount: number;
  /**
   * True only when nothing needs creating AND there are no conflicts, no
   * collisions, and no unreachable repos — so a clean "view in sync" verdict is
   * never claimed while a repo was blocked, ambiguous, or could not be resolved.
   */
  ok: boolean;
};

/** Normalize a relative roster path for comparison: trim, drop trailing slashes, empty => ".". */
function normalize(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.length === 0 ? "." : s;
}

/**
 * Compute the {@link WorkspaceViewPlan} from per-repo facts. For each declared,
 * reachable, non-colliding repo: a `missing` view link becomes a create, a
 * `mismatch`/`occupied`/`blocked` link becomes a {@link ViewConflict} (never a
 * create — we do not overwrite), and a `correct` link is counted. The view
 * aggregates exactly the DECLARED roster — the anchor is aggregated when present
 * as its `.` entry (which `adopt` always adds) and, unlike the instruction
 * symlinks, is NOT skipped; it is not implicitly injected when absent (the roster
 * is the single source of truth). An unresolvable repo is `unreachable`, and two
 * distinct repos sharing a basename are a {@link ViewCollision} (neither
 * auto-wired).
 *
 * Robustness (mirroring the instruction-symlink planner):
 * - Facts are deduped by normalized path (a repo declared twice yields one link,
 *   never a duplicate `symlinkSync` → EEXIST or a duplicate report entry).
 * - `ok` is true only when there is genuinely nothing to do and every repo was
 *   resolvable and unambiguous.
 */
export function planWorkspaceView(facts: ViewRepoFact[]): WorkspaceViewPlan {
  // Dedup by normalized path (first declaration wins).
  const deduped: ViewRepoFact[] = [];
  const seenPath = new Set<string>();
  for (const f of facts) {
    const key = normalize(f.path);
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    deduped.push(f);
  }

  // Detect basename collisions among the reachable repos (distinct paths sharing
  // one link name would clobber a single `<view>/<basename>`).
  const byLinkName = new Map<string, string[]>();
  for (const f of deduped) {
    if (!f.reachable || f.linkName === undefined) continue;
    const repos = byLinkName.get(f.linkName) ?? [];
    repos.push(f.path);
    byLinkName.set(f.linkName, repos);
  }
  const collisions: ViewCollision[] = [];
  const collidingPaths = new Set<string>();
  for (const [linkName, repos] of byLinkName) {
    if (repos.length > 1) {
      collisions.push({ linkName, repos });
      for (const r of repos) collidingPaths.add(r);
    }
  }

  const toCreate: { name: string; target: string }[] = [];
  const conflicts: ViewConflict[] = [];
  const unreachable: string[] = [];
  let correctCount = 0;

  for (const f of deduped) {
    if (!f.reachable) {
      unreachable.push(f.path);
      continue;
    }
    if (collidingPaths.has(f.path)) continue; // surfaced as a collision; not auto-wired
    if (f.linkName === undefined || f.expectedTarget === undefined || f.state === undefined) {
      continue;
    }

    if (f.state === "missing") {
      toCreate.push({ name: f.linkName, target: f.expectedTarget });
    } else if (f.state === "mismatch") {
      conflicts.push({
        name: f.linkName,
        reason: "mismatch",
        ...(f.actualTarget !== undefined ? { actualTarget: f.actualTarget } : {}),
      });
    } else if (f.state === "occupied") {
      conflicts.push({ name: f.linkName, reason: "occupied" });
    } else if (f.state === "blocked") {
      conflicts.push({ name: f.linkName, reason: "blocked" });
    } else {
      correctCount += 1; // "correct"
    }
  }

  return {
    toCreate,
    conflicts,
    collisions,
    unreachable,
    correctCount,
    ok:
      toCreate.length === 0 &&
      conflicts.length === 0 &&
      collisions.length === 0 &&
      unreachable.length === 0,
  };
}
