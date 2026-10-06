import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries } from "../storage/sessions.js";
import { listSessions } from "./sessions.js";

/**
 * The version of how the `freshness` section measures. Raised whenever a
 * value of the section would change for the same trail and native logs, as
 * when `basou orient` judges freshness differently.
 */
export const BOARD_FRESHNESS_METHOD = 1;

/**
 * What a dry run of `basou refresh` would do on this host: the sessions it
 * would newly import, the imported ones it would import again (grown or
 * replaced), and those that changed but it could not import safely. The
 * caller runs it, as `basou orient` does; the board does not import.
 */
export type BoardImportProbe = {
  newSessions: number;
  updatedSessions: number;
  unverifiableSessions: number;
};

/**
 * How current the workspace's own trail is on this host, as `basou orient`
 * judges it. Left out of the digest: it moves as work goes on, and the
 * session that measures is itself such work.
 */
export type BoardFreshness = {
  /**
   * When the newest session that is not archived started, as recorded. Null
   * with no not_found entry when there is no such session, a null that means
   * so. Null with an entry at `freshness.newest_session_at` when the sessions
   * cannot be listed (or `.basou/sessions` is refused), a session.yaml cannot
   * be read, or an entry named as a session is not a directory: the session
   * left out could be the newest.
   */
  newest_session_at: string | null;
  /**
   * Sessions a `basou refresh` would newly import, import again, or could not
   * import safely. Null with an entry at `freshness.unimported` when no dry
   * run was given or it could not run.
   */
  unimported: { new: number; updated: number; unverifiable: number } | null;
};

export type FreshnessInput = {
  paths: BasouPaths;
  now: Date;
  /** A dry run of `basou refresh`; null when it could not run. */
  probeImports?: () => Promise<BoardImportProbe | null>;
};

/** The `freshness` section of a measurement, and why a value is missing when it is. */
export async function measureFreshness(input: FreshnessInput): Promise<{
  freshness: BoardFreshness;
  notFound: { at: string; reason: string }[];
}> {
  const notFound: { at: string; reason: string }[] = [];
  const newest = await newestSessionStart(input.paths, input.now);
  if (!newest.ok) notFound.push({ at: "freshness.newest_session_at", reason: newest.reason });

  let unimported: BoardFreshness["unimported"] = null;
  if (input.probeImports === undefined) {
    notFound.push({
      at: "freshness.unimported",
      reason: "no dry run of an import was given to count the sessions not yet imported",
    });
  } else {
    let probe: BoardImportProbe | null;
    try {
      probe = await input.probeImports();
    } catch {
      probe = null;
    }
    if (probe === null) {
      notFound.push({ at: "freshness.unimported", reason: "a dry run of an import could not run" });
    } else {
      unimported = {
        new: probe.newSessions,
        updated: probe.updatedSessions,
        unverifiable: probe.unverifiableSessions,
      };
    }
  }
  return {
    freshness: { newest_session_at: newest.ok ? newest.at : null, unimported },
    notFound,
  };
}

// The start of the newest session that is not archived, as `basou orient`
// finds it, or why it is not known.
async function newestSessionStart(
  paths: BasouPaths,
  now: Date,
): Promise<{ ok: true; at: string | null } | { ok: false; reason: string }> {
  const listed = await listSessions(paths);
  if (!listed.ok) return listed;
  let unreadable = 0;
  let notDirectories = 0;
  let entries: Awaited<ReturnType<typeof loadSessionEntries>>;
  try {
    entries = await loadSessionEntries(paths, {
      now,
      onSkip: (_sessionId, reason) => {
        if (reason === "session_dir_not_directory") notDirectories++;
        // Its events are read only to tell whether a running session is
        // suspect; its start is in session.yaml, which was read.
        else if (reason !== "events_jsonl_unreadable") unreadable++;
      },
    });
  } catch {
    return { ok: false, reason: "the sessions of the workspace could not be read" };
  }
  const problems: string[] = [];
  if (unreadable > 0) {
    problems.push(`${unreadable} session${unreadable === 1 ? "" : "s"} could not be read`);
  }
  if (notDirectories > 0) {
    const n = notDirectories;
    problems.push(
      `${n} session ${n === 1 ? "entry is" : "entries are"} not a directory (a symlink or a file)`,
    );
  }
  if (problems.length > 0) {
    return { ok: false, reason: `${problems.join(", and ")}, so the newest may be missing` };
  }
  let newest: { at: string; time: number } | null = null;
  for (const entry of entries) {
    if (entry.session.session.status === "archived") continue;
    const at = entry.session.session.started_at;
    const time = Date.parse(at);
    if (newest === null || time > newest.time) newest = { at, time };
  }
  return { ok: true, at: newest?.at ?? null };
}
