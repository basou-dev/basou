/**
 * Agent instruction-file "A preset" generation. A repo's
 * canonical instruction file splits into a STABLE PRESET (its source
 * visibility, source language, and published surfaces — facts derived from the
 * manifest) and a HAND-AUTHORED POLICY (tech choices, coding rules). This
 * renders the stable preset from the declaration so the operator stops
 * hand-typing it into every prompt, and plans how that generated region
 * reconciles against each repo's canonical — so `basou project preset` keeps it
 * in sync without ever touching the hand-authored content around it.
 *
 * Pure: it renders deterministic markdown from declared fields and judges
 * already-gathered facts (does the canonical exist? what does its generated
 * region currently hold?). The filesystem / marker reading / writing is the
 * caller's job.
 */

import {
  presetStrings,
  resolveAnchorContentLanguage,
  resolveRepoContentLanguage,
} from "../lib/view-strings.js";
import { normalizeRelativePath as normalizePath } from "./relative-path.js";
import type { PublishTarget, RepoLanguage, RepoVisibility } from "./roster.js";

/** The declared fields the preset block is rendered from. */
export type PresetRepo = {
  visibility?: RepoVisibility | undefined;
  language?: RepoLanguage | undefined;
  publishes?: PublishTarget[] | undefined;
};

/**
 * Whether a repo has anything to render. A repo with no visibility, no language,
 * and no published surface yields an all-"unset" block that helps no one, so it
 * is reported as `undeclared` rather than generated.
 */
export function isRenderable(repo: PresetRepo): boolean {
  return (
    repo.visibility !== undefined ||
    repo.language !== undefined ||
    (repo.publishes !== undefined && repo.publishes.length > 0)
  );
}

/**
 * Render the stable-preset markdown block (the content that lives BETWEEN the
 * BASOU:GENERATED markers in a canonical). Deterministic and OSS-generic: it
 * derives entirely from the declared fields, embedding no operator-specific
 * names, so re-running on an unchanged manifest produces byte-identical output
 * (the basis for drift detection). The block's content language follows the
 * repo's own declared `language` (its audience): `ja` renders the Japanese
 * strings byte-identical to the pre-i18n output; `en` / `en+ja` / undeclared
 * render English. The published surfaces are listed in their declared order.
 * Returns the block WITHOUT a trailing newline; the marker writer adds the
 * surrounding structure.
 */
export function renderPresetBlock(repo: PresetRepo): string {
  const t = presetStrings(resolveRepoContentLanguage(repo.language)).repoBlock;
  const lines: string[] = [];
  lines.push(t.heading);
  lines.push("");
  lines.push(t.intro);
  lines.push("");
  lines.push(`- ${t.sourceVisibilityLabel}: ${t.visibilityLabel(repo.visibility)}`);
  lines.push(`- ${t.sourceLanguageLineLabel}: ${t.sourceLanguageLabel(repo.language)}`);
  const publishes = repo.publishes ?? [];
  if (publishes.length === 0) {
    lines.push(t.publishesNone);
  } else {
    lines.push(t.publishesHeader);
    for (const p of publishes) {
      lines.push(
        `    - ${t.publishKindLabel(p.kind)} — ${t.publishVisibilityLabel(p.visibility)} / ${t.contentLanguageLabel(p.language)}`,
      );
    }
  }
  return lines.join("\n");
}

/** One repo aggregated by the view, rendered with its short visibility / language. */
export type ViewPresetRepo = {
  name: string;
  visibility?: RepoVisibility | undefined;
  language?: RepoLanguage | undefined;
  /**
   * True when the repo declares `instructions: self` (it owns its AGENTS.md;
   * basou stays hands-off). Rendered in the instruction-ownership column so an
   * agent reading the view knows which AGENTS.md files are generated and which
   * are hand-maintained. Absent => the default `hub` (basou-generated).
   */
  self?: boolean | undefined;
  /**
   * True when this repo IS the project anchor (the planning master). Its own
   * AGENTS.md is hand-maintained at the anchor root — basou never generates it
   * (preset skips it), so the instruction column must NOT claim `hub`. Takes
   * precedence over `self` in the label.
   */
  anchor?: boolean | undefined;
};

