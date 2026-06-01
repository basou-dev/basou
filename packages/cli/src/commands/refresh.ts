import { assertBasouRootSafe, basouPaths, findErrorCode, resolveRepositoryRoot } from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { type ImportOutcome, type RefreshResult, refreshAll } from "../lib/provenance-actions.js";
import type { ImportContext } from "./import.js";

export type RefreshOptions = {
  project?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type RefreshContext = ImportContext & {
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou refresh` onto `program`. One command that imports every adapter
 * for the project and regenerates handoff + decisions, so the dogfood loop is
 * a single invocation instead of four.
 */
export function registerRefreshCommand(program: Command): void {
  program
    .command("refresh")
    .description(
      "Import all adapters for the project and regenerate handoff + decisions in one step",
    )
    .option(
      "--project <path>",
      "Source project path to import (defaults to the current repository root)",
    )
    .option("--force", "Re-import sessions already imported instead of skipping")
    .option("--dry-run", "Preview imports and skip writing handoff / decisions")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: RefreshOptions) => {
      await runRefresh(options);
    });
}

/**
 * Programmatic entry that owns `process.exitCode`. Tests should prefer
 * {@link doRunRefresh}, which returns the structured result.
 */
export async function runRefresh(options: RefreshOptions, ctx: RefreshContext = {}): Promise<void> {
  try {
    await doRunRefresh(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner: resolves the workspace, runs the shared refresh pipeline, and
 * prints a summary (or JSON). Returns the {@link RefreshResult} so the same
 * pipeline can be exercised by tests and reused by the view server.
 */
export async function doRunRefresh(
  options: RefreshOptions,
  ctx: RefreshContext,
): Promise<RefreshResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForRefresh(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const result = await refreshAll({
    options: {
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(options.force === true ? { force: true } : {}),
      ...(options.dryRun === true ? { dryRun: true } : {}),
    },
    ctx,
    paths,
    nowIso,
  });

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    printRefreshSummary(result);
  }
  return result;
}

function describeImport(outcome: ImportOutcome): string {
  if (outcome.status === "skipped") {
    return `${outcome.adapter}: skipped (${outcome.reason})`;
  }
  const verb = outcome.dryRun ? "would import" : "imported";
  const parts = [`${outcome.importedCount} session(s)`, `${outcome.eventTotal} events`];
  if (outcome.replacedCount > 0) parts.push(`${outcome.replacedCount} replaced`);
  if (outcome.skippedAlreadyImported > 0)
    parts.push(`${outcome.skippedAlreadyImported} already imported`);
  return `${outcome.adapter}: ${verb} ${parts.join(", ")}`;
}

function printRefreshSummary(result: RefreshResult): void {
  console.log(describeImport(result.claudeCode));
  console.log(describeImport(result.codex));
  if (result.handoff.status === "generated") {
    console.log(
      `handoff: regenerated (sessions: ${result.handoff.sessionCount}, decisions: ${result.handoff.decisionCount})`,
    );
  } else {
    console.log(`handoff: skipped (${result.handoff.reason})`);
  }
  if (result.decisions.status === "generated") {
    console.log(`decisions: regenerated (${result.decisions.decisionCount})`);
  } else {
    console.log(`decisions: skipped (${result.decisions.reason})`);
  }
}

async function resolveRepositoryRootForRefresh(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou refresh'.", {
        cause: error,
      });
    }
    throw error;
  }
}

async function assertWorkspaceInitialized(basouRoot: string): Promise<void> {
  try {
    await assertBasouRootSafe(basouRoot);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Workspace not initialized. Run 'basou init' first.");
    }
    throw error;
  }
}
