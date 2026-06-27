/**
 * Retrofit an existing repo's hand-authored `AGENTS.md` into the project's
 * "saddle" topology. The greenfield flow (`project new` → `project derive`)
 * assumes the canonical instruction file is born in the anchor at
 * `agents/<repo>/AGENTS.md`; but a repo that was developed BEFORE adoption
 * carries its instructions as a plain regular file at `<repo>/AGENTS.md`. The
 * other generators never relocate it — `project symlinks` is non-destructive and
 * skips an occupied path, `project preset` would create a near-empty canonical
 * beside the orphaned prose. Retrofit is the one missing migration step: it moves
 * that regular file to the anchor canonical and leaves a symlink in its place, so
 * the prose is preserved at the single source of truth and `project derive` can
 * finish the wiring (CLAUDE.md / Copilot spokes, `.gitignore`, the preset block).
 *
 * Pure: it CLASSIFIES already-gathered facts (is the file a regular file? does the
 * destination canonical already exist?) into one action. The realpath / lstat /
 * move / symlink I/O is the caller's job. Non-destructive by contract: it only
 * relocates a genuine regular-file AGENTS.md into a FREE canonical slot; an
 * existing canonical (which would be clobbered), an already-wired symlink, an
 * absent file, the anchor itself, or an unreachable/undeclared repo all yield a
 * refuse/skip — never a move.
 */

/** The basename of the canonical instruction file. */
const CANONICAL_FILE = "AGENTS.md";

/**
 * On-disk state of the repo's own `AGENTS.md` (the file to relocate), as seen by
 * `lstat` (never following the link). `regular-file` is the only relocatable
 * state; `symlink` means it is already wired, `absent` means there is nothing to
 * move, and `blocked` means the path could not be inspected (a non-ENOENT error)
 * so it must not be mistaken for relocatable.
 */
export type RetrofitAgentsState = "regular-file" | "symlink" | "absent" | "blocked";

/** The single action retrofit will take for the repo. */
export type RetrofitAction = "relocate" | "skip" | "refuse";

/** Why {@link classifyRetrofit} chose its action (machine-stable; the caller renders prose). */
export type RetrofitReason =
  /** relocate: a regular-file AGENTS.md with a free destination canonical. */
  | "ok"
  /** refuse: the repo is not in the declared roster. */
  | "not-declared"
  /**
   * refuse: the repo declares `instructions: self` — its AGENTS.md is a
   * hand-authored committed file that stays in the repo, so there is no anchor
   * canonical to relocate it to (retrofit does not apply).
   */
  | "self"
  /** refuse: the path is the project anchor (it owns the canonical directly — nothing to relocate). */
  | "anchor"
  /** refuse: the path does not resolve / is not a git repo. */
  | "unreachable"
  /** refuse: the AGENTS.md path could not be inspected (a non-ENOENT lstat error). */
  | "blocked"
  /** refuse: the destination canonical already exists (relocating would clobber it). */
  | "canonical-exists"
  /** skip: AGENTS.md is already a symlink (likely already wired — idempotent). */
  | "already-symlink"
  /** skip: there is no AGENTS.md to relocate. */
  | "absent";

/** The gathered facts for the one repo being retrofitted. Pure inputs — no I/O. */
export type RetrofitFacts = {
  /** The repo's roster path (relative to the anchor), echoed in the report. */
  path: string;
  /** True when the path is declared in the manifest roster. */
  declared: boolean;
  /**
   * True when the declared entry uses `instructions: self` — its AGENTS.md stays
   * in the repo, so retrofit (which relocates it to the anchor canonical) does
   * not apply. Absent/false => the default `hub` behavior, unchanged.
   */
  self?: boolean | undefined;
  /** True when the path resolves to the anchor itself. */
  isAnchor: boolean;
  /** False when the path does not resolve / is not a git repo. */
  reachable: boolean;
  /** The repo basename used for the anchor canonical `agents/<canonicalName>/AGENTS.md`. */
  canonicalName: string;
  /** On-disk state of the repo's own `AGENTS.md`. */
  agentsState: RetrofitAgentsState;
  /** True when the destination canonical already exists (moving would clobber it). */
  canonicalExists: boolean;
  /**
   * The repo's spoke instruction files (`CLAUDE.md`, `.github/copilot-instructions.md`)
   * that are regular files — they would block clean wiring (`project symlinks`
   * skips an occupied path), so they are surfaced as a manual checklist. Never
   * moved by retrofit (they are spokes to AGENTS.md, not separate canonicals).
   */
  regularSpokes: string[];
};

/** The classified outcome for the repo. */
export type RetrofitPlan = {
  path: string;
  action: RetrofitAction;
  reason: RetrofitReason;
  /** The repo basename used for the canonical (echoed for the report). */
  canonicalName: string;
  /** The anchor-relative destination `agents/<canonicalName>/AGENTS.md`; set only when `action` is `relocate`. */
  canonicalPath?: string;
  /** Spoke instruction files that are regular files (reported, never moved). */
  regularSpokes: string[];
};

/**
 * Classify the retrofit facts into one action. Refusals are checked first, in a
 * fixed precedence so the outcome is deterministic when several guardrails could
 * apply: undeclared → anchor → self → unreachable → uninspectable AGENTS.md. Then
 * the idempotent skips (already a symlink, or absent — nothing to move). Only a
 * genuine regular-file AGENTS.md reaches the relocate decision, and even then a
 * pre-existing destination canonical refuses (relocating would clobber it).
 * `regularSpokes` is echoed in every outcome (it is advisory, relevant whenever a
 * relocate or skip leaves the operator to tidy the spokes).
 */
export function classifyRetrofit(facts: RetrofitFacts): RetrofitPlan {
  const base = {
    path: facts.path,
    canonicalName: facts.canonicalName,
    regularSpokes: facts.regularSpokes,
  };

  if (!facts.declared) return { ...base, action: "refuse", reason: "not-declared" };
  if (facts.isAnchor) return { ...base, action: "refuse", reason: "anchor" };
  // A `self` repo keeps its AGENTS.md in its own tree — there is no anchor
  // canonical to relocate it to, so retrofit does not apply.
  if (facts.self === true) return { ...base, action: "refuse", reason: "self" };
  if (!facts.reachable) return { ...base, action: "refuse", reason: "unreachable" };
  if (facts.agentsState === "blocked") return { ...base, action: "refuse", reason: "blocked" };
  if (facts.agentsState === "symlink")
    return { ...base, action: "skip", reason: "already-symlink" };
  if (facts.agentsState === "absent") return { ...base, action: "skip", reason: "absent" };
  if (facts.canonicalExists) return { ...base, action: "refuse", reason: "canonical-exists" };

  return {
    ...base,
    action: "relocate",
    reason: "ok",
    canonicalPath: `agents/${facts.canonicalName}/${CANONICAL_FILE}`,
  };
}
