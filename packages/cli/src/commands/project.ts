import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type AdoptCandidate,
  basouPaths,
  GENERATED_END,
  GENERATED_START,
  type GitignorePlanSummary,
  type InstructionFileFact,
  type InstructionSymlinkFact,
  type InstructionSymlinkState,
  isGitNotFound,
  type Manifest,
  type PresetPlanSummary,
  parseMarkers,
  planGitignore,
  planRosterAdoption,
  planWorkspaceView,
  type RepoEntry,
  type RepoGitignoreFacts,
  type RepoGitignorePlan,
  type RepoPresetFacts,
  type RepoPresetPlan,
  type RepoSymlinkFacts,
  type RepoSymlinkPlan,
  type RepoWiringFacts,
  type RosterAdoptionPlan,
  type RosterDriftSummary,
  readManifest,
  readMarkdownFile,
  reconcileSourceRoots,
  renderWithMarkers,
  type SourceRootsReconcile,
  type SymlinkPlanSummary,
  safeSimpleGit,
  summarizePresetPlan,
  summarizeRosterDrift,
  summarizeSymlinkPlan,
  summarizeWiring,
  type ViewRepoFact,
  type WiringSummary,
  type WorkspaceViewPlan,
  writeManifest,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import type { ImportContext } from "./import.js";

export type ProjectCheckOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type ProjectCheckContext = ImportContext;

export type ProjectSyncOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectSyncContext = ImportContext & { now?: () => Date };

/** Flat result of {@link doRunProjectSync}: the reconciliation plus what was done. */
export type ProjectSyncResult = SourceRootsReconcile & {
  /** Whether a repo roster (`repos`) was declared at all (else there is nothing to sync from). */
  hasRoster: boolean;
  /** Whether the manifest was written (i.e. `--apply` was set AND there was drift to reconcile). */
  applied: boolean;
};

export type ProjectAdoptOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectAdoptContext = ImportContext & { now?: () => Date };

/** Flat result of {@link doRunProjectAdopt}: the proposed roster plus what was done. */
export type ProjectAdoptResult = RosterAdoptionPlan & {
  /** Whether a `repos` roster was ALREADY declared (adopt is a one-time bootstrap; `--apply` refuses). */
  alreadyDeclared: boolean;
  /** Whether the manifest was written (i.e. `--apply` set, no existing roster, AND at least one repo found). */
  applied: boolean;
};

export type ProjectWiringOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type ProjectWiringContext = ImportContext;

/** Result of {@link doRunProjectWiring}: the wiring summary plus whether a roster was declared. */
export type ProjectWiringResult = WiringSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to inspect — run adopt first). */
  hasRoster: boolean;
};

export type ProjectGitignoreOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectGitignoreContext = ImportContext;

/** Result of {@link doRunProjectGitignore}: the plan plus whether a roster exists and whether it was applied. */
export type ProjectGitignoreResult = GitignorePlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether `.gitignore` files were written (i.e. `--apply` was set AND there was something to add). */
  applied: boolean;
};

export type ProjectSymlinksOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectSymlinksContext = ImportContext;

/** Result of {@link doRunProjectSymlinks}: the plan plus whether a roster exists and what `--apply` did. */
export type ProjectSymlinksResult = SymlinkPlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether any symlinks were actually created (true only when `--apply` created at least one link). */
  applied: boolean;
  /** Per-file failures encountered during `--apply` (collected, not thrown — kept transparent). */
  failures: { repo: string; file: string; message: string }[];
};

export type ProjectWorkspaceOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectWorkspaceContext = ImportContext;

/** Result of {@link doRunProjectWorkspace}: the view plan plus whether a view is declared and what `--apply` did. */
export type ProjectWorkspaceResult = WorkspaceViewPlan & {
  /** Whether `workspace.view` is declared (else there is no view to generate — solo project / not configured). */
  hasView: boolean;
  /** Whether any view symlinks were actually created (true only when `--apply` created at least one). */
  applied: boolean;
  /** Per-link failures encountered during `--apply` (collected, not thrown — pathless reason). */
  failures: { name: string; message: string }[];
};

export type ProjectPresetOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectPresetContext = ImportContext;

/** Result of {@link doRunProjectPreset}: the plan plus whether a roster exists and what `--apply` did. */
export type ProjectPresetResult = PresetPlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether any canonical was actually written (true only when `--apply` wrote at least one). */
  applied: boolean;
  /** Per-repo write failures encountered during `--apply` (collected, not thrown — pathless reason). */
  failures: { repo: string; message: string }[];
};

/**
 * Agent instruction files inspected per repo. GEMINI.md is intentionally absent
 * (the Gemini CLI was discontinued for personal use). Each should be a gitignored
 * symlink to a canonical source, never tracked in a public repo's history.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;

/**
 * The canonical instruction file name. It lives in the anchor at
 * `agents/<repo>/AGENTS.md` and is the hub each repo's own AGENTS.md symlink
 * resolves to; CLAUDE.md and Copilot are spokes pointing back at it.
 */
const CANONICAL_FILE = "AGENTS.md";

/**
 * Wire `basou project` (a read-only inspector for the project's declared repo
 * roster) and its `check` subcommand onto `program`. The roster is the single
 * source of truth for which repos make up a project; `check` compares it
 * against the capture config (`source_roots`) and surfaces drift. It writes
 * nothing and enforces nothing.
 */
