import {
  assertBasouRootSafe,
  basouPaths,
  computeWorkStats,
  findErrorCode,
  resolveRepositoryRoot,
  type SourceWorkStats,
  type WorkStatsResult,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  renderCliError,
} from "../lib/error-render.js";
import { formatDurationMs } from "../lib/format-duration.js";

export type StatsOptions = {
  json?: boolean;
  bySource?: boolean;
  verbose?: boolean;
};

export type StatsContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Register `basou stats`: an honest "how much did the AI work" report. It
 * leads with output VOLUME (tokens + action counts), which is the most direct
 * signal, and reports TIME measures as labeled proxies.
 */
export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Report how much the AI worked (output volume + time proxies) across sessions")
    .option("--by-source", "Break the totals down by session source kind")
    .option("--json", "Output the full stats as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: StatsOptions) => {
      await runStats(options);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunStats}. */
export async function runStats(options: StatsOptions, ctx: StatsContext = {}): Promise<void> {
  try {
    await doRunStats(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Pure runner: resolve the workspace, aggregate, and print (text or JSON). */
export async function doRunStats(options: StatsOptions, ctx: StatsContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForStats(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const now = ctx.nowProvider?.() ?? new Date();
  const result = await computeWorkStats({
    paths,
    now,
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
  });

  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printStatsText(result, options.bySource === true);
}

function printStatsText(result: WorkStatsResult, bySource: boolean): void {
  const t = result.totals;
  const statusPart =
    result.byStatus.length > 0
      ? ` (${result.byStatus.map((s) => `${s.status} ${s.count}`).join(", ")})`
      : "";
  console.log(`Sessions: ${t.sessionCount}${statusPart}`);

  console.log("");
  console.log("Volume (what the AI produced):");
  const tokenSessions = result.sessions.filter((s) => s.availability.tokens).length;
  const tokenCaveat =
    t.tokensAvailable && tokenSessions < t.sessionCount
      ? `  (token data on ${tokenSessions} of ${t.sessionCount} sessions)`
      : t.tokensAvailable
        ? ""
        : "  (no token data captured; re-import to backfill)";
  console.log(`  Output tokens:     ${formatInt(t.tokens.output)}${tokenCaveat}`);
  if (t.tokens.reasoning > 0) {
    console.log(`  Reasoning tokens:  ${formatInt(t.tokens.reasoning)}  (Codex)`);
  }
  console.log(
    `  Actions:           ${t.commandCount} commands, ${t.fileChangedCount} files, ${t.decisionCount} decisions`,
  );

  console.log("");
  console.log("Time (proxies, not model compute):");
  const openPart = t.openSessionCount > 0 ? `; ${t.openSessionCount} open counted to now` : "";
  console.log(
    `  Active:   ${formatDurationMs(t.activeTimeMs)}  (heuristic: idle gaps > 5m excluded)`,
  );
  console.log(`  Span:     ${formatDurationMs(t.sessionSpanMs)}  (total elapsed${openPart})`);
  const cmdCaveat = t.commandTimeReliable
    ? ""
    : "; some sessions (e.g. claude-code-import) report 0 shell time";
  console.log(
    `  Command:  ${formatDurationMs(t.commandTimeMs)}  (real shell execution${cmdCaveat})`,
  );

  if (bySource && result.bySource.length > 0) {
    console.log("");
    console.log("By source:");
    for (const s of result.bySource) {
      console.log(`  ${s.sourceKind}: ${describeSource(s)}`);
    }
  }
}

function describeSource(s: SourceWorkStats): string {
  const cmd = s.commandTimeReliable ? formatDurationMs(s.commandTimeMs) : "n/a";
  const tokens = s.tokensAvailable ? `${formatInt(s.tokens.output)} out tok` : "no tokens";
  return `${s.sessionCount} sessions, ${tokens}, active ${formatDurationMs(s.activeTimeMs)}, command ${cmd}`;
}

/** "1,234,567" — thousands-separated, fixed en-US so output is deterministic. */
function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

async function resolveRepositoryRootForStats(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou stats'.", {
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
