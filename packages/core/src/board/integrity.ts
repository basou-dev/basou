import { type ChainVerdictStatus, verifyEventsChain } from "../events/verify.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { listSessions } from "./sessions.js";

/**
 * The version of how the `integrity` section measures. Raised whenever a value
 * of the section would change for the same trail, as when `basou verify`
 * judges a session differently or gains a status.
 */
export const BOARD_INTEGRITY_METHOD = 1;

// Every status `basou verify` gives, in the order its summary line tallies
// them. A Record keyed by the union, so a status added to the verifier fails
// to compile here until it is listed.
const STATUSES: Record<ChainVerdictStatus, true> = {
  verified: true,
  unchained: true,
  empty: true,
  incomplete: true,
  in_progress: true,
  unsupported: true,
  tampered: true,
};

/**
 * What `basou verify` finds in the workspace's own sessions, on this host
 * only. Both values are null, with one not_found entry at `integrity`, when
 * the sessions cannot be listed (or `.basou/sessions` is refused, being a
 * symlink or not a directory) or a session cannot be read (where `basou
 * verify` stops with an error): a count that leaves a session out would be
 * wrong, not partial.
 */
export type BoardIntegrity = {
  /**
   * How many sessions have each status, every status `basou verify` gives
   * included at 0, in the order its summary line tallies them. An entry named
   * as a session that is not a directory (a symlink or a file) is `tampered`,
   * as `basou verify` judges it.
   */
  by_status: Record<string, number> | null;
  /** The sessions whose status is not `verified`, whatever it is. */
  not_verified: number | null;
};

/** The `integrity` section of a measurement, and why it is missing when it is. */
export async function measureIntegrity(paths: BasouPaths): Promise<{
  integrity: BoardIntegrity;
  notFound: { at: string; reason: string }[];
}> {
  const unmeasured = (reason: string) => ({
    integrity: { by_status: null, not_verified: null },
    notFound: [{ at: "integrity", reason }],
  });
  const listed = await listSessions(paths);
  if (!listed.ok) return unmeasured(listed.reason);
  const names = [...listed.dirs, ...listed.notDirectories];
  const byStatus: Record<string, number> = {};
  for (const status of Object.keys(STATUSES)) byStatus[status] = 0;
  let unreadable = 0;
  for (const sessionId of names) {
    try {
      const { status } = await verifyEventsChain(paths, sessionId);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    } catch {
      unreadable++;
    }
  }
  if (unreadable > 0) {
    const n = unreadable;
    return unmeasured(
      `${n} session${n === 1 ? "" : "s"} could not be read, so the counts are not known`,
    );
  }
  const notVerified = Object.entries(byStatus)
    .filter(([status]) => status !== "verified")
    .reduce((sum, [, count]) => sum + count, 0);
  return { integrity: { by_status: byStatus, not_verified: notVerified }, notFound: [] };
}
