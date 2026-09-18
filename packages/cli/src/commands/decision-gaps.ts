import {
  basouPaths,
  type DecisionGap,
  type DecisionGapsSummary,
  findDecisionGaps,
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

export type DecisionGapsOptions = {
  since?: string;
  limit?: number;
  json?: boolean;
  verbose?: boolean;
};

export type DecisionGapsContext = ImportContext & {
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/** Entries shown before the rest are summarised as a count. */
export const DEFAULT_GAP_LIMIT = 20;

/** Commander parser: `--limit` is a non-negative integer. */
export function parseLimit(value: string): number {
  // Decimal digits only: `Number` would otherwise accept `1e2`, `0x10` and the
  // empty string, none of which a reader typing a count means.
  const n = /^\d+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("--limit must be a non-negative integer.");
  }
  return n;
}

/**
 * Commander parser: `--since` is an ISO instant or a `<n><unit>` duration back
 * from now (`7d`, `36h`, `90m`). A duration is resolved against the same clock
 * the run reports as `generatedAt`.
 */
export function parseSince(value: string, now: Date = new Date()): string {
  const duration = /^(\d+)([dhm])$/u.exec(value.trim());
  if (duration !== null) {
    const n = Number(duration[1]);
    const ms = { d: 86_400_000, h: 3_600_000, m: 60_000 }[duration[2] as "d" | "h" | "m"];
    return new Date(now.getTime() - n * ms).toISOString();
  }
  // A bare number is rejected rather than handed to `Date.parse`, which reads
  // "5" as the year 2005 — putting the whole history in scope, the outcome the
  // start boundary exists to prevent, from dropping one character of "5d".
  if (/^\d+$/u.test(value.trim())) {
    throw new InvalidArgumentError("--since needs a unit (7d, 36h, 90m) or a full ISO timestamp.");
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError(
      "--since must be an ISO timestamp or a duration (7d, 36h, 90m).",
    );
  }
  return new Date(parsed).toISOString();
}

/**
 * Wire `basou decision gaps` onto the `decision` command. A read-only, advisory
 * list of decisions no task carries — the plans that were agreed and then never
 * became work. It writes nothing and enforces nothing.
 */
export function registerDecisionGapsCommand(decision: Command): void {
  decision
    .command("gaps")
    .description("List recorded decisions that no task carries (read-only, advisory)")
    .option(
      "--since <when>",
      "Only decisions recorded at or after this ISO instant or duration back (7d, 36h)",
    )
    .option(
      "--limit <n>",
      `Maximum entries to list; the rest are counted (default ${DEFAULT_GAP_LIMIT}, 0 = no limit)`,
      parseLimit,
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: DecisionGapsOptions) => {
      await runDecisionGaps(opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunDecisionGaps}. */
export async function runDecisionGaps(
  options: DecisionGapsOptions,
  ctx: DecisionGapsContext = {},
): Promise<void> {
  try {
    await doRunDecisionGaps(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Pure runner: resolves the workspace, computes the summary, prints it (or JSON). */
export async function doRunDecisionGaps(
  options: DecisionGapsOptions,
  ctx: DecisionGapsContext,
): Promise<DecisionGapsSummary> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "decision gaps");
  const paths = basouPaths(repositoryRoot);

  const now = ctx.nowProvider?.() ?? new Date();
  // 0 means "no limit", which is not the same as "unset" — the default cap only
  // applies when the operator said nothing.
  const limit = options.limit ?? DEFAULT_GAP_LIMIT;

  const summary = await findDecisionGaps({
    paths,
    nowIso: now.toISOString(),
    ...(options.since !== undefined ? { start: parseSince(options.since, now) } : {}),
    ...(limit > 0 ? { limit } : {}),
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
  });

  if (options.json === true) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(renderDecisionGaps(summary));
  }
  return summary;
}

function relAge(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  // A record can carry a clock ahead of this one (a federated host, a skewed
  // importer). Say so rather than rounding it to "just now", which would read
  // as a fact about when the decision was made.
  if (!Number.isFinite(ms)) return "(unknown)";
  if (ms < 0) return "clock ahead";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Flatten to one line and cap by user-perceived character. A decision title is
 * operator-written text: a newline in it must not be able to restructure this
 * report, and a cap between UTF-16 units or code points can strip a combining
 * mark or split an emoji sequence.
 */
function oneLine(value: string, max: number): string {
  const flat = [...GRAPHEMES.segment(value.replace(/\s+/gu, " ").trim())].map((s) => s.segment);
  return flat.length > max ? `${flat.slice(0, max - 1).join("")}…` : flat.join("");
}

/** The whole decision id, not a prefix: it is what the reader pastes into `basou task new`. */
function gapLine(d: DecisionGap, now: Date): string {
  return `- ${oneLine(d.title, 100)}\n  ${relAge(d.recordedAt, now)} · ${d.decisionId}`;
}

/** The sentence describing what the run could not read, or `null` when it read everything. */
function incompleteLine(summary: DecisionGapsSummary): string | null {
  const { sessions, tasks, unknownReferences } = summary.incomplete;
  const parts: string[] = [];
  if (sessions > 0) {
    parts.push(
      `${sessions} session${sessions === 1 ? "" : "s"} could not be read in full, so a decision recorded there may be missing from these numbers, and a \`decision void\` recorded there may not have been applied`,
    );
  }
  if (tasks > 0) {
    parts.push(
      `${tasks} task file${tasks === 1 ? "" : "s"} could not be read, so a decision one of them carries is listed above as if nothing did`,
    );
  }
  if (unknownReferences > 0) {
    parts.push(
      `${unknownReferences} decision id${unknownReferences === 1 ? "" : "s"} named by a task ${unknownReferences === 1 ? "matches" : "match"} no decision in this store, and ${unknownReferences === 1 ? "was" : "were"} not counted as carrying anything`,
    );
  }
  return parts.length === 0 ? null : `⚠️ ${parts.join("; ")}.`;
}

/**
 * Render the advisory report.
 *
 * The zero case is stated as what was checked rather than as a clear. The
 * sibling surfacer refuses to emit a confident pass for the same reason: a
 * clear here rests on task files that are hand-editable and carry no events, so
 * "nothing is waiting" is a stronger claim than this can establish.
 */
export function renderDecisionGaps(summary: DecisionGapsSummary): string {
  const now = new Date(summary.generatedAt);
  const { excluded, scope } = summary;
  const lines: string[] = ["# Decision gaps", ""];

  if (summary.populationCount === 0) {
    lines.push(
      `No decision recorded since ${scope.start} by \`basou decision capture\` or \`basou decision record\` is still open, so there is nothing to check yet. This list fills as decisions are recorded.`,
    );
  } else if (summary.gaps.length === 0) {
    lines.push(
      `✅ Within what was checked, each of the ${summary.populationCount} open decision${summary.populationCount === 1 ? "" : "s"} in scope has a task carrying it.`,
    );
  } else {
    const total = summary.gaps.length + summary.truncated;
    lines.push(`⚠️ Open decisions no task carries: ${total} of ${summary.populationCount} in scope`);
    lines.push("");
    for (const d of summary.gaps) lines.push(gapLine(d, now));
    if (summary.truncated > 0) {
      lines.push(`  ... +${summary.truncated} more (--limit 0 to list them all, or --json)`);
    }
  }
  lines.push("");

  lines.push("## Scope");
  lines.push(
    `- Checked: decisions recorded at or after ${scope.start} with source \`${scope.source}\` (i.e. recorded by running basou, not derived from a transcript by an importer), still open, and not a track.`,
  );
  // Applied in order, each decision counted under the first ground that excludes
  // it, so the four numbers partition rather than overlap.
  lines.push(
    `- Not checked: ${excluded.byStart} recorded earlier, then ${excluded.bySource} recorded by something other than basou itself, then ${excluded.track} tracks (already shown every session by \`basou orient\` until closed), then ${excluded.voided} closed with \`basou decision void\`.`,
  );
  lines.push(
    `- Task files read: ${summary.tasksScanned} (live and archived); ${summary.carried} of the decisions in scope are carried by one.`,
  );
  const incomplete = incompleteLine(summary);
  if (incomplete !== null) lines.push(`- ${incomplete}`);
  lines.push("");
  lines.push(
    "Note: read-only advisory. A task carries a decision when it names that decision's full id; an abbreviated id names no one decision, because a captured batch shares a millisecond and its ids differ only at the end. It does not read what a decision means, and it does not enforce.",
  );
  return lines.join("\n");
}
