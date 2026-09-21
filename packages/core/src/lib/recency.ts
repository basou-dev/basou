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
  session: { session: { started_at: string; related_files?: readonly string[] } };
};

/**
 * How many `command_executed` events each session recorded, by session id. A
 * session absent from the map counts as zero.
 */
export type SessionCommandCounts = ReadonlyMap<string, number>;

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
 * `commandCounts` is required rather than optional on purpose: a caller that
 * forgot it would silently fall back to the files-only ranking this exists to
 * correct.
 *
 * Returns `undefined` for an empty list. Does not mutate the input.
 */
export function pickLatestSubstantiveEntry<E extends RankableSessionEntry>(
  entries: readonly E[],
  commandCounts: SessionCommandCounts,
): E | undefined {
  const didWork = (e: E): number => {
    if ((e.session.session.related_files?.length ?? 0) > 0) return 1;
    return (commandCounts.get(e.sessionId) ?? 0) > WRAPPER_SESSION_COMMAND_COUNT ? 1 : 0;
  };
  return [...entries].sort((a, b) => {
    const aWorked = didWork(a);
    const bWorked = didWork(b);
    if (aWorked !== bWorked) return bWorked - aWorked;
    return Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at);
  })[0];
}
