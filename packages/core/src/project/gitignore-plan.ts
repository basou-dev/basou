/**
 * Plan the agent instruction-file `.gitignore` entries a declared repo needs
 * (the first generation step of the "saddle" model). For a public-facing repo,
 * the agent instruction files (AGENTS.md, CLAUDE.md, …) must be GITIGNORED so the
 * gitignored symlinks to the private canonical never enter public git history.
 * `basou project gitignore` reconciles each repo's `.gitignore` to that; this is
 * the pure planner behind it.
 *
 * Pure: it diffs the REQUIRED patterns against the repo's CURRENT `.gitignore`
 * lines (both gathered by the caller) and reports only what is MISSING — it never
 * proposes removing a line. The realpath / file reading / writing is the caller's
 * job. The privacy decision is visibility-aware: only public / future-public
 * repos require the patterns (a private anchor may legitimately track its
 * canonical), and a repo with unset visibility is skipped (reported), never
 * acted on by guesswork.
 */

import type { RepoVisibility } from "./roster.js";

/** A declared repo's current `.gitignore` state, gathered by the caller. */
export type RepoGitignoreFacts = {
  /** Roster repo path (relative to the manifest root). */
  path: string;
  /** Declared visibility; undefined when the operator has not set it yet. */
  visibility?: RepoVisibility | undefined;
  /** False when the repo path could not be resolved / is not a usable git repo. */
  reachable: boolean;
  /** Existing `.gitignore` lines, trimmed; an empty array when there is no `.gitignore`. */
  currentLines: string[];
};

/** The patterns to ADD to one repo's `.gitignore` (never any to remove). */
export type RepoGitignorePlan = {
  path: string;
  toAdd: string[];
};

export type GitignorePlanSummary = {
  /** Repos that need patterns added (those with an empty `toAdd` are omitted). */
  plans: RepoGitignorePlan[];
  /** Repo paths skipped because visibility is unset (cannot decide safely). */
  unknown: string[];
  /** Repo paths that could not be resolved / are not usable git repos. */
  unreachable: string[];
  /**
   * True only when nothing needs adding AND every repo was judgeable and
   * reachable — so a clean verdict is never claimed while some repos were
   * skipped (unset visibility) or could not be inspected (unreachable).
   */
  ok: boolean;
};

/** Whether a visibility exposes git history to the public (so instruction files must be ignored). */
function isPublicFacing(v: RepoVisibility | undefined): v is "public" | "future-public" {
  return v === "public" || v === "future-public";
}

/**
 * Compute the {@link GitignorePlanSummary}: for each public-facing, reachable
 * repo, the `required` patterns that are not already present in its `.gitignore`
 * (compared by trimmed exact line). Private repos require nothing; unset
 * visibility is reported as `unknown` and unreachable repos as `unreachable`.
 * `ok` is true when no repo needs any addition.
 */
export function planGitignore(input: {
  repos: RepoGitignoreFacts[];
  required: string[];
}): GitignorePlanSummary {
  const plans: RepoGitignorePlan[] = [];
  const unknown: string[] = [];
  const unreachable: string[] = [];

  for (const repo of input.repos) {
    if (!repo.reachable) {
      unreachable.push(repo.path);
      continue;
    }
    if (repo.visibility === undefined) {
      unknown.push(repo.path);
      continue;
    }
    if (!isPublicFacing(repo.visibility)) continue;

    // A line already present suppresses re-adding. Treat an anchored-root form
    // (`/AGENTS.md`) as covering the plain pattern (`AGENTS.md`) so we do not add
    // a redundant equivalent rule. A directory-only `AGENTS.md/` or a comment is
    // intentionally NOT treated as equivalent.
    const present = new Set<string>();
    for (const line of repo.currentLines) {
      const trimmed = line.trim();
      present.add(trimmed);
      if (trimmed.startsWith("/")) present.add(trimmed.slice(1));
    }
    const toAdd = input.required.filter((p) => !present.has(p));
    if (toAdd.length > 0) plans.push({ path: repo.path, toAdd });
  }

  return {
    plans,
    unknown,
    unreachable,
    ok: plans.length === 0 && unknown.length === 0 && unreachable.length === 0,
  };
}
