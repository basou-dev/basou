import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { type Event, EventSchema } from "../schemas/event.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { acquireLock } from "../storage/lockfile.js";
import { genesisHash, lineHash, serializeEventLine } from "./chain.js";

/**
 * The chain state of an existing `events.jsonl`, as needed by the live append
 * and finalize paths.
 *
 * - `chained` — whether the NEXT line written to this log must carry a
 *   `prev_hash`. True for an empty / not-yet-created log (a fresh session
 *   chains from its genesis) and for a log whose FIRST complete line already
 *   carries `prev_hash`. False for a legacy / pre-feature log whose first line
 *   is unchained (so it stays unchained — we never half-chain a file).
 * - `head` — the `prev_hash` value the next line carries when `chained`:
 *   `genesisHash(sessionId)` for an empty log, otherwise `lineHash` of the LAST
 *   complete line's raw bytes. Meaningless (set to the genesis hash) when
 *   `chained` is false.
 * - `count` — number of complete (newline-terminated) lines on disk; the
 *   `event_count` an integrity anchor records.
 */
export type ChainTailState = {
  chained: boolean;
  head: string;
  count: number;
};

// Byte-level line split on 0x0A. The caller guarantees the buffer is
// newline-terminated, so every returned entry is a complete line and there is
// no trailing fragment. Subarray views, no copying.
function splitLinesBytes(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

// Does this raw line decode to a JSON object carrying a top-level `prev_hash`?
// A line that fails to parse is treated as not carrying one (our writers never
// emit such a line; verify is the detector for a corrupt chained log).
function carriesPrevHash(line: Buffer): boolean {
  try {
    const obj: unknown = JSON.parse(line.toString("utf8"));
    return typeof obj === "object" && obj !== null && "prev_hash" in obj;
  } catch {
    return false;
  }
}

/**
 * Inspect `<sessions>/<sessionId>/events.jsonl` to decide how the next append
 * (or the finalize anchor) must treat the chain. READ-ONLY; the caller MUST
 * already hold the session lock so the inspected tail cannot move underneath a
 * subsequent append.
 *
 * Chained-ness is decided from the FIRST complete line (does the log claim to
 * be chained), and the head pointer is taken from the LAST complete line. If
 * the first and last lines DISAGREE — a mixed / partially-tampered file — the
 * call THROWS rather than extending a broken chain; verify is the detector, the
 * writer must not deepen a break. An unterminated final line (a torn tail from
 * a crashed prior append) also THROWS so a new line is never glued onto a
 * fragment.
 *
 * Throws `Error("Failed to read events.jsonl")` for non-ENOENT I/O,
 * `Error("Unterminated final line in events.jsonl")` for a torn tail, and
 * `Error("events.jsonl is partially chained")` for a mixed first/last line.
 */
export async function inspectChainTail(
  paths: BasouPaths,
  sessionId: string,
): Promise<ChainTailState> {
  const filePath = join(paths.sessions, sessionId, "events.jsonl");
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      // A not-yet-created log: the first append chains from the session genesis.
      return { chained: true, head: genesisHash(sessionId), count: 0 };
    }
    throw new Error("Failed to read events.jsonl", { cause: error });
  }
  if (raw.length === 0) {
    return { chained: true, head: genesisHash(sessionId), count: 0 };
  }
  if (raw[raw.length - 1] !== 0x0a) {
    throw new Error("Unterminated final line in events.jsonl");
  }
  const lines = splitLinesBytes(raw);
  const first = lines[0] as Buffer;
  const last = lines[lines.length - 1] as Buffer;
  const firstChained = carriesPrevHash(first);
  if (firstChained !== carriesPrevHash(last)) {
    throw new Error("events.jsonl is partially chained");
  }
  return {
    chained: firstChained,
    head: firstChained ? lineHash(last) : genesisHash(sessionId),
    count: lines.length,
  };
}

/**
 * Append one event to `<sessions>/<sessionId>/events.jsonl`, threading the
 * tamper-evidence hash chain. The caller MUST already hold the session lock
 * (`acquireLock(paths, "session", sessionId)`); this function does NOT acquire
 * it, so it composes inside a larger caller-owned critical section (the
 * convention used by `decision record`, `session note`, task attach and
 * approval resolution) without re-entrant lock deadlock.
 *
 * The event is validated against {@link EventSchema}, then — if the existing
 * log is chained (or empty) — written with a `prev_hash` back-pointer derived
 * from the real on-disk tail (see {@link inspectChainTail}); a legacy unchained
 * log keeps receiving plain unchained lines. The single serializer
 * ({@link serializeEventLine}) is shared with the bulk writers so the bytes a
 * chain hashes can never diverge from another path's bytes.
 *
 * Does NOT touch `session.yaml.integrity`: the head anchor is written once, at
 * the terminal-status finalize, by {@link finalizeSessionYaml}. A still-live
 * session therefore has a chained log but no anchor yet, which `verify` reports
 * as the benign `in_progress`.
 *
 * Throws `"Invalid Basou event payload"` on validation failure, the
 * {@link inspectChainTail} errors on a torn / mixed log, or `"Failed to append
 * event to events.jsonl"` on a disk failure. The native error is attached as
 * `cause`.
 */
export async function appendChainedEventLocked(
  paths: BasouPaths,
  sessionId: string,
  event: unknown,
): Promise<{ chained: boolean }> {
  let validated: Event;
  try {
    validated = EventSchema.parse(event);
  } catch (error: unknown) {
    throw new Error("Invalid Basou event payload", { cause: error });
  }
  const tail = await inspectChainTail(paths, sessionId);
  const line = tail.chained
    ? serializeEventLine({ ...validated, prev_hash: tail.head })
    : serializeEventLine(validated);
  try {
    await appendFile(join(paths.sessions, sessionId, "events.jsonl"), `${line}\n`, "utf8");
  } catch (error: unknown) {
    throw new Error("Failed to append event to events.jsonl", { cause: error });
  }
  return { chained: tail.chained };
}

/**
 * Self-locking wrapper around {@link appendChainedEventLocked} for callers that
 * do NOT already hold the session lock (the `exec` / `run` orchestrators, which
 * append one event at a time to a session they own). Acquires the session lock,
 * appends, and releases. Each append is a short-lived lock hold — the lock is
 * NEVER held across a child process — so a foreign attach can interleave safely
 * and the next append chains onto the true tail.
 */
export async function appendChainedEvent(
  paths: BasouPaths,
  sessionId: string,
  event: unknown,
): Promise<{ chained: boolean }> {
  const lock = await acquireLock(paths, "session", sessionId);
  try {
    return await appendChainedEventLocked(paths, sessionId, event);
  } finally {
    await lock.release();
  }
}
