import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  assertBasouRootSafe,
  type BasouPaths,
  type BoardCellChange,
  type BoardDeclaration,
  type BoardDiff,
  type BoardLiveMeasurement,
  type BoardMeasurement,
  type BoardNotFound,
  type BoardObservation,
  type BoardObservedChange,
  type BoardOrderAnomaly,
  type BoardPreviousRecords,
  type BoardRepo,
  basouPaths,
  buildRecord,
  byCodePoint,
  diffCells,
  diffObserved,
  displayPath,
  findErrorCode,
  type Manifest,
  measureBoard,
  measureBoardLive,
  NO_PREVIOUS_RECORDS,
  parseBoardDeclaration,
  parseRecordInput,
  readManifest,
  readPreviousRecords,
  writeRecord,
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
  /** The model that will judge the board, for trigger (c) of the axis. */
  model?: string;
  verbose?: boolean;
};

export type BoardRecordOptions = {
  board?: string;
  /** Read the record's input from this file; `-`, or none, reads stdin. */
  file?: string;
  dryRun?: boolean;
  /** Record even where no repo the manifest declares private holds the records. */
  notPrivate?: boolean;
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
  /**
   * Defaults to reading process.stdin to EOF. Injectable for tests so they do
   * not depend on a real stdin stream. Ignored when `--file` names a file.
   */
  readInput?: () => Promise<string>;
};

/** Where a board's declaration is read from when `--board` is not given. */
export const DEFAULT_BOARD_PATH = "board/board.yaml";

/**
 * Register `basou board`, the progress board of a workspace: a declaration
 * file (`board.yaml`) saying what to measure, and the commands that measure
 * it and record it with a judgement. Experimental (docs/spec/compatibility.md lists it): its flags, output
 * and files may change at any release.
 */
