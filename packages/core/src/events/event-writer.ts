import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { EventSchema } from "../schemas/event.schema.js";

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
