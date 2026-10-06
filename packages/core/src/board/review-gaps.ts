import { join } from "node:path";
import {
  findReviewGaps,
  type ReviewGapsSummary,
  type ReviewGapVerdict,
} from "../review/review-gaps.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { listSessions, lostAmong } from "./sessions.js";

/**
 * The version of how the `review_gaps` section measures. Raised whenever a
 * value of the section would change for the same trail, as when `basou
 * review-gaps` judges a unit of work differently, gains a verdict or changes
 * its default window.
 */
export const BOARD_REVIEW_GAPS_METHOD = 1;

// Every verdict `basou review-gaps` gives, in the order its type lists them.
// A Record keyed by the union, so a verdict added to the surfacer fails to
// compile here until it is listed.
const VERDICTS: Record<ReviewGapVerdict, true> = {
  omission: true,
  near_unbound: true,
  candidate: true,
  unknown: true,
};

/**
 * What `basou review-gaps` finds in the workspace's own trail, on this host
 * only, over every repository and with its default window. Both values are
 * null, with one not_found entry at `review_gaps`, when the sessions cannot
 * be listed (or `.basou/sessions` is refused, being a symlink or not a
 * directory), an event line could not be read (a torn last line, a write in
 * progress, is not counted as one), a session's session.yaml or events.jsonl
 * could not be read, or an entry named as a session is not a directory:
 * `basou review-gaps` passes over such a session, and a commit in it would be
 * a gap the count leaves out.
 */
export type BoardReviewGaps = {
  /**
   * How many units of work (one session's commits in one repository) have
   * each verdict, every verdict `basou review-gaps` gives included at 0, in
   * the order its type lists them.
   */
  by_verdict: Record<string, number> | null;
  /** The units `basou review-gaps` lists as gaps: those with no bound review trail. */
  gaps: number | null;
};

/** The `review_gaps` section of a measurement, and why it is missing when it is. */
export async function measureReviewGaps(input: { paths: BasouPaths; now: Date }): Promise<{
  reviewGaps: BoardReviewGaps;
  notFound: { at: string; reason: string }[];
}> {
  const unmeasured = (reason: string) => ({
    reviewGaps: { by_verdict: null, gaps: null },
    notFound: [{ at: "review_gaps", reason }],
  });
  const listed = await listSessions(input.paths);
  if (!listed.ok) return unmeasured(listed.reason);

  // A running session's events are read twice, once to tell whether it is
  // suspect, so a line is known by where it is rather than counted per call.
  const malformed = new Map<string, Set<number>>();
  const offSchema = new Set<string>();
  const unreadable = new Set<string>();
  const notDirectories = new Set<string>();
  let summary: ReviewGapsSummary;
  try {
    summary = await findReviewGaps({
      paths: input.paths,
      nowIso: input.now.toISOString(),
      onWarning: (warning, sessionId) => {
        if (warning.kind === "malformed_json") {
          const lines = malformed.get(sessionId) ?? new Set<number>();
          lines.add(warning.line);
          malformed.set(sessionId, lines);
        } else if (warning.kind === "schema_violation") {
          offSchema.add(`${sessionId}\0${warning.line}`);
        }
      },
      onSessionSkip: (sessionId, reason) => {
        if (reason === "session_dir_not_directory") notDirectories.add(sessionId);
        else unreadable.add(sessionId);
      },
    });
  } catch {
    return unmeasured("the sessions of the workspace could not be read");
  }

  let lost = offSchema.size;
  for (const [sessionId, lines] of malformed) {
    lost += await lostAmong(join(input.paths.sessions, sessionId, "events.jsonl"), [...lines]);
  }
  const problems: string[] = [];
  if (lost > 0) problems.push(`${lost} event line${lost === 1 ? "" : "s"} could not be read`);
  if (unreadable.size > 0) {
    const n = unreadable.size;
    problems.push(`${n} session${n === 1 ? "" : "s"} could not be read`);
  }
  if (notDirectories.size > 0) {
    const n = notDirectories.size;
    problems.push(
      `${n} session ${n === 1 ? "entry is" : "entries are"} not a directory (a symlink or a file)`,
    );
  }
  if (problems.length > 0) {
    return unmeasured(`${problems.join(", and ")}, so the counts are not known`);
  }

  const byVerdict: Record<string, number> = {};
  for (const verdict of Object.keys(VERDICTS)) byVerdict[verdict] = 0;
  for (const unit of [...summary.gaps, ...summary.candidates, ...summary.unknowns]) {
    byVerdict[unit.verdict] = (byVerdict[unit.verdict] ?? 0) + 1;
  }
  return { reviewGaps: { by_verdict: byVerdict, gaps: summary.gaps.length }, notFound: [] };
}
