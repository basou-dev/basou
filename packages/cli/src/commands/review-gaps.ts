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

/**
 * Flatten recorded text onto one line and cap it. Recorded content is written
 * by whatever ran the review; it must not be able to restructure this report —
 * a newline inside a claimed SHA would otherwise inject a Markdown line.
 */
function flatten(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Split into user-perceived characters. Neither UTF-16 units nor code points
 * are the right unit: a cap between them can strip a combining mark or leave a
 * ZWJ emoji sequence half-rendered.
 */
function graphemes(value: string): string[] {
  return [...GRAPHEMES.segment(value)].map((s) => s.segment);
}

/** {@link flatten} plus a length cap, for free-form recorded text. */
function oneLine(value: string, max: number): string {
  const flat = graphemes(flatten(value));
  return flat.length > max ? `${flat.slice(0, max - 1).join("")}…` : flat.join("");
}

/** Short SHAs a record claimed to cover, capped so one line stays readable. */
function claimedCommits(commits: string[]): string {
  if (commits.length === 0) return "";
  const shown = commits.slice(0, 3).map((c) => graphemes(flatten(c)).slice(0, 8).join(""));
  return ` claiming ${shown.join(", ")}${commits.length > shown.length ? ", ..." : ""}`;
}

/** Self-reports rendered inline before the rest are summarised as a count. */
const SELF_REPORTS_SHOWN = 3;

/**
 * The self-report suffix. It is appended to a line — never substituted for it —
 * so the record is visible without changing what the unit is. The commits a
 * record claimed are shown as exactly that: the reviewer's claim, which nothing
 * here checks and no count uses.
 *
 * `stillCounted` is false on a candidate: the wording must stay true, and a
 * candidate is not in the gap count the phrase refers to.
 */
function selfReportSuffix(u: ReviewGapUnit, stillCounted: boolean): string {
  if (u.selfReports.length === 0) return "";
  const parts = u.selfReports
    .slice(0, SELF_REPORTS_SHOWN)
    .map(
      (r) =>
        `${oneLine(r.reviewer, 40)}${claimedCommits(r.commits)}${r.recordedAfterCommit ? " (recorded after the commit)" : ""}`,
    );
  const rest = u.selfReports.length - parts.length;
  if (rest > 0) parts.push(`+${rest} more`);
  return ` · self-reported by ${parts.join("; ")} — ${stillCounted ? "unverified, still counted" : "unverified"}`;
}

/**
 * States how many of a unit's commits ran with no recorded exit code, so the
 * report never says "this work landed" on the strength of an outcome nobody
 * observed. Like a self-report this only LABELS: the commit count above it is
 * unchanged, because a commit that cannot be verified must not be able to leave
 * the report by being unverifiable.
 */
function unobservedOutcomeSuffix(u: ReviewGapUnit): string {
  const n = u.commitsWithUnobservedOutcome;
  if (n === 0) return "";
  const scope = n === u.commitCount ? "" : `${n} of them `;
  return ` · ${scope}exited with no recorded status — landing assumed, not observed`;
}

function unitLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const head = `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"})`;
  if (u.verdict === "near_unbound") {
    const ids = u.reviews.map((r) => r.sessionId.slice(0, 14)).join(", ");
    return `${head} — a nearby review exists, but the diff / changed files were not examined [${ids}]${selfReportSuffix(u, true)}${unobservedOutcomeSuffix(u)}`;
  }
  return `${head} — no bound cross-model review${selfReportSuffix(u, true)}${unobservedOutcomeSuffix(u)}`;
}

function candidateLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const cite = u.reviews
    .map((r) => `${r.sessionId.slice(0, 14)}${r.examinedDiff ? "(diff)" : ""}`)
    .join(", ");
  // A record bound here counts as attached, so it is absent from the unattached
  // diagnostic; without this suffix it would exist only in --json and the claim
  // would be silently missing from the report the operator actually reads.
  return `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"}) — review trace: ${cite}${selfReportSuffix(u, false)}${unobservedOutcomeSuffix(u)}`;
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

  if (summary.gaps.length === 0 && summary.unknowns.length > 0) {
    // Never the green line while work exists that could not be placed at all:
    // a zero that means "stopped looking" must not read as a zero that means
    // "nothing was missed".
    const n = summary.unknowns.reduce((sum, u) => sum + u.commitCount, 0);
    lines.push(
      `⚠️ No unit of work was found without a review trail — but ${n} captured commit${n === 1 ? "" : "s"} could not be placed in a repository at all, so ${n === 1 ? "it was" : "they were"} never checked (see below).`,
    );
  } else if (summary.gaps.length === 0) {
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
      `## Undeterminable (${summary.unknowns.length} unit${summary.unknowns.length === 1 ? "" : "s"} / ${n} commit${n === 1 ? "" : "s"}) — repo or timestamp could not be derived from capture; verdict withheld (not a clear). Belongs to no repository, so this is listed even under --repo`,
    );
    // Listed, not just counted: a bare tally leaves nothing to go and look at,
    // and this section exists precisely so work the tool could not examine does
    // not disappear behind a number.
    for (const u of summary.unknowns) {
      // The whole session id, not a prefix. Elsewhere a line carries a repo name
      // and a review trace; here the session is the only handle on the work, and
      // a ULID's leading characters are its timestamp -- two sessions from the
      // same millisecond share them, so a prefix can be both indistinguishable
      // here and ambiguous to the commands the operator would paste it into.
      lines.push(
        `- ${relAge(u.lastCommitAt, now)} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"}) [${u.sessionId}]`,
      );
    }
    lines.push("");
  }

  lines.push("## By repository");
  for (const r of summary.repos) {
    lines.push(
      `- ${r.repo}: ${r.units} unit${r.units === 1 ? "" : "s"} (no trail ${r.omissionUnits} / nearby only ${r.nearUnboundUnits} / to confirm ${r.candidateUnits}${r.unknownUnits > 0 ? ` / unknown ${r.unknownUnits}` : ""}${r.selfReportedGapUnits > 0 ? ` / self-reported ${r.selfReportedGapUnits}` : ""})`,
    );
  }
  lines.push("");
  lines.push(
    `Note: read-only advisory. Only captured commits are in scope (newest captured commit: ${summary.newestCommitAt === null ? "none" : relAge(summary.newestCommitAt, now)}). It never auto-judges that a review "happened", and temporal proximity alone is not a pass. It does not enforce.`,
  );
  // Only claimed for a unit the count above actually contains. A candidate can
  // carry a record too, and saying it "stays in the count" would be false there.
  if (summary.gaps.some((u) => u.selfReports.length > 0)) {
    lines.push(
      'Note: a "self-reported" unit has a `basou review record` naming this repo, but nothing corroborates it — it stays in the count above, because an empty record must not be a way to make the number go down.',
    );
  }
  lines.push(...unattachedLines(summary.unattachedSelfReports));
  if (summary.refusedPairings > 0) {
    // Per pairing, so a record that landed on one unit still reports the units
    // it could not be checked against.
    lines.push(
      `Note: ${summary.refusedPairings} pairing${summary.refusedPairings === 1 ? "" : "s"} between a recorded review and captured work could not be checked, because that work's own repository path was never verified.`,
    );
  }
  return lines.join("\n");
}

/**
 * Recorded reviews that changed nothing, with the cause of each. The causes are
 * listed separately rather than summarised because they are different mistakes:
 * only one of them is fixed by adding a `repos` field, and asserting that cause
 * for all of them would state a reason this never established.
 */
function unattachedLines(u: ReviewGapsSummary["unattachedSelfReports"]): string[] {
  if (u.total === 0) return [];
  const lines = [
    `Note: ${u.total} recorded review${u.total === 1 ? "" : "s"} changed nothing in this report (counted across all repositories, not just any --repo scope):`,
  ];
  if (u.noRepos > 0) {
    lines.push(
      `  ${u.noRepos} named no repository — add \`repos\` to the record; without it the record's own location is the planning repo, not the repo reviewed`,
    );
  }
  if (u.unresolvableRepo > 0) {
    lines.push(
      `  ${u.unresolvableRepo} named a path that is not a repository root on this machine — unverifiable, so not paired with any work`,
    );
  }
  if (u.noMatchingUnit > 0) {
    lines.push(
      `  ${u.noMatchingUnit} named a repository, but no captured unit of work fell within the window of it`,
    );
  }
  if (u.unverifiableUnit > 0) {
    // Deliberately not folded into the line above: work WAS captured, and saying
    // otherwise would deny the operator a unit they can go and look at.
    lines.push(
      `  ${u.unverifiableUnit} fell within the window of captured work, but that work's own repository path could not be verified — the pairing could not be checked either way`,
    );
  }
  return lines;
}
