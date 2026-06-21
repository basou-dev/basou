import {
  basouPaths,
  type RosterDriftSummary,
  readManifest,
  reconcileSourceRoots,
  type SourceRootsReconcile,
  summarizeRosterDrift,
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
    ...(manifest.import?.source_roots !== undefined
      ? { sourceRoots: manifest.import.source_roots }
      : {}),
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
