import type { CommandExecutedEvent, Event } from "./event.schema.js";

/**
 * The duration a `command_executed` event actually OBSERVED, in milliseconds,
 * or `null` when it observed none.
 *
 * This is the single implementation of the read rule stated in
 * `docs/spec/schemas.md` §7.3. Every reader of `duration_ms` goes through it
 * instead of reading the field directly, so the rule cannot hold in one surface
 * and lapse in another.
 *
 * The rule needs no `schema_version` branch, because `0` means the same thing
 * on every version:
 *
 * - Under `0.1.0` the field could not be null, so a writer with nothing to
 *   report stored `0` as the floor. Every command imported from a Claude Code
 *   transcript, which carries no timing at all, was written that way.
 * - From `0.2.0` a writer records `null` instead and never writes `0` (see
 *   {@link writeObservedDuration} and {@link hasRetiredZeroDuration}), so the
 *   value survives only on events already on disk. Those are not rewritten in
 *   place — that would break the tamper-evidence chain — though a session whose
 *   source log grows is re-derived, which restamps its events at the current
 *   version. A session whose source is gone keeps its 0.1.0 lines indefinitely.
 * - A `0` from any other writer is read the same way. A spawned process cannot
 *   have run in under half a millisecond: `fork` + `exec` alone costs more, and
 *   `Math.round` collapses anything below that anyway. So `0` is not a
 *   duration a command can have had, whoever wrote it.
 */
export function readObservedDuration(ev: CommandExecutedEvent): number | null {
  const stored = ev.duration_ms;
  if (stored === null || stored === 0) return null;
  return stored;
}

/**
 * A measured duration as it should be WRITTEN: the measurement itself, or
 * `null` when there was nothing to observe.
 *
 * The counterpart of {@link readObservedDuration}, so the two halves of the
 * convention live side by side.
 *
 * A non-positive measurement is not an observation of a command. A spawn costs
 * real time — measured on one host, 40 of 40 `/usr/bin/true` spawns took over
 * 0.5ms (minimum 0.75ms, median 0.83ms) — and basou's own live capture times it
 * on a monotonic sub-millisecond clock, so a real spawn rounds to at least 1ms.
 * A zero or negative value therefore means the measurement itself is not
 * usable, not that the command ran instantly, and basou reports no duration it
 * cannot back.
 *
 * This depends on the caller measuring at sub-millisecond resolution. Taking
 * the difference of two whole-millisecond wall-clock readings does NOT
 * qualify: a 0.8ms spawn lands on 0 or 1 depending only on where in the
 * millisecond it started, and 5 of those same 40 runs came out 0 that way —
 * which this function would then report as unobserved. `ChildProcessRunner`
 * measures with {@link performance.now} for exactly that reason.
 *
 * The paths where nothing was timed at all (a spawn that failed before the
 * child ran, a run interrupted early) write null directly and do not come
 * through here.
 */
export function writeObservedDuration(measuredMs: number | null): number | null {
  if (measuredMs === null || !Number.isFinite(measuredMs)) return null;
  // Round FIRST: the field is a whole number of milliseconds, so a measurement
  // under half a millisecond would otherwise round back to the 0 this release
  // stops writing.
  const rounded = Math.round(measuredMs);
  if (rounded <= 0) return null;
  // Above the schema's integer domain the value is not a duration either (2^53
  // milliseconds is 285,000 years), and letting it through would fail
  // validation deep inside a batch import and abort the candidates behind it.
  if (!Number.isSafeInteger(rounded)) return null;
  return rounded;
}

/**
 * Event `schema_version` from which writers stopped emitting
 * `command_executed.duration_ms: 0` and record `null` instead.
 */
export const ZERO_DURATION_RETIRED_SINCE = "0.2.0" as const;

/**
 * Whether this event carries a `duration_ms` of `0` that its OWN version says
 * no writer should have produced.
 *
 * This is NOT the read rule. {@link readObservedDuration} treats `0` as
 * unobserved on every version and needs no version branch; this is a
 * data-quality check on top of it, and it is the only thing that makes the
 * 0.2.0 bump verifiable. Without it the invariant "a 0.2.0 writer never emits
 * 0" is a promise no code checks: the schema still accepts `0` (0.1.0 events
 * carrying it are on disk and must keep validating), so a future code path, or
 * a third party using this package's writers, could put one there and the read
 * rule would silently reinterpret it.
 *
 * A `0` on a pre-0.2.0 event is expected and not flagged: that was the floor a
 * writer stored when it had nothing to report.
 */
export function hasRetiredZeroDuration(ev: Event): boolean {
  if (ev.type !== "command_executed") return false;
  if (ev.duration_ms !== 0) return false;
  return compareSchemaVersion(ev.schema_version, ZERO_DURATION_RETIRED_SINCE) >= 0;
}

/**
 * Compare two `0.x.y` schema versions. Returns a negative number, 0, or a
 * positive one, like a sort comparator. An unparseable version sorts BELOW
 * every parseable one, which keeps {@link hasRetiredZeroDuration} from flagging
 * an event whose version it cannot read.
 */
function compareSchemaVersion(a: string, b: string): number {
  const pa = parseSchemaVersion(a);
  const pb = parseSchemaVersion(b);
  if (pa === null) return pb === null ? 0 : -1;
  if (pb === null) return 1;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `"0.2.0"` -> `[0, 2, 0]`; null when the string is not `major.minor.patch`. */
function parseSchemaVersion(version: string): [number, number, number] | null {
  const parts = version.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}
