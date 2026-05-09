import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { type Event, EventSchema } from "../schemas/event.schema.js";

/**
 * Recoverable warning surfaced via {@link ReplayOptions.onWarning}. The replay
 * generator never throws on these — it skips the offending line and continues.
 *
 * `partial_trailing_line` indicates the events.jsonl did not end with `\n` and
 * the unterminated tail parsed as a complete event. The line is dropped
 * instead of yielded so consumers cannot accidentally observe a
 * partially-written record.
 */
export type ReplayWarning =
  | { kind: "partial_trailing_line"; line: number }
  | { kind: "malformed_json"; line: number; cause: unknown }
  | { kind: "schema_violation"; line: number; cause: unknown };

export type ReplayOptions = {
  /**
   * Hook to receive recoverable warnings (partial line / malformed JSON /
   * schema violation). When omitted, warnings are silently dropped — callers
   * that want to surface them (e.g. CLI orchestration) MUST provide this hook.
   */
  onWarning?: (warning: ReplayWarning) => void;
};

/**
 * Stream events from `<sessionDir>/events.jsonl` line by line.
 *
 * Behavior:
 * - ENOENT or empty file: yields nothing without warning.
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
  sessionDir: string,
  options: ReplayOptions = {},
): AsyncGenerator<Event, void, void> {
  const filePath = join(sessionDir, "events.jsonl");

  // Probe existence first so ENOENT (= empty session) is silent while every
  // other I/O failure surfaces as a single fixed-message error.
  try {
    await stat(filePath);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return;
    throw new Error("Failed to read events.jsonl", { cause: error });
  }

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

  const result = EventSchema.safeParse(parsed);
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
  const result = EventSchema.safeParse(parsed);
  if (!result.success) {
    options.onWarning?.({ kind: "schema_violation", line: lineNo, cause: result.error });
    return null;
  }
  return result.data;
}

/**
 * Eager array helper: collect every event from {@link replayEvents} into
 * memory. Convenience for callers that need the full list in one structure
 * (e.g. `basou session show` rendering).
 */
export async function readAllEvents(
  sessionDir: string,
  options: ReplayOptions = {},
): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of replayEvents(sessionDir, options)) {
    out.push(ev);
  }
  return out;
}