export function registerProjectCommand(program: Command): void {
  const project = program
    .command("project")
    .description("Inspect a project's declared repo roster (read-only)");

  project
    .command("check")
    .description(
      "Compare the declared repo roster (manifest `repos`) against the capture config (`source_roots`) and surface drift (read-only, advisory)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectCheckOptions) => {
      await runProjectCheck(opts);
    });

  project
    .command("sync")
    .description(
      "Reconcile the capture config (`source_roots`) to cover every declared repo (manifest `repos`). Dry-run by default; pass --apply to write. Additive only — it never removes an existing source root (e.g. the workspace view)",
    )
    .option(
      "--apply",
      "Write the reconciled source_roots to the manifest (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectSyncOptions) => {
      await runProjectSync(opts);
    });

  project
    .command("adopt")
    .description(
      "Bootstrap a repo roster (manifest `repos`) from the existing capture config (`source_roots`): classify each by realpath + `.git`, keep the git repos, exclude non-repos (the workspace view, /tmp). Dry-run by default; pass --apply to write (refuses if a roster already exists)",
    )
    .option("--apply", "Write the bootstrapped roster to the manifest (default: dry-run preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectAdoptOptions) => {
      await runProjectAdopt(opts);
    });

  project
    .command("wiring")
    .description(
      "Inspect each declared repo's agent instruction-file wiring (AGENTS.md, CLAUDE.md, copilot-instructions.md): present? tracked by git? Surfaces privacy risks (a public repo tracking an instruction file) and gaps (read-only, advisory)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectWiringOptions) => {
      await runProjectWiring(opts);
    });

  project
    .command("gitignore")
    .description(
      "Reconcile each public-facing repo's .gitignore to exclude the agent instruction files (so the gitignored symlinks never enter public history). Dry-run by default; pass --apply to write. Additive only — it never removes a line; private repos and unset-visibility repos are left untouched",
    )
    .option(
      "--apply",
      "Append the missing patterns to each repo's .gitignore (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectGitignoreOptions) => {
      await runProjectGitignore(opts);
    });

  project
    .command("symlinks")
    .description(
      "Generate each declared repo's agent instruction-file symlinks (AGENTS.md, CLAUDE.md, copilot-instructions.md) pointing at the project anchor's canonical (agents/<repo>/AGENTS.md). Dry-run by default; pass --apply to create. Non-destructive — it only creates missing links and never overwrites an existing file or repoints a link",
    )
    .option("--apply", "Create the missing instruction-file symlinks (default: dry-run preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectSymlinksOptions) => {
      await runProjectSymlinks(opts);
    });

  project
    .command("workspace")
    .description(
      "Generate the project's workspace view: a directory (manifest `workspace.view`) that aggregates every declared repo via a `<repo-basename>` symlink (the anchor included). Dry-run by default; pass --apply to create. Non-destructive — it only creates missing links, never overwrites an existing entry or repoints a link, and does not prune strays",
    )
    .option("--apply", "Create the missing view symlinks (default: dry-run preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectWorkspaceOptions) => {
      await runProjectWorkspace(opts);
    });

  project
    .command("preset")
    .description(
      "Generate the stable-preset block (source visibility, source language, published surfaces) of each declared repo's canonical instruction file (agents/<repo>/AGENTS.md) from the manifest. Dry-run by default; pass --apply to write. Non-destructive — it only writes the marker-delimited region (creating an absent canonical, updating an out-of-date one) and never touches hand-authored content or a canonical whose markers are missing/malformed",
    )
    .option(
      "--apply",
      "Write the generated preset block to each canonical (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectPresetOptions) => {
      await runProjectPreset(opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectCheck}. */
export async function runProjectCheck(
  options: ProjectCheckOptions,
  ctx: ProjectCheckContext = {},
): Promise<void> {
  try {
    await doRunProjectCheck(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * The capture roots a manifest effectively scans. An absent `import.source_roots`
 * means "the host repository only" (import's documented default), so it resolves
 * to `["."]` here — NOT the empty set. Comparing the roster against the empty set
 * would falsely report the host `.` as a capture gap after a solo-repo adoption.
 */
function effectiveSourceRoots(manifest: Manifest): string[] {
  return manifest.import?.source_roots ?? ["."];
}

/** Pure runner: resolves the workspace, reads the manifest, computes the drift, prints it (or JSON). */
export async function doRunProjectCheck(
  options: ProjectCheckOptions,
  ctx: ProjectCheckContext,
): Promise<RosterDriftSummary> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project check");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const summary = summarizeRosterDrift({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    sourceRoots: effectiveSourceRoots(manifest),
  });

  if (options.json === true) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(renderProjectCheck(summary));
  }
  return summary;
}

/**
 * Render the advisory report. Leads with the capture gaps (declared repos not
 * being captured — the actionable drift), then the captured-but-undeclared
 * paths (commonly the workspace view), and states the read-only / no-enforce
 * framing so the verdict is not over-read.
 */
export function renderProjectCheck(summary: RosterDriftSummary): string {
  const lines: string[] = [];
  lines.push("# プロジェクト構成チェック(宣言 vs 捕捉)");
  lines.push("");

  if (summary.declaredCount === 0) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。`source_roots` のみで運用中のため、宣言との照合はできません。",
    );
    if (summary.extra.length > 0) {
      lines.push("");
      lines.push(`捕捉中の source_roots (${summary.extra.length}):`);
      for (const p of summary.extra) lines.push(`- ${p}`);
    }
    return lines.join("\n");
  }

  if (summary.gaps.length === 0) {
    lines.push(
      `✅ 宣言された ${summary.declaredCount} repo はすべて捕捉対象(source_roots)に含まれています。`,
    );
  } else {
    lines.push(`⚠️ 宣言されているのに捕捉対象に無い repo: ${summary.gaps.length}(取りこぼし)`);
    for (const g of summary.gaps) {
      lines.push(`- ${g.path}${g.visibility ? ` [${g.visibility}]` : ""} — source_roots に未登録`);
    }
  }
  lines.push("");

  if (summary.extra.length > 0) {
    lines.push(
      `## 宣言外の捕捉対象 (${summary.extra.length}) — workspace view か、宣言漏れの可能性`,
    );
    for (const p of summary.extra) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: read-only の advisory です。宣言(repos)と捕捉設定(source_roots)の差分のみを表示し、enforce はしません。",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectSync}. */
export async function runProjectSync(
  options: ProjectSyncOptions,
  ctx: ProjectSyncContext = {},
): Promise<void> {
  try {
    await doRunProjectSync(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Reconcile `source_roots` against the declared roster. Resolves the workspace,
 * reads the manifest, computes the additive reconciliation, and — only when
 * `--apply` is set and there is drift to fix — writes the manifest back (the
 * declared repos appended to `source_roots`, `workspace.updated_at` bumped).
 * Without `--apply` it writes nothing and prints the plan.
 */
export async function doRunProjectSync(
  options: ProjectSyncOptions,
  ctx: ProjectSyncContext,
): Promise<ProjectSyncResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project sync");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const hasRoster = manifest.repos !== undefined && manifest.repos.length > 0;
  const reconcile = reconcileSourceRoots({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    ...(manifest.import?.source_roots !== undefined
      ? { sourceRoots: manifest.import.source_roots }
      : {}),
  });

  const applied = options.apply === true && hasRoster && !reconcile.unchanged;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(
      paths,
      {
        ...manifest,
        import: { ...manifest.import, source_roots: reconcile.next },
        workspace: { ...manifest.workspace, updated_at: now().toISOString() },
      },
      { force: true },
    );
  }

  const result: ProjectSyncResult = { ...reconcile, hasRoster, applied };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectSync(result));
  }
  return result;
}

/**
 * Render the sync report. Leads with the actionable outcome: nothing to sync
 * (no roster), already in sync, or the source roots that will be / were added.
 * The dry-run framing makes clear that without `--apply` nothing is written.
 */
