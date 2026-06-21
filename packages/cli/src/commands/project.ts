import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AdoptCandidate,
  basouPaths,
  type InstructionFileFact,
  isGitNotFound,
  type Manifest,
  planRosterAdoption,
  type RepoEntry,
  type RepoWiringFacts,
  type RosterAdoptionPlan,
  type RosterDriftSummary,
  readManifest,
  reconcileSourceRoots,
  type SourceRootsReconcile,
  safeSimpleGit,
  summarizeRosterDrift,
  summarizeWiring,
  type WiringSummary,
  writeManifest,
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

/**
 * Agent instruction files inspected per repo. GEMINI.md is intentionally absent
 * (the Gemini CLI was discontinued for personal use). Each should be a gitignored
 * symlink to a canonical source, never tracked in a public repo's history.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;

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

  if (result.risks.length === 0) {
    lines.push("✅ 公開系 repo で git 追跡されている指示書はありません(privacy リスクなし)。");
  } else {
    lines.push(
      `⚠️ 公開系 repo で指示書が git 追跡されています: ${result.risks.length}(canonical の漏洩リスク)`,
    );
    for (const r of result.risks) {
      lines.push(
        `- ${r.repo} [${r.visibility}] — ${r.file} が tracked(gitignore された symlink である必要があります)`,
      );
    }
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
