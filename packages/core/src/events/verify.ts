import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import type { SessionIntegrity, SessionStatus } from "../schemas/session.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readSessionYaml } from "../storage/sessions.js";
import { genesisHash, lineHash } from "./chain.js";

/**
 * Session statuses whose `events.jsonl` is at rest, so its tail and head anchor
 * are strictly checked (a torn tail / missing / mismatching anchor is
 * tampering). A live append session writes its anchor only at the terminal
 * finalize, so these are exactly the statuses a finalized log can carry.
 * `imported` and the reserved `archived` are likewise at rest.
 */
const STRICT_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed",
  "failed",
  "interrupted",
  "imported",
  "archived",
]);

// A live session's events.jsonl tail is legitimately still growing (and its
// anchor is not written until finalize), so the internal chain is verified but
// the tail / anchor checks are forgiven => `in_progress`.
function isLiveStatus(status: SessionStatus): boolean {
  return !STRICT_STATUSES.has(status);
}

/**
 * Verification outcome for one session's `events.jsonl`.
 *
 * - `unchained` — no event line carries `prev_hash` (live / ad-hoc / legacy
 *   session) and `session.yaml` carries no integrity anchor. Informational.
 * - `empty` — zero events and no integrity anchor. Informational.
 * - `incomplete` — the log is chained but `session.yaml` is ENTIRELY absent
 *   (an import crashed between the events write and the yaml write, or the
 *   yaml was deleted out of band). Benign: a re-import / `--force` repairs it.
 * - `tampered` — a real integrity break (see {@link ChainBreakReason}).
 * - `in_progress` — a chained log whose session is still LIVE (a non-terminal
 *   status: initialized / running / waiting_approval). The internal
 *   back-pointer chain is fully verified, but the tail and head anchor are
 *   forgiven because a live session's log is legitimately still growing and its
 *   anchor is not written until the terminal finalize. Informational, exit 0.
 * - `verified` — every back-pointer, genesis, session-id and line-discipline
 *   check passed AND the head anchor matches the on-disk log.
 */
export type ChainVerdictStatus =
  | "verified"
  | "unchained"
  | "empty"
  | "incomplete"
  | "in_progress"
  | "tampered";

/** Machine-readable detail for a `tampered` (or `incomplete`) verdict. */
export type ChainBreakReason =
  /** The file does not end with `\n`; chained writers always terminate the last line. */
  | "torn_tail"
  /** A blank line inside a chained log; chained writers never emit one. */
  | "blank_line"
  /** A line of a chained log failed JSON parsing; writers only emit valid JSON. */
  | "malformed_line"
  /** A chained log has a line without `prev_hash`; chained writers chain every line. */
  | "missing_prev_hash"
  /** Line 1's `prev_hash` is not this session's genesis hash (edit or cross-session copy). */
  | "genesis_mismatch"
  /** A line's `prev_hash` does not hash-match the previous line (edit / insert / delete / reorder). */
  | "broken_link"
  /** A line's `session_id` is not this session's id (cross-session copied line). */
  | "session_id_mismatch"
  /** `session.yaml` exists but its `integrity` anchor is missing (anchor stripped). */
  | "anchor_missing"
  /** The anchor's `head_hash` / `event_count` disagree with the on-disk log (edit or truncation). */
  | "anchor_mismatch"
  /** An integrity anchor exists but the log is unchained, empty, or missing (chain stripped). */
  | "anchor_without_chain"
  /** `session.yaml` exists but could not be parsed / validated, so the anchor is unreadable. */
  | "yaml_unreadable"
  /** `incomplete` only: `session.yaml` is entirely absent. */
  | "yaml_missing";

/** Result of {@link verifyEventsChain}. */
export type ChainVerdict = {
  status: ChainVerdictStatus;
  /** Complete (newline-terminated) event lines found on disk. */
  eventCount: number;
  /** Detail for `tampered` / `incomplete`; absent otherwise. */
  reason?: ChainBreakReason;
  /** 1-based line number of the first break, when one specific line broke. */
  line?: number;
};

