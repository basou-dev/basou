/**
 * Project roster drift (the "saddle" model). A project's repos are DECLARED
 * once in the manifest's `repos` list; the capture config (`source_roots`) must
 * cover every declared repo. This computes the drift between the two so
 * `basou project check` can surface a declared repo that is NOT being captured
 * — the class of bug where a companion repo was wired into the workspace but
 * never added to `source_roots`, so its work silently fell out of capture.
 *
 * Pure: it compares declared relative paths against captured relative paths and
 * performs no filesystem or git I/O. Paths are compared as declared (both lists
 * use the same machine-portable relative-path form), not resolved on disk.
 */

import { normalizeRelativePath as normalize } from "./relative-path.js";

export type RepoVisibility = "public" | "private" | "future-public";

/**
 * The audience-driven language axis. Independent of visibility: a private repo
 * can publish English content, a public repo can carry bilingual docs. `en` /
 * `ja` for a single audience, `en+ja` when both are served.
 */
export type RepoLanguage = "en" | "ja" | "en+ja";

/** A published surface a repo emits: a deployed website or a package registry. */
export type PublishKind = "web" | "npm";

/**
 * Where a repo's agent instruction files live (the instruction-source axis),
 * independent of visibility / language / publishes. `hub` is basou's native,
 * generated hub-and-spoke topology (canonical in the anchor, gitignored symlinks
 * in each repo); `self` is the additive opt-in where the canonical AGENTS.md is a
 * regular committed file in the repo itself and basou stays hands-off about its
 * content. See {@link instructionMode} for the default (absent => `hub`).
 */
export type RepoInstructions = "hub" | "self";

/**
 * One published surface. Its visibility and language are INDEPENDENT of the
 * source repo's: a private repo commonly publishes a public website. Both are
 * optional so a surface can be declared
 * before those facts are pinned down (mirroring how `adopt` leaves repo
 * visibility unset for the operator to fill in).
 */
export type PublishTarget = {
  kind: PublishKind;
  visibility?: RepoVisibility | undefined;
  language?: RepoLanguage | undefined;
};

export type RepoEntry = {
  /** Path relative to the manifest repo root (e.g. ".", "../takuhon"). */
  path: string;
  // `| undefined` so a zod-inferred manifest entry (visibility?: X | undefined,
  // under exactOptionalPropertyTypes) is assignable without remapping.
  visibility?: RepoVisibility | undefined;
  /** Source language (commits/comments/code, read by contributors). Independent of visibility. */
  language?: RepoLanguage | undefined;
  /** Published surfaces this repo emits (opt-in; absent for a repo that publishes nothing). */
  publishes?: PublishTarget[] | undefined;
  /**
   * Instruction-source mode. Absent => `hub` (basou's native generated topology),
   * so an existing roster's behavior is unchanged. `self` opts the repo out of
   * generation: its AGENTS.md is a hand-authored committed file and basou stays
   * hands-off. Resolve the effective mode with {@link instructionMode}.
   */
  instructions?: RepoInstructions | undefined;
};

/**
 * The effective instruction-source mode for a repo: the declared `instructions`,
 * defaulting to `hub` when absent. The default is the single guarantee that an
 * existing roster (which has no `instructions` field) keeps basou's current
 * hub-and-spoke behavior byte-for-byte — every generator branches on this, never
 * on the raw optional field, so "absent => hub" is decided in exactly one place.
 */
export function instructionMode(entry: {
  instructions?: RepoInstructions | undefined;
}): RepoInstructions {
  return entry.instructions ?? "hub";
}

export type RosterDriftSummary = {
  declaredCount: number;
  capturedCount: number;
  /** Declared in `repos` but absent from `source_roots`: a capture gap. */
  gaps: RepoEntry[];
  /** In `source_roots` but not declared in `repos` (e.g. a workspace view, or a stray). */
  extra: string[];
  /** Declared paths that are also captured. */
  matched: string[];
  /** True when there is no capture gap (every declared repo is covered). */
  ok: boolean;
};

/**
 * Compute the {@link RosterDriftSummary} for a project. A declared repo missing
 * from the captured set is a `gap` (the surfaced suspicion); a captured path not
 * in the declared set is `extra` (commonly the workspace view, which is a
 * capture source but not itself a project repo). With no declared roster, there
 * are no gaps (nothing to check against) and every captured path is `extra`.
 */
