import type { CommandExecutedEvent } from "./event.schema.js";

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
 *   {@link writeObservedDuration}), so the value survives only on events
 *   already on disk — which are never rewritten, because that would break the
 *   tamper-evidence chain.
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
 * A non-positive measurement is not an observation of a command. basou's own
 * live capture takes a wall-clock difference across a spawn, and a spawn costs
 * real time: measured on one host, 40 of 40 `/usr/bin/true` spawns took over
 * 0.5ms (minimum 0.9ms) and `/bin/sh -c :` took 2.4ms. So a zero or negative
 * value here is a clock anomaly — the wall clock stepping backwards
 * mid-command — not a command that ran instantly, and basou reports no
 * duration it cannot back. The paths where nothing was timed at all (a spawn
 * that failed before the child ran, a run interrupted early) write null
 * directly and do not come through here.
 */
export function writeObservedDuration(measuredMs: number | null): number | null {
  if (measuredMs === null || !Number.isFinite(measuredMs)) return null;
  // Round FIRST: the field is a whole number of milliseconds, so a measurement
  // under half a millisecond would otherwise round back to the 0 this release
  // stops writing.
  const rounded = Math.round(measuredMs);
  return rounded > 0 ? rounded : null;
}
