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

export type RepoVisibility = "public" | "private" | "future-public";

export type RepoEntry = {
  /** Path relative to the manifest repo root (e.g. ".", "../takuhon"). */
  path: string;
  // `| undefined` so a zod-inferred manifest entry (visibility?: X | undefined,
  // under exactOptionalPropertyTypes) is assignable without remapping.
  visibility?: RepoVisibility | undefined;
};

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

/** Normalize a relative roster path for comparison: trim, drop trailing slashes, empty => ".". */
function normalize(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.length === 0 ? "." : s;
}

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
