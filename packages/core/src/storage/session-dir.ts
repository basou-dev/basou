import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { SessionIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "./basou-dir.js";

/**
 * What is at a session's name under `paths.sessions`, judged without following
 * symlinks:
 *
 * - `directory` — a session.
 * - `symlink` — a symlink, whatever it points to.
 * - `not_a_directory` — anything else that is not a directory (a file).
 * - `missing` — nothing.
 */
export type SessionEntryKind = "directory" | "symlink" | "not_a_directory" | "missing";

/**
 * Refuse to operate on `.basou/sessions` if it is a symlink or not a
 * directory, so no session is read from or written to a place outside the
 * store. basou never creates such an entry. Mirrors `assertBasouRootSafe`,
 * which guards `.basou` itself.
 *
 * An absent `.basou/sessions` passes: an empty or stripped-down workspace has
 * none, and the writers that start a session create it.
 *
 * Throws `".basou/sessions is a symlink; refusing to operate"`,
 * `".basou/sessions exists but is not a directory"`, or
 * `Error("Failed to inspect .basou/sessions", { cause })` on any other lstat
 * failure.
 *
 * Like `assertBasouRootSafe`, this detects an entry already swapped; it does
 * not race-proof the filesystem.
 */
export async function assertSessionStoreSafe(paths: BasouPaths): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(paths.sessions);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return;
    throw new Error("Failed to inspect .basou/sessions", { cause: error });
  }
  if (entry.isSymbolicLink()) {
    throw new Error(".basou/sessions is a symlink; refusing to operate");
  }
  if (!entry.isDirectory()) {
    throw new Error(".basou/sessions exists but is not a directory");
  }
}

/**
 * Classify the entry at `<paths.sessions>/<sessionId>` (see
 * {@link SessionEntryKind}), after checking that `sessionId` is a session id
 * (so nothing but a name directly under the store is ever looked at) and the
 * store itself with {@link assertSessionStoreSafe}.
 *
 * Throws `Error("Invalid session id")` for anything that is not a session id,
 * the {@link assertSessionStoreSafe} errors, or
 * `Error("Failed to read the session directory of <id>", { cause })` on an
 * lstat failure other than ENOENT.
 */
export async function inspectSessionEntry(
  paths: BasouPaths,
  sessionId: string,
): Promise<SessionEntryKind> {
  if (!SessionIdSchema.safeParse(sessionId).success) throw new Error("Invalid session id");
  await assertSessionStoreSafe(paths);
  try {
    const entry = await lstat(join(paths.sessions, sessionId));
    if (entry.isSymbolicLink()) return "symlink";
    return entry.isDirectory() ? "directory" : "not_a_directory";
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return "missing";
    throw new Error(`Failed to read the session directory of ${sessionId}`, { cause: error });
  }
}

/**
 * Refuse to read or write session `sessionId` when its entry is a symlink or
 * a file: it is not followed. `readSessionYaml`, `classifySuspect` and the
 * chained append / finalize paths call it, and so do the commands handed an
 * id from elsewhere (an approval's recorded `session_id`). A reader that
 * takes a session directory instead (`replayEvents`, `readAllEvents`) relies
 * on its caller: an id from a listing, from `resolveSessionId`, or from this
 * check or {@link inspectSessionEntry}.
 *
 * A missing entry passes, so each caller keeps its own "not found" handling.
 * The error message matches `resolveSessionId`'s for the same entry.
 *
 * Throws `"Session <id> is not a directory; a symlink or a file there is not
 * followed"`, or the {@link inspectSessionEntry} errors.
 */
export async function assertSessionDirSafe(paths: BasouPaths, sessionId: string): Promise<void> {
  const kind = await inspectSessionEntry(paths, sessionId);
  if (kind === "symlink" || kind === "not_a_directory") {
    throw new Error(
      `Session ${sessionId} is not a directory; a symlink or a file there is not followed`,
    );
  }
}
