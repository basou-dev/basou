import { lstat } from "node:fs/promises";
import type { BasouPaths } from "../storage/basou-dir.js";
import { enumerateSessionEntries, type SessionDirEntries } from "../storage/sessions.js";

/** The entries named as sessions in the workspace's store, or why they were not listed. */
export type ListedSessions = ({ ok: true } & SessionDirEntries) | { ok: false; reason: string };

/**
 * List the workspace's sessions for a section of a measurement. A
 * `.basou/sessions` that is a symlink or not a directory is refused, as every
 * command refuses it, and the reason says so rather than that it could not be
 * read.
 */
export async function listSessions(paths: BasouPaths): Promise<ListedSessions> {
  try {
    const entry = await lstat(paths.sessions);
    if (entry.isSymbolicLink()) {
      return { ok: false, reason: ".basou/sessions is a symlink, which basou refuses to read" };
    }
    if (!entry.isDirectory()) {
      return { ok: false, reason: ".basou/sessions is not a directory" };
    }
  } catch {
    // An absent store has no session; any other failure is the listing's to report.
  }
  try {
    return { ok: true, ...(await enumerateSessionEntries(paths)) };
  } catch {
    return { ok: false, reason: "the sessions of the workspace could not be read" };
  }
}
