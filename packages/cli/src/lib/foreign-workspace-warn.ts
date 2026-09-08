import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { type BasouPaths, readMarkdownFile } from "@basou/core";
import { scanForeignWorkspaceNames } from "./foreign-workspace-scan.js";
import { loadPortfolioConfig } from "./portfolio-config.js";

/**
 * The CLI half of foreign-workspace detection: read the portfolio registry and
 * scan a text basou is about to hand to an agent for the names of OTHER
 * registered workspaces.
 *
 * On the commands a person runs, the scan is advisory and never blocks.
 * Refusing to render a position or a protocol block would stop `basou refresh`
 * — the command the operator runs many times a day — on prose they may have
 * written deliberately; a warning they can act on is the honest trade. The
 * warning also names no workspace and quotes no matched text: it reports WHERE
 * to look, so the warning itself cannot become the leak it is reporting. The
 * one automatic path, `basou hook session-start`, has no reader for a warning
 * and withholds the position instead.
 *
 * A missing, unreadable or empty registry yields `null` (silence): the scan is
 * a courtesy to an operator who registered several workspaces, not a
 * prerequisite for using basou with one.
 */

/** How many line numbers a warning spells out before summarizing the rest. */
const MAX_LISTED_LINES = 5;

/** What {@link findForeignWorkspaceNames} found: nothing is reported as `null`. */
export type ForeignWorkspaceReport = {
  /** Distinct registered workspaces (other than `selfPath`) named in the text. */
  workspaceCount: number;
  /** 1-based line numbers carrying one of those names, ascending. */
  lines: number[];
};

/**
 * Resolve a path through any symlink, falling back to the path itself. The
 * scanner matches lexically, so an aliased spelling would otherwise read as a
 * different workspace; `basou hook`'s registry check and the member-to-master
 * resolver both canonicalize the same way. A registry entry whose path no
 * longer exists still contributes its name, which is the useful behaviour: a
 * workspace that moved is exactly one whose old name is still in old records.
 */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Scan `text` for the names of registered workspaces other than `selfPath`.
 * Returns `null` when nothing was found or when the registry cannot be used —
 * the caller warns only on a non-null result. Never throws: a broken registry
 * must not fail the command it was advising.
 *
 * Pass no `selfPath` for a text that belongs to no single workspace (the
 * user-global protocol block): then every registered workspace counts.
 */
export async function findForeignWorkspaceNames(args: {
  text: string;
  selfPath?: string | undefined;
  configPath?: string | undefined;
}): Promise<ForeignWorkspaceReport | null> {
  let workspacePaths: string[];
  let selfPath: string | undefined;
  try {
    const workspaces = await loadPortfolioConfig(args.configPath);
    workspacePaths = await Promise.all(workspaces.map((w) => canonicalize(w.path)));
    selfPath = args.selfPath === undefined ? undefined : await canonicalize(args.selfPath);
  } catch {
    return null;
  }

  const hits = scanForeignWorkspaceNames({
    text: args.text,
    workspacePaths,
    selfPath,
  });
  if (hits.length === 0) return null;

  const lines = [...new Set(hits.flatMap((h) => h.lines))].sort((a, b) => a - b);
  return { workspaceCount: hits.length, lines };
}

/**
 * Render the line numbers for a warning: the first few spelled out, the rest
 * counted, with the noun agreeing with the count. A position can name another
 * workspace on many lines, and a warning that prints forty numbers is one
 * nobody finishes reading.
 */
export function describeForeignWorkspaceLines(lines: number[]): string {
  const listed = lines.slice(0, MAX_LISTED_LINES).join(", ");
  const rest = lines.length - MAX_LISTED_LINES;
  const numbers = rest > 0 ? `${listed} and ${rest} more` : listed;
  return `${lines.length === 1 ? "line" : "lines"} ${numbers}`;
}

/**
 * The warning printed after a position was rendered. `where` is the position
 * file's own path, spelled in full: one `basou refresh --portfolio` run scans
 * fifteen workspaces in a row, and a warning that says only
 * `.basou/orientation.md` names none of them. The path is the SCANNED
 * workspace's — the self, whose path this command already prints — never the
 * matched one.
 */
export function positionForeignWorkspaceWarning(
  report: ForeignWorkspaceReport,
  where: string,
): string {
  const subject =
    report.workspaceCount === 1
      ? "names another registered workspace"
      : `names ${report.workspaceCount} other registered workspaces`;
  return (
    `basou: this workspace's position ${subject} ` +
    `(${where}, ${describeForeignWorkspaceLines(report.lines)}). ` +
    "The position is handed to the agent session running in this workspace, so those names travel with it. " +
    "Advisory only: nothing was withheld."
  );
}

/**
 * The warning printed for the standing-protocol block, after a successful sync.
 * This one is sharper than the position's — the block goes to the user-global
 * instructions file, so a name in it reaches every project on the machine — and
 * it must say two things the position's does not: the line numbers count from
 * the block, not from the file (the block is written at an offset that depends
 * on what the operator already had there), and only basou's own block is
 * checked. The rest of that file is the operator's prose, which basou renders
 * nothing into and does not inspect.
 */
export function protocolForeignWorkspaceWarning(report: ForeignWorkspaceReport): string {
  const subject =
    report.workspaceCount === 1
      ? "names a registered workspace"
      : `names ${report.workspaceCount} registered workspaces`;
  return (
    `basou: the protocol block ${subject} ` +
    `(block ${describeForeignWorkspaceLines(report.lines)}, counted from the block's first line, not the file's). ` +
    "Standing protocols are written to the user-global CLAUDE.md, which every project on this machine loads, " +
    "so a workspace-specific name there reaches every workspace's sessions. " +
    "Only the basou-managed block is checked; the rest of that file is not basou's to inspect. " +
    "Advisory only: nothing was withheld."
  );
}

/**
 * Read back the position a caller just regenerated and warn if it names other
 * registered workspaces. For the writers that do not hold the rendered body —
 * `basou refresh` and the view server's refresh route — which is why it reads
 * the file instead of taking the text.
 *
 * Never throws and never changes the caller's outcome: a refresh that succeeded
 * must not be reported as failed because an advisory could not be computed.
 */
export async function warnIfPositionNamesOtherWorkspaces(args: {
  paths: BasouPaths;
  configPath?: string | undefined;
}): Promise<void> {
  try {
    const body = await readMarkdownFile(args.paths.files.orientation);
    if (body === null) return;
    const report = await findForeignWorkspaceNames({
      text: body,
      selfPath: dirname(args.paths.root),
      configPath: args.configPath,
    });
    if (report !== null) {
      console.error(positionForeignWorkspaceWarning(report, args.paths.files.orientation));
    }
  } catch {
    // Advisory only: never let the check itself fail the command it advises.
  }
}
