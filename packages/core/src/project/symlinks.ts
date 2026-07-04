/**
 * Plan the agent instruction-file symlinks a declared repo needs (the
 * generation step that follows `basou project gitignore` in the "saddle"
 * model). Each repo's agent instruction files are GITIGNORED symlinks that
 * resolve to a single canonical source kept in the project's private anchor —
 * so the canonical (which may carry private planning content) is edited once
 * and every CLI reads it through a symlink, never committed to a public repo's
 * history.
 *
 * The on-disk topology (verified against the operator's live environment) is a
 * hub-and-spoke:
 *
 *   <repo>/AGENTS.md                       -> <anchor>/agents/<repo>/AGENTS.md   (the hub → canonical)
 *   <repo>/CLAUDE.md                       -> AGENTS.md                          (a spoke → the hub)
 *   <repo>/.github/copilot-instructions.md -> ../AGENTS.md                       (a spoke → the hub)
 *
 * Only AGENTS.md points at the anchor's canonical; CLAUDE.md and Copilot point
 * back at the repo's own AGENTS.md, so there is exactly one link per repo that
 * depends on the anchor path. GEMINI.md is intentionally not generated (the
 * Gemini CLI was discontinued for personal use).
 *
 * Pure: it judges already-gathered, per-file facts (does the link exist? does
 * it point where it should?) and reports only what is MISSING. It never
 * proposes overwriting an existing file or repointing a link that points
 * elsewhere — those surface as conflicts for the operator to resolve by hand
 * (non-destructive, like the additive `.gitignore` planner). The realpath /
 * symlink reading / writing is the caller's job.
 */

import { normalizeRelativePath as normalize } from "./relative-path.js";

/**
 * The on-disk state of one instruction file relative to the symlink it should
 * be. `correct` = the expected link already exists (idempotent skip); `missing`
 * = nothing there (ENOENT), so it can be created; `mismatch` = a symlink
 * pointing somewhere else; `occupied` = a real file or directory; `blocked` =
 * the path could not be inspected (e.g. a parent component is a file → ENOTDIR,
 * or permission denied). Only `missing` is actionable; the rest are left
 * untouched. `blocked` is distinct from `missing` so a non-ENOENT lstat error
 * is never mistaken for a creatable gap (which would crash `--apply`).
 */
export type InstructionSymlinkState = "correct" | "missing" | "mismatch" | "occupied" | "blocked";

/** The gathered facts for one instruction file in one declared repo. */
export type InstructionSymlinkFact = {
  /** Repo-relative file name, e.g. "AGENTS.md", ".github/copilot-instructions.md". */
  name: string;
  /** The relative symlink target this file should have (computed by the caller). */
  expectedTarget: string;
  /** On-disk state of the path. */
  state: InstructionSymlinkState;
  /** The link's current target, present only when `state` is `mismatch`. */
  actualTarget?: string;
};

/** The gathered symlink facts for one declared repo. */
export type RepoSymlinkFacts = {
  /** Roster repo path (relative to the manifest root). */
  path: string;
  /**
   * True when this repo IS the project anchor (it hosts the OTHER repos' hub
   * canonicals under `agents/`, so it is excluded from canonical-collision
   * detection — it owns those, never links to them). Its OWN AGENTS.md is a
   * regular committed file at the anchor root, the same shape as a `self` repo:
   * only its CLAUDE.md / Copilot spokes are generated, and only once that root
   * AGENTS.md exists (`canonicalPresent`). An anchor whose AGENTS.md is absent is
   * left alone (not reported missing) until it is seeded.
   */
  isAnchor: boolean;
  /**
   * True when this repo declares `instructions: self`: its canonical AGENTS.md is
   * a regular committed file in the repo itself, so only the CLAUDE.md / Copilot
   * spokes are generated (never the AGENTS.md hub link), `canonicalPresent` means
   * "the repo's own AGENTS.md is present" (an absent one is `selfAgentsMissing`,
   * not `missingCanonical`), and the repo is excluded from anchor-canonical
   * collision detection (it shares no anchor canonical). Absent => the default
   * `hub` behavior, unchanged.
   */
  self?: boolean | undefined;
  /** False when the repo path could not be resolved / is not a usable git repo. */
  reachable: boolean;
  /**
   * For a `hub` repo: whether the anchor's canonical source
   * (`<anchor>/agents/<repo>/AGENTS.md`) exists — without it the hub link would
   * dangle, so no links are planned (reported as `missingCanonical` instead). For
   * a `self` repo: whether the repo's OWN AGENTS.md exists — without it the
   * spokes would dangle, so none are planned (reported as `selfAgentsMissing`).
   */
  canonicalPresent: boolean;
  /**
   * The canonical's repo name (the `<repo>` in `agents/<repo>/AGENTS.md`) this
   * repo wires to. Two DISTINCT repos sharing one canonical name would silently
   * collide on a single canonical, so it is used to detect that. Set by the
   * caller for reachable, canonical-present repos; undefined otherwise.
   */
  canonicalName?: string;
  /** Per instruction-file facts (empty when an un-seeded anchor / unreachable / canonical absent). */
  files: InstructionSymlinkFact[];
};