export function renderProjectSync(result: ProjectSyncResult): string {
  const lines: string[] = [];
  lines.push("# source_roots 同期(宣言ロースター → 捕捉設定)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。同期の元になる宣言が無いため、変更はありません。",
    );
    return lines.join("\n");
  }

  if (result.unchanged) {
    lines.push("✅ source_roots は宣言ロースターをすべて覆っています(同期不要)。");
    return lines.join("\n");
  }

  if (result.applied) {
    lines.push(`✅ source_roots に ${result.added.length} 件追加しました:`);
    for (const p of result.added) lines.push(`- ${p}`);
  } else {
    lines.push(
      `${result.added.length} 件の repo が source_roots に未登録です。追加予定(dry-run、反映するには --apply):`,
    );
    for (const p of result.added) lines.push(`- ${p}`);
    lines.push("");
    lines.push("注: 既存の source_roots は保持し、不足分の追記のみ行います(削除はしません)。");
  }
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectAdopt}. */
export async function runProjectAdopt(
  options: ProjectAdoptOptions,
  ctx: ProjectAdoptContext = {},
): Promise<void> {
  try {
    await doRunProjectAdopt(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Classify a declared source-root path against disk: a git repo root (`repo`),
 * a resolved-but-non-repo directory such as the workspace view or `/tmp`
 * (`non-repo`), or a path that does not resolve (`unresolved`). Resolves the
 * path relative to the repository root, then realpath (which follows the view's
 * symlink and unifies platform aliases) before probing for `.git`.
 */
function classifySourceRoot(repositoryRoot: string, declaredPath: string): AdoptCandidate {
  const absolute = resolve(repositoryRoot, declaredPath);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return { path: declaredPath, kind: "unresolved" };
  }
  return { path: declaredPath, kind: existsSync(join(real, ".git")) ? "repo" : "non-repo" };
}

/**
 * Bootstrap a `repos` roster from the existing `source_roots`. Resolves the
 * workspace, reads the manifest, classifies each source root on disk, and plans
 * the roster (git repos kept, non-repos/unresolved excluded). When `--apply` is
 * set, no roster exists yet, and at least one repo was found, it writes the
 * roster (and bumps `workspace.updated_at`). Without `--apply` — or when a
 * roster already exists — it writes nothing and prints the plan.
 *
 * `source_roots` absent mirrors import's default (the host repo `.` only), so a
 * solo repo adopts a `["."]` roster.
 */
export async function doRunProjectAdopt(
  options: ProjectAdoptOptions,
  ctx: ProjectAdoptContext,
): Promise<ProjectAdoptResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project adopt");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const alreadyDeclared = manifest.repos !== undefined && manifest.repos.length > 0;
  const candidates = effectiveSourceRoots(manifest).map((r) =>
    classifySourceRoot(repositoryRoot, r),
  );
  const plan = planRosterAdoption(candidates);

  const applied = options.apply === true && !alreadyDeclared && plan.repos.length > 0;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(
      paths,
      {
        ...manifest,
        repos: plan.repos,
        workspace: { ...manifest.workspace, updated_at: now().toISOString() },
      },
      { force: true },
    );
  }

  const result: ProjectAdoptResult = { ...plan, alreadyDeclared, applied };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectAdopt(result));
  }
  return result;
}

/**
 * Render the adoption report. Leads with the actionable outcome: a roster
 * already exists (nothing to bootstrap), nothing found, or the proposed roster
 * (with the excluded paths and why). The dry-run framing makes clear that
 * without `--apply` nothing is written, and reminds the operator to set
 * visibility afterward.
 */
export function renderProjectAdopt(result: ProjectAdoptResult): string {
  const lines: string[] = [];
  lines.push("# repo ロースターの bootstrap(source_roots → repos)");
  lines.push("");

  if (result.alreadyDeclared) {
    lines.push(
      "ℹ️ repo ロースター(manifest の `repos`)は既に宣言済みです。adopt は一度きりの bootstrap のため何も書き込みません。以後の保守は `project check` / `project sync` を使ってください。",
    );
    return lines.join("\n");
  }

  if (result.repos.length === 0) {
    lines.push("ℹ️ source_roots に git repo が見つかりませんでした(bootstrap 対象なし)。");
  } else if (result.applied) {
    lines.push(`✅ ${result.repos.length} repo を repos ロースターに書き込みました:`);
    for (const r of result.repos) lines.push(`- ${r.path}`);
    lines.push("");
    lines.push(
      "注: visibility は未設定です。各 repo に public / private / future-public を手動で付与してください。",
    );
  } else {
    lines.push(
      `${result.repos.length} repo を repos ロースターに宣言予定(dry-run、反映するには --apply):`,
    );
    for (const r of result.repos) lines.push(`- ${r.path}`);
    lines.push("");
    lines.push("注: visibility は未設定で提案します。反映後に手動で付与してください。");
  }

  if (result.excluded.length > 0) {
    lines.push("");
    lines.push(`## 除外 (${result.excluded.length}) — git repo ではないため repos に含めません`);
    for (const e of result.excluded) {
      const reason =
        e.kind === "non-repo" ? "非 repo(workspace view / tmp 等)" : "解決不能(パスが存在しない)";
      lines.push(`- ${e.path} — ${reason}`);
    }
  }
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectWiring}. */
export async function runProjectWiring(
  options: ProjectWiringOptions,
  ctx: ProjectWiringContext = {},
): Promise<void> {
  try {
    await doRunProjectWiring(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Whether a repo-relative path is tracked by git in `repoRoot`. `git ls-files`
 * prints the path when it is tracked and nothing when it is not. Any error
 * (missing git, a corrupt repo) propagates; {@link gatherRepoWiring} decides
 * whether to surface it (a missing git executable, which is global) or degrade
 * the single repo to unreachable (a per-repo failure) — never reading the error
 * as a false "untracked".
 */
async function isTrackedByGit(repoRoot: string, relPath: string): Promise<boolean> {
  const out = await safeSimpleGit(repoRoot).raw(["ls-files", "--", relPath]);
  return out.trim().length > 0;
}

/**
 * Gather the on-disk + git facts for one declared repo. Resolves the repo path
 * (realpath) and requires a `.git`; an unresolvable or non-repo path is reported
 * as `reachable: false` rather than crashing the whole report. Presence uses
 * `lstat` so a symlink (even a broken one) still counts as present.
 */
async function gatherRepoWiring(
  repositoryRoot: string,
  entry: RepoEntry,
): Promise<RepoWiringFacts> {
  const base = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, reachable: false, instructionFiles: [] };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, reachable: false, instructionFiles: [] };
  }

  try {
    const instructionFiles: InstructionFileFact[] = [];
    for (const name of INSTRUCTION_FILES) {
      let present = true;
      try {
        lstatSync(join(real, name));
      } catch {
        present = false;
      }
      instructionFiles.push({ name, present, tracked: await isTrackedByGit(real, name) });
    }
    return { ...base, reachable: true, instructionFiles };
  } catch (error: unknown) {
    // A missing git executable is a global, actionable failure — surface it so
    // the whole report does not silently read every repo as "untracked".
    if (isGitNotFound(error)) throw error;
    // A per-repo git failure (a corrupt repo, a stale worktree pointer) degrades
    // only THIS repo to unreachable, so one bad repo cannot blank the report.
    return { ...base, reachable: false, instructionFiles: [] };
  }
}

/**
 * Inspect each declared repo's instruction-file wiring. Resolves the workspace,
 * reads the manifest, gathers per-repo facts (presence + git-tracked status),
 * and summarizes the privacy-relevant drift. Read-only — it generates nothing.
 */
export async function doRunProjectWiring(
  options: ProjectWiringOptions,
  ctx: ProjectWiringContext,
): Promise<ProjectWiringResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project wiring");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const facts: RepoWiringFacts[] = [];
  for (const entry of roster) facts.push(await gatherRepoWiring(repositoryRoot, entry));

  const summary = summarizeWiring(facts);
  const result: ProjectWiringResult = { ...summary, hasRoster: roster.length > 0 };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectWiring(result));
  }
  return result;
}

/**
 * Render the wiring report. Leads with the actionable outcome: no roster (run
 * adopt first), the privacy risks (a public repo tracking an instruction file),
 * the unjudgeable repos (visibility unset), and the wiring gaps (missing files).
 * States the read-only framing so the verdict is not over-read.
 */