/** The declared fields the view preset block is rendered from. */
export type ViewPresetInput = {
  /**
   * The view directory's basename — names the view's own canonical
   * (`agents/<viewName>/AGENTS.md`) in the block's self-description, so a reader
   * of the generated file learns where its editable source of truth lives.
   */
  viewName: string;
  repos: ViewPresetRepo[];
};

/**
 * Render the workspace-view instruction-file preset block (the content between
 * the BASOU:GENERATED markers in the view's own canonical). Like
 * {@link renderPresetBlock} it is deterministic and OSS-generic: it derives
 * entirely from the declared roster (repo names come from the manifest, no
 * operator-specific string is embedded), so re-running on an unchanged manifest
 * produces byte-identical output. The view is a workspace-level artifact, so
 * its content language follows the ANCHOR entry's declared language (mirroring
 * the generated views' rule); a `ja` anchor renders byte-identical to the
 * pre-i18n output. The repos are listed in the order supplied. An empty roster
 * still renders cleanly (a header-only table, empty lists). Returns the block
 * WITHOUT a trailing newline; the marker writer adds the surrounding structure.
 */
export function renderViewPresetBlock(input: ViewPresetInput): string {
  const t = presetStrings(resolveAnchorContentLanguage(input.repos)).viewBlock;
  const shortLabel = (v: string | undefined): string => v ?? t.unsetShort;
  const instructionsLabel = (repo: ViewPresetRepo): string => {
    if (repo.anchor === true) return t.instructionsAnchor;
    return repo.self === true ? t.instructionsSelf : t.instructionsHub;
  };
  const lines: string[] = [];
  lines.push(t.heading);
  lines.push("");
  lines.push(t.intro);
  lines.push(t.selfNote(input.viewName));
  lines.push("");
  lines.push(t.aggregates(input.repos.length));
  lines.push("");
  lines.push(t.reposHeading);
  lines.push("");
  lines.push(t.tableHeader);
  lines.push("|---|---|---|---|");
  for (const r of input.repos) {
    lines.push(
      `| ${r.name} | ${shortLabel(r.visibility)} | ${shortLabel(r.language)} | ${instructionsLabel(r)} |`,
    );
  }
  lines.push("");
  lines.push(t.commitHeading);
  lines.push("");
  lines.push(t.commitBody);
  lines.push("");
  for (const r of input.repos) {
    lines.push(`- ${r.name} → \`cd ${r.name}\``);
  }
  lines.push("");
  lines.push(t.conventionsHeading);
  lines.push("");
  lines.push(t.conventionsBody);
  lines.push("");
  for (const r of input.repos) {
    lines.push(`- ${r.name}/AGENTS.md`);
  }
  lines.push("");
  lines.push(t.principlesHeading);
  lines.push("");
  lines.push(t.principleStateless);
  lines.push(t.principleNoFiles);
  return lines.join("\n");
}

/**
 * The canonical's marker state as parsed by the caller (mirrors
 * `markdown-store`'s `MarkerSection.kind`). `ok` means exactly one well-ordered
 * marker pair; any other value means the generated region cannot be located
 * safely, so the preset is NOT injected (we never clobber a hand-authored file).
 */
export type PresetMarkerKind =
  | "ok"
  | "no_markers"
  | "missing_start"
  | "missing_end"
  | "multiple_pairs"
  | "wrong_order";

/** The gathered facts for one declared repo. */
export type RepoPresetFacts = {
  /** Roster repo path (relative to the manifest root). */
  path: string;
  /** True when this repo IS the project anchor (its own AGENTS.md is hand-maintained; skipped). */
  isAnchor: boolean;
  /**
   * True when this repo declares `instructions: self`: its AGENTS.md is
   * hand-authored and basou stays hands-off — no preset block is ever written
   * (reported as `self`, skipped like an anchor). Absent => the default `hub`
   * behavior, unchanged.
   */
  self?: boolean | undefined;
  /** False when the repo path could not be resolved / is not a usable git repo. */
  reachable: boolean;
  /** Declared fields (the render input). */
  visibility?: RepoVisibility | undefined;
  language?: RepoLanguage | undefined;
  publishes?: PublishTarget[] | undefined;
  /**
   * The canonical's repo name (`<name>` in `agents/<name>/AGENTS.md`). Two
   * DISTINCT repos sharing it would write to one canonical, so it is used to
   * detect that. Set by the caller for reachable, non-anchor repos.
   */
  canonicalName?: string | undefined;
  /** Whether the canonical file exists on disk. */
  canonicalPresent: boolean;
  /**
   * Whether the present canonical could be read. Defaults to readable; the
   * caller sets it `false` when the file exists but a non-ENOENT read failed
   * (e.g. it is a directory, or permission denied), so one bad canonical
   * degrades only that repo instead of crashing the whole report.
   */
  canonicalReadable?: boolean | undefined;
  /** Marker parse result of the canonical (only meaningful when present and readable). */
  markerKind?: PresetMarkerKind | undefined;
  /** Current generated-region content (only when `markerKind === "ok"`). */
  currentBlock?: string | undefined;
};

