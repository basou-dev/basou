/**
 * Re-export the shared duration formatter from `@basou/core`. It lives in core
 * so the report renderer (also in core) and the CLI surfaces (`basou stats`,
 * `basou session show`) all format durations identically. Kept as a thin
 * re-export so existing CLI imports of `../lib/format-duration.js` stay valid.
 */
export { formatDurationMs } from "@basou/core";
