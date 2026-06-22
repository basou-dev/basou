/**
 * The date portion of an imported session's human-readable label.
 *
 * A same-day session reads as a single date (`2026-06-22`). A session that
 * spans a day boundary — e.g. a long evening-into-morning run — reads as a
 * range (`2026-06-21..2026-06-22`) so the most recent day stays visible instead
 * of the work being buried under the (older) start date when scanning
 * `basou session list`. The label is sorted/listed by `started_at` elsewhere;
 * this only governs the displayed text.
 *
 * Dates are the raw ISO date prefix with no timezone normalization, matching
 * how `started_at` / `ended_at` are stored. `ended_at` is never earlier than
 * `started_at` by instant, but with mixed UTC offsets the earlier instant can
 * still carry the later calendar date, so the two dates are ordered
 * lexicographically (= chronologically for `YYYY-MM-DD`) and the range always
 * reads earliest..latest.
 */
export function sessionLabelDateSpan(startIso: string, endIso: string): string {
  const a = startIso.slice(0, 10);
  const b = endIso.slice(0, 10);
  if (a === b) return a;
  return a < b ? `${a}..${b}` : `${b}..${a}`;
}
