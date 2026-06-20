import {
  basouPaths,
  type RosterDriftSummary,
  readManifest,
  summarizeRosterDrift,
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
