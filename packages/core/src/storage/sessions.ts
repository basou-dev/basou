import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { findErrorCode } from "../lib/error-codes.js";
import { type Session, SessionSchema } from "../schemas/session.schema.js";
import type { BasouPaths } from "./basou-dir.js";
import { readYamlFile } from "./yaml-store.js";

/**
 * Threshold above which a still-`running` session with no `session_ended`
 * event is flagged suspect.
 *
 * 24h: long enough that an active long-running session will not be flagged,
 * short enough that an abandoned process is surfaced within a working day.
 * Tunable via CLI option in a later step (continuation backlog #23).
 */
export const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type SuspectReason = "events_say_ended_but_yaml_running" | "running_no_end_event";

export type SessionEntry = {
  sessionId: string;
  session: Session;
  suspect: boolean;
  suspectReason: SuspectReason | null;
};

/**
 * Per-session degradation reason emitted by {@link loadSessionEntries.onSkip}.
 *
 * - `session_yaml_missing` (ENOENT) and `session_yaml_invalid` (parse or schema
 *   failure) both omit the entry from the result.
 * - `events_jsonl_unreadable` still pushes the entry with `suspect=false` so
 *   the session row remains visible to the caller; only the suspect check is
 *   degraded. Matches the existing CLI behaviour at
 *   `packages/cli/src/commands/session.ts` (suspect-check stderr warning).
 */
export type SessionSkipReason =
  | "session_yaml_missing"
  | "session_yaml_invalid"
  | "events_jsonl_unreadable";

export type LoadSessionEntriesOptions = {
  /**
   * Single `now` shared across every {@link classifySuspect} call so that
   * sessions classified back-to-back observe the same instant. Avoids
   * boundary races where a session at age ≈ 24h would flip between calls.
   */
  now: Date;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSkip?: (sessionId: string, reason: SessionSkipReason) => void;
};

/**
 * List session directory names under `paths.sessions`, ULID ascending.
 *
 * - Returns `[]` when the sessions directory does not exist (empty workspace
 *   or pre-init state).
 * - Throws `Error("Failed to enumerate sessions", { cause })` on other I/O.
 * - Only directories are returned (`.gitkeep` and other files are filtered).
 *
 * Sort order is `Array.prototype.sort()` default (Unicode code-point
 * compare). ULIDs are Crockford base32 in uppercase, so the natural sort
 * is also chronological session-start order.
 */
export async function enumerateSessionDirs(paths: BasouPaths): Promise<string[]> {
  try {
    const dirents = await readdir(paths.sessions, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return [];
    throw new Error("Failed to enumerate sessions", { cause: error });
  }
}

/**
 * Read and validate `<paths.sessions>/<sessionId>/session.yaml`.
 *
 * - Re-throws the yaml-store fixed-message `"YAML file not found"` for
 *   ENOENT so the caller can branch on it.
 * - Throws `Error("Failed to read session.yaml", { cause })` for parse
 *   failures and schema violations (cause is either the YAML parser error
 *   or the zod error).
 */
export async function readSessionYaml(paths: BasouPaths, sessionId: string): Promise<Session> {
  const filePath = join(paths.sessions, sessionId, "session.yaml");
  let raw: unknown;
  try {
    raw = await readYamlFile(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") throw error;
    throw new Error("Failed to read session.yaml", { cause: error });
  }
  const result = SessionSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("Failed to read session.yaml", { cause: result.error });
  }
  return result.data;
}

/**
 * Classify a `running` session as suspect using one of two rules:
 *
 * - Rule A (`events_say_ended_but_yaml_running`): events.jsonl contains a
 *   `session_ended` event but the session.yaml is still `running`. The
 *   session ended cleanly in the event log but the YAML write was lost or
 *   never reached.
 * - Rule B (`running_no_end_event`): no `session_ended` event and the last
 *   event is older than {@link STUCK_THRESHOLD_MS}. The process likely
 *   crashed or was killed.
 *
 * Sessions that are not `running` are never suspect.
 *
 * I/O failure on events.jsonl is re-thrown unwrapped so the caller can
 * degrade with a warning instead of treating the session as healthy. The
 * caller is also responsible for surfacing replay warnings via `onWarning`.
 */
export async function classifySuspect(
  paths: BasouPaths,
  sessionId: string,
  session: Session,
  now: Date,
  onWarning?: (warning: ReplayWarning) => void,
): Promise<{ suspect: boolean; suspectReason: SuspectReason | null }> {
  if (session.session.status !== "running") {
    return { suspect: false, suspectReason: null };
  }
  const sessionDir = join(paths.sessions, sessionId);
  let endedFound = false;
  let lastEventOccurredAt: string | null = null;
  // Forward onWarning only when supplied — `exactOptionalPropertyTypes`
  // rejects passing a literal `undefined` for an optional property.
  const replayOpts = onWarning !== undefined ? { onWarning } : {};
  for await (const ev of replayEvents(sessionDir, replayOpts)) {
    lastEventOccurredAt = ev.occurred_at;
    if (ev.type === "session_ended") endedFound = true;
  }
  if (endedFound) {
    return { suspect: true, suspectReason: "events_say_ended_but_yaml_running" };
  }
  if (lastEventOccurredAt !== null) {
    const ageMs = now.getTime() - Date.parse(lastEventOccurredAt);
    if (Number.isFinite(ageMs) && ageMs > STUCK_THRESHOLD_MS) {
      return { suspect: true, suspectReason: "running_no_end_event" };
    }
  }
  return { suspect: false, suspectReason: null };
}

/**
 * High-level helper that enumerates session dirs, reads each `session.yaml`,
 * and classifies suspect for `running` sessions in one pass.
 *
 * Per-session degradations are surfaced via `options.onSkip`:
 * - `session_yaml_missing` (ENOENT) and `session_yaml_invalid` (parse or
 *   schema violation): the entry is omitted from the result.
 * - `events_jsonl_unreadable`: the entry is still pushed with `suspect=false`
 *   so callers can render the session row plus a CLI-side warning.
 *
 * `options.now` is taken once and threaded into every {@link classifySuspect}
 * call so age comparisons are consistent across sessions.
 */
export async function loadSessionEntries(
  paths: BasouPaths,
  options: LoadSessionEntriesOptions,
): Promise<SessionEntry[]> {
  const sessionIds = await enumerateSessionDirs(paths);
  const entries: SessionEntry[] = [];
  for (const sid of sessionIds) {
    let session: Session;
    try {
      session = await readSessionYaml(paths, sid);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "YAML file not found") {
        options.onSkip?.(sid, "session_yaml_missing");
      } else {
        options.onSkip?.(sid, "session_yaml_invalid");
      }
      continue;
    }
    let suspect = false;
    let suspectReason: SuspectReason | null = null;
    try {
      const r = await classifySuspect(paths, sid, session, options.now, (w) =>
        options.onWarning?.(w, sid),
      );
      suspect = r.suspect;
      suspectReason = r.suspectReason;
    } catch {
      // events.jsonl I/O failure (EACCES etc.) on the suspect check is
      // unrecoverable for the classification but should not drop the session
      // entry. Surface a dedicated reason so the caller can distinguish a
      // broken events.jsonl from a broken session.yaml.
      options.onSkip?.(sid, "events_jsonl_unreadable");
    }
    entries.push({ sessionId: sid, session, suspect, suspectReason });
  }
  return entries;
}