/** `create` seeds an absent canonical; `update` replaces the region of an existing one. */
export type PresetAction = "create" | "update";

/** A repo whose canonical's generated region will be created or updated. */
export type RepoPresetPlan = {
  path: string;
  canonicalName: string;
  action: PresetAction;
  /** The block that will be written (the marker-delimited content). */
  desiredBlock: string;
};

/**
 * A canonical that exists but whose markers cannot be located safely (absent or
 * malformed). The region is NOT injected — surfaced so the operator can add the
 * markers (or remove the malformed ones) by hand.
 */
export type PresetMarkerConflict = {
  repo: string;
  reason: Exclude<PresetMarkerKind, "ok">;
};

/**
 * Two or more DISTINCT declared repos whose canonical resolves to the same
 * `agents/<canonicalName>/AGENTS.md`. They would write over one canonical, so
 * neither is generated; the operator must disambiguate.
 */
export type PresetCollision = {
  canonicalName: string;
  repos: string[];
  /**
   * True when the shared canonical is the WORKSPACE VIEW's own
   * (`agents/<viewName>/AGENTS.md`): the listed repo(s) collide with the view,
   * not (only) with each other, so neither the repo side nor the view side is
   * generated. Absent for a plain repo↔repo collision.
   */
  view?: boolean;
};

export type PresetPlanSummary = {
  /** Repos whose canonical's generated region will be created/updated (only those with work). */
  plans: RepoPresetPlan[];
  /** Repos already in sync (canonical present, ok markers, block matches). */
  inSync: string[];
  /** Repos with nothing declared to render (no visibility, language, or published surface). */
  undeclared: string[];
  /** Canonicals that exist but whose markers are absent/malformed — not overwritten. */
  markerConflicts: PresetMarkerConflict[];
  /** Repos whose canonical exists but could not be read (degraded, not generated). */
  unreadable: string[];
  /** Groups of distinct repos that resolve to the same canonical (ambiguous; not generated). */
  collisions: PresetCollision[];
  /** Repos that resolve to the anchor (their own AGENTS.md is hand-maintained; skipped). */
  anchors: string[];
  /** `instructions: self` repos: hands-off, skipped (basou never writes their AGENTS.md). */
  self: string[];
  /** Repo paths that could not be resolved / are not usable git repos. */
  unreachable: string[];
  /**
   * True only when nothing needs writing AND there are no marker conflicts, no
   * unreadable canonicals, no collisions, no unreachable repos, and no
   * undeclared repos — so a clean "all in sync" verdict is never claimed while
   * some repo was skipped or unjudgeable. Anchors and `self` repos do not block
   * it (they are intentionally not generated).
   */
  ok: boolean;
};