export function renderProjectWiring(result: ProjectWiringResult): string {
  const lines: string[] = [];
  lines.push("# 指示書 wiring チェック(宣言ロースター × 指示書の存在/git 追跡)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。`basou project adopt` で宣言してから実行してください。",
    );
    return lines.join("\n");
  }

  if (result.risks.length > 0) {
    lines.push(
      `⚠️ 公開系 repo で指示書が git 追跡されています: ${result.risks.length}(canonical の漏洩リスク)`,
    );
    for (const r of result.risks) {
      lines.push(
        `- ${r.repo} [${r.visibility}] — ${r.file} が tracked(gitignore された symlink である必要があります)`,
      );
    }
  } else if (result.ok) {
    lines.push("✅ 公開系 repo で git 追跡されている指示書はありません(privacy リスクなし)。");
  } else {
    // No confirmed risks, but unjudgeable / unreachable repos exist below — do NOT
    // lead with a clean "no risk" verdict (that would be a false-clear).
    lines.push(
      "ℹ️ 確定した privacy リスクはありませんが、判定できない/到達できない repo があります(下記参照)。",
    );
  }
  lines.push("");

  if (result.unknown.length > 0) {
    lines.push(
      `## visibility 未設定 (${result.unknown.length}) — privacy 判定不可。manifest の repos に visibility を付与してください`,
    );
    for (const p of result.unknown) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.incomplete.length > 0) {
    lines.push(`## 指示書の欠落 (${result.incomplete.length}) — 後続の生成スライスで補完予定`);
    for (const i of result.incomplete) lines.push(`- ${i.repo} — ${i.missing.join(", ")}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## 到達不能 (${result.unreachable.length}) — パス未解決 / git repo でない`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: read-only の advisory です。指示書の存在と git 追跡状況のみを表示し、生成・enforce はしません(.basou のフットプリントは `basou view --check`)。",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectGitignore}. */
export async function runProjectGitignore(
  options: ProjectGitignoreOptions,
  ctx: ProjectGitignoreContext = {},
): Promise<void> {
  try {
    await doRunProjectGitignore(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Gather one declared repo's `.gitignore` facts. Resolves the repo path
 * (realpath) and requires a `.git`; an unresolvable / non-repo path is reported
 * as `reachable: false`. Reads the repo's `.gitignore` into trimmed-on-compare
 * lines (an empty array when there is none). Pure filesystem reads — no writes.
 */
function gatherRepoGitignore(repositoryRoot: string, entry: RepoEntry): RepoGitignoreFacts {
  const base = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, reachable: false, currentLines: [] };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, reachable: false, currentLines: [] };
  }
  return { ...base, reachable: true, currentLines: readGitignoreLines(join(real, ".gitignore")) };
}

/** True when an error carries a string `code` (a Node errno like `ENOENT`). */
function hasErrorCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Read a `.gitignore` into trimmed-on-compare lines. A genuinely absent file
 * (`ENOENT`) yields `[]`; any OTHER read error is re-thrown with a pathless
 * message (so an unreadable file is never mistaken for "no patterns", which on
 * the apply path would clobber it down to only the generated patterns).
 */
function readGitignoreLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return [];
    throw new Error("Failed to read .gitignore", { cause: error });
  }
}

/** Append the planned patterns to a repo's `.gitignore`, creating it if absent. */
function applyGitignorePlan(repositoryRoot: string, plan: RepoGitignorePlan): void {
  const file = join(realpathSync(resolve(repositoryRoot, plan.path)), ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (error: unknown) {
    if (!(hasErrorCode(error) && error.code === "ENOENT")) {
      // Do NOT clobber an existing-but-unreadable .gitignore with only the patterns.
      throw new Error("Failed to read .gitignore", { cause: error });
    }
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(file, `${existing}${sep}${plan.toAdd.join("\n")}\n`);
  } catch (error: unknown) {
    throw new Error("Failed to write .gitignore", { cause: error });
  }
}

/**
 * Reconcile each public-facing repo's `.gitignore` to exclude the agent
 * instruction files. Resolves the workspace, reads the manifest, gathers each
 * declared repo's current `.gitignore`, and plans the missing patterns. When
 * `--apply` is set and there is something to add, it appends the patterns
 * (additive — it never removes a line); otherwise it writes nothing and prints
 * the plan. Private and unset-visibility repos are left untouched.
 */
export async function doRunProjectGitignore(
  options: ProjectGitignoreOptions,
  ctx: ProjectGitignoreContext,
): Promise<ProjectGitignoreResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project gitignore");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const facts = roster.map((entry) => gatherRepoGitignore(repositoryRoot, entry));
  const summary = planGitignore({ repos: facts, required: [...INSTRUCTION_FILES] });

  const applied = options.apply === true && summary.plans.length > 0;
  if (applied) {
    for (const plan of summary.plans) applyGitignorePlan(repositoryRoot, plan);
  }

  const result: ProjectGitignoreResult = { ...summary, hasRoster: roster.length > 0, applied };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectGitignore(result));
  }
  return result;
}

/**
 * Render the gitignore report. Leads with the actionable outcome: no roster (run
 * adopt first), the per-repo patterns that will be / were added, then the
 * skipped (unset visibility) and unreachable repos. A clean verdict is shown
 * only when there is genuinely nothing to do AND every repo was judgeable and
 * reachable (no false-clear).
 */
