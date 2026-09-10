import type { CommandExecutedEvent } from "./event.schema.js";

/**
 * First event `schema_version` on which `command_executed.duration_ms: 0` means
 * a duration that WAS observed and was zero.
 *
 * Below this version the field was non-nullable, so a writer with nothing to
 * report had to store `0` as well: there, the two meanings share one value and
 * cannot be told apart.
 */
export const DURATION_OBSERVED_SINCE = "0.2.0" as const;

/**
 * The duration a `command_executed` event actually OBSERVED, in milliseconds,
 * or `null` when it observed none.
 *
 * This is the single implementation of the read rule stated in
 * `docs/spec/schemas.md` §7.3. Every reader of `duration_ms` goes through it
 * instead of reading the field directly, so the rule cannot hold in one surface
 * and lapse in another:
 *
 * - `null` is an absent observation on every version.
 * - From {@link DURATION_OBSERVED_SINCE}, `0` is an observation. Codex reports
 *   `Wall time: 0.0000 seconds` for most per-command calls, and folding those
 *   into "unrecorded" would discard the one thing the source did say.
 * - Below it, a stored `0` carries both meanings and is read as UNOBSERVED.
 *   Reading it as 0ms would credit a measured zero to every command imported
 *   from a Claude Code transcript, which carries no timing at all.
 *
 * Events are never rewritten — that would break the tamper-evidence chain, and
 * re-deriving cannot recover a duration the source never reported — so both
 * versions stay on disk indefinitely and this branch is permanent.
 */
export function readObservedDuration(ev: CommandExecutedEvent): number | null {
  const stored = ev.duration_ms;
  if (stored === null) return null;
  if (stored === 0 && !zeroMeansObserved(ev.schema_version)) return null;
  return stored;
}

/**
 * Whether a `0` written under `version` means "observed, and it was zero".
 *
 * An unparseable version reads as pre-0.2.0, which is the conservative
 * direction: basou reports no observation it cannot back.
 */
function zeroMeansObserved(version: string): boolean {
  const parsed = parseSchemaVersion(version);
  if (parsed === null) return false;
  const since = parseSchemaVersion(DURATION_OBSERVED_SINCE);
  if (since === null) return false;
  for (let i = 0; i < 3; i++) {
    const a = parsed[i] ?? 0;
    const b = since[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** `"0.2.0"` -> `[0, 2, 0]`; null when the string is not a `major.minor.patch`. */
function parseSchemaVersion(version: string): [number, number, number] | null {
  const parts = version.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : Number.NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}