export function summarizeRosterDrift(input: {
  repos?: RepoEntry[];
  sourceRoots?: string[];
}): RosterDriftSummary {
  const captured = new Set((input.sourceRoots ?? []).map(normalize));
  // Last declaration of a given normalized path wins, but carry it as one entry.
  const declared = new Map<string, RepoEntry>();
  for (const r of input.repos ?? []) declared.set(normalize(r.path), r);

  const gaps: RepoEntry[] = [];
  const matched: string[] = [];
  for (const [norm, entry] of declared) {
    if (captured.has(norm)) matched.push(norm);
    else gaps.push(entry);
  }
  const extra = [...captured].filter((c) => !declared.has(c)).sort();

  return {
    declaredCount: declared.size,
    capturedCount: captured.size,
    gaps,
    extra,
    matched: matched.sort(),
    ok: gaps.length === 0,
  };
}

export type SourceRootsReconcile = {
  /**
   * The reconciled `source_roots`: the existing entries verbatim, then every
   * declared repo path that was missing (normalized, in roster order). Existing
   * order and form are preserved so the manifest diff is minimal and reversible.
   */
  next: string[];
  /** Declared repo paths (normalized) that were appended because `source_roots` did not cover them. */
  added: string[];
  /** True when `source_roots` already covers every declared repo (`next` equals the current list). */
  unchanged: boolean;
};

/**
 * Derive the `source_roots` a project's declared repo roster requires. The
 * roster (`repos`) is the single source of truth for which repos belong to the
 * project; this is the actuator behind `basou project sync`, computing the
 * additive reconciliation so every declared repo is captured.
 *
 * ADDITIVE ONLY: it appends declared paths that are missing and never removes
 * an existing entry. A captured-but-undeclared path (commonly the generated
 * workspace view — a legitimate capture source that is not itself a project
 * repo) is preserved; pruning strays is deferred to the slice that generates
 * the view (so basou knows which extras it owns). Existing entries are kept
 * byte-identical; only appended paths are normalized.
 *
 * Pure: no filesystem or git I/O. Paths are compared in the same normalized
 * form as {@link summarizeRosterDrift}, so a trailing-slash variant of an
 * already-captured repo is not re-appended.
 */
export function reconcileSourceRoots(input: {
  repos?: RepoEntry[];
  sourceRoots?: string[];
}): SourceRootsReconcile {
  const current = input.sourceRoots ?? [];
  const seen = new Set(current.map(normalize));
  const added: string[] = [];
  for (const r of input.repos ?? []) {
    const norm = normalize(r.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    added.push(norm);
  }
  return {
    next: [...current, ...added],
    added,
    unchanged: added.length === 0,
  };
}

/**
 * On-disk classification of a source-root candidate during adoption: a git repo
 * root (→ becomes a roster entry), a resolved-but-non-repo directory (the
 * generated workspace view, `/tmp`, a scratch dir → excluded), or a path that
 * could not be resolved on disk (→ excluded).
 */
export type AdoptCandidateKind = "repo" | "non-repo" | "unresolved";

export type AdoptCandidate = {
  /** Source-root path as declared (relative to the manifest root). */
  path: string;
  /** On-disk classification; the filesystem probing that produces it is the caller's job. */
  kind: AdoptCandidateKind;
};

export type RosterAdoptionPlan = {
  /** Proposed `repos` entries: the candidates that are git repos (visibility left unset for the operator). */
  repos: RepoEntry[];
  /** Candidates excluded from the roster, with why (a non-repo directory, or an unresolvable path). */
  excluded: { path: string; kind: Exclude<AdoptCandidateKind, "repo"> }[];
};

/**
 * Plan a `repos` roster from classified source-root candidates (the actuator
 * behind `basou project adopt`). Pure: it partitions already-classified
 * candidates — the realpath / `.git` filesystem probing that produces each
 * `kind` is the caller's job, so this stays testable without disk I/O.
 *
 * A git repo becomes a roster entry (path only; visibility is left unset because
 * it is a human judgment, kept independent of the other axes). A non-repo
 * (commonly the generated workspace view) or an unresolvable path is excluded and
 * reported, so the operator sees what was dropped and why before editing. Repo
 * paths are deduped by normalized form, preserving the first declared form and
 * order.
 */
export function planRosterAdoption(candidates: AdoptCandidate[]): RosterAdoptionPlan {
  const repos: RepoEntry[] = [];
  const excluded: { path: string; kind: Exclude<AdoptCandidateKind, "repo"> }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    // Dedup by normalized path across ALL kinds (a trailing-slash variant of a
    // path already seen — repo or excluded — is not listed twice).
    const norm = normalize(c.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (c.kind === "repo") repos.push({ path: c.path });
    else excluded.push({ path: c.path, kind: c.kind });
  }
  return { repos, excluded };
}
