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

import type { PublishTarget, RepoLanguage, RepoVisibility } from "./roster.js";

/** The declared fields the preset block is rendered from. */
export type PresetRepo = {
  visibility?: RepoVisibility | undefined;
  language?: RepoLanguage | undefined;
  publishes?: PublishTarget[] | undefined;
};

/** Source git-visibility, rendered with the consequence the agent must respect. */
function visibilityLabel(v: RepoVisibility | undefined): string {
  switch (v) {
    case "public":
      return "public(git 履歴は公開)";
    case "private":
      return "private(git 履歴は非公開)";
    case "future-public":
      return "future-public(現在は非公開・将来公開予定)";
    default:
      return "未設定";
  }
}

/** Source language (commits/comments/code), rendered with the audience it serves. */
function sourceLanguageLabel(l: RepoLanguage | undefined): string {
  switch (l) {
    case "en":
      return "en(commit・コメント・コードは英語)";
    case "ja":
      return "ja(commit・コメント・コードは日本語)";
    case "en+ja":
      return "en+ja(commit・コメント・コードは日英)";
    default:
      return "未設定";
  }
}

/** Published-surface kind. */
function publishKindLabel(k: PublishTarget["kind"]): string {
  return k === "web" ? "web(デプロイ)" : "npm(パッケージ)";
}

/** A published surface's visibility (independent of the source repo's). */
function publishVisibilityLabel(v: RepoVisibility | undefined): string {
  switch (v) {
    case "public":
      return "公開";
    case "private":
      return "非公開";
    case "future-public":
      return "将来公開";
    default:
      return "可視性未設定";
  }
}

/** A published surface's content language (read by end users; may differ from source). */
function contentLanguageLabel(l: RepoLanguage | undefined): string {
  return l ?? "言語未設定";
}

/**
 * Whether a repo has anything to render. A repo with no visibility, no language,
 * and no published surface yields an all-"未設定" block that helps no one, so it
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
 * (the basis for drift detection). The published surfaces are listed in their
 * declared order. Returns the block WITHOUT a trailing newline; the marker
 * writer adds the surrounding structure.
 */
export function renderPresetBlock(repo: PresetRepo): string {
  const lines: string[] = [];
  lines.push("## プロジェクト構成(basou が生成 — manifest が正本)");
  lines.push("");
  lines.push(
    "このセクションは `.basou/manifest.yaml` の宣言から `basou project preset` が生成します。編集は manifest 側で行ってください(マーカー外の記述は保持されます)。",
  );
  lines.push("");
  lines.push(`- ソース可視性: ${visibilityLabel(repo.visibility)}`);
  lines.push(`- ソース言語: ${sourceLanguageLabel(repo.language)}`);
  const publishes = repo.publishes ?? [];
  if (publishes.length === 0) {
    lines.push("- 配信物: なし");
  } else {
    lines.push("- 配信物:");
    for (const p of publishes) {
      lines.push(
        `    - ${publishKindLabel(p.kind)} — ${publishVisibilityLabel(p.visibility)} / ${contentLanguageLabel(p.language)}`,
      );
    }
  }
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
  /** Repo paths that could not be resolved / are not usable git repos. */
  unreachable: string[];
  /**
   * True only when nothing needs writing AND there are no marker conflicts, no
   * unreadable canonicals, no collisions, no unreachable repos, and no
   * undeclared repos — so a clean "all in sync" verdict is never claimed while
   * some repo was skipped or unjudgeable. Anchors do not block it (they are
   * intentionally not generated).
   */
  ok: boolean;
};

/** Normalize a relative roster path for comparison: trim, drop trailing slashes, empty => ".". */
function normalizePath(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.length === 0 ? "." : s;
}

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
 */
export function summarizePresetPlan(facts: RepoPresetFacts[]): PresetPlanSummary {
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
  // (non-anchor, reachable, renderable, canonical name known).
  const byCanonical = new Map<string, string[]>();
  for (const f of deduped) {
    if (f.isAnchor || !f.reachable || f.canonicalName === undefined || !isRenderable(f)) continue;
    const repos = byCanonical.get(f.canonicalName) ?? [];
    repos.push(f.path);
    byCanonical.set(f.canonicalName, repos);
  }
  const collisions: PresetCollision[] = [];
  const collidingPaths = new Set<string>();
  for (const [canonicalName, repos] of byCanonical) {
    if (repos.length > 1) {
      collisions.push({ canonicalName, repos });
      for (const r of repos) collidingPaths.add(r);
    }
  }

  const plans: RepoPresetPlan[] = [];
  const inSync: string[] = [];
  const undeclared: string[] = [];
  const markerConflicts: PresetMarkerConflict[] = [];
  const unreadable: string[] = [];
  const anchors: string[] = [];
  const unreachable: string[] = [];

  for (const f of deduped) {
    if (f.isAnchor) {
      anchors.push(f.path);
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