export function renderProjectGitignore(result: ProjectGitignoreResult): string {
  const lines: string[] = [];
  lines.push("# .gitignore 生成(公開系 repo の指示書を除外)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。`basou project adopt` で宣言してから実行してください。",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    const verb = result.applied ? "追加しました" : "追加予定(dry-run、反映するには --apply)";
    lines.push(
      `${result.applied ? "✅ " : ""}${result.plans.length} repo の .gitignore に${verb}:`,
    );
    for (const p of result.plans) lines.push(`- ${p.path} — ${p.toAdd.join(", ")}`);
  } else if (result.ok) {
    lines.push("✅ 公開系 repo の .gitignore は指示書をすべて除外済みです(追加不要)。");
  } else {
    lines.push(
      "ℹ️ 追加が必要な公開系 repo はありませんが、判定できない/到達できない repo があります(下記参照)。",
    );
  }
  lines.push("");

  if (result.unknown.length > 0) {
    lines.push(
      `## visibility 未設定 (${result.unknown.length}) — 対象外。manifest の repos に visibility を付与してください`,
    );
    for (const p of result.unknown) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## 到達不能 (${result.unreachable.length}) — パス未解決 / git repo でない`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: 既存の .gitignore 行は保持し、不足パターンの追記のみ行います(削除はしません)。private / visibility 未設定の repo は対象外です。",
  );
  lines.push(
    "注: .gitignore への追記は、既に git 追跡済みのファイルを untrack しません。追跡済みの指示書は `basou project wiring` で検出し、`git rm --cached <file>` で外してください。",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectSymlinks}. */
export async function runProjectSymlinks(
  options: ProjectSymlinksOptions,
  ctx: ProjectSymlinksContext = {},
): Promise<void> {
  try {
    await doRunProjectSymlinks(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * The instruction files and their expected symlink targets for one repo, in the
 * hub-and-spoke topology: AGENTS.md is the hub (a relative link to the anchor's
 * canonical), while CLAUDE.md and Copilot are spokes pointing back at the repo's
 * own AGENTS.md. `repoDirReal` and `canonicalFile` are both realpath-resolved so
 * the computed relative target matches a hand-wired link byte-for-byte.
 */
function expectedSymlinkTargets(
  repoDirReal: string,
  canonicalFile: string,
): { name: string; target: string }[] {
  return [
    { name: "AGENTS.md", target: relative(repoDirReal, canonicalFile) },
    { name: "CLAUDE.md", target: CANONICAL_FILE },
    { name: ".github/copilot-instructions.md", target: `../${CANONICAL_FILE}` },
  ];
}

/**
 * Inspect one instruction file's on-disk state against the link it should be.
 * `lstat` examines a symlink as a link (even a broken one), never following it.
 * Only a genuinely absent path (ENOENT) is `missing` (a creatable gap); any other
 * lstat error (ENOTDIR when a parent component is a regular file, EACCES) is
 * `blocked` — NOT `missing` — so a non-ENOENT error is never mistaken for a gap
 * and planned, which would crash `--apply` (e.g. `mkdirSync` over a `.github`
 * file). A symlink is `correct` when it points at `expectedTarget` and `mismatch`
 * (carrying its current target) otherwise; a real file or directory is `occupied`.
 */
function inspectSymlink(
  filePath: string,
  expectedTarget: string,
): { state: InstructionSymlinkState; actualTarget?: string } {
  let isLink: boolean;
  try {
    isLink = lstatSync(filePath).isSymbolicLink();
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return { state: "missing" };
    return { state: "blocked" };
  }
  if (!isLink) return { state: "occupied" };
  const actual = readlinkSync(filePath);
  return actual === expectedTarget
    ? { state: "correct" }
    : { state: "mismatch", actualTarget: actual };
}

/**
 * Gather the symlink facts for one declared repo. Resolves the repo path
 * (realpath); the entry that resolves to the manifest root IS the anchor (it
 * owns the canonical, so it is flagged `isAnchor` and never linked to itself). A
 * path that does not resolve or has no `.git` is `reachable: false`. Otherwise it
 * checks whether the anchor's canonical (`agents/<repo>/AGENTS.md`) exists and,
 * if so, inspects each instruction file's current state. Pure filesystem reads —
 * no writes.
 */
function gatherRepoSymlinks(
  repositoryRoot: string,
  anchorReal: string,
  entry: RepoEntry,
): RepoSymlinkFacts {
  const base = { path: entry.path };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, isAnchor: false, reachable: false, canonicalPresent: false, files: [] };
  }
  if (real === anchorReal) {
    return { ...base, isAnchor: true, reachable: true, canonicalPresent: false, files: [] };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, isAnchor: false, reachable: false, canonicalPresent: false, files: [] };
  }

  const canonicalFile = join(anchorReal, "agents", basename(real), CANONICAL_FILE);
  if (!existsSync(canonicalFile)) {
    return { ...base, isAnchor: false, reachable: true, canonicalPresent: false, files: [] };
  }

  const files: InstructionSymlinkFact[] = expectedSymlinkTargets(real, canonicalFile).map(
    (spec) => {
      const { state, actualTarget } = inspectSymlink(join(real, spec.name), spec.target);
      return {
        name: spec.name,
        expectedTarget: spec.target,
        state,
        ...(actualTarget !== undefined ? { actualTarget } : {}),
      };
    },
  );
  return {
    ...base,
    isAnchor: false,
    reachable: true,
    canonicalPresent: true,
    canonicalName: basename(real),
    files,
  };
}

/**
 * Create the planned (missing) symlinks for one repo, making `.github` if needed.
 * Defensive: a per-file failure (a path made unwritable, a parent that is not a
 * directory, or a race that created the file first) is collected, not thrown — so
 * one bad path neither aborts the remaining repos nor leaves the run silent about
 * what was actually created (upholding the non-destructive contract transparently).
 */
function applySymlinkPlan(
  repositoryRoot: string,
  plan: RepoSymlinkPlan,
): { created: string[]; failed: { file: string; message: string }[] } {
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, plan.path));
  } catch (error: unknown) {
    const message = failureReason(error);
    return { created: [], failed: plan.toCreate.map((c) => ({ file: c.name, message })) };
  }
  const created: string[] = [];
  const failed: { file: string; message: string }[] = [];
  for (const { name, target } of plan.toCreate) {
    const filePath = join(real, name);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      symlinkSync(target, filePath);
      created.push(name);
    } catch (error: unknown) {
      failed.push({ file: name, message: failureReason(error) });
    }
  }
  return { created, failed };
}

/**
 * A pathless failure reason for `--apply` errors: the errno code (EEXIST,
 * ENOTDIR, EACCES, …) when present, else a generic label. Never the raw Node
 * `error.message`, which embeds the absolute filesystem path and would leak it
 * into the report / `--json` output (the repo + repo-relative file already
 * identify the failure).
 */
function failureReason(error: unknown): string {
  return hasErrorCode(error) ? error.code : "unknown error";
}

/**
 * Generate each declared repo's instruction-file symlinks. Resolves the
 * workspace, reads the manifest, gathers each repo's current symlink state, and
 * plans the missing links. When `--apply` is set and there is something to
 * create, it creates only the `missing` links (non-destructive — conflicts and
 * occupied paths are never touched); otherwise it writes nothing and prints the
 * plan.
 */
export async function doRunProjectSymlinks(
  options: ProjectSymlinksOptions,
  ctx: ProjectSymlinksContext,
): Promise<ProjectSymlinksResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project symlinks");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const anchorReal = realpathSync(repositoryRoot);
  const facts = roster.map((entry) => gatherRepoSymlinks(repositoryRoot, anchorReal, entry));
  const summary = summarizeSymlinkPlan(facts);

  const wantApply = options.apply === true && summary.plans.length > 0;
  const failures: { repo: string; file: string; message: string }[] = [];
  let createdCount = 0;
  if (wantApply) {
    for (const plan of summary.plans) {
      const { created, failed } = applySymlinkPlan(repositoryRoot, plan);
      createdCount += created.length;
      for (const f of failed) failures.push({ repo: plan.path, file: f.file, message: f.message });
    }
  }

  const result: ProjectSymlinksResult = {
    ...summary,
    hasRoster: roster.length > 0,
    applied: createdCount > 0,
    failures,
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectSymlinks(result));
  }
  return result;
}

/**
 * Render the symlink-generation report. Leads with the actionable outcome: no
 * roster (run adopt first), the per-repo links that will be / were created, then
 * the conflicts (existing files / links pointing elsewhere — left untouched),
 * repos whose anchor canonical is absent, and unreachable repos. A clean "all
 * wired" verdict is shown only when there is genuinely nothing to do AND every
 * repo was judgeable and reachable (no false-clear).
 */
