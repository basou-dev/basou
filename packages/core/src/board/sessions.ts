import { lstat, readFile } from "node:fs/promises";
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

/**
 * How many of the lines of an events log that were not JSON were lost events:
 * all but a torn last line, one with no newline after it, which is a write
 * that has not finished. The log is read once, however many there are.
 */
export async function lostAmong(eventsLog: string, malformed: readonly number[]): Promise<number> {
  let body: Buffer;
  try {
    body = await readFile(eventsLog);
  } catch {
    return malformed.length;
  }
  if (body.length === 0 || body[body.length - 1] === 0x0a) return malformed.length;
  let newlines = 0;
  for (const byte of body) if (byte === 0x0a) newlines++;
  return malformed.filter((lineNo) => lineNo !== newlines + 1).length;
}
