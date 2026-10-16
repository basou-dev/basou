import { createReadStream } from "node:fs";
import { join } from "node:path";
import { type Event, EventSchema } from "../schemas/event.schema.js";
import { normalizeEventTimestamps } from "../schemas/iso-timestamp.js";
import { hasRetiredZeroDuration } from "../schemas/observed-duration.js";
import { SessionIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import {
  lstatSessionEntry,
  lstatSessionFile,
  type SessionEntryKind,
  type SessionFileKind,
  SessionFileNotAFileError,
  SessionNotADirectoryError,
} from "../storage/session-dir.js";

/**
 * Recoverable warning surfaced via {@link ReplayOptions.onWarning}. The replay
 * generator never throws on these — it skips the offending line and continues.
 *
 * `partial_trailing_line` indicates the events.jsonl did not end with `\n` and
 * the unterminated tail parsed as a complete event. The line is dropped
 * instead of yielded so consumers cannot accidentally observe a
 * partially-written record.
 *
 * `retired_zero_duration` is ADVISORY: the line is valid and IS yielded. It
 * reports a `command_executed` carrying `duration_ms: 0` on an event version
 * whose writers never produce one, which no basou writer can create (they are
 * guarded) but a third party using this package's writers, or another host
 * reached through the federation reader, could. See `hasRetiredZeroDuration`.
 */
export type ReplayWarning =
  | { kind: "partial_trailing_line"; line: number }
  | { kind: "malformed_json"; line: number; cause: unknown }
  | { kind: "schema_violation"; line: number; cause: unknown }
  | { kind: "retired_zero_duration"; line: number };

export type ReplayOptions = {
  /**
   * Hook to receive recoverable warnings (partial line / malformed JSON /
   * schema violation). When omitted, warnings are silently dropped — callers
   * that want to surface them (e.g. CLI orchestration) MUST provide this hook.
   */
  onWarning?: (warning: ReplayWarning) => void;
};

/**
 * Stream the events of session `sessionId` from
 * `<paths.sessions>/<sessionId>/events.jsonl` line by line.
 *
 * Behavior:
 * - The entry at the session's name is checked first, without following it:
 *   a symlink or a file throws {@link SessionNotADirectoryError}, and an id
 *   that is not a session id throws `Error("Invalid session id")`. The store
 *   (`.basou/sessions`) itself is not checked here; the listing or resolver
 *   that produced the id checks the local one, and a federated mirror's may
 *   be a symlink.
 * - No entry, ENOENT on events.jsonl, or an empty file: yields nothing
 *   without warning.
 * - An events.jsonl that is a symlink, whatever it points to, or anything but
 *   a regular file (a directory, a FIFO) is not followed: it throws
 *   {@link SessionFileNotAFileError} before anything is read.
 * - I/O error: throws `Error("Failed to read events.jsonl")` with the native
 *   error attached as `cause`. The thrown message never embeds an absolute
 *   path (pathless contract).
 * - Trailing partial line that parses as a valid event: dropped silently when
 *   {@link ReplayOptions.onWarning} is omitted; otherwise reported as
 *   `partial_trailing_line`. A trailing partial line that fails JSON parsing
 *   is reported as `malformed_json` instead.
 * - Malformed JSON / schema violation: skipped, with the corresponding
 *   warning when a hook is provided.
 *
 * Single-writer-per-session is assumed (see `event-writer.ts` JSDoc on
 * {@link appendEvent}). Concurrent writers may interleave lines beyond
 * `PIPE_BUF` and are not recovered here in v0.1.
 */
// NOTE: switched from plan A (Transform stream + readline) to plan B (manual
// chunk-level split) because plan A's source-stream errors do not propagate
// through `pipe()` to the readline iterator, so an EACCES on the events.jsonl
// hangs the for-await loop instead of throwing. Plan B observes errors
// directly via the for-await over `createReadStream` and reaches end-of-stream
// deterministically with the trailing buffer in hand.
export async function* replayEvents(
  paths: BasouPaths,
  sessionId: string,
  options: ReplayOptions = {},
): AsyncGenerator<Event, void, void> {
  if (!SessionIdSchema.safeParse(sessionId).success) throw new Error("Invalid session id");
  let entry: SessionEntryKind;
  try {
    entry = await lstatSessionEntry(paths.sessions, sessionId);
  } catch (error: unknown) {
    throw new Error("Failed to read events.jsonl", { cause: error });
  }
  if (entry === "symlink" || entry === "not_a_directory") {
    throw new SessionNotADirectoryError(sessionId, entry);
  }
  const filePath = join(paths.sessions, sessionId, "events.jsonl");

  // Probe the file first, without following it, so ENOENT (= empty session)
  // is silent, a symlink or anything but a regular file (a FIFO would block
  // the read) is refused, and every other I/O failure surfaces as a single
  // fixed-message error.
  let file: SessionFileKind;
  try {
    file = await lstatSessionFile(paths, sessionId, "events.jsonl");
  } catch (error: unknown) {
    throw new Error("Failed to read events.jsonl", { cause: error });
  }
  if (file === "missing") return;
  if (file !== "file") throw new SessionFileNotAFileError(sessionId, "events.jsonl", file);

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch (error: unknown) {
    throw new Error("Failed to read events.jsonl", { cause: error });
  }

  let buffer = "";
  let lineNo = 0;

  try {
    for await (const chunk of stream as unknown as AsyncIterable<string>) {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        lineNo += 1;
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const ev = processLine(rawLine, lineNo, options);
        if (ev !== null) yield ev;
        newlineIdx = buffer.indexOf("\n");
      }
    }
  } catch (error: unknown) {
    throw new Error("Failed to read events.jsonl", { cause: error });
  }

  // Stream ended mid-line: anything left in `buffer` is the trailing partial
  // line. Empty / whitespace-only trailing content is treated as a normal end
  // of file (e.g. a final '\n' was stripped by the loop above).
  const trimmed = buffer.replace(/[\r\n\t ]+$/u, "");
  if (trimmed.length === 0) return;
  lineNo += 1;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    // The trailing buffer was non-empty AND JSON-invalid. Either
    // partial_trailing_line or malformed_json captures the same observable
    // outcome; we surface malformed_json because the JSON layer rejected it
    // first and the line number is meaningful for the consumer.
    options.onWarning?.({ kind: "malformed_json", line: lineNo, cause });
    return;
  }

  const result = EventSchema.safeParse(normalizeEventTimestamps(parsed));
  if (!result.success) {
    options.onWarning?.({ kind: "schema_violation", line: lineNo, cause: result.error });
    return;
  }

  // Valid JSON + valid event schema BUT no terminating newline. Drop instead
  // of yielding so a half-flushed write cannot be consumed as a real event.
  options.onWarning?.({ kind: "partial_trailing_line", line: lineNo });
}

function processLine(rawLine: string, lineNo: number, options: ReplayOptions): Event | null {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    options.onWarning?.({ kind: "malformed_json", line: lineNo, cause });
    return null;
  }
  const result = EventSchema.safeParse(normalizeEventTimestamps(parsed));
  if (!result.success) {
    options.onWarning?.({ kind: "schema_violation", line: lineNo, cause: result.error });
    return null;
  }
  // Advisory only: the event is valid and is yielded either way. A reader
  // treats this 0 as unobserved regardless (readObservedDuration), so nothing
  // downstream is wrong -- but the value should not exist at this version, and
  // silently reinterpreting it would leave the version bump unverifiable.
  if (hasRetiredZeroDuration(result.data)) {
    options.onWarning?.({ kind: "retired_zero_duration", line: lineNo });
  }
  return result.data;
}

/**
 * Eager array helper: collect every event from {@link replayEvents} into
 * memory. Convenience for callers that need the full list in one structure
 * (e.g. `basou session show` rendering).
 */
export async function readAllEvents(
  paths: BasouPaths,
  sessionId: string,
  options: ReplayOptions = {},
): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of replayEvents(paths, sessionId, options)) {
    out.push(ev);
  }
  return out;
}