export function renderProjectSymlinks(result: ProjectSymlinksResult): string {
  const lines: string[] = [];
  lines.push("# 指示書 symlink 生成(各 repo → anchor の canonical)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。`basou project adopt` で宣言してから実行してください。",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    // `--apply` was attempted when something was created OR something failed; a
    // dry-run has neither (its plan is just intentions, written nowhere).
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `${result.plans.length} repo に指示書 symlink を作成予定(dry-run、反映するには --apply):`,
      );
      for (const p of result.plans) {
        lines.push(`- ${p.path}`);
        for (const c of p.toCreate) lines.push(`    ${c.name} -> ${c.target}`);
      }
    } else {
      // List only what was ACTUALLY created — a planned file that failed appears
      // in the failures section, never here (no false "created" claim).
      const header =
        result.failures.length === 0
          ? "✅ 指示書 symlink を作成しました:"
          : result.applied
            ? "指示書 symlink を作成しました(一部失敗、下記参照):"
            : "指示書 symlink を作成できませんでした(下記参照):";
      lines.push(header);
      for (const p of result.plans) {
        const failedFiles = new Set(
          result.failures.filter((f) => f.repo === p.path).map((f) => f.file),
        );
        const created = p.toCreate.filter((c) => !failedFiles.has(c.name));
        if (created.length === 0) continue;
        lines.push(`- ${p.path}`);
        for (const c of created) lines.push(`    ${c.name} -> ${c.target}`);
      }
    }
  } else if (result.ok) {
    lines.push("✅ 宣言された全 repo の指示書 symlink は正しく張られています(生成不要)。");
  } else {
    lines.push(
      "ℹ️ 生成が必要な symlink はありませんが、競合 / 衝突 / canonical 不在 / 到達できない repo があります(下記参照)。",
    );
  }
  lines.push("");

  if (result.failures.length > 0) {
    lines.push(`## 作成に失敗 (${result.failures.length}) — 一部の symlink を作成できませんでした`);
    for (const f of result.failures) lines.push(`- ${f.repo} — ${f.file}: ${f.message}`);
    lines.push("");
  }

  if (result.conflicts.length > 0) {
    lines.push(
      `## 競合 (${result.conflicts.length}) — 既存を上書きしません。手動で確認してください`,
    );
    for (const c of result.conflicts) {
      const detail =
        c.reason === "mismatch"
          ? `別の場所を指す symlink(現在: ${c.actualTarget ?? "?"})`
          : c.reason === "occupied"
            ? "symlink でない実ファイル/ディレクトリ"
            : "検査できないパス(親が非ディレクトリ等)";
      lines.push(`- ${c.repo} — ${c.file}: ${detail}`);
    }
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## canonical 衝突 (${result.collisions.length}) — 別 repo が同名 canonical を共有(自動配線しません)`,
    );
    for (const c of result.collisions) {
      lines.push(`- agents/${c.canonicalName}/AGENTS.md ← ${c.repos.join(", ")}`);
    }
    lines.push("");
  }

  if (result.missingCanonical.length > 0) {
    lines.push(
      `## canonical 不在 (${result.missingCanonical.length}) — anchor に agents/<repo>/AGENTS.md が無いため生成できません`,
    );
    for (const p of result.missingCanonical) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## 到達不能 (${result.unreachable.length}) — パス未解決 / git repo でない`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: 既存ファイル・別の場所を指す symlink は上書きせず、不足分の作成のみ行います(GEMINI.md は廃止のため生成しません)。",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectWorkspace}. */
export async function runProjectWorkspace(
  options: ProjectWorkspaceOptions,
  ctx: ProjectWorkspaceContext = {},
): Promise<void> {
  try {
    await doRunProjectWorkspace(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Resolve the view directory to a realpath-stable absolute path. When the view
 * exists, realpath it; when it does not exist yet, anchor on its (existing)
 * parent's realpath + basename so the relative targets computed against the
 * realpath'd repos stay consistent. Falls back to the plain resolved path only
 * when the parent is also absent (apply's recursive mkdir will create it).
 */
function resolveViewDir(repositoryRoot: string, viewPath: string): string {
  const abs = resolve(repositoryRoot, viewPath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Gather one roster repo's place in the view. Resolves the repo (realpath); an
 * unresolvable path is `reachable: false` (cannot be aggregated). The view link
 * is named by the repo's basename and should point at the repo relative to the
 * view; its on-disk state is inspected with the same ENOENT-only rule as the
 * instruction symlinks (a non-ENOENT lstat error is `blocked`, never a creatable
 * gap). Pure filesystem reads — no writes.
 */
function gatherViewRepo(repositoryRoot: string, viewDir: string, entry: RepoEntry): ViewRepoFact {
  let repoReal: string;
  try {
    repoReal = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { path: entry.path, reachable: false };
  }
  const expectedTarget = relative(viewDir, repoReal);
  // A repo that resolves to the view directory ITSELF yields an empty (self-)
  // target. It cannot be aggregated into the view, and an empty symlink target
  // would create a broken link that a later run reads back as falsely "correct"
  // (readlink "" === expectedTarget "") — so surface it as unreachable instead.
  if (expectedTarget === "" || expectedTarget === ".") {
    return { path: entry.path, reachable: false };
  }
  const linkName = basename(repoReal);
  const { state, actualTarget } = inspectSymlink(join(viewDir, linkName), expectedTarget);
  return {
    path: entry.path,
    reachable: true,
    linkName,
    expectedTarget,
    state,
    ...(actualTarget !== undefined ? { actualTarget } : {}),
  };
}

/** Create the planned (missing) view symlinks, making the view directory if needed. */
function applyViewPlan(
  viewDir: string,
  toCreate: { name: string; target: string }[],
): { created: string[]; failed: { name: string; message: string }[] } {
  const created: string[] = [];
  const failed: { name: string; message: string }[] = [];
  for (const { name, target } of toCreate) {
    const filePath = join(viewDir, name);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      symlinkSync(target, filePath);
      created.push(name);
    } catch (error: unknown) {
      failed.push({ name, message: failureReason(error) });
    }
  }
  return { created, failed };
}

/**
 * Generate the project's workspace view. Resolves the workspace, reads the
 * manifest, and — when `workspace.view` is declared — gathers each roster repo's
 * view-link state and plans the missing links. When `--apply` is set and there
 * is something to create, it creates only the `missing` links (non-destructive;
 * conflicts/collisions are never touched and strays are not pruned); otherwise it
 * writes nothing and prints the plan.
 */
export async function doRunProjectWorkspace(
  options: ProjectWorkspaceOptions,
  ctx: ProjectWorkspaceContext,
): Promise<ProjectWorkspaceResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project workspace");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const viewPath = manifest.workspace.view;
  const roster = manifest.repos ?? [];

  let result: ProjectWorkspaceResult;
  if (viewPath === undefined) {
    result = {
      toCreate: [],
      conflicts: [],
      collisions: [],
      unreachable: [],
      correctCount: 0,
      ok: true,
      hasView: false,
      applied: false,
      failures: [],
    };
  } else {
    const viewDir = resolveViewDir(repositoryRoot, viewPath);
    const facts = roster.map((entry) => gatherViewRepo(repositoryRoot, viewDir, entry));
    const plan = planWorkspaceView(facts);

    const failures: { name: string; message: string }[] = [];
    let createdCount = 0;
    if (options.apply === true && plan.toCreate.length > 0) {
      const applied = applyViewPlan(viewDir, plan.toCreate);
      createdCount = applied.created.length;
      for (const f of applied.failed) failures.push(f);
    }
    result = { ...plan, hasView: true, applied: createdCount > 0, failures };
  }

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectWorkspace(result));
  }
  return result;
}

/**
 * Render the workspace-view report. Leads with the actionable outcome: no view
 * declared, the links that will be / were created, then conflicts, basename
 * collisions, and unreachable repos. A clean "in sync" verdict is shown only when
 * there is genuinely nothing to do AND every repo was resolvable and unambiguous
 * (no false-clear). Stray entries are not pruned (out of scope).
 */
export function renderProjectWorkspace(result: ProjectWorkspaceResult): string {
  const lines: string[] = [];
  lines.push("# workspace view 生成(roster repo を集約)");
  lines.push("");

  if (!result.hasView) {
    lines.push(
      "ℹ️ view が未宣言です(manifest の `workspace.view`)。集約先のディレクトリを宣言してから実行してください。",
    );
    return lines.join("\n");
  }

  if (result.toCreate.length > 0) {
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `${result.toCreate.length} 件の repo symlink を view に作成予定(dry-run、反映するには --apply):`,
      );
      for (const c of result.toCreate) lines.push(`    ${c.name} -> ${c.target}`);
    } else {
      const failed = new Set(result.failures.map((f) => f.name));
      const header =
        result.failures.length === 0
          ? "✅ view に repo symlink を作成しました:"
          : result.applied
            ? "view に repo symlink を作成しました(一部失敗、下記参照):"
            : "view に repo symlink を作成できませんでした(下記参照):";
      lines.push(header);
      for (const c of result.toCreate) {
        if (failed.has(c.name)) continue;
        lines.push(`    ${c.name} -> ${c.target}`);
      }
    }
  } else if (result.ok) {
    lines.push(
      `✅ view は宣言された roster をすべて集約しています(${result.correctCount} links、生成不要)。`,
    );
  } else {
    lines.push(
      "ℹ️ 作成が必要な symlink はありませんが、競合 / 衝突 / 到達できない repo があります(下記参照)。",
    );
  }
  lines.push("");

  if (result.failures.length > 0) {
    lines.push(`## 作成に失敗 (${result.failures.length}) — 一部の symlink を作成できませんでした`);
    for (const f of result.failures) lines.push(`- ${f.name}: ${f.message}`);
    lines.push("");
  }

  if (result.conflicts.length > 0) {
    lines.push(
      `## 競合 (${result.conflicts.length}) — 既存を上書きしません。手動で確認してください`,
    );
    for (const c of result.conflicts) {
      const detail =
        c.reason === "mismatch"
          ? `別の場所を指す symlink(現在: ${c.actualTarget ?? "?"})`
          : c.reason === "occupied"
            ? "symlink でない実ファイル/ディレクトリ"
            : "検査できないパス(親が非ディレクトリ等)";
      lines.push(`- ${c.name}: ${detail}`);
    }
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## basename 衝突 (${result.collisions.length}) — 別 repo が同じ view 名を取り合い(自動配線しません)`,
    );
    for (const c of result.collisions) lines.push(`- ${c.linkName} ← ${c.repos.join(", ")}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(
      `## 到達不能 (${result.unreachable.length}) — パス未解決、または view 自身に解決するため集約できません`,
    );
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: 既存エントリは上書きせず、不足分の作成のみ行います。view 内の所有外エントリ(stray)の削除は未対応です。",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectPreset}. */
export async function runProjectPreset(
  options: ProjectPresetOptions,
  ctx: ProjectPresetContext = {},
): Promise<void> {
  try {
    await doRunProjectPreset(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** The anchor's canonical file for a repo: `<anchor>/agents/<name>/AGENTS.md`. */
function canonicalFileFor(anchorReal: string, canonicalName: string): string {
  return join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
}

/** The repo-relative label for a canonical (used in marker errors — never an absolute path). */
function canonicalLabelFor(canonicalName: string): string {
  return join("agents", canonicalName, CANONICAL_FILE);
}

/**
 * Gather one declared repo's preset facts. Resolves the repo (realpath); the
 * entry that resolves to the manifest root IS the anchor (its own AGENTS.md is
 * hand-maintained, so it is flagged and skipped). A path that does not resolve
 * or has no `.git` is `reachable: false`. Otherwise it reads the anchor's
 * canonical (`agents/<repo>/AGENTS.md`): absent => to be created; present =>
 * parsed for its marker region so the summarizer can detect drift. A present
 * canonical that cannot be read (a non-ENOENT failure) degrades only this repo
 * (`canonicalReadable: false`) instead of crashing the whole report.
 */
async function gatherRepoPreset(
  repositoryRoot: string,
  anchorReal: string,
  entry: RepoEntry,
): Promise<RepoPresetFacts> {
  const declared = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
    ...(entry.language !== undefined ? { language: entry.language } : {}),
    ...(entry.publishes !== undefined ? { publishes: entry.publishes } : {}),
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...declared, isAnchor: false, reachable: false, canonicalPresent: false };
  }
  if (real === anchorReal) {
    return { ...declared, isAnchor: true, reachable: true, canonicalPresent: false };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...declared, isAnchor: false, reachable: false, canonicalPresent: false };
  }

  const canonicalName = basename(real);
  let content: string | null;
  try {
    content = await readMarkdownFile(canonicalFileFor(anchorReal, canonicalName));
  } catch {
    // Present but unreadable (e.g. a directory at that path, or permission denied).
    return {
      ...declared,
      isAnchor: false,
      reachable: true,
      canonicalName,
      canonicalPresent: true,
      canonicalReadable: false,
    };
  }
  if (content === null) {
    return {
      ...declared,
      isAnchor: false,
      reachable: true,
      canonicalName,
      canonicalPresent: false,
    };
  }
  const section = parseMarkers(content);
  return {
    ...declared,
    isAnchor: false,
    reachable: true,
    canonicalName,
    canonicalPresent: true,
    canonicalReadable: true,
    markerKind: section.kind,
    ...(section.kind === "ok" ? { currentBlock: section.generated } : {}),
  };
}

/**
 * Write one planned canonical, always replacing ONLY the marker region via
 * {@link renderWithMarkers} so hand-authored content around it is preserved.
 *
 * Both `create` and `update` re-read the file at write time and render against
 * the CURRENT content (null => fresh). This closes the create-race: if a
 * canonical appeared between gather (which saw it absent) and the write, its
 * hand-authored content around well-formed markers is preserved, and a
 * markerless / malformed file makes {@link renderWithMarkers} throw — collected
 * by the caller as a failure — rather than being clobbered by a blind null-based
 * write. A symlinked canonical is refused: `atomicReplace` would swap the link
 * for a regular file, silently breaking deliberate wiring. The only on-disk
 * mutations are the recursive `mkdir` for a create and the marker-region write.
 */
async function applyPresetPlan(anchorReal: string, plan: RepoPresetPlan): Promise<void> {
  const file = canonicalFileFor(anchorReal, plan.canonicalName);
  const label = canonicalLabelFor(plan.canonicalName);
  // Refuse to replace a symlinked canonical. `lstat` examines the link itself; an
  // absent path (ENOENT) or any uninspectable path is not a symlink to guard —
  // the create branch / the write itself handles those.
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) throw new Error(`Canonical is a symlink in ${label}`);

  if (plan.action === "create") mkdirSync(dirname(file), { recursive: true });
  const existing = await readMarkdownFile(file);
  await writeMarkdownFile(file, renderWithMarkers(existing, plan.desiredBlock, label));
}

/**
 * A pathless failure reason for an `--apply` write error. A marker mismatch
 * thrown by {@link renderWithMarkers} (`Markers …`) or the symlink guard above
 * (`Canonical …`) carries an already-safe message (it embeds only the
 * repo-relative label); any other error is reduced to its errno code (from the
 * wrapped cause when present), never the raw message (which would leak an
 * absolute filesystem path into the report / `--json`).
 */
function presetFailureReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message.startsWith("Markers") || error.message.startsWith("Canonical"))
  ) {
    return error.message;
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (hasErrorCode(cause)) return cause.code;
  if (hasErrorCode(error)) return error.code;
  return "unknown error";
}

