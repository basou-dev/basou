/**
 * Gap longer than this between two consecutive engagement timestamps is treated
 * as idle and not credited as active time. A deliberately coarse heuristic: a
 * focus / billable-attention proxy, NOT a measure of model compute. 5 minutes.
 */
export const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

/** A wall-clock range, in epoch milliseconds, expressed as `[start, end]`. */
export type IntervalMs = [start: number, end: number];

/** A wall-clock range expressed as ISO-8601 strings (for persistence). */
export type IsoInterval = { start: string; end: string };

/**
 * Identifier stored in `metrics.active_time_method` for active time derived
 * from genuine engagement timestamps (conversation turns plus action events).
 * Bump this string if the derivation method changes, so stored numbers remain
 * interpretable.
 */
export const ENGAGED_TURNS_METHOD = "engaged-turns";

/**
 * Build active intervals from a list of engagement timestamps (epoch ms).
 *
 * Each consecutive pair credits the range `[t_prev, t_prev + min(gap, capMs)]`:
 * activity at a timestamp is assumed to continue until the next timestamp, or
 * for at most `capMs` if the next is further away (the remainder is idle).
 * Adjacent or overlapping ranges are merged into runs. The summed duration of
 * the merged intervals equals `sum(min(gap, capMs))`, so this both reproduces a
 * gap-capped active-time scalar and yields the real ranges needed for
 * cross-session union.
 *
 * Non-finite timestamps are skipped (the single invalid-timestamp policy) and
 * the input is sorted internally, so callers may pass timestamps in any order.
 */
export function activeTimeFromTimestamps(
  timestampsMs: ReadonlyArray<number>,
  capMs: number,
): { ms: number; intervals: IntervalMs[] } {
  const sorted = timestampsMs.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const raw: IntervalMs[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined) continue;
    const gap = curr - prev;
    if (gap <= 0) continue;
    raw.push([prev, prev + Math.min(gap, capMs)]);
  }
  const intervals = mergeIntervals(raw);
  return { ms: sumDurations(intervals), intervals };
}

/** Merge a set of (possibly unsorted / overlapping) intervals into disjoint runs. */
export function mergeIntervals(intervals: ReadonlyArray<IntervalMs>): IntervalMs[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: IntervalMs[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    // `start <= last end` joins adjacent runs (an interval ending exactly where
    // the next begins) as well as genuine overlaps.
    if (last !== undefined && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * De-duplicate active time across many sessions: merge all their intervals and
 * return the union duration (so concurrent sessions do not double-count human
 * wall-clock) together with the merged ranges.
 */
export function unionDurationMs(intervals: ReadonlyArray<IntervalMs>): {
  ms: number;
  merged: IntervalMs[];
} {
  const merged = mergeIntervals(intervals);
  return { ms: sumDurations(merged), merged };
}

/** Convert epoch-ms intervals to ISO ranges for persistence. */
export function intervalsMsToIso(intervals: ReadonlyArray<IntervalMs>): IsoInterval[] {
  return intervals.map(([start, end]) => ({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  }));
}

/** Parse stored ISO ranges back to epoch-ms intervals, skipping unparseable ones. */
export function intervalsIsoToMs(intervals: ReadonlyArray<IsoInterval>): IntervalMs[] {
  const out: IntervalMs[] = [];
  for (const { start, end } of intervals) {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) out.push([s, e]);
  }
  return out;
}

function sumDurations(intervals: ReadonlyArray<IntervalMs>): number {
  let total = 0;
  for (const [start, end] of intervals) total += end - start;
  return total;
}