// Three-state view of `session.yaml` as seen by the verifier. The `present`
// variant carries the session status so the verdict can forgive a live
// session's still-growing tail / not-yet-written anchor (`in_progress`).
type AnchorState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "present"; integrity: SessionIntegrity | undefined; status: SessionStatus };

/**
 * Verify the tamper-evidence hash chain of `<sessions>/<sessionId>/events.jsonl`
 * against the head anchor in `session.yaml.integrity`. READ-ONLY.
 *
 * The verifier reads the RAW line BYTES (not the schema-filtering replay
 * reader, which silently drops bad lines; and not a decoded string, which
 * would collapse invalid UTF-8 sequences into U+FFFD and let a byte-level
 * substitution survive re-hashing) and hashes exactly the bytes it read.
 * The verdict is decided on the events first, then the anchor:
 *
 * - No line carries `prev_hash` (or there are zero lines / no file): the log
 *   is unchained. If `session.yaml` nevertheless carries an integrity anchor,
 *   the chain was stripped out of band => `tampered` (`anchor_without_chain`);
 *   otherwise `unchained` / `empty`.
 * - At least one line carries `prev_hash`: the log claims to be chained, and
 *   every check applies — line discipline (terminating `\n`, no blank lines,
 *   valid JSON), genesis binding, per-line back-pointers, per-line session id,
 *   and finally the head anchor (`incomplete` when `session.yaml` is entirely
 *   absent; `tampered` when it is present without a matching anchor).
 *
 * - When the chained log belongs to a LIVE session (a non-terminal status),
 *   the internal chain is verified but a torn tail / absent / mismatching
 *   anchor is FORGIVEN as `in_progress`: a live session's tail is legitimately
 *   still growing and its anchor is written only at the terminal finalize.
 *
 * NON-CRYPTOGRAPHIC: the anchor lives in `session.yaml`, which is itself
 * editable; an attacker rewriting BOTH files consistently is not detected.
 * Signing is a follow-up.
 *
 * Throws `Error("Failed to read events.jsonl")` only for non-ENOENT I/O
 * failures (EACCES etc.) — an unreadable file is an environment problem, not
 * a verdict.
 *
 * READ-ONLY and lock-free: a session being finalized concurrently can leave the
 * two files momentarily out of step (old events read before a finalize, new
 * anchor read after it). A strict `anchor_mismatch` is therefore re-snapshotted
 * ONCE before being returned — a genuine mismatch is deterministic across the
 * retry, while a finalize-in-flight resolves within it.
 */
export async function verifyEventsChain(
  paths: BasouPaths,
  sessionId: string,
): Promise<ChainVerdict> {
  const first = await verifyOnce(paths, sessionId);
  if (first.status === "tampered" && first.reason === "anchor_mismatch") {
    return await verifyOnce(paths, sessionId);
  }
  return first;
}

