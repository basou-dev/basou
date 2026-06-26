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
  session: { session: { started_at: string; related_files?: readonly string[] } };
};

/**
 * Pick the session that should represent the latest / most informative work.
 *
 * A bare resume/refresh session (e.g. 1 command, 0 files) is the most RECENT
 * session but the least informative; selecting it hides the real-work session
 * and makes the latest-session and latest-decision pointers disagree. So rank a
 * session that touched files ahead of one that did not, then break ties by
 * recency (started_at). The result is the most recent SUBSTANTIVE session,
 * falling back to the most recent session overall when none touched files.
 *
 * Returns `undefined` for an empty list. Does not mutate the input.
 */
export function pickLatestSubstantiveEntry<E extends RankableSessionEntry>(
  entries: readonly E[],
): E | undefined {
  return [...entries].sort((a, b) => {
    const aSubstantive = (a.session.session.related_files?.length ?? 0) > 0 ? 1 : 0;
    const bSubstantive = (b.session.session.related_files?.length ?? 0) > 0 ? 1 : 0;
    if (aSubstantive !== bSubstantive) return bSubstantive - aSubstantive;
    return Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at);
  })[0];
}
