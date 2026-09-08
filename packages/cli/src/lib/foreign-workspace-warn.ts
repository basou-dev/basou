import { scanForeignWorkspaceNames } from "@basou/core";
import { loadPortfolioConfig } from "./portfolio-config.js";

/**
 * The CLI half of foreign-workspace detection: read the portfolio registry and
 * scan a text basou is about to hand to an agent for the names of OTHER
 * registered workspaces.
 *
 * The scan is advisory and never blocks. Refusing to render a position or a
 * protocol block would stop `basou refresh` — the command the operator runs
 * many times a day — on prose they may have written deliberately; a warning
 * they can act on is the honest trade. The warning also names no workspace and
 * quotes no matched text: it reports WHERE to look, so the warning itself
 * cannot become the leak it is reporting.
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
  try {
    const workspaces = await loadPortfolioConfig(args.configPath);
    workspacePaths = workspaces.map((w) => w.path);
  } catch {
    return null;
  }

  const hits = scanForeignWorkspaceNames({
    text: args.text,
    workspacePaths,
    selfPath: args.selfPath,
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
 * The warning printed after a position was rendered. `where` is the file the
 * line numbers refer to, so the operator can open it and look.
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
 * The warning printed for the standing-protocol block. This one
 * is sharper than the position's: the block goes to the user-global
 * instructions file, so a name in it reaches every project on the machine.
 */
export function protocolForeignWorkspaceWarning(report: ForeignWorkspaceReport): string {
  const subject =
    report.workspaceCount === 1
      ? "names a registered workspace"
      : `names ${report.workspaceCount} registered workspaces`;
  return (
    `basou: the protocol block ${subject} ` +
    `(block ${describeForeignWorkspaceLines(report.lines)}). ` +
    "Standing protocols are written to the user-global CLAUDE.md, which every project on this machine loads, " +
    "so a workspace-specific name there reaches every workspace's sessions. Advisory only: nothing was withheld."
  );
}
