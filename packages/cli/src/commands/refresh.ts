import { assertBasouRootSafe, basouPaths, findErrorCode, resolveRepositoryRoot } from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { type ImportOutcome, type RefreshResult, refreshAll } from "../lib/provenance-actions.js";
import type { ImportContext } from "./import.js";
import {
  DEFAULT_WATCH_INTERVAL_SEC,
  MAX_WATCH_INTERVAL_SEC,
  MIN_WATCH_INTERVAL_SEC,
  runRefreshWatch,
} from "./refresh-watch.js";

export type RefreshOptions = {
  project?: string[];
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Run as a long-lived watcher: re-import when the native logs change. */
  watch?: boolean;
  /** Poll interval in seconds for `--watch` (default {@link DEFAULT_WATCH_INTERVAL_SEC}). */
  interval?: number;
  verbose?: boolean;
};

/** Commander collector: accumulate a repeatable option into an array. */
function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Commander parser: `--interval` is an integer count of seconds within the supported range. */
export function parseInterval(value: string): number {
  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_WATCH_INTERVAL_SEC ||
    seconds > MAX_WATCH_INTERVAL_SEC
  ) {
    throw new InvalidArgumentError(
      `--interval must be an integer between ${MIN_WATCH_INTERVAL_SEC} and ${MAX_WATCH_INTERVAL_SEC} (seconds).`,
    );
  }
  return seconds;
}

/** Resolve after `ms`, or early when `signal` aborts (e.g. on Ctrl-C). Leaves no listener behind. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
      "Source project path to import (repeatable; defaults to the manifest source roots, then the repository root)",
      collectPath,
      [],
    )
    .option("--force", "Re-import sessions already imported instead of skipping")
    .option("--dry-run", "Preview imports and skip writing handoff / decisions")
    .option("--json", "Output the result as JSON")
    .option(
      "--watch",
      "Keep running: re-import + regenerate when the native logs change (Ctrl-C to stop)",
    )
    .option(
      "--interval <seconds>",
      `Poll interval for --watch, in seconds (default ${DEFAULT_WATCH_INTERVAL_SEC}, min ${MIN_WATCH_INTERVAL_SEC})`,
      parseInterval,
    )
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
    if (options.watch === true) {
      await doRunRefreshWatch(options, ctx);
    } else {
      await doRunRefresh(options, ctx);
    }
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * `basou refresh --watch`: resolve + validate, then run the polling watcher
 * until SIGINT / SIGTERM. Startup failures (bad combo, no workspace, failed
 * initial refresh) propagate and exit non-zero; a steady-state cycle failure is
 * logged inside the loop and the watcher keeps running.
 */
export async function doRunRefreshWatch(
  options: RefreshOptions,
  ctx: RefreshContext,
): Promise<void> {
  if (options.dryRun === true) throw new Error("--watch cannot be combined with --dry-run.");
  if (options.json === true) throw new Error("--watch cannot be combined with --json.");
  if (options.force === true) throw new Error("--watch cannot be combined with --force.");

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForRefresh(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const intervalMs = (options.interval ?? DEFAULT_WATCH_INTERVAL_SEC) * 1000;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await runRefreshWatch({
      ctx,
      paths,
      intervalMs,
      importOptions:
        options.project !== undefined && options.project.length > 0
          ? { project: options.project }
          : {},
      now: () => ctx.nowProvider?.() ?? new Date(),
      signal: controller.signal,
      sleep: abortableSleep,
      log: (line) => console.log(line),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
      ...(options.project !== undefined && options.project.length > 0
        ? { project: options.project }
        : {}),
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