async function verifyOnce(paths: BasouPaths, sessionId: string): Promise<ChainVerdict> {
  const sessionDir = join(paths.sessions, sessionId);

  let raw: Buffer | null = null;
  try {
    raw = await readFile(join(sessionDir, "events.jsonl"));
  } catch (error: unknown) {
    if (!findErrorCode(error, "ENOENT")) {
      throw new Error("Failed to read events.jsonl", { cause: error });
    }
  }

  let anchor: AnchorState;
  try {
    const session = await readSessionYaml(paths, sessionId);
    anchor = {
      kind: "present",
      integrity: session.session.integrity,
      status: session.session.status,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      anchor = { kind: "absent" };
    } else {
      anchor = { kind: "unreadable" };
    }
  }

  // Split the raw BYTES into complete (newline-terminated) lines plus an
  // optional unterminated tail fragment. A missing or empty file has neither.
  // Splitting and hashing stay at the byte level; decoding to a string
  // happens only for JSON field inspection.
  const terminated = raw === null || raw.length === 0 || raw[raw.length - 1] === 0x0a;
  const segments = raw === null ? [] : splitLinesBytes(raw);
  const tailFragment = !terminated && segments.length > 0 ? (segments.pop() as Buffer) : null;
  const lines = segments;

  // Chained-ness: does ANY parseable line (or the tail fragment) carry prev_hash?
  const carriesPrevHash = (s: Buffer): boolean => {
    try {
      const obj: unknown = JSON.parse(s.toString("utf8"));
      return typeof obj === "object" && obj !== null && "prev_hash" in obj;
    } catch {
      return false;
    }
  };
  const chained =
    lines.some((l) => l.length > 0 && carriesPrevHash(l)) ||
    (tailFragment !== null && carriesPrevHash(tailFragment));

  if (!chained) {
    // Unchained / empty logs are informational — UNLESS session.yaml anchors
    // a chain that is no longer there (one-file strip / truncate-to-zero /
    // log deletion). Legitimately unchained sessions never have an anchor:
    // only the import writers set one, and they always chain.
    if (anchor.kind === "present" && anchor.integrity !== undefined) {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: "anchor_without_chain",
      };
    }
    if (raw === null || raw.length === 0) {
      return { status: "empty", eventCount: 0 };
    }
    return { status: "unchained", eventCount: lines.length };
  }

  // The log claims to be chained: walk the back-pointer chain over the
  // complete lines, reporting the FIRST break.
  let expected = genesisHash(sessionId);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Buffer;
    const lineNo = i + 1;
    if (line.length === 0) {
      return { status: "tampered", eventCount: lines.length, reason: "blank_line", line: lineNo };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: "malformed_line",
        line: lineNo,
      };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.prev_hash !== "string") {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: "missing_prev_hash",
        line: lineNo,
      };
    }
    if (record.prev_hash !== expected) {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: i === 0 ? "genesis_mismatch" : "broken_link",
        line: lineNo,
      };
    }
    if (record.session_id !== sessionId) {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: "session_id_mismatch",
        line: lineNo,
      };
    }
    expected = lineHash(line);
  }

  // The internal back-pointer chain over the complete lines is consistent. A
  // LIVE session's tail and anchor are forgiven from here: the log is still
  // growing and the anchor is not written until the terminal finalize, so a
  // torn tail (crashed append) or absent / lagging anchor is benign.
  const live = anchor.kind === "present" && isLiveStatus(anchor.status);

  // A chained file must end in a terminating newline; for an at-rest (strict)
  // session an unterminated tail can only come from out-of-band editing (the
  // finalize wrote a terminated log). A live session may legitimately carry a
  // torn tail from a crashed in-flight append.
  if (tailFragment !== null || !terminated) {
    if (live) {
      return { status: "in_progress", eventCount: lines.length };
    }
    return {
      status: "tampered",
      eventCount: lines.length,
      reason: "torn_tail",
      line: lines.length + 1,
    };
  }

  // Events are internally consistent — now the head anchor.
  if (anchor.kind === "absent") {
    return { status: "incomplete", eventCount: lines.length, reason: "yaml_missing" };
  }
  if (anchor.kind === "unreadable") {
    return { status: "tampered", eventCount: lines.length, reason: "yaml_unreadable" };
  }
  if (live) {
    // The anchor is not authoritative until the session reaches a terminal
    // status, so it is neither required nor checked here.
    return { status: "in_progress", eventCount: lines.length };
  }
  if (anchor.integrity === undefined) {
    return { status: "tampered", eventCount: lines.length, reason: "anchor_missing" };
  }
  if (anchor.integrity.event_count !== lines.length || anchor.integrity.head_hash !== expected) {
    return { status: "tampered", eventCount: lines.length, reason: "anchor_mismatch" };
  }
  return { status: "verified", eventCount: lines.length };
}

// Byte-level line split on 0x0A. A trailing newline yields no final entry;
// content after the last newline (an unterminated tail) is returned as the
// final entry. Subarray views, no copying.
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
