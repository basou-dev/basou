import { createHash } from "node:crypto";
import type { Event } from "../schemas/event.schema.js";

// Domain-separation prefix for the chain's genesis hash. Versioned so a
// future chain format can re-anchor without colliding with v1 hashes.
const GENESIS_PREFIX = "basou:event-chain:v1:";

/**
 * Session-bound genesis hash: the `prev_hash` carried by the FIRST event line
 * of a chained `events.jsonl`. Binding the genesis to the session id means a
 * chain copied verbatim from another session fails verification at line 1
 * even though its internal back-pointers are intact.
 */
export function genesisHash(sessionId: string): string {
  return createHash("sha256").update(`${GENESIS_PREFIX}${sessionId}`, "utf8").digest("hex");
}

/**
 * Hex sha-256 of one event line's written bytes (EXCLUDING the trailing
 * `\n`). The hash covers the literal serialized bytes — no canonical JSON
 * form. Writers pass the line string (always valid UTF-8, so its UTF-8
 * encoding IS the written bytes); the verifier passes the RAW BYTES it read,
 * so a byte-level mutation that decodes to the same string (e.g. an invalid
 * UTF-8 sequence collapsing to U+FFFD) still breaks the chain.
 */
export function lineHash(rawLine: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof rawLine === "string") {
    hash.update(rawLine, "utf8");
  } else {
    hash.update(rawLine);
  }
  return hash.digest("hex");
}

/**
 * The single serializer for event lines. Every writer (bulk and append) MUST
 * go through this function so the bytes a chain hashes can never diverge from
 * the bytes another code path would write.
 */
export function serializeEventLine(event: Event): string {
  return JSON.stringify(event);
}

/** Result of {@link chainEvents}: the serialized lines plus the head anchor inputs. */
export type ChainedEvents = {
  /** Serialized event lines (no trailing newline on the entries). */
  lines: string[];
  /**
   * Hex sha-256 of the LAST line — the value `session.yaml.integrity.head_hash`
   * anchors. For an empty batch this is the genesis hash and no anchor is
   * written.
   */
  headHash: string;
  /** Number of chained lines (= `integrity.event_count`). */
  count: number;
};

/**
 * Thread a `prev_hash` back-pointer through `events` and serialize them:
 * line 0 carries `genesisHash(sessionId)`, line N carries the hash of line
 * N-1's written bytes. Any `prev_hash` already present on an incoming event
 * (e.g. a round-trip import payload) is discarded and recomputed — chains are
 * never trusted from input, only derived at write time.
 */
export function chainEvents(events: ReadonlyArray<Event>, sessionId: string): ChainedEvents {
  let prev = genesisHash(sessionId);
  const lines: string[] = [];
  for (const event of events) {
    // Spread + override discards the incoming prev_hash VALUE; key order is
    // irrelevant because hashing covers the literal written bytes.
    const chained: Event = { ...event, prev_hash: prev };
    const line = serializeEventLine(chained);
    lines.push(line);
    prev = lineHash(line);
  }
  return { lines, headHash: prev, count: lines.length };
}
