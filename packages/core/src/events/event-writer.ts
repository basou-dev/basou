import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Event, EventSchema } from "../schemas/event.schema.js";
import { atomicReplace } from "../storage/atomic.js";
import { chainEvents, serializeEventLine } from "./chain.js";

/**
 * Append a single Basou event to `<sessionDir>/events.jsonl`.
 *
 * The event is validated against the discriminated union {@link EventSchema}
 * before being serialized as a single JSONL line (UTF-8, terminated by `\n`).
 * Validation enforces the per-variant contract (required fields, source
 * vocabulary, strict variants such as `adapter_output`).
 *
 * Appended lines are NOT hash-chained: chaining is exclusive to the bulk
 * import writers ({@link writeEventsBulk} with `chain: true`), and imported
 * sessions reject every append path, so a chained file never receives an
 * unchained appended line.
 *
 * Atomicity: writes go through `appendFile` which uses `O_APPEND`. Lines up
 * to `PIPE_BUF` bytes (Linux 4096 / macOS 512) are written atomically by the
 * kernel; longer lines may interleave with concurrent writers and are not
 * recovered here. v0.1 assumes a single writer per session, so partial-line
 * recovery is delegated to the read side (event replay) when introduced.
 *
 * Throws if validation fails or the underlying append errors. The thrown
 * Error message is pathless; the original error is attached as `cause`.
 *
 * @param sessionDir absolute path to `.basou/sessions/<session_id>/`
 * @param event unknown payload to validate and append
 */
export async function appendEvent(sessionDir: string, event: unknown): Promise<void> {
  let validated: ReturnType<typeof EventSchema.parse>;
  try {
    validated = EventSchema.parse(event);
  } catch (error: unknown) {
    throw new Error("Invalid Basou event payload", { cause: error });
  }
  const line = `${serializeEventLine(validated)}\n`;
  try {
    await appendFile(join(sessionDir, "events.jsonl"), line, "utf8");
  } catch (error: unknown) {
    throw new Error("Failed to append event to events.jsonl", { cause: error });
  }
}

/** Options for {@link writeEventsBulk}. */
export type WriteEventsBulkOptions = {
  /**
   * Thread a per-line `prev_hash` hash chain through the batch and return the
   * head anchor inputs. Used ONLY by the import writers (fresh import and
   * in-place re-import); defaults to false so the live / ad-hoc writers keep
   * producing plain unchained lines.
   */
  chain?: boolean;
};

/** Head anchor inputs returned by a chained {@link writeEventsBulk}. */
export type BulkChainResult = {
  /** Hex sha-256 of the last written line (excluding the trailing `\n`). */
  headHash: string;
  /** Number of chained lines written. */
  count: number;
};

/**
 * Write `events.jsonl` in one atomic tmp+rename pass via {@link atomicReplace},
 * validating every event against {@link EventSchema} before any disk I/O so
 * a payload that fails validation never leaves a partial file behind.
 *
 * The helper is used by the round-trip importer (`session-import.ts`) and the
 * ad-hoc session orchestrator (`ad-hoc-session.ts`) where a small, fixed batch
 * of events must land together or not at all. Zero events produces a
 * zero-byte file so the session_yaml `events_log` pointer remains valid.
 *
 * With `options.chain` set, each line is written with a `prev_hash`
 * back-pointer (any incoming `prev_hash` is discarded and recomputed; the
 * chain's genesis is bound to `basename(sessionDir)` = the session id) and
 * the head anchor inputs are returned so the caller can persist
 * `session.yaml.integrity`. An empty chained batch writes a zero-byte file
 * and returns null — no anchor. Without `chain` the return value is null and
 * the written bytes are identical to the previous unchained format.
 *
 * Throws `"Invalid Basou event payload"` (same fixed message as
 * {@link appendEvent}) on validation failure, or `"Failed to write
 * events.jsonl"` on a disk I/O failure. The original native error is attached
 * as `cause`.
 */
export async function writeEventsBulk(
  sessionDir: string,
  events: Event[],
  options: WriteEventsBulkOptions = {},
): Promise<BulkChainResult | null> {
  const validated: Event[] = [];
  try {
    for (const event of events) {
      validated.push(EventSchema.parse(event));
    }
  } catch (error: unknown) {
    throw new Error("Invalid Basou event payload", { cause: error });
  }
  const filePath = join(sessionDir, "events.jsonl");

  let body: string;
  let result: BulkChainResult | null = null;
  if (options.chain === true) {
    const { lines, headHash, count } = chainEvents(validated, basename(sessionDir));
    body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    result = count > 0 ? { headHash, count } : null;
  } else {
    body = validated.length > 0 ? `${validated.map(serializeEventLine).join("\n")}\n` : "";
  }

  try {
    await atomicReplace(filePath, body);
  } catch (error: unknown) {
    throw new Error("Failed to write events.jsonl", { cause: error });
  }
  return result;
}