/** The instruction-file symlinks to CREATE in one repo (only the `missing` ones). */
export type RepoSymlinkPlan = {
  path: string;
  toCreate: { name: string; target: string }[];
};

/**
 * A symlink that already exists but is not what we would generate: a symlink
 * pointing elsewhere (`mismatch`), a real file/directory (`occupied`), or a path
 * that could not be inspected (`blocked`, e.g. a parent is a file). Surfaced,
 * never overwritten.
 */
export type SymlinkConflict = {
  repo: string;
  file: string;
  reason: "mismatch" | "occupied" | "blocked";
  /** The conflicting link's current target, present only when `reason` is `mismatch`. */
  actualTarget?: string;
};

/**
 * Two or more DISTINCT declared repos whose canonical resolves to the same
 * `agents/<canonicalName>/AGENTS.md`. They would silently share one canonical,
 * so neither is auto-wired; the operator must disambiguate.
 */
export type SymlinkCollision = {
  canonicalName: string;
  repos: string[];
};

export type SymlinkPlanSummary = {
  /** Repos with at least one link to create (those with nothing to create are omitted). */
  plans: RepoSymlinkPlan[];
  /** Existing files/links that block generation and are left untouched for the operator. */
  conflicts: SymlinkConflict[];
  /** Repo paths whose anchor canonical (`agents/<repo>/AGENTS.md`) is absent, so nothing can be wired. */
  missingCanonical: string[];
  /**
   * `self` repo paths whose own AGENTS.md is absent, so the spokes would dangle
   * and none are planned. Distinct from `missingCanonical` (which is the anchor
   * canonical a `hub` repo links to): the operator authors a `self` repo's
   * AGENTS.md by hand, then re-runs.
   */
  selfAgentsMissing: string[];
  /** Repo paths that could not be resolved / are not usable git repos. */
  unreachable: string[];
  /** Groups of distinct repos that resolve to the same canonical (ambiguous; not auto-wired). */
  collisions: SymlinkCollision[];
  /**
   * True only when nothing needs creating AND there are no conflicts, no missing
   * canonicals, no self repos missing their AGENTS.md, no unreachable repos, and
   * no collisions — so a clean "all wired" verdict is never claimed while some
   * repo was blocked, ambiguous, or could not be inspected.
   */
  ok: boolean;
};

/**
 * Compute the {@link SymlinkPlanSummary} from per-repo facts. For each declared,
 * reachable repo whose canonical exists: a `missing` link becomes a create, a
 * `mismatch`/`occupied`/`blocked` link becomes a {@link SymlinkConflict} (never a
 * create — we do not overwrite), and a `correct` link is a no-op. An absent
 * canonical is reported as `missingCanonical` (no links planned, since the hub
 * would dangle), and an unresolvable repo as `unreachable`.
 *
 * The anchor is a special case: it hosts the other repos' hub canonicals (so it
 * is excluded from collision detection — it owns those), but its OWN AGENTS.md is
 * a root committed file (self-style), so its CLAUDE.md / Copilot spokes ARE wired
 * — once that root AGENTS.md exists. An anchor whose AGENTS.md is absent is left
 * alone (not reported as missing): the seed step / operator creates it, then a
 * re-run wires the spokes.
 *
 * Robustness:
 * - Facts are deduped by normalized path (first wins), so a repo listed twice in
 *   the manifest never yields duplicate plans (which would make `--apply` create
 *   the same link twice → EEXIST) or duplicate report entries.
 * - Two DISTINCT repos resolving to the same canonical name are reported as a
 *   {@link SymlinkCollision} and neither is auto-wired (silent sharing of one
 *   canonical is surfaced, not actioned).
 *
 * A `self` repo (its `self` flag set by the caller) carries only its spoke files
 * (CLAUDE.md / Copilot → its own AGENTS.md), is excluded from collision
 * detection, and routes an absent own-AGENTS.md to `selfAgentsMissing` rather
 * than `missingCanonical`. Otherwise it flows through the same create/conflict
 * logic as a hub repo.
 *
 * `ok` is true only when there is genuinely nothing to do and every repo was
 * judgeable, reachable, and unambiguous.
 */
