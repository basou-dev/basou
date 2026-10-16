import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { SessionIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "./basou-dir.js";
import { assertStoreDirectorySafe } from "./store-dir.js";

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
 * Thrown where a session is read or written by its id and the entry at that
 * name is a symlink, whatever it points to, or a file: it is not followed.
 * `kind` says which, as {@link inspectSessionEntry} classifies it.
 *
 * The message is `Session <id> is not a directory; a symlink or a file there
 * is not followed`. Tell this refusal apart by its class, not by the message.
 */
export class SessionNotADirectoryError extends Error {
  readonly sessionId: string;
  readonly kind: "symlink" | "not_a_directory";

  constructor(sessionId: string, kind: "symlink" | "not_a_directory") {
    super(`Session ${sessionId} is not a directory; a symlink or a file there is not followed`);
    this.name = "SessionNotADirectoryError";
    this.sessionId = sessionId;
    this.kind = kind;
  }
}

/**
 * Classify the entry at `<sessionsDir>/<sessionId>` without following it, for
 * a `sessionId` the caller has already checked to be a session id. Rethrows an
 * lstat failure other than ENOENT as it is, for the caller to wrap in its own
 * fixed message. It does not check the store itself: {@link inspectSessionEntry}
 * does, and the event readers rely on the listing or resolver that produced
 * the id, so that they also serve a federated mirror, whose store may be a
 * symlink.
 */
export async function lstatSessionEntry(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionEntryKind> {
  try {
    const entry = await lstat(join(sessionsDir, sessionId));
    if (entry.isSymbolicLink()) return "symlink";
    return entry.isDirectory() ? "directory" : "not_a_directory";
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

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
  await assertStoreDirectorySafe(paths.sessions, ".basou/sessions");
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
    return await lstatSessionEntry(paths.sessions, sessionId);
  } catch (error: unknown) {
    throw new Error(`Failed to read the session directory of ${sessionId}`, { cause: error });
  }
}

/**
 * Refuse to read or write session `sessionId` when its entry is a symlink or
 * a file: it is not followed. `readSessionYaml`, `classifySuspect` and the
 * chained append / finalize paths call it, and so do `approval approve` and
 * `approval reject` for an approval's recorded `session_id`; `approval show`
 * and `basou view` classify the entry with {@link inspectSessionEntry}
 * instead. The event readers (`replayEvents`, `readAllEvents`) check the
 * entry themselves, without the store check.
 *
 * A missing entry passes, so each caller keeps its own "not found" handling.
 * `resolveSessionId` throws the same error for the same entry.
 *
 * Throws {@link SessionNotADirectoryError}, or the {@link inspectSessionEntry}
 * errors.
 */
export async function assertSessionDirSafe(paths: BasouPaths, sessionId: string): Promise<void> {
  const kind = await inspectSessionEntry(paths, sessionId);
  if (kind === "symlink" || kind === "not_a_directory") {
    throw new SessionNotADirectoryError(sessionId, kind);
  }
}

/** A file basou keeps in a session's directory and reads back. */
export type SessionFileName = "events.jsonl" | "session.yaml";

/**
 * What is at a session file's name, judged without following symlinks:
 *
 * - `file` — a regular file.
 * - `symlink` — a symlink, whatever it points to.
 * - `not_a_file` — anything else: a directory, a FIFO, a socket, a device.
 * - `missing` — nothing.
 */
export type SessionFileKind = "file" | "symlink" | "not_a_file" | "missing";

/**
 * Thrown where a session's `events.jsonl` or `session.yaml` is read and the
 * entry at that name is not a regular file: a symlink, whatever it points to,
 * or anything else (a directory, a FIFO). It is not followed, so nothing is
 * read from outside the store and no read waits on a FIFO. `file` says which
 * file, and `kind` what is there, as {@link lstatSessionFile} classifies it.
 *
 * The message is `<file> of session <id> is not a regular file; a symlink or
 * anything else there is not followed`. Tell this refusal apart by its class,
 * not by the message.
 */
export class SessionFileNotAFileError extends Error {
  readonly sessionId: string;
  readonly file: SessionFileName;
  readonly kind: "symlink" | "not_a_file";

  constructor(sessionId: string, file: SessionFileName, kind: "symlink" | "not_a_file") {
    super(
      `${file} of session ${sessionId} is not a regular file; a symlink or anything else there is not followed`,
    );
    this.name = "SessionFileNotAFileError";
    this.sessionId = sessionId;
    this.file = file;
    this.kind = kind;
  }
}

/**
 * Classify `<paths.sessions>/<sessionId>/<file>` without following it (see
 * {@link SessionFileKind}), for a session whose entry the caller has already
 * found to be a directory. Rethrows an lstat failure other than ENOENT as it
 * is, for the caller to wrap in its own fixed message.
 *
 * Like the checks of the session's entry, this detects a file already
 * swapped; it does not race-proof the filesystem.
 */
export async function lstatSessionFile(
  paths: BasouPaths,
  sessionId: string,
  file: SessionFileName,
): Promise<SessionFileKind> {
  try {
    const entry = await lstat(join(paths.sessions, sessionId, file));
    if (entry.isSymbolicLink()) return "symlink";
    return entry.isFile() ? "file" : "not_a_file";
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

/**
 * What is at each of a session's files (see {@link SessionFileKind}), for a
 * session whose entry the caller has already found to be a directory.
 *
 * Throws `Error("Failed to read <file>", { cause })` on an lstat failure
 * other than ENOENT.
 */
export async function inspectSessionFiles(
  paths: BasouPaths,
  sessionId: string,
): Promise<Record<SessionFileName, SessionFileKind>> {
  const kinds = {} as Record<SessionFileName, SessionFileKind>;
  for (const file of ["events.jsonl", "session.yaml"] as const) {
    try {
      kinds[file] = await lstatSessionFile(paths, sessionId, file);
    } catch (error: unknown) {
      throw new Error(`Failed to read ${file}`, { cause: error });
    }
  }
  return kinds;
}

/** Whether a {@link SessionFileKind} is one that is not followed. */
export function isUnfollowedFile(kind: SessionFileKind): kind is "symlink" | "not_a_file" {
  return kind === "symlink" || kind === "not_a_file";
}

/**
 * The first of a session's files that is there but is not a regular file,
 * `events.jsonl` before `session.yaml`, or `null` when neither is. For a
 * session whose entry the caller has already found to be a directory.
 *
 * Throws the {@link inspectSessionFiles} errors.
 */
export async function findUnfollowedSessionFile(
  paths: BasouPaths,
  sessionId: string,
): Promise<{ file: SessionFileName; kind: "symlink" | "not_a_file" } | null> {
  const kinds = await inspectSessionFiles(paths, sessionId);
  for (const file of ["events.jsonl", "session.yaml"] as const) {
    const kind = kinds[file];
    if (isUnfollowedFile(kind)) return { file, kind };
  }
  return null;
}

/**
 * Read the bytes of a session's `file` when it is a regular file, or `null`
 * when there is none, for a session whose entry the caller has already found
 * to be a directory. The file is not followed: a symlink or anything else
 * there throws {@link SessionFileNotAFileError} before anything is read.
 *
 * Throws `Error("Failed to read <file>", { cause })` on any other failure.
 */
export async function readSessionFile(
  paths: BasouPaths,
  sessionId: string,
  file: SessionFileName,
): Promise<Buffer | null> {
  let kind: SessionFileKind;
  try {
    kind = await lstatSessionFile(paths, sessionId, file);
  } catch (error: unknown) {
    throw new Error(`Failed to read ${file}`, { cause: error });
  }
  if (kind === "missing") return null;
  if (kind !== "file") throw new SessionFileNotAFileError(sessionId, file, kind);
  try {
    return await readFile(join(paths.sessions, sessionId, file));
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return null;
    throw new Error(`Failed to read ${file}`, { cause: error });
  }
}