/**
 * Generate each declared repo's canonical instruction-file preset block.
 * Resolves the workspace, reads the manifest, gathers each repo's canonical
 * state, and plans the create/update work. When `--apply` is set and there is
 * something to write, it writes only the marker-delimited region (creating an
 * absent canonical, updating an out-of-date one); a per-repo write failure is
 * collected, not thrown. Without `--apply` it writes nothing and prints the plan.
 */
export async function doRunProjectPreset(
  options: ProjectPresetOptions,
  ctx: ProjectPresetContext,
): Promise<ProjectPresetResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project preset");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const anchorReal = realpathSync(repositoryRoot);
  const facts: RepoPresetFacts[] = [];
  for (const entry of roster) facts.push(await gatherRepoPreset(repositoryRoot, anchorReal, entry));
  const summary = summarizePresetPlan(facts);

  const failures: { repo: string; message: string }[] = [];
  let writtenCount = 0;
  if (options.apply === true && summary.plans.length > 0) {
    for (const plan of summary.plans) {
      try {
        await applyPresetPlan(anchorReal, plan);
        writtenCount += 1;
      } catch (error: unknown) {
        failures.push({ repo: plan.path, message: presetFailureReason(error) });
      }
    }
  }

  const result: ProjectPresetResult = {
    ...summary,
    hasRoster: roster.length > 0,
    applied: writtenCount > 0,
    failures,
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectPreset(result));
  }
  return result;
}