export function registerBoardCommand(program: Command): void {
  const board = program
    .command("board")
    .description("Measure and record the progress board a workspace declares in board.yaml");
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
    .option(
      "--model <name>",
      "The model that will judge the board, to tell whether it is not the one that reviewed the axis last",
    )
    .option("-v, --verbose", "Show error causes")
    .addHelpText(
      "after",
      `
For a board.yaml, the last record in the records/ beside it is the previous
one, and the result says what moved since it.

Exit codes: 0 when everything was measured; 1 when something could not be
measured (the result is still printed, with null for what is missing and a
reason under not_found); 1 when the declaration or the manifest cannot be
read (nothing is printed on stdout).`,
    )
    .action(async (options: BoardMeasureOptions) => {
      await runBoardMeasure(options);
    });
  board
    .command("record")
    .description(
      "Measure the board again and record it with a judgement of it, in records/ beside board.yaml",
    )
    .option(
      "--board <path>",
      `The board.yaml to read, a file of that name (default: ${DEFAULT_BOARD_PATH} in the workspace, only when the manifest declares the workspace's own repo private)`,
    )
    .option("--file <path>", "Read the record's input (JSON) from a file; - or none reads stdin")
    .option("--dry-run", "Check the input and measure again, but write nothing")
    .option(
      "--not-private",
      "Record even when no repo the manifest declares private holds records/ (a record holds what the trail holds)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .addHelpText(
      "after",
      `
The input is a JSON object: measure_digest (the digest of the measurement the
judgement saw), observed (exactly the observations the board declares, when it
declares any), cells (every lane at every stage), prose, judged_by and
axis_review. The board is measured again, and nothing is written when the
digest differs. Records are never written under a .basou/ directory. Exit
codes: 0 when the record was written, or with --dry-run when everything
checked out (nothing is written then); 1 when it was refused (nothing is
written; the reasons are on stderr).`,
    )
    .action(async (options: BoardRecordOptions) => {
      await runBoardRecord(options);
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
  if (options.model !== undefined && options.model.trim() === "") {
    throw new Error("--model must name a model.");
  }
  const loaded = await loadBoard(options, ctx, "board measure");
  const measurement = await measureLoaded(loaded, ctx, options.model, await previousOf(loaded));
  if (options.json === true) console.log(JSON.stringify(measurement, null, 2));
  else printMeasurementText(measurement, hasRecords(loaded));
  if (!measurement.complete) process.exitCode = 1;
  return measurement;
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunBoardRecord}. */
export async function runBoardRecord(
  options: BoardRecordOptions,
  ctx: BoardContext = {},
): Promise<void> {
  try {
    await doRunBoardRecord(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** What `basou board record` reports when it is not refused. */
export type BoardRecordResult = {
  /**
   * Where the record was written: beside the --board given, as given, or
   * else from the current directory (null with --dry-run).
   */
  record: string | null;
  dry_run: boolean;
  /** Whether the measurement recorded was complete. */
  complete: boolean;
  /** What the measurement recorded could not measure, and why. */
  not_found: BoardNotFound[];
  order_anomalies: BoardOrderAnomaly[];
  /**
   * What moved since the previous record: in the measurement, the cells and
   * the observations. Null when there is no previous record, or when it
   * cannot be read (`not_found` then says why, at `diff`).
   */
  diff: {
    against: string;
    measure: Omit<BoardDiff, "against">;
    cells: BoardCellChange[];
    observed: BoardObservedChange[];
  } | null;
};

// A refusal of `basou board record` that says nothing was written.
class RecordRefusal extends Error {}

/**
 * Check where the record goes and the input against the declaration, measure
 * the board again with the judge's model, and write the record when the
 * digest is the one the judgement saw. Anything refused throws, saying that
 * nothing was written.
 */
export async function doRunBoardRecord(
  options: BoardRecordOptions,
  ctx: BoardContext,
): Promise<BoardRecordResult> {
  let result: BoardRecordResult;
  try {
    result = await checkAndRecord(options, ctx);
  } catch (error: unknown) {
    if (error instanceof RecordRefusal || !(error instanceof Error)) throw error;
    throw new RecordRefusal(`${error.message}\nNothing was written.`, { cause: error.cause });
  }
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else printRecordText(result);
  return result;
}

async function checkAndRecord(
  options: BoardRecordOptions,
  ctx: BoardContext,
): Promise<BoardRecordResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const loaded = await loadBoard(options, ctx, "board record");
  const beside = (...parts: string[]) =>
    loaded.board.given
      ? join(dirname(loaded.board.shown), ...parts)
      : relative(cwd, join(dirname(loaded.board.path), ...parts));
  const recordsDir = join(dirname(loaded.board.path), "records");
  await checkRecordsPlace(loaded, recordsDir, beside("records"), options.notPrivate === true);

  const text = await readRecordInput(options, ctx);
  // A key given twice keeps its last, as JSON.parse reads it.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new RecordRefusal("The record's input is not valid JSON; nothing was written.", {
      cause: error,
    });
  }
  const parsed = parseRecordInput(value, loaded.declaration);
  if (!parsed.ok) {
    throw new RecordRefusal(
      `The record's input was refused; nothing was written:\n${parsed.errors
        .map((e) => `  - ${displayPath(e)}`)
        .join("\n")}`,
    );
  }
  const recordedAt = ctx.nowProvider?.() ?? new Date();
  const previous = await previousOf(loaded);
  const measurement = await measureLoaded(loaded, ctx, parsed.input.judged_by.model, previous);
  if (measurement.digest !== parsed.input.measure_digest) {
    throw new RecordRefusal(
      `measure_digest is ${parsed.input.measure_digest}, but the board measures ${measurement.digest} now: something it measures moved since the judgement, or basou was rebuilt or upgraded since that measurement. Measure again and judge that; nothing was written.`,
    );
  }
  const record = buildRecord({
    declaration: loaded.declaration,
    measurement,
    recordInput: parsed.input,
    recordedAt,
    recordedWith: { basou: BASOU_CLI_VERSION, build: BASOU_BUILD?.commit ?? null },
  });
  let written: string | null = null;
  if (options.dryRun !== true) {
    let name: string;
    try {
      name = await writeRecord(recordsDir, record);
    } catch (error: unknown) {
      const code = errorCode(error);
      throw new RecordRefusal(
        `The record could not be written${code === undefined ? "" : ` (${code})`}; nothing was written.`,
        { cause: error },
      );
    }
    written = beside("records", name);
  }
  const { last } = previous;
  let diff: BoardRecordResult["diff"] = null;
  if (measurement.diff !== null && last.status === "found") {
    const { against, ...moved } = measurement.diff;
    diff = {
      against,
      measure: moved,
      cells: diffCells(last.record.cells, parsed.input.cells),
      observed: diffObserved(last.record.observed, parsed.input.observed),
    };
  }
  return {
    record: written,
    dry_run: options.dryRun === true,
    complete: measurement.complete,
    not_found: measurement.not_found,
    order_anomalies: record.order_anomalies,
    diff,
  };
}

// Only a file named board.yaml has records: one board a records/ directory.
function hasRecords(loaded: LoadedBoard): boolean {
  return basename(loaded.board.path) === "board.yaml";
}

async function previousOf(loaded: LoadedBoard): Promise<BoardPreviousRecords> {
  return hasRecords(loaded)
    ? readPreviousRecords(join(dirname(loaded.board.path), "records"))
    : NO_PREVIOUS_RECORDS;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

// Where records go, checked before the input is read, with --dry-run too: the
// records/ beside a file named board.yaml (one board a directory), never under
// a .basou/ directory, and, unless --not-private, inside a repo the manifest
// declares private, since a record holds what the trail holds.
async function checkRecordsPlace(
  loaded: LoadedBoard,
  recordsDir: string,
  shown: string,
  notPrivate: boolean,
): Promise<void> {
  const { board } = loaded;
  if (basename(board.path) !== "board.yaml") {
    throw new RecordRefusal(
      `${displayPath(board.shown)} is not named board.yaml: basou board record reads only a file of that name, so that the records/ beside it holds one board's records; nothing was written.`,
    );
  }
  let dir: string;
  try {
    dir = await realpath(dirname(board.path));
  } catch (error: unknown) {
    throw new RecordRefusal(
      `The directory of ${displayPath(board.shown)} could not be resolved; nothing was written.`,
      { cause: error },
    );
  }
  if (dir.split(sep).includes(".basou")) {
    throw new RecordRefusal(
      `${displayPath(shown)} would be under a .basou/ directory, where basou board record writes nothing; nothing was written.`,
    );
  }
  if (!notPrivate) {
    let holder: { real: string; private: boolean } | undefined;
    for (const repo of loaded.manifest.repos ?? []) {
      const real = await realpath(resolve(loaded.root, repo.path)).catch(() => undefined);
      if (real === undefined || (dir !== real && !dir.startsWith(`${real}${sep}`))) continue;
      // The innermost repo holds it.
      if (holder === undefined || real.length > holder.real.length) {
        holder = { real, private: repo.visibility === "private" };
      }
    }
    if (holder?.private !== true) {
      throw new RecordRefusal(
        `${displayPath(shown)} is not in a repo the manifest declares private, and a record holds what the trail holds (open tracks, time worked, model names). Pass --not-private to record there anyway; nothing was written.`,
      );
    }
  }
  try {
    const entry = await lstat(recordsDir);
    if (!entry.isDirectory()) {
      throw new RecordRefusal(
        `${displayPath(shown)} is not a directory (a symlink or a file); nothing was written.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof RecordRefusal) throw error;
    if (!findErrorCode(error, "ENOENT")) {
      const code = errorCode(error);
      throw new RecordRefusal(
        `${displayPath(shown)} could not be looked at${code === undefined ? "" : ` (${code})`}; nothing was written.`,
        { cause: error },
      );
    }
  }
}

function printRecordText(result: BoardRecordResult): void {
  const lines = [
    result.record === null
      ? "Dry run: the record checked out (nothing was written)."
      : `Recorded ${displayPath(result.record)}`,
  ];
  // What moved comes first, after where the record is.
  if (result.diff === null) {
    lines.push(
      result.not_found.some((n) => n.at === "diff")
        ? "The previous record could not be read, so nothing is compared with it."
        : "Not compared with a previous record.",
    );
  } else {
    const { cells, observed } = result.diff;
    lines.push(`Since the previous record ${result.diff.against}:`);
    for (const c of cells) {
      lines.push(
        `  ${displayPath(c.lane)} ${displayPath(c.stage)}: ${displayPath(c.before ?? "no cell")} -> ${displayPath(c.after ?? "no cell")}`,
      );
    }
    for (const o of observed) {
      lines.push(
        `  observed ${displayPath(o.name)}: ${observation(o.before)} -> ${observation(o.after)}`,
      );
    }
    lines.push(...diffLines(result.diff.measure, cells.length + observed.length > 0));
  }
  if (!result.complete) {
    lines.push(`The measurement recorded is not complete (${result.not_found.length}):`);
    for (const missing of result.not_found) {
      lines.push(`  ${displayPath(missing.at)}: ${displayPath(missing.reason)}`);
    }
  }
  if (result.order_anomalies.length > 0) {
    lines.push(`Order anomalies (${result.order_anomalies.length}):`);
    for (const a of result.order_anomalies) {
      lines.push(
        `  ${displayPath(a.lane)} ${a.stage} is ${a.state} before ${a.before}, which is done or begun`,
      );
    }
  }
  console.log(lines.join("\n"));
}

const NO_RECORD_INPUT = "No input: pipe the record's JSON to stdin or pass --file <path>.";

async function readRecordInput(options: BoardRecordOptions, ctx: BoardContext): Promise<string> {
  let text: string;
  if (options.file !== undefined && options.file !== "-") {
    try {
      text = await readFile(options.file, "utf8");
    } catch (error: unknown) {
      if (findErrorCode(error, "ENOENT")) {
        throw new Error(`Input file not found: ${displayPath(options.file)}`, { cause: error });
      }
      throw new Error(`Failed to read ${displayPath(options.file)}.`, { cause: error });
    }
  } else if (ctx.readInput !== undefined) {
    text = await ctx.readInput();
  } else {
    // A bare invocation with no piped stdin would otherwise block forever.
    if (process.stdin.isTTY === true) throw new Error(NO_RECORD_INPUT);
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (text.trim() === "") throw new Error(NO_RECORD_INPUT);
  return text;
}

type LoadedBoard = {
  root: string;
  paths: BasouPaths;
  manifest: Manifest;
  repoPaths: string[];
  board: BoardLocation;
  declaration: BoardDeclaration;
};

// Find the workspace and read the board's declaration, or throw before
// anything is printed.
async function loadBoard(
  options: { board?: string },
  ctx: BoardContext,
  command: string,
): Promise<LoadedBoard> {
  const cwd = ctx.cwd ?? process.cwd();
  const root = await resolveBasouRootForCommand(
    cwd,
    command,
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
  return { root, paths, manifest, repoPaths, board, declaration: parsed.declaration };
}

async function measureLoaded(
  loaded: LoadedBoard,
  ctx: BoardContext,
  model: string | undefined,
  previous: BoardPreviousRecords,
): Promise<BoardMeasurement> {
  const { root, paths } = loaded;
  const now = ctx.nowProvider?.() ?? new Date();
  // The dry run `basou orient` runs to judge freshness: it reads the native
  // logs of this host and writes nothing.
  const probeCtx: ImportContext = { cwd: root };
  if (ctx.claudeProjectsDir !== undefined) probeCtx.claudeProjectsDir = ctx.claudeProjectsDir;
  if (ctx.codexSessionsDir !== undefined) probeCtx.codexSessionsDir = ctx.codexSessionsDir;
  return measureBoard({
    declaration: loaded.declaration,
    root,
    repos: loaded.repoPaths,
    paths,
    now,
    measuredWith: { basou: BASOU_CLI_VERSION, build: BASOU_BUILD?.commit ?? null },
    onReplayWarning: (warning, sessionId) => printReplayWarning(warning, sessionId),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
    ...(ctx.portfolioConfigPath === undefined
      ? {}
      : { portfolioConfigPath: ctx.portfolioConfigPath }),
    probeImports: () => probeStaleness({ ctx: probeCtx, paths, nowIso: now.toISOString() }),
    ...(model === undefined ? {} : { model }),
    previous,
  });
}

/**
 * Measure what the workspace at `root` shows with no board declared, for the
 * board page of `basou view`: the built-in sections that need nothing from a
 * declaration, over the repos the manifest declares (the workspace's own repo
 * alone when it declares none, or cannot be read). Writes nothing, sends
 * nothing, and runs no import: the sessions not yet imported are counted by
 * the dry run `basou orient` runs.
 */
export async function measureLiveBoard(
  root: string,
  ctx: BoardContext,
): Promise<BoardLiveMeasurement> {
  const paths = basouPaths(root);
  let repos: string[] = ["."];
  let manifestUnread = false;
  try {
    const declared = ((await readManifest(paths)).repos ?? []).map((repo) => repo.path);
    if (declared.length > 0) repos = declared;
  } catch {
    manifestUnread = true;
  }
  const now = ctx.nowProvider?.() ?? new Date();
  const probeCtx: ImportContext = { cwd: root };
  if (ctx.claudeProjectsDir !== undefined) probeCtx.claudeProjectsDir = ctx.claudeProjectsDir;
  if (ctx.codexSessionsDir !== undefined) probeCtx.codexSessionsDir = ctx.codexSessionsDir;
  const measured = await measureBoardLive({
    root,
    repos,
    paths,
    now,
    measuredWith: { basou: BASOU_CLI_VERSION, build: BASOU_BUILD?.commit ?? null },
    probeImports: () => probeStaleness({ ctx: probeCtx, paths, nowIso: now.toISOString() }),
  });
  if (!manifestUnread) return measured;
  return {
    ...measured,
    complete: false,
    not_found: [
      {
        at: "repos",
        reason: "the manifest could not be read, so only the workspace's own repo was measured",
      },
      ...measured.not_found,
    ],
  };
}

/** Where a board.yaml is, how to show it, and whether --board gave it. */
type BoardLocation = { path: string; shown: string; given: boolean };

// The default is used only when the manifest declares the workspace's own
// repo private: a measurement carries what the trail holds (open tracks,
// task counts), and a default must not lead it into a public history.
function boardPath(
  options: { board?: string },
  cwd: string,
  root: string,
  manifest: Manifest,
): BoardLocation {
  if (options.board !== undefined)
    return { path: resolve(cwd, options.board), shown: options.board, given: true };
  const own = (manifest.repos ?? []).find((repo) => repo.path === ".");
  if (own?.visibility !== "private") {
    throw new Error(
      `No --board given, and the default ${DEFAULT_BOARD_PATH} is used only when the manifest declares this workspace's own repo (path: .) private. Pass --board <path to board.yaml>.`,
    );
  }
  return { path: join(root, DEFAULT_BOARD_PATH), shown: DEFAULT_BOARD_PATH, given: false };
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

// A value of a diff as text: a number rounded as the summary rounds it, anything
// else as JSON.
function shownJson(value: unknown): string {
  if (typeof value === "number") return shownValue(value);
  return displayPath(JSON.stringify(value) ?? "undefined");
}

function observation(o: BoardObservation | null): string {
  if (o === null) return "not observed";
  return o.error === undefined
    ? shownJson(o.value)
    : `${shownJson(o.value)} (${displayPath(o.error)})`;
}

// The lines of what moved in a measurement; `more` says whether other lines
// of the same diff came before them.
function diffLines(diff: Omit<BoardDiff, "against">, more: boolean): string[] {
  const lines: string[] = [];
  if (diff.methods.length > 0) {
    const moved = diff.methods.map(
      (m) => `${displayPath(m.section)} ${m.before ?? "none"} -> ${m.after ?? "none"}`,
    );
    lines.push(`  methods changed: ${moved.join(", ")}`);
  }
  const flag = (c: { method_changed?: true }) =>
    c.method_changed === true ? "  (its method changed)" : "";
  for (const c of diff.values) {
    const delta = c.delta === undefined ? "" : ` (${c.delta > 0 ? "+" : ""}${shownValue(c.delta)})`;
    lines.push(
      `  ${displayPath(c.at)}: ${shownJson(c.before)} -> ${shownJson(c.after)}${delta}${flag(c)}`,
    );
  }
  for (const c of diff.added)
    lines.push(`  + ${displayPath(c.at)}: ${shownJson(c.value)}${flag(c)}`);
  for (const c of diff.removed) {
    lines.push(`  - ${displayPath(c.at)}: ${shownJson(c.value)}${flag(c)}`);
  }
  if (lines.length === 0 && !more) lines.push("  nothing moved");
  return lines;
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
  if (found === null || unacknowledged === null) return ["  not measured"];
  const lines = [
    `  ${Object.keys(found).length} found, ${unacknowledged.length} unacknowledged, ${gone === null ? "gone not known" : `${gone.length} gone`}`,
  ];
  const sorted = Object.entries(found).sort(([a], [b]) => byCodePoint(a, b));
  for (const [key, component] of sorted) {
    const flag = component.status === "unacknowledged" ? "  (unacknowledged)" : "";
    lines.push(`    ${displayPath(key)}  ${component.kinds.join(", ")}${flag}`);
  }
  for (const key of gone ?? []) lines.push(`    ${displayPath(key)}  (gone)`);
  return lines;
}

function axisLines(m: BoardMeasurement): string[] {
  const a = m.axis;
  const last =
    a.last_review === null
      ? "no review on record"
      : `last reviewed ${a.last_review.date} by ${displayPath(a.last_review.model)} (${a.last_review.from})`;
  const needed = a.review_needed === null ? "not known" : a.review_needed ? "yes" : "no";
  const lines = [`  version ${a.version}, ${last}`, `  review needed: ${needed}`];
  for (const r of a.reasons) lines.push(`    (${r.trigger}) ${displayPath(r.detail)}`);
  for (const u of a.unjudged) lines.push(`    (${u.trigger}) not judged: ${u.why}`);
  return lines;
}

function printMeasurementText(m: BoardMeasurement, hasRecords: boolean): void {
  const lines: string[] = [displayPath(m.title)];
  const build = m.measured_with.build === null ? "" : ` (build ${m.measured_with.build})`;
  lines.push(`Measured ${m.measured_at} with basou ${m.measured_with.basou}${build}`);
  // What moved comes first: it is what a reader of the board looks for.
  if (m.diff !== null) {
    lines.push("", `Since the previous record ${m.diff.against}:`, ...diffLines(m.diff, false));
  } else if (m.not_found.some((n) => n.at === "diff")) {
    lines.push("", "The previous record could not be read (see Not measured).");
  } else {
    lines.push(
      "",
      hasRecords
        ? "No previous record to compare with."
        : "No records are read for a declaration not named board.yaml.",
    );
  }
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
  lines.push("", "Axis:", ...axisLines(m));
  if (m.not_found.length > 0) {
    lines.push("", `Not measured (${m.not_found.length}):`);
    for (const missing of m.not_found)
      lines.push(`  ${missing.at}: ${displayPath(missing.reason)}`);
  }
  lines.push("", `Complete: ${m.complete ? "yes" : "no"}`, `Digest: ${m.digest}`);
  console.log(lines.join("\n"));
}
