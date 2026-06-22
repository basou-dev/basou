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
 * Pruning stray entries already in the view IS now in scope (see `toPrune` /
 * `strayUnknown` and {@link ExistingViewLink}): the ownership model that tells an
 * orphaned repo link from the view's own instruction files / local state lives
 * here. Still NOT in scope: generating the view's own instruction files.
 */

import { normalizeRelativePath as normalize } from "./relative-path.js";

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

/**
 * An entry actually present in the view directory, pre-classified by the caller's
 * filesystem probe, for stray detection (the inverse of generation). Only
 * symlinks are candidates — a real file or directory is never the caller's to
 * remove and is not gathered here. `kind` tells the planner whether a symlink not
 * tied to any roster repo is a basou-generated repo link safe to prune:
 *
 * - `repo`: a relative target that follows to an existing git repository — a
 *   directory containing a `.git` entry, whether a directory OR a gitdir-pointer
 *   FILE (git worktrees and submodules), matching the project family's repo test
 *   (`existsSync(<dir>/.git)`, as `adopt`/`wiring` use). Exactly what
 *   {@link planWorkspaceView}'s `toCreate` produces. A stray of this kind is prunable.
 * - `broken`: a relative target that does not resolve on disk (e.g. the repo was
 *   moved/deleted). Reported, never auto-pruned (we cannot confirm it was ours).
 * - `non-repo`: a relative target that resolves to a non-repository path (a file,
 *   or a directory without `.git`). Reported, never auto-pruned.
 * - `absolute`: an absolute target. basou never writes absolute view links, so it
 *   is not ours. Reported, never auto-pruned.
 *
 * The caller filters out the view's OWN instruction-file symlinks (e.g. a top-level
 * `AGENTS.md`/`CLAUDE.md`) before classifying, so they never surface as strays.
 */
export type ExistingViewLink = {
  name: string;
  target: string;
  kind: "repo" | "broken" | "non-repo" | "absolute";
};

/**
 * A view symlink not tied to any current roster repo that was NOT auto-pruned
 * because we could not confirm it is a basou-generated repo link. Surfaced for
 * the operator to resolve by hand; never removed.
 */
export type ViewStrayUnknown = {
  name: string;
  target: string;
  reason: "broken" | "non-repo" | "absolute";
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
  /**
   * Stray basou-generated repo links to remove: a view symlink whose name is not
   * a current roster repo and whose relative target follows to a git repository.
   * Removed only under `--prune` (its own opt-in, separate from `--apply`).
   */
  toPrune: { name: string; target: string }[];
  /**
   * Stray view symlinks not tied to any roster repo that we did NOT recognize as
   * a basou-generated repo link (broken, non-repo, or absolute target). Reported,
   * never auto-pruned.
   */
  strayUnknown: ViewStrayUnknown[];
  /** Count of repos whose view link is already correct (for the report). */
  correctCount: number;
  /**
   * True only when nothing needs creating, there are no conflicts, no collisions,
   * no unreachable repos, AND no strays (prunable or unknown) — so a clean "view
   * in sync" verdict is never claimed while a repo was blocked, ambiguous, could
   * not be resolved, or the view still carries an entry the roster no longer backs.
   */
  ok: boolean;
};

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
 * Stray detection (the inverse of generation): given the entries actually present
 * in the view (`existing`), any symlink whose name is NOT owned by a declared
 * roster repo is a stray. A stray classified `repo` (a relative target following to
 * a git repository — basou's own generation shape) goes to `toPrune` (removed only
 * under the separate `--prune` opt-in); a stray we cannot confirm is ours (broken,
 * non-repo, or absolute target) goes to `strayUnknown` (reported, never removed).
 *
 * Ownership (what is NEVER a stray): a name is owned if it is the link name of a
 * reachable roster repo OR appears in `rosterNames` — the basenames of EVERY
 * declared roster entry, supplied independent of reachability. The reachability-
 * independent set is load-bearing: a roster repo whose path transiently fails to
 * resolve (an unmounted volume, a mid-edit symlinked parent, an uncloned sibling)
 * still owns its view link name, so its live link is never mislabeled a stray and
 * pruned. (A roster repo's link reached under a DIFFERENT name — e.g. an aliased
 * roster path — is excluded by the caller before it reaches `existing`, by matching
 * the link's resolved target against the roster's resolved repos.) `existing` and
 * `rosterNames` default to empty, so a caller that does not scan the view gets the
 * original create-only plan.
 *
 * Robustness (mirroring the instruction-symlink planner):
 * - Facts are deduped by normalized path (a repo declared twice yields one link,
 *   never a duplicate `symlinkSync` → EEXIST or a duplicate report entry).
 * - `ok` is true only when there is genuinely nothing to do, every repo was
 *   resolvable and unambiguous, and the view carries no stray.
 */
export function planWorkspaceView(
  facts: ViewRepoFact[],
  existing: ExistingViewLink[] = [],
  rosterNames: string[] = [],
): WorkspaceViewPlan {
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

  // Stray detection: every declared roster repo "owns" its link name and must
  // never have its link pruned — even a colliding one (the repo still wants it)
  // and even an unreachable one (a transient resolution failure must not expose a
  // live link to deletion). Ownership is the union of reachable repos' resolved
  // link names and EVERY declared entry's basename (`rosterNames`, reachability-
  // independent). Any existing view symlink whose name is outside that set is a
  // stray candidate.
  const ownedNames = new Set<string>(rosterNames);
  for (const f of deduped) {
    if (f.reachable && f.linkName !== undefined) ownedNames.add(f.linkName);
  }

  const toPrune: { name: string; target: string }[] = [];
  const strayUnknown: ViewStrayUnknown[] = [];
  const seenExisting = new Set<string>();
  for (const e of existing) {
    if (ownedNames.has(e.name)) continue; // a declared repo's own link, not a stray
    if (seenExisting.has(e.name)) continue; // a name can appear once on disk; guard anyway
    seenExisting.add(e.name);
    if (e.kind === "repo") {
      toPrune.push({ name: e.name, target: e.target });
    } else {
      strayUnknown.push({ name: e.name, target: e.target, reason: e.kind });
    }
  }

  return {
    toCreate,
    conflicts,
    collisions,
    unreachable,
    toPrune,
    strayUnknown,
    correctCount,
    ok:
      toCreate.length === 0 &&
      conflicts.length === 0 &&
      collisions.length === 0 &&
      unreachable.length === 0 &&
      toPrune.length === 0 &&
      strayUnknown.length === 0,
  };
}
