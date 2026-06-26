import {
  basouPaths,
  findReviewGaps,
  type ReviewGapsSummary,
  type ReviewGapUnit,
} from "@basou/core";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  renderCliError,
} from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import type { ImportContext } from "./import.js";

export type ReviewGapsOptions = {
  repo?: string[];
  window?: number;
  json?: boolean;
  verbose?: boolean;
};

export type ReviewGapsContext = ImportContext & {
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/** Commander collector: accumulate a repeatable `--repo` into an array. */
function collectRepo(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Commander parser: `--window` is a positive integer count of hours. */
export function parseWindow(value: string): number {
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new InvalidArgumentError("--window must be a positive integer (hours).");
  }
  return hours;
}

/**
 * Wire `basou review-gaps` onto `program`. A read-only, advisory check for the
 * "external adversarial review before commit" protocol: it surfaces units of
 * work that landed commits with NO bound cross-model (Codex) review trail. It
 * never claims a unit WAS reviewed — temporal proximity is not binding — so it
 * surfaces suspicion and leaves the final call to the operator. It writes
 * nothing and enforces nothing.
 */
export function registerReviewGapsCommand(program: Command): void {
  program
    .command("review-gaps")
    .description(
      "Surface units of work committed without a bound cross-model review trail (read-only, advisory)",
    )
    .option(
      "--repo <name>",
      "Restrict to a repo by name (repeatable; default: every repo with captured commits)",
      collectRepo,
      [],
    )
    .option(
      "--window <hours>",
      "Hours before a commit to look for a review (default 24)",
      parseWindow,
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ReviewGapsOptions) => {
      await runReviewGaps(opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunReviewGaps}. */
export async function runReviewGaps(
  options: ReviewGapsOptions,
  ctx: ReviewGapsContext = {},
): Promise<void> {
  try {
    await doRunReviewGaps(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Pure runner: resolves the workspace, computes the summary, prints it (or JSON). */
export async function doRunReviewGaps(
  options: ReviewGapsOptions,
  ctx: ReviewGapsContext,
): Promise<ReviewGapsSummary> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "review-gaps");
  const paths = basouPaths(repositoryRoot);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const summary = await findReviewGaps({
    paths,
    nowIso,
    ...(options.repo !== undefined && options.repo.length > 0 ? { scope: options.repo } : {}),
    ...(options.window !== undefined ? { windowHours: options.window } : {}),
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
  });

  if (options.json === true) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(renderReviewGaps(summary));
  }
  return summary;
}

function relAge(iso: string | null, now: Date): string {
  if (iso === null) return "(unknown)";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function unitLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const head = `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"})`;
  if (u.verdict === "near_unbound") {
    const ids = u.reviews.map((r) => r.sessionId.slice(0, 14)).join(", ");
    return `${head} — a nearby review exists, but the diff / changed files were not examined [${ids}]`;
  }
  return `${head} — no bound cross-model review`;
}

function candidateLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const cite = u.reviews
    .map((r) => `${r.sessionId.slice(0, 14)}${r.examinedDiff ? "(diff)" : ""}`)
    .join(", ");
  return `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"}) — review trace: ${cite}`;
}

/**
 * Render the advisory report. Leads with the gaps (units with no bound review),
 * then the candidates to confirm, then a per-repo tally. It deliberately states
 * the read-only / capture-bounded / no-auto-clear framing so the verdict is not
 * over-read.
 */
export function renderReviewGaps(summary: ReviewGapsSummary): string {
  const now = new Date(summary.generatedAt);
  const lines: string[] = [];
  const scope = summary.scope ? summary.scope.join(", ") : "all repositories";
  lines.push(`# Review-trail gaps (${scope})`);
  lines.push("");

  if (summary.gaps.length === 0) {
    lines.push("✅ Within the captured range, no unit of work landed without a review trail.");
  } else {
    lines.push(`⚠️ Units of work that landed without a review trail: ${summary.gaps.length}`);
    for (const u of summary.gaps) lines.push(unitLine(u, now));
  }
  lines.push("");

  if (summary.candidates.length > 0) {
    lines.push(
      `## To confirm (${summary.candidates.length}) — a cross-model review trace exists; confirm it actually examined this change`,
    );
    for (const u of summary.candidates) lines.push(candidateLine(u, now));
    lines.push("");
  }

  if (summary.unknowns.length > 0) {
    const n = summary.unknowns.reduce((sum, u) => sum + u.commitCount, 0);
    lines.push(
      `## Undeterminable (${summary.unknowns.length} unit${summary.unknowns.length === 1 ? "" : "s"} / ${n} commit${n === 1 ? "" : "s"}) — repo or timestamp could not be derived from capture; verdict withheld (not a clear)`,
    );
    lines.push("");
  }

  lines.push("## By repository");
  for (const r of summary.repos) {
    lines.push(
      `- ${r.repo}: ${r.units} unit${r.units === 1 ? "" : "s"} (no trail ${r.omissionUnits} / nearby only ${r.nearUnboundUnits} / to confirm ${r.candidateUnits}${r.unknownUnits > 0 ? ` / unknown ${r.unknownUnits}` : ""})`,
    );
  }
  lines.push("");
  lines.push(
    `Note: read-only advisory. Only captured commits are in scope (newest captured commit: ${summary.newestCommitAt === null ? "none" : relAge(summary.newestCommitAt, now)}). It never auto-judges that a review "happened", and temporal proximity alone is not a pass. It does not enforce.`,
  );
  return lines.join("\n");
}
