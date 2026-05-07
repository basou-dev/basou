// `[1-9]\d*` rejects "0" and leading zeros so that callers cannot smuggle in
// a non-positive duration (which the underlying spawn validators would later
// reject anyway). The unit is fixed to `ms`/`s`/`m`/`h`; days and weeks are
// out of scope for v0.1.
const DURATION_RE = /^([1-9]\d*)(ms|s|m|h)$/;

/**
 * Parse a unit-suffixed duration string (e.g. `30s`, `5m`, `1h`, `100ms`)
 * into milliseconds.
 *
 * Rejects formats that cannot represent a positive, finite millisecond
 * value: malformed inputs, zero, leading-zero values, and computations that
 * overflow to `Infinity`. The returned number is always a positive integer.
 *
 * Supported units: `ms` (milliseconds), `s` (seconds), `m` (minutes),
 * `h` (hours).
 *
 * @param input duration string with required unit suffix
 * @returns duration in milliseconds (positive, finite)
 * @throws Error with message
 *   `Invalid duration: <input>. Expected format: <positive-integer><unit> where unit is ms/s/m/h`
 *   for format errors, or `Duration overflow: <input>` for non-finite results.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration: ${trimmed}. Expected format: <positive-integer><unit> where unit is ms/s/m/h`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  let ms: number;
  switch (unit) {
    case "ms":
      ms = value;
      break;
    case "s":
      ms = value * 1000;
      break;
    case "m":
      ms = value * 60_000;
      break;
    case "h":
      ms = value * 3_600_000;
      break;
    default:
      // Unreachable per the regex; satisfy exhaustiveness analysis.
      throw new Error(`Invalid duration unit: ${unit}`);
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`Duration overflow: ${trimmed}`);
  }
  return ms;
}
