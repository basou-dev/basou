/**
 * Coarse human duration from milliseconds: "3h 05m" / "12m 30s" / "8s".
 * Shared by the work-stats surfaces (`basou stats`, `basou session show`) so
 * they format identically.
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
