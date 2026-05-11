import { randomUUID } from "node:crypto";
import { appendFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Event, EventSchema } from "../schemas/event.schema.js";

/**
 * Append a single Basou event to `<sessionDir>/events.jsonl`.
 *
 * The event is validated against the discriminated union {@link EventSchema}
 * before being serialized as a single JSONL line (UTF-8, terminated by `\n`).
 * Validation enforces the per-variant contract (required fields, source
 * vocabulary, strict variants such as `adapter_output`).
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
  const line = `${JSON.stringify(validated)}\n`;
  try {
    await appendFile(join(sessionDir, "events.jsonl"), line, "utf8");
  } catch (error: unknown) {
    throw new Error("Failed to append event to events.jsonl", { cause: error });
  }
}

/**
 * Write `events.jsonl` in one atomic tmp+rename pass, validating every event
 * against {@link EventSchema} before any disk I/O so a payload that fails
 * validation never leaves a partial file behind.
 *
 * The helper is used by the round-trip importer (`session-import.ts`) and the
 * ad-hoc session orchestrator (`ad-hoc-session.ts`) where a small, fixed batch
 * of events must land together or not at all. Zero events produces a
 * zero-byte file so the session_yaml `events_log` pointer remains valid.
 *
 * Throws `"Invalid Basou event payload"` (same fixed message as
 * {@link appendEvent}) on validation failure, or `"Failed to write
 * events.jsonl"` on a disk I/O failure. The original native error is attached
 * as `cause`. The tmp file is best-effort unlinked on any failure so disk
 * never carries a half-written rename source.
 */
export async function writeEventsBulk(sessionDir: string, events: Event[]): Promise<void> {
  const validated: Event[] = [];
  try {
    for (const event of events) {
      validated.push(EventSchema.parse(event));
    }
  } catch (error: unknown) {
    throw new Error("Invalid Basou event payload", { cause: error });
  }
  const filePath = join(sessionDir, "events.jsonl");
  const body =
    validated.length > 0 ? `${validated.map((e) => JSON.stringify(e)).join("\n")}\n` : "";
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, body, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error("Failed to write events.jsonl", { cause: error });
  }
}