/** A compact one-line summary of what a plan's generated block declares. */
function presetActionLabel(action: RepoPresetPlan["action"]): string {
  return action === "create" ? "新規作成" : "更新";
}

/**
 * Render the preset-generation report. Leads with the actionable outcome: no
 * roster (run adopt first), the per-repo canonical blocks that will be / were
 * written (with the generated block shown in dry-run), then the marker conflicts
 * (canonical present but unmarked/malformed — left untouched, with the remedy),
 * unreadable canonicals, basename collisions, undeclared repos, the skipped
 * anchor, and unreachable repos. A clean "all in sync" verdict is shown only when
 * there is genuinely nothing to do AND every repo was judgeable (no false-clear).
 */
export function renderProjectPreset(result: ProjectPresetResult): string {
  const lines: string[] = [];
  lines.push("# 指示書 A プリセット生成(宣言 → canonical の生成領域)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ repo ロースターが未宣言です(manifest の `repos`)。`basou project adopt` で宣言してから実行してください。",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    // `--apply` was attempted when something was written OR something failed.
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `${result.plans.length} repo の canonical に A プリセットを生成予定(dry-run、反映するには --apply):`,
      );
      for (const p of result.plans) {
        lines.push(
          `- ${p.path} [${presetActionLabel(p.action)}] → ${canonicalLabelFor(p.canonicalName)}`,
        );
        for (const bl of p.desiredBlock.split("\n")) lines.push(`    ${bl}`);
      }
    } else {
      const failed = new Set(result.failures.map((f) => f.repo));
      const header =
        result.failures.length === 0
          ? "✅ canonical に A プリセットを生成しました:"
          : result.applied
            ? "A プリセットを生成しました(一部失敗、下記参照):"
            : "A プリセットを生成できませんでした(下記参照):";
      lines.push(header);
      for (const p of result.plans) {
        if (failed.has(p.path)) continue;
        lines.push(
          `- ${p.path} [${presetActionLabel(p.action)}] → ${canonicalLabelFor(p.canonicalName)}`,
        );
      }
    }
  } else if (result.ok) {
    lines.push("✅ 宣言された全 repo の A プリセットは canonical と同期済みです(生成不要)。");
  } else {
    lines.push(
      "ℹ️ 生成が必要な repo はありませんが、マーカー競合 / 衝突 / 未宣言 / 到達できない repo があります(下記参照)。",
    );
  }
  lines.push("");

  if (result.inSync.length > 0) {
    lines.push(`同期済み (${result.inSync.length}): ${result.inSync.join(", ")}`);
    lines.push("");
  }

  if (result.failures.length > 0) {
    lines.push(
      `## 書き込みに失敗 (${result.failures.length}) — 一部の canonical を書けませんでした`,
    );
    for (const f of result.failures) lines.push(`- ${f.repo}: ${f.message}`);
    lines.push("");
  }

  if (result.markerConflicts.length > 0) {
    lines.push(
      `## マーカー競合 (${result.markerConflicts.length}) — canonical のマーカーが無い/壊れているため上書きしません`,
    );
    for (const c of result.markerConflicts) {
      const detail =
        c.reason === "no_markers" ? "マーカー領域が無い" : `マーカー不整合(${c.reason})`;
      lines.push(`- ${c.repo}: ${detail}`);
    }
    lines.push(
      `  対処: A プリセットを入れたい位置に次の2行を追加してください — \`${GENERATED_START}\` と \`${GENERATED_END}\`(無ければ basou が新規 canonical を作ります)。`,
    );
    lines.push("");
  }

  if (result.unreadable.length > 0) {
    lines.push(
      `## canonical 読み取り不能 (${result.unreadable.length}) — ディレクトリ/権限等で読めません`,
    );
    for (const p of result.unreadable) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## canonical 衝突 (${result.collisions.length}) — 別 repo が同名 canonical を共有(自動生成しません)`,
    );
    for (const c of result.collisions) {
      lines.push(`- agents/${c.canonicalName}/AGENTS.md ← ${c.repos.join(", ")}`);
    }
    lines.push("");
  }

  if (result.undeclared.length > 0) {
    lines.push(
      `## 宣言なし (${result.undeclared.length}) — visibility / language / publishes が未設定のため生成しません`,
    );
    for (const p of result.undeclared) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.anchors.length > 0) {
    lines.push(
      `## anchor (${result.anchors.length}) — 自身の AGENTS.md は手で維持するためスキップ`,
    );
    for (const p of result.anchors) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## 到達不能 (${result.unreachable.length}) — パス未解決 / git repo でない`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "注: マーカー領域のみを生成し、canonical の手書き部分(マーカー外)は保持します。生成内容は manifest の宣言から導出されます。",
  );
  return lines.join("\n");
}
