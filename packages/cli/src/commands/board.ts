import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertBasouRootSafe,
  type BoardMeasurement,
  type BoardRepo,
  basouPaths,
  displayPath,
  findErrorCode,
  type Manifest,
  measureBoard,
  parseBoardDeclaration,
  readManifest,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printTaskSkip,
  renderCliError,
} from "../lib/error-render.js";
import { probeStaleness } from "../lib/provenance-actions.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import { BASOU_BUILD, BASOU_CLI_VERSION } from "../program.js";
import type { ImportContext } from "./import.js";

export type BoardMeasureOptions = {
  board?: string;
  json?: boolean;
  verbose?: boolean;
};

export type BoardContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
  /**
   * The portfolio config, read both to find a member repo's master and for
   * the portfolio section. Defaults to `~/.basou/portfolio.yaml`. Injectable
   * for tests.
   */
  portfolioConfigPath?: string;
  /** Defaults to `~/.claude/projects`. Injectable for tests. */
  claudeProjectsDir?: string;
  /** Defaults to `~/.codex/sessions`. Injectable for tests. */
  codexSessionsDir?: string;
};

/** Where a board's declaration is read from when `--board` is not given. */
export const DEFAULT_BOARD_PATH = "board/board.yaml";

/**
 * Register `basou board`, the progress board of a workspace: a declaration
 * file (`board.yaml`) saying what to measure, and the commands that measure
 * it. Experimental (docs/spec/compatibility.md lists it): its flags, output
 * and files may change at any release.
 */