export function summarizeSymlinkPlan(facts: RepoSymlinkFacts[]): SymlinkPlanSummary {
  // Dedup by normalized path (first declaration wins).
  const deduped: RepoSymlinkFacts[] = [];
  const seenPath = new Set<string>();
  for (const f of facts) {
    const key = normalize(f.path);
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    deduped.push(f);
  }

  // Detect canonical-name collisions among the repos that would actually wire
  // (reachable, canonical present). Distinct repo paths sharing a canonical name
  // are ambiguous: surface them and wire neither. `self` repos are excluded: each
  // owns its AGENTS.md in its own tree, so two `self` repos sharing a basename
  // collide on nothing (they never point at one shared anchor canonical).
  const byCanonical = new Map<string, string[]>();
  for (const f of deduped) {
    if (
      f.isAnchor ||
      f.self === true ||
      !f.reachable ||
      !f.canonicalPresent ||
      f.canonicalName === undefined
    ) {
      continue;
    }
    const repos = byCanonical.get(f.canonicalName) ?? [];
    repos.push(f.path);
    byCanonical.set(f.canonicalName, repos);
  }
  const collisions: SymlinkCollision[] = [];
  const collidingPaths = new Set<string>();
  for (const [canonicalName, repos] of byCanonical) {
    if (repos.length > 1) {
      collisions.push({ canonicalName, repos });
      for (const r of repos) collidingPaths.add(r);
    }
  }

  const plans: RepoSymlinkPlan[] = [];
  const conflicts: SymlinkConflict[] = [];
  const missingCanonical: string[] = [];
  const selfAgentsMissing: string[] = [];
  const unreachable: string[] = [];

  for (const f of deduped) {
    // The anchor hosts the other repos' hub canonicals, but its OWN AGENTS.md is
    // a root committed file (self-style): only its CLAUDE.md / Copilot spokes are
    // wired, and only once that AGENTS.md exists (canonicalPresent). An anchor
    // whose AGENTS.md is absent is left alone (not reported as missing) — the seed
    // step / operator creates it, then a re-run wires the spokes. It never owns a
    // hub canonical of its own, so it is excluded from collision detection above.
    if (f.isAnchor && !f.canonicalPresent) continue;
    if (!f.reachable) {
      unreachable.push(f.path);
      continue;
    }
    if (!f.canonicalPresent) {
      // For a `self` repo the missing file is its OWN AGENTS.md (the operator
      // authors it), distinct from a `hub` repo's absent anchor canonical.
      if (f.self === true) selfAgentsMissing.push(f.path);
      else missingCanonical.push(f.path);
      continue;
    }
    // A repo sharing a canonical name with another is surfaced as a collision and
    // never auto-wired (avoids silently pointing two repos at one canonical).
    if (collidingPaths.has(f.path)) continue;

    const toCreate: { name: string; target: string }[] = [];
    for (const file of f.files) {
      if (file.state === "missing") {
        toCreate.push({ name: file.name, target: file.expectedTarget });
      } else if (file.state === "mismatch") {
        conflicts.push({
          repo: f.path,
          file: file.name,
          reason: "mismatch",
          ...(file.actualTarget !== undefined ? { actualTarget: file.actualTarget } : {}),
        });
      } else if (file.state === "occupied") {
        conflicts.push({ repo: f.path, file: file.name, reason: "occupied" });
      } else if (file.state === "blocked") {
        conflicts.push({ repo: f.path, file: file.name, reason: "blocked" });
      }
      // "correct" → already wired, nothing to do.
    }
    if (toCreate.length > 0) plans.push({ path: f.path, toCreate });
  }

  return {
    plans,
    conflicts,
    missingCanonical,
    selfAgentsMissing,
    unreachable,
    collisions,
    ok:
      plans.length === 0 &&
      conflicts.length === 0 &&
      missingCanonical.length === 0 &&
      selfAgentsMissing.length === 0 &&
      unreachable.length === 0 &&
      collisions.length === 0,
  };
}
