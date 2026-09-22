/**
 * Shared "resume coherence" helpers for the orientation and handoff renderers,
 * so both judge staleness and pick the representative session identically.
 *
 * These exist because a resume (re-import, then pick up where you left off) must
 * not present a stale recorded decision as the current direction, nor represent
 * the latest work with an essentially empty session — the two failure modes that
 * let an agent re-attempt already-completed work on resume.
 */

/**
 * A recorded decision / next-step note is "trailing" when captured activity
 * continued for more than this gap after it. Decisions are recorded only from
 * AskUserQuestion tool calls, `basou decision record`, or `basou decision
 * capture` — free-form conversational decisions are not auto-captured — so a
 * long trailing gap means the operator's current direction may simply be
 * unrecorded. 1h is a deliberately conservative threshold so a decision made
 * near a session's end does not trigger the note.
 */
export const DECISION_TRAILING_ACTIVITY_GAP_MS = 60 * 60 * 1000;

/**
 * True when captured activity continued more than
 * {@link DECISION_TRAILING_ACTIVITY_GAP_MS} after `recordedAt`. Used to decide
 * whether a recorded decision / note should carry a staleness caveat instead of
 * being presented as the current direction. `latestActivityAt === null` (no
 * activity tail) is never stale.
 */
export function isTrailingStale(latestActivityAt: string | null, recordedAt: string): boolean {
  if (latestActivityAt === null) return false;
  return Date.parse(latestActivityAt) - Date.parse(recordedAt) > DECISION_TRAILING_ACTIVITY_GAP_MS;
}

/** Minimal shape needed to rank a session for "representative latest session". */
type RankableSessionEntry = {
  sessionId: string;
  session: {
    session: {
      started_at: string;
      ended_at?: string | undefined;
      related_files?: readonly string[];
    };
  };
};

/**
 * How many `command_executed` events each session recorded, by session id. A
 * session absent from the map counts as zero.
 */
export type SessionCommandCounts = ReadonlyMap<string, number>;

/**
 * Sessions whose `events.jsonl` could not be replayed, so their command count
 * is UNKNOWN rather than zero. Kept apart from an absent map entry, which means
 * "read fine, ran nothing".
 */
export type UnmeasuredSessions = ReadonlySet<string>;

/**
 * A `basou exec` / `run` wrapper session records exactly one command and no
 * files -- the "1 command, 0 files" case this ranking exists to skip -- so a
 * session counts as work only when it ran MORE than this many commands.
 */
const WRAPPER_SESSION_COMMAND_COUNT = 1;

/**
 * Pick the session that should represent the latest / most informative work.
 *
 * A bare wrapper session (exactly 1 command, 0 files) is the most RECENT
 * session but the least informative; selecting it hides the real-work session
 * and makes the latest-session and latest-decision pointers disagree. So rank a
 * session that did work ahead of one that did not, then break ties by recency
 * (started_at). The result is the most recent WORKING session, falling back to
 * the most recent session overall when none qualifies.
 *
 * "Did work" is commands run OR files touched -- not files alone. Files alone
 * under-counts, because the importer fills `related_files` from Edit / Write /
 * NotebookEdit tool calls only: an agent that edits through the shell (a
 * heredoc, `sed -i`, a script) records commands and no files. Measured on a
 * real 1205-session store, 307 sessions ran commands with zero `related_files`,
 * while ZERO sessions touched files without running commands -- so the command
 * count strictly contains the old signal, and widening to it cannot demote a
 * session the old rule promoted. Before this, a session that cut a release
 * entirely through the shell ranked below a two-day-old one.
 *
 * A session that ran entirely inside another working session's window is that
 * session's work rather than a separate answer to "where am I", so it is not a
 * candidate. See {@link isNestedInAnother}.
 *
 * `commandCounts` is required rather than optional on purpose: a caller that
 * forgot it would silently fall back to the files-only ranking this exists to
 * correct.
 *
 * Returns `undefined` for an empty list. Does not mutate the input.
 */
export function pickLatestSubstantiveEntry<E extends RankableSessionEntry>(
  entries: readonly E[],
  commandCounts: SessionCommandCounts,
  unmeasured: UnmeasuredSessions,
): E | undefined {
  const didWork = (e: E): boolean => {
    if ((e.session.session.related_files?.length ?? 0) > 0) return true;
    // An unreadable events.jsonl leaves no map entry, which is indistinguishable
    // from "ran nothing" unless it is named. Reading that absence as proof of
    // idleness is the same error as reporting an unrecorded handoff as "no
    // pending tasks": it states a fact the capture never established. So a
    // session we could not measure keeps its candidacy. The cost is that a
    // corrupt bookkeeping session can be named the latest; the alternative is
    // hiding real work, which is the failure this ranking exists to prevent.
    if (unmeasured.has(e.sessionId)) return true;
    return (commandCounts.get(e.sessionId) ?? 0) > WRAPPER_SESSION_COMMAND_COUNT;
  };
  const working = entries.filter(didWork);
  const outermost = working.filter((e) => !isNestedInAnother(e, working));
  // `outermost` is non-empty whenever `working` is: nesting is a proper-subset
  // relation, so the widest window can never itself be nested. The two later
  // terms are belt-and-braces for a caller that hands us something unexpected.
  const pool = outermost.length > 0 ? outermost : working.length > 0 ? working : entries;
  return [...pool].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];
}

/**
 * Whether `entry` ran entirely inside some OTHER session's window.
 *
 * A subagent invocation (`codex exec` from inside a Claude Code session, say)
 * is imported as its own session, and it is newer than the session that
 * launched it, so pure recency hands "where am I" to the subagent instead of
 * the work it was part of. Measured on a real store, 222 of 236 codex sessions
 * (94%) ran entirely inside a Claude Code session; the remaining 6% are
 * standalone codex work and stay eligible, which is why this is expressed as
 * containment rather than as a rule about source kinds.
 *
 * Containment must be PROPER (strictly wider on at least one side) or two
 * sessions sharing an identical window would exclude each other and both drop
 * out. A session with no known `ended_at` (still live) is neither a container
 * nor contained: its end is unknown (the schema makes `ended_at` optional for
 * a session that has not finished), so neither claim can be made.
 *
 * O(n^2) over working sessions, which is a few hundred on a real store and
 * costs parsed-number comparisons only.
 */
function isNestedInAnother<E extends RankableSessionEntry>(
  entry: E,
  working: readonly E[],
): boolean {
  const end = entry.session.session.ended_at;
  if (end === undefined) return false;
  const start = Date.parse(entry.session.session.started_at);
  const finish = Date.parse(end);
  // Every bound must be finite before containment can be claimed. A NaN makes
  // each `>` and `<` false, so an unparseable end would slip past the rejection
  // and let a single `oStart < start` establish containment on its own -- and
  // several such windows can form a containment cycle that empties the
  // candidate set. Schema-validated sessions cannot reach this (the timestamp
  // schema gates on a regex that Date.parse accepts), so this guards the
  // function rather than the store.
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return false;
  return working.some((other) => {
    if (other.sessionId === entry.sessionId) return false;
    const otherEnd = other.session.session.ended_at;
    if (otherEnd === undefined) return false;
    const oStart = Date.parse(other.session.session.started_at);
    const oFinish = Date.parse(otherEnd);
    if (!Number.isFinite(oStart) || !Number.isFinite(oFinish)) return false;
    if (oStart > start || oFinish < finish) return false;
    return oStart < start || oFinish > finish;
  });
}
