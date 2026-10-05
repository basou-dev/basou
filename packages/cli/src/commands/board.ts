import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertBasouRootSafe,
  type BoardMeasurement,
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
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import { BASOU_BUILD, BASOU_CLI_VERSION } from "../program.js";

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
  const root = await resolveBasouRootForCommand(cwd, "board measure");
  const paths = basouPaths(root);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);

  const board = boardPath(options, cwd, root, manifest);
  const text = await readDeclaration(board);
  const parsed = parseBoardDeclaration(text, {
    manifestRepoPaths: (manifest.repos ?? []).map((repo) => repo.path),
  });
  if (!parsed.ok) {
    throw new Error(
      `${displayPath(board.shown)} is not a valid board declaration:\n${parsed.errors
        .map((e) => `  - ${displayPath(e)}`)
        .join("\n")}`,
    );
  }

  const measurement = await measureBoard({
    declaration: parsed.declaration,
    root,
    paths,
    now: ctx.nowProvider?.() ?? new Date(),
    measuredWith: { basou: BASOU_CLI_VERSION, build: BASOU_BUILD?.commit ?? null },
    onReplayWarning: (warning, sessionId) => printReplayWarning(warning, sessionId),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
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

function printMeasurementText(m: BoardMeasurement): void {
  const lines: string[] = [displayPath(m.title)];
  const build = m.measured_with.build === null ? "" : ` (build ${m.measured_with.build})`;
  lines.push(`Measured ${m.measured_at} with basou ${m.measured_with.basou}${build}`);
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
  if (m.not_found.length > 0) {
    lines.push("", `Not measured (${m.not_found.length}):`);
    for (const missing of m.not_found)
      lines.push(`  ${missing.at}: ${displayPath(missing.reason)}`);
  }
  lines.push("", `Complete: ${m.complete ? "yes" : "no"}`, `Digest: ${m.digest}`);
  console.log(lines.join("\n"));
}