/** Normalize a block for in-sync comparison: LF line endings, no trailing blank lines. */
function normalizeBlock(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * Compute the {@link PresetPlanSummary} from per-repo facts. For each declared,
 * non-anchor, reachable, renderable repo: an absent canonical is a `create`, an
 * existing canonical with an `ok` marker region is an `update` (or `inSync` when
 * the region already matches), and a canonical with absent/malformed markers is
 * a {@link PresetMarkerConflict} (never overwritten). The anchor is skipped
 * (`anchors`), an unrenderable repo is `undeclared`, and an unresolvable repo is
 * `unreachable`.
 *
 * Robustness:
 * - Facts are deduped by normalized path (first wins), so a repo listed twice
 *   never yields duplicate plans / report entries.
 * - Two DISTINCT repos resolving to the same canonical name are a
 *   {@link PresetCollision} and neither is generated (silent clobbering of one
 *   canonical is surfaced, not actioned).
 * - When the caller passes `opts.viewCanonicalName` (the workspace view's own
 *   canonical name), a repo whose canonical name equals it is ALSO a collision
 *   (flagged `view: true`) and is suppressed — the repo and the view would
 *   otherwise write over one shared `agents/<name>/AGENTS.md`. Without the
 *   option the behavior is unchanged.
 */
export function summarizePresetPlan(
  facts: RepoPresetFacts[],
  opts?: { viewCanonicalName?: string },
): PresetPlanSummary {
  // Dedup by normalized path (first declaration wins).
  const deduped: RepoPresetFacts[] = [];
  const seenPath = new Set<string>();
  for (const f of facts) {
    const key = normalizePath(f.path);
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    deduped.push(f);
  }

  // Detect canonical-name collisions among repos that would actually generate
  // (non-anchor, non-self, reachable, renderable, canonical name known). A `self`
  // repo writes nothing, so it shares no canonical and cannot collide.
  const byCanonical = new Map<string, string[]>();
  for (const f of deduped) {
    if (
      f.isAnchor ||
      f.self === true ||
      !f.reachable ||
      f.canonicalName === undefined ||
      !isRenderable(f)
    )
      continue;
    const repos = byCanonical.get(f.canonicalName) ?? [];
    repos.push(f.path);
    byCanonical.set(f.canonicalName, repos);
  }
  const collisions: PresetCollision[] = [];
  const collidingPaths = new Set<string>();
  for (const [canonicalName, repos] of byCanonical) {
    // A repo↔repo collision (two distinct repos, one canonical) OR a repo↔view
    // collision (the canonical name is the workspace view's own) — either way
    // the shared canonical is ambiguous and none of the parties is generated.
    const viewCollision =
      opts?.viewCanonicalName !== undefined && canonicalName === opts.viewCanonicalName;
    if (repos.length > 1 || viewCollision) {
      collisions.push({ canonicalName, repos, ...(viewCollision ? { view: true } : {}) });
      for (const r of repos) collidingPaths.add(r);
    }
  }

  const plans: RepoPresetPlan[] = [];
  const inSync: string[] = [];
  const undeclared: string[] = [];
  const markerConflicts: PresetMarkerConflict[] = [];
  const unreadable: string[] = [];
  const anchors: string[] = [];
  const self: string[] = [];
  const unreachable: string[] = [];

  for (const f of deduped) {
    if (f.isAnchor) {
      anchors.push(f.path);
      continue;
    }
    // A `self` repo is hands-off: never generate a preset block into its
    // hand-authored AGENTS.md. Checked before reachability/render so it is always
    // reported as `self` regardless of on-disk state.
    if (f.self === true) {
      self.push(f.path);
      continue;
    }
    if (!f.reachable) {
      unreachable.push(f.path);
      continue;
    }
    if (!isRenderable(f)) {
      undeclared.push(f.path);
      continue;
    }
    // A repo sharing a canonical name with another is surfaced as a collision
    // and never generated.
    if (collidingPaths.has(f.path)) continue;
    // Reachable + renderable + non-colliding repos always have a canonical name
    // (the caller sets it from the resolved basename); guard for type-safety.
    if (f.canonicalName === undefined) {
      unreachable.push(f.path);
      continue;
    }

    const desiredBlock = renderPresetBlock(f);
    if (!f.canonicalPresent) {
      plans.push({ path: f.path, canonicalName: f.canonicalName, action: "create", desiredBlock });
      continue;
    }
    // Canonical exists but could not be read — degrade this repo, do not generate.
    if (f.canonicalReadable === false) {
      unreadable.push(f.path);
      continue;
    }
    if (f.markerKind === "ok") {
      if (normalizeBlock(f.currentBlock ?? "") === normalizeBlock(desiredBlock)) {
        inSync.push(f.path);
      } else {
        plans.push({
          path: f.path,
          canonicalName: f.canonicalName,
          action: "update",
          desiredBlock,
        });
      }
      continue;
    }
    // Canonical present but markers absent/malformed — do not clobber.
    markerConflicts.push({ repo: f.path, reason: f.markerKind ?? "no_markers" });
  }

  return {
    plans,
    inSync,
    undeclared,
    markerConflicts,
    unreadable,
    collisions,
    anchors,
    self,
    unreachable,
    ok:
      plans.length === 0 &&
      markerConflicts.length === 0 &&
      unreadable.length === 0 &&
      collisions.length === 0 &&
      unreachable.length === 0 &&
      undeclared.length === 0,
  };
}
