import { isAbsolute, resolve } from "node:path";
import {
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  renderReport,
  resolveRepositoryRoot,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  printTaskSkip,
  renderCliError,
} from "../lib/error-render.js";

export type ReportGenerateOptions = {
  out?: string;
  json?: boolean;
  title?: string;
  verbose?: boolean;
};

export type ReportContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou report generate` onto `program`. The `report` group is
 * registered up front so future subcommands (e.g. `show`) can slot under the
 * same group without breaking the CLI surface.
 */
export function registerReportCommand(program: Command): void {
  const report = program
    .command("report")
    .description(
      "Generate a work report — a shareable export explaining the work in this workspace",
    );

  report
    .command("generate")
    .description("Generate a work report from the current workspace state")
    .option("--out <path>", "Write the markdown report to a file instead of stdout")
    .option("--json", "Emit the structured report data as JSON to stdout")
    .option("--title <text>", "Subject line shown in the report header")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ReportGenerateOptions) => {
      await runReportGenerate(opts);
    });
}

/**
 * Programmatic entry that owns `process.exitCode`. A successful render always
 * exits 0 — integrity verdicts inside the report (`unchained` / `tampered`) are
 * informational and never fail the command (unlike `basou verify`). Only real
 * operational failures set a non-zero exit. [Codex #8]
 */
export async function runReportGenerate(
  options: ReportGenerateOptions,
  ctx: ReportContext = {},
): Promise<void> {
  try {
    await doRunReportGenerate(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `report generate`. Throws on any failure with a pathless
 * message; native errors are attached as `cause` for verbose surfacing.
 *
 * Output contract:
 * - default → markdown body to stdout.
 * - `--json` → structured data as JSON to stdout, JSON-only (pipe-safe).
 * - `--out <path>` → write the markdown body to the file; a one-line summary
 *   goes to stderr (never stdout) so `--out` composes with `--json`.
 */
export async function doRunReportGenerate(
  options: ReportGenerateOptions,
  ctx: ReportContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForReport(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const result = await renderReport({
    paths,
    nowIso,
    ...(options.title !== undefined ? { title: options.title } : {}),
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
  });

  if (options.out !== undefined) {
    const outPath = isAbsolute(options.out) ? options.out : resolve(cwd, options.out);
    await writeMarkdownFile(outPath, result.body);
    const { sessions, decisions, tasks } = result.data;
    // Confirmation on stderr (console.error) so stdout stays clean for `--json`.
    console.error(
      `Wrote report to ${options.out} (sessions: ${sessions.total}, decisions: ${decisions.count}, tasks: ${tasks.total})`,
    );
  }

  if (options.json === true) {
    console.log(JSON.stringify(result.data, null, 2));
  } else if (options.out === undefined) {
    console.log(result.body);
  }
}

async function resolveRepositoryRootForReport(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        "Not a git repository. Run 'git init' first, then re-run 'basou report generate'.",
        { cause: error },
      );
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