export function registerBoardCommand(program: Command): void {
  const board = program
    .command("board")
    .description("Measure the progress board a workspace declares in board.yaml");
  board
    .command("measure")
    .description(
      "Measure what board.yaml declares and print the result (writes nothing, sends nothing)",
    )
    .option(
      "--board <path>",
      `The board.yaml to read (default: ${DEFAULT_BOARD_PATH} in the workspace, only when the manifest declares the workspace's own repo private)`,
    )
    .option("--json", "Output the measurement as JSON")
    .option("-v, --verbose", "Show error causes")
    .addHelpText(
      "after",
      `
Exit codes: 0 when everything was measured; 1 when something could not be
measured (the result is still printed, with null for what is missing and a
reason under not_found); 1 when the declaration or the manifest cannot be
read (nothing is printed on stdout).`,
    )
    .action(async (options: BoardMeasureOptions) => {
      await runBoardMeasure(options);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunBoardMeasure}. */
export async function runBoardMeasure(
  options: BoardMeasureOptions,
  ctx: BoardContext = {},
): Promise<void> {
  try {
    await doRunBoardMeasure(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Read the declaration, measure it and print the result. A declaration or
 * manifest that cannot be read throws before anything is printed; a
 * measurement with something missing is printed and sets exit code 1.
 */
export async function doRunBoardMeasure(
  options: BoardMeasureOptions,
  ctx: BoardContext,
): Promise<BoardMeasurement> {
  const cwd = ctx.cwd ?? process.cwd();
  const root = await resolveBasouRootForCommand(
    cwd,
    "board measure",
    ctx.portfolioConfigPath === undefined ? {} : { portfolioConfigPath: ctx.portfolioConfigPath },
  );
  const paths = basouPaths(root);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);

  const board = boardPath(options, cwd, root, manifest);
  const text = await readDeclaration(board);
  const repoPaths = (manifest.repos ?? []).map((repo) => repo.path);
  const parsed = parseBoardDeclaration(text, { manifestRepoPaths: repoPaths });
  if (!parsed.ok) {
    throw new Error(
      `${displayPath(board.shown)} is not a valid board declaration:\n${parsed.errors
        .map((e) => `  - ${displayPath(e)}`)
        .join("\n")}`,
    );
  }

  const now = ctx.nowProvider?.() ?? new Date();
  // The dry run `basou orient` runs to judge freshness: it reads the native
  // logs of this host and writes nothing.
  const probeCtx: ImportContext = { cwd: root };
  if (ctx.claudeProjectsDir !== undefined) probeCtx.claudeProjectsDir = ctx.claudeProjectsDir;
  if (ctx.codexSessionsDir !== undefined) probeCtx.codexSessionsDir = ctx.codexSessionsDir;
  const measurement = await measureBoard({
    declaration: parsed.declaration,
    root,
    repos: repoPaths,
    paths,
    now,
    measuredWith: { basou: BASOU_CLI_VERSION, build: BASOU_BUILD?.commit ?? null },
    onReplayWarning: (warning, sessionId) => printReplayWarning(warning, sessionId),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
    ...(ctx.portfolioConfigPath === undefined
      ? {}
      : { portfolioConfigPath: ctx.portfolioConfigPath }),
    probeImports: () => probeStaleness({ ctx: probeCtx, paths, nowIso: now.toISOString() }),
  });

  if (options.json === true) console.log(JSON.stringify(measurement, null, 2));
  else printMeasurementText(measurement);
  if (!measurement.complete) process.exitCode = 1;
  return measurement;
}

type BoardLocation = { path: string; shown: string };

// The default is used only when the manifest declares the workspace's own
// repo private: a measurement carries what the trail holds (open tracks,
// task counts), and a default must not lead it into a public history.
function boardPath(
  options: BoardMeasureOptions,
  cwd: string,
  root: string,
  manifest: Manifest,
): BoardLocation {
  if (options.board !== undefined)
    return { path: resolve(cwd, options.board), shown: options.board };
  const own = (manifest.repos ?? []).find((repo) => repo.path === ".");
  if (own?.visibility !== "private") {
    throw new Error(
      `No --board given, and the default ${DEFAULT_BOARD_PATH} is used only when the manifest declares this workspace's own repo (path: .) private. Pass --board <path to board.yaml>.`,
    );
  }
  return { path: join(root, DEFAULT_BOARD_PATH), shown: DEFAULT_BOARD_PATH };
}

async function readDeclaration(board: BoardLocation): Promise<string> {
  try {
    return await readFile(board.path, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error(`No board declaration at ${displayPath(board.shown)}.`, { cause: error });
    }
    if (findErrorCode(error, "EISDIR")) {
      throw new Error(`${displayPath(board.shown)} is a directory, not a board declaration.`, {
        cause: error,
      });
    }
    throw new Error(`Failed to read ${displayPath(board.shown)}.`, { cause: error });
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

function shownValue(value: number | string | null): string {
  if (value === null) return "not measured";
  if (typeof value === "number") return String(Math.round(value * 10000) / 10000);
  return displayPath(value);
}

// One line per repository. A null the not_found entries do not explain has
// the meaning the measurement gives it (a detached HEAD, no commit yet, no
// origin/main).
function repoLines(m: BoardMeasurement): string[] {
  const missing = new Set(m.not_found.map((n) => n.at));
  return m.repos.map((repo) => {
    const at = `repos[${repo.path}]`;
    if (missing.has(at)) return `  ${displayPath(repo.path)}  not measured`;
    const measured = (field: keyof BoardRepo, shown: (value: string | number) => string) => {
      const value = repo[field];
      if (value !== null) return shown(value);
      return missing.has(`${at}.${field}`) ? "not measured" : undefined;
    };
    const name = repo.name === null ? "" : ` (${displayPath(repo.name)})`;
    const branch = measured("branch", (b) => displayPath(String(b))) ?? "detached HEAD";
    const head = measured("head", (h) => String(h).slice(0, 7)) ?? "no commit yet";
    const parts = [
      `${branch} at ${head}`,
      `last commit ${measured("last_commit", String) ?? "none"}`,
      `commits ${measured("commits", String) ?? "not measured"}`,
      `files ${measured("files", String) ?? "not measured"}`,
      `uncommitted ${measured("uncommitted", String) ?? "not measured"}`,
      `behind origin/main ${measured("behind_main", String) ?? "(no origin/main)"}`,
    ];
    return `  ${displayPath(repo.path)}${name}  ${parts.join(", ")}`;
  });
}

function trailLines(m: BoardMeasurement): string[] {
  const { decisions_all, decisions_live, tracks_open } = m.trail;
  if (decisions_all === null || decisions_live === null || tracks_open === null) {
    return ["  not measured"];
  }
  const lines = [
    `  decisions ${decisions_all} (live ${decisions_live})`,
    `  open tracks ${tracks_open.length}`,
  ];
  for (const track of tracks_open) lines.push(`    ${track.id}  ${displayPath(track.title)}`);
  return lines;
}

function integrityLines(m: BoardMeasurement): string[] {
  const { by_status, not_verified } = m.integrity;
  if (by_status === null || not_verified === null) return ["  not measured"];
  const counts = Object.entries(by_status);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return [
    `  sessions ${total}: ${counts.map(([status, count]) => `${count} ${status}`).join(", ")}`,
    `  not verified ${not_verified}`,
  ];
}

function reviewGapsLines(m: BoardMeasurement): string[] {
  const { by_verdict, gaps } = m.review_gaps;
  if (by_verdict === null || gaps === null) return ["  not measured"];
  const counts = Object.entries(by_verdict);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return [
    `  units ${total}: ${counts.map(([verdict, count]) => `${count} ${verdict}`).join(", ")}`,
    `  gaps ${gaps}`,
  ];
}

// A null the not_found entries do not explain means there is no portfolio
// config.
function portfolioLines(m: BoardMeasurement): string[] {
  const { workspaces, initialized } = m.portfolio;
  if (workspaces === null || initialized === null) {
    return m.not_found.some((n) => n.at === "portfolio")
      ? ["  not measured"]
      : ["  no ~/.basou/portfolio.yaml"];
  }
  return [`  workspaces ${workspaces} (initialized ${initialized})`];
}

function freshnessLines(m: BoardMeasurement): string[] {
  const missing = new Set(m.not_found.map((n) => n.at));
  const { newest_session_at: newest, unimported } = m.freshness;
  const shownNewest =
    newest !== null
      ? displayPath(newest)
      : missing.has("freshness.newest_session_at")
        ? "not measured"
        : "none";
  const shownUnimported =
    unimported === null
      ? "not measured"
      : `${unimported.new} new, ${unimported.updated} updated, ${unimported.unverifiable} unverifiable`;
  return [`  newest session ${shownNewest}`, `  not imported ${shownUnimported}`];
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function effortLines(m: BoardMeasurement): string[] {
  const e = m.effort;
  if (e.time_zone === null || e.elapsed_days === null || e.commits === null) {
    return [`  from ${e.start}, not measured`];
  }
  const { union, claude, codex } = e.active_ms;
  const shownCodex =
    codex !== null ? hours(codex) : union === null ? "not measured" : "no Codex session";
  const time =
    union === null || claude === null
      ? "active not measured"
      : `active ${hours(union)}: Claude ${hours(claude)}, Codex ${shownCodex}`;
  const tokens =
    e.output_tokens === null
      ? "output tokens not measured"
      : `output tokens ${e.output_tokens}, ${e.sessions_without_tokens ?? 0} session${e.sessions_without_tokens === 1 ? "" : "s"} recorded none`;
  const commits = Object.entries(e.commits).map(
    ([path, n]) => `${displayPath(path)} ${n ?? "not measured"}`,
  );
  return [
    `  from ${e.start} (${displayPath(e.time_zone)}), ${e.elapsed_days} day${e.elapsed_days === 1 ? "" : "s"}`,
    `  ${time}`,
    `  ${tokens}`,
    `  commits${commits.length === 0 ? " none" : `: ${commits.join(", ")}`}`,
  ];
}

function componentLines(m: BoardMeasurement): string[] {
  const { found, unacknowledged, gone } = m.components;
  if (found === null || unacknowledged === null || gone === null) return ["  not measured"];
  const lines = [
    `  ${Object.keys(found).length} found, ${unacknowledged.length} unacknowledged, ${gone.length} gone`,
  ];
  for (const [key, component] of Object.entries(found)) {
    const flag = component.status === "unacknowledged" ? "  (unacknowledged)" : "";
    lines.push(`    ${displayPath(key)}  ${component.kinds.join(", ")}${flag}`);
  }
  for (const key of gone) lines.push(`    ${displayPath(key)}  (gone)`);
  return lines;
}

function printMeasurementText(m: BoardMeasurement): void {
  const lines: string[] = [displayPath(m.title)];
  const build = m.measured_with.build === null ? "" : ` (build ${m.measured_with.build})`;
  lines.push(`Measured ${m.measured_at} with basou ${m.measured_with.basou}${build}`);
  if (m.repos.length > 0) lines.push("", "Repos:", ...repoLines(m));
  const measures = Object.entries(m.measures);
  if (measures.length > 0) {
    const width = Math.max(...measures.map(([id]) => id.length));
    lines.push("", "Measures:");
    for (const [id, measure] of measures) {
      const unit = measure.value === null ? "" : ` ${displayPath(measure.unit)}`;
      const lane = measure.lane === undefined ? "" : `  [${measure.lane}]`;
      lines.push(`  ${id.padEnd(width)}  ${shownValue(measure.value)}${unit}${lane}`);
    }
  }
  const ratios = Object.entries(m.ratios);
  if (ratios.length > 0) {
    const width = Math.max(...ratios.map(([id]) => id.length));
    lines.push("", "Ratios:");
    for (const [id, ratio] of ratios) {
      lines.push(
        `  ${id.padEnd(width)}  ${shownValue(ratio.value)}  (${ratio.numerator} / ${ratio.denominator})`,
      );
    }
  }
  lines.push("", "Trail:", ...trailLines(m));
  lines.push("", "Integrity:", ...integrityLines(m));
  lines.push("", "Review gaps:", ...reviewGapsLines(m));
  lines.push("", "Portfolio:", ...portfolioLines(m));
  lines.push("", "Freshness:", ...freshnessLines(m));
  lines.push("", "Effort:", ...effortLines(m));
  lines.push("", "Components:", ...componentLines(m));
  if (m.not_found.length > 0) {
    lines.push("", `Not measured (${m.not_found.length}):`);
    for (const missing of m.not_found)
      lines.push(`  ${missing.at}: ${displayPath(missing.reason)}`);
  }
  lines.push("", `Complete: ${m.complete ? "yes" : "no"}`, `Digest: ${m.digest}`);
  console.log(lines.join("\n"));
}
