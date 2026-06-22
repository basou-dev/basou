/**
 * Archive (fold) a repo out of a project's declared roster — the inverse of
 * `adopt` + `sync`, and the first PRUNING step in the saddle model (every prior
 * slice was additive and deliberately deferred removal). When a repo has served
 * its purpose, archiving removes it from the declared `repos` roster and prunes
 * its capture entry from `source_roots`, so it is no longer part of the project
 * or scanned by `refresh`.
 *
 * Pure: it computes the manifest mutation from the DECLARED lists alone — no
 * filesystem or git I/O — so it works even when the repo is already gone from
 * disk (the common "I deleted the repo, now clean basou" case). Historical
 * captured data in the anchor is NOT touched (archiving stops future capture,
 * it does not erase the past). The repo-side wiring teardown (view symlink,
 * instruction symlinks, .gitignore, canonical) is the caller's separate,
 * higher-blast-radius concern; this only mutates the manifest's declaration.
 */

import type { RepoEntry } from "./roster.js";

export type ArchivePlan = {
  /** The normalized target path being archived. */
  target: string;
  /** True when the target is declared in the roster. */
  found: boolean;
  /**
   * True when the target resolves to the anchor/host (`.`). Archiving the
   * project's own root is refused: it is the home of the manifest, not a member
   * repo to fold. The caller writes nothing in this case.
   */
  isAnchor: boolean;
  /** The roster entry that would be removed (echoed for the report); set only when found & not anchor. */
  rosterEntry?: RepoEntry | undefined;
  /** The roster after removal. An empty array means the project closes (the `repos` key is dropped). */
  nextRepos: RepoEntry[];
  /** True when removal leaves the roster empty (the unified-instruction project is fully closed). */
  reposEmptied: boolean;
  /** The `source_roots` entry (normalized) that would be pruned; set only when the target was captured. */
  sourceRootRemoval?: string | undefined;
  /** The `source_roots` after pruning; set only when a prune actually happens. */
  nextSourceRoots?: string[] | undefined;
  /** Declared repos remaining after removal. */
  remainingCount: number;
  /** True when exactly one repo remains: the project becomes solo and the workspace view is no longer needed. */
  becomesSolo: boolean;
};

/** Normalize a relative roster path for comparison: trim, drop trailing slashes, empty => ".". */
function normalize(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.length === 0 ? "." : s;
}

/**
 * Compute the {@link ArchivePlan} for folding `target` out of the project. Pure:
 * it partitions the declared `repos` and `source_roots` by normalized path.
 *
 * - Archiving the anchor (`.`, or a path the caller resolved to the manifest
 *   root) is refused — the plan reports `isAnchor` and removes nothing.
 * - A target not in the roster yields `found: false` and no change (the caller
 *   reports the declared paths so the operator sees what to type).
 * - Otherwise EVERY roster entry matching the normalized target is removed (so a
 *   path declared twice does not survive), and the matching `source_roots` entry
 *   (commonly the same path) is pruned. Only the EXACT normalized target is
 *   pruned from `source_roots`; entries for every other path — the host `.`, a
 *   generated workspace-view source root — survive.
 * - When removal empties the roster, `nextRepos` is `[]` and `reposEmptied` is
 *   true (the caller drops the `repos` key — `repos: []` is not a valid roster).
 */
export function planArchive(input: {
  repos?: RepoEntry[];
  sourceRoots?: string[];
  target: string;
  targetIsAnchor?: boolean;
}): ArchivePlan {
  const target = normalize(input.target);
  const repos = input.repos ?? [];
  const isAnchor = input.targetIsAnchor === true || target === ".";
  const matched = repos.filter((r) => normalize(r.path) === target);
  const found = matched.length > 0;

  // Refusals / no-ops: archiving the anchor, or a target not in the roster,
  // changes nothing. Report the situation and leave the lists untouched.
  if (isAnchor || !found) {
    return {
      target,
      found,
      isAnchor,
      nextRepos: repos,
      reposEmptied: false,
      remainingCount: repos.length,
      becomesSolo: false,
    };
  }

  const nextRepos = repos.filter((r) => normalize(r.path) !== target);
  const remainingCount = nextRepos.length;

  let sourceRootRemoval: string | undefined;
  let nextSourceRoots: string[] | undefined;
  if (input.sourceRoots !== undefined) {
    const pruned = input.sourceRoots.filter((s) => normalize(s) !== target);
    if (pruned.length !== input.sourceRoots.length) {
      sourceRootRemoval = target;
      nextSourceRoots = pruned;
    }
  }

  return {
    target,
    found: true,
    isAnchor: false,
    rosterEntry: matched[matched.length - 1],
    nextRepos,
    reposEmptied: remainingCount === 0,
    ...(sourceRootRemoval !== undefined ? { sourceRootRemoval } : {}),
    ...(nextSourceRoots !== undefined ? { nextSourceRoots } : {}),
    remainingCount,
    becomesSolo: remainingCount === 1,
  };
}
