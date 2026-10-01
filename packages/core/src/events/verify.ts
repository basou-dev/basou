import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { normalizeSessionTimestamps } from "../schemas/iso-timestamp.js";
import {
  SESSION_SCHEMA_VERSION,
  type SessionIntegrity,
  SessionIntegritySchema,
  SessionSchema,
  type SessionStatus,
  SessionStatusSchema,
} from "../schemas/session.schema.js";
import { SchemaVersionSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { inspectSessionEntry } from "../storage/session-dir.js";
import { readYamlFile } from "../storage/yaml-store.js";
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
 * - `unsupported` — `session.yaml` was written by a newer basou, whose rules
 *   this verifier does not know. A format major other than 0 is `unsupported`
 *   before anything is judged, the log included. A `0.x.y` newer than the one
 *   this basou writes is judged as usual, and a result that would be
 *   `tampered` is reported `unsupported` instead: the newer writer may have
 *   changed the anchor or the chain, or added a status or anchor key. Not
 *   verified, so it fails the command like `tampered`; the remedy is to
 *   upgrade basou.
 * - `verified` — every back-pointer, genesis, session-id and line-discipline
 *   check passed AND the head anchor matches the on-disk log.
 */
export type ChainVerdictStatus =
  | "verified"
  | "unchained"
  | "empty"
  | "incomplete"
  | "in_progress"
  | "unsupported"
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
  /**
   * The log is unchained, empty, or missing, but `session.yaml` has an
   * `integrity` key (chain stripped). The key's presence decides it, not
   * whether its value validates. At a newer version this is `unsupported`.
   */
  | "anchor_without_chain"
  /**
   * `session.yaml` is not at a newer version, but the verifier cannot read
   * what it needs from it: the file does not parse as YAML, its top level is
   * not a mapping or it has no `session` mapping, or its `schema_version`
   * (including one that is not a version at all), its `integrity` anchor or
   * its `status` fails validation. Reported only for a chained log. A failure
   * in any other field does not produce this (see
   * {@link ChainVerdict.sessionYamlInvalid}); at a newer version the result is
   * `unsupported` instead, and an I/O failure throws.
   */
  | "yaml_unreadable"
  /** `incomplete` only: `session.yaml` is entirely absent. */
  | "yaml_missing"
  /**
   * The entry named as the session is a symlink, whatever it points to. It is
   * not followed, so nothing is read and `eventCount` is 0. Usually the
   * session's storage was moved; moving it back repairs it.
   */
  | "symlink"
  /**
   * The entry named as the session is neither a directory nor a symlink — a
   * file, for instance. Nothing is read and `eventCount` is 0.
   */
  | "not_a_directory";

/** Result of {@link verifyEventsChain}. */
export type ChainVerdict = {
  status: ChainVerdictStatus;
  /** Complete (newline-terminated) event lines found on disk. */
  eventCount: number;
  /** Detail for `tampered` / `incomplete`; absent otherwise. */
  reason?: ChainBreakReason;
  /** 1-based line number of the first break, when one specific line broke. */
  line?: number;
  /**
   * Present (and `true`) when `session.yaml` exists but does not load as a
   * whole document: it does not parse or fails the full session schema. The
   * commands that read the whole document skip such a session with
   * `session_yaml_invalid`; they also skip an I/O failure under that code,
   * which makes this verifier throw instead. It does not decide the verdict:
   * when the format version, the anchor and the status were still readable
   * the verdict was decided on them; otherwise it is `unsupported` at a newer
   * version, and `tampered` / `yaml_unreadable` on a chained log at any other.
   */
  sessionYamlInvalid?: true;
};

// View of `session.yaml` as seen by the verifier. The `present` variant
// carries the session status so the verdict can forgive a live session's
// still-growing tail / not-yet-written anchor (`in_progress`), and whether the
// whole document validates. An `unreadable` or `unsupported` document never
// does; `unreadable` records whether an `integrity` key was there at all, so a
// stripped chain is caught even when the anchor itself cannot be read.
// `newer` marks a 0.x.y above the version this basou writes.
type AnchorState =
  | { kind: "absent" }
  | { kind: "unreadable"; anchorKeyPresent: boolean; newer: boolean }
  | { kind: "unsupported" }
  | {
      kind: "present";
      integrity: SessionIntegrity | undefined;
      status: SessionStatus;
      documentValid: boolean;
      newer: boolean;
    };

/**
 * Verify the tamper-evidence hash chain of `<sessions>/<sessionId>/events.jsonl`
 * against the head anchor in `session.yaml.integrity`. READ-ONLY.
 *
 * The verifier reads the RAW line BYTES (not the schema-filtering replay
 * reader, which silently drops bad lines; and not a decoded string, which
 * would collapse invalid UTF-8 sequences into U+FFFD and let a byte-level
 * substitution survive re-hashing) and hashes exactly the bytes it read.
 * Apart from a newer writer's document (below), the verdict is decided on the
 * events first, then the anchor:
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
 * From `session.yaml` the verifier reads exactly three fields, each against its
 * own schema: the `schema_version` format gate, the `integrity` anchor, and
 * the `status` that decides whether the anchor is due yet. A validation
 * failure anywhere else in the document says nothing about the log, so it
 * does not change the verdict — otherwise a narrowing of an unrelated field
 * would report tampering that did not happen. Whether the whole document
 * loads is reported beside the verdict as `sessionYamlInvalid`.
 *
 * A document a newer basou wrote is told apart by its version, not by what
 * fails. A format major other than 0 is `unsupported` before the events are
 * read. A version newer than {@link SESSION_SCHEMA_VERSION} is judged as
 * usual, and a `tampered` result becomes `unsupported`: the spec requires a
 * change to what this verifier reads — the anchor's keys or meaning, the
 * status values — to move the version, so under a newer version a result
 * that looks like tampering may be the newer rules. At a version this basou
 * knows, a failure is damage (`yaml_unreadable`).
 *
 * NON-CRYPTOGRAPHIC: the anchor lives in `session.yaml`, which is itself
 * editable; an attacker rewriting BOTH files consistently is not detected.
 * Signing is a follow-up.
 *
 * An entry at the session's name that is not a directory is `tampered` before
 * anything is read — `symlink` for a symlink, `not_a_directory` for anything
 * else (a file) — and is never followed.
 *
 * Throws `Error("Failed to read events.jsonl")`, or an error naming the
 * session for the session directory or `session.yaml` (`Failed to read
 * session.yaml of <id>`), only for non-ENOENT I/O failures (EACCES etc.) — an
 * unreadable file is an environment problem, not a verdict. A
 * `.basou/sessions` that is a symlink or not a directory throws too (the
 * `assertSessionStoreSafe` errors): no session in it is judged. So does a
 * `sessionId` that is not a session id (`"Invalid session id"`).
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

  // A session is a directory inside the store. Anything else at its name is
  // not followed: reading through a symlink would verify files outside the
  // store, and an absent directory falls through to `empty` as before.
  const entry = await inspectSessionEntry(paths, sessionId);
  if (entry === "symlink" || entry === "not_a_directory") {
    return { status: "tampered", eventCount: 0, reason: entry };
  }

  let raw: Buffer | null = null;
  try {
    raw = await readFile(join(sessionDir, "events.jsonl"));
  } catch (error: unknown) {
    if (!findErrorCode(error, "ENOENT")) {
      throw new Error("Failed to read events.jsonl", { cause: error });
    }
  }

  const anchor = await readAnchorState(paths, sessionId);
  const judged = judgeChain(raw, anchor, sessionId);
  const newer = (anchor.kind === "present" || anchor.kind === "unreadable") && anchor.newer;
  const verdict: ChainVerdict =
    newer && judged.status === "tampered"
      ? { status: "unsupported", eventCount: judged.eventCount }
      : judged;
  const documentInvalid =
    anchor.kind === "present" ? !anchor.documentValid : anchor.kind !== "absent";
  return documentInvalid ? { ...verdict, sessionYamlInvalid: true } : verdict;
}

// Read the three fields the verdict depends on, each against its own schema,
// and record separately whether the whole document validates. A format major
// other than 0 is `unsupported` outright; any other failure is `unreadable`,
// marked `newer` when the version is a 0.x.y above the one this basou writes.
// An I/O failure other than ENOENT throws.
async function readAnchorState(paths: BasouPaths, sessionId: string): Promise<AnchorState> {
  let raw: unknown;
  try {
    raw = await readYamlFile(join(paths.sessions, sessionId, "session.yaml"));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      return { kind: "absent" };
    }
    if (error instanceof Error && error.message === "Failed to parse YAML content") {
      return { kind: "unreadable", anchorKeyPresent: false, newer: false };
    }
    throw new Error(`Failed to read session.yaml of ${sessionId}`, { cause: error });
  }
  if (!isRecord(raw)) return { kind: "unreadable", anchorKeyPresent: false, newer: false };
  const standing = formatStanding(raw.schema_version);
  if (standing === "foreign_major") return { kind: "unsupported" };
  const newer = standing === "newer";
  const inner = isRecord(raw.session) ? raw.session : null;
  const unreadable: AnchorState = {
    kind: "unreadable",
    anchorKeyPresent: inner !== null && Object.hasOwn(inner, "integrity"),
    newer,
  };
  if (!SchemaVersionSchema.safeParse(raw.schema_version).success) return unreadable;
  if (inner === null) return unreadable;
  const status = SessionStatusSchema.safeParse(inner.status);
  if (!status.success) return unreadable;
  let integrity: SessionIntegrity | undefined;
  if (inner.integrity !== undefined) {
    const parsed = SessionIntegritySchema.safeParse(inner.integrity);
    if (!parsed.success) return unreadable;
    integrity = parsed.data;
  }
  return {
    kind: "present",
    integrity,
    status: status.data,
    documentValid: SessionSchema.safeParse(normalizeSessionTimestamps(raw)).success,
    newer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// How a stored `schema_version` stands against the format this basou writes.
// `foreign_major`: it starts with a major other than 0 (a pre-release suffix
// does not change that). `newer`: a plain 0.x.y above SESSION_SCHEMA_VERSION.
// `other`: an older or equal version, or not a version at all — a number with
// a leading zero included, so `0.03.0` is not read as 0.3.0.
function formatStanding(version: unknown): "foreign_major" | "newer" | "other" {
  if (typeof version !== "string") return "other";
  const major = /^(0|[1-9]\d*)\./.exec(version);
  if (major === null) return "other";
  if (major[1] !== "0") return "foreign_major";
  const full = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const stored = full.exec(version);
  const known = full.exec(SESSION_SCHEMA_VERSION);
  if (stored === null || known === null) return "other";
  const [storedMinor, storedPatch] = [Number(stored[1]), Number(stored[2])];
  const [knownMinor, knownPatch] = [Number(known[1]), Number(known[2])];
  const isNewer =
    storedMinor > knownMinor || (storedMinor === knownMinor && storedPatch > knownPatch);
  return isNewer ? "newer" : "other";
}

function judgeChain(raw: Buffer | null, anchor: AnchorState, sessionId: string): ChainVerdict {
  // Split the raw BYTES into complete (newline-terminated) lines plus an
  // optional unterminated tail fragment. A missing or empty file has neither.
  // Splitting and hashing stay at the byte level; decoding to a string
  // happens only for JSON field inspection.
  const terminated = raw === null || raw.length === 0 || raw[raw.length - 1] === 0x0a;
  const segments = raw === null ? [] : splitLinesBytes(raw);
  const tailFragment = !terminated && segments.length > 0 ? (segments.pop() as Buffer) : null;
  const lines = segments;

  // A format major this basou does not read: its rules are unknown, so
  // nothing is judged, the log included.
  if (anchor.kind === "unsupported") {
    return { status: "unsupported", eventCount: lines.length };
  }

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
    const anchorPresent =
      (anchor.kind === "present" && anchor.integrity !== undefined) ||
      (anchor.kind === "unreadable" && anchor.anchorKeyPresent);
    if (anchorPresent) {
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
    // A line that parses to something other than an object (`null`, a number,
    // a string, an array) carries no `prev_hash` either.
    if (!isRecord(parsed) || typeof parsed.prev_hash !== "string") {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: "missing_prev_hash",
        line: lineNo,
      };
    }
    if (parsed.prev_hash !== expected) {
      return {
        status: "tampered",
        eventCount: lines.length,
        reason: i === 0 ? "genesis_mismatch" : "broken_link",
        line: lineNo,
      };
    }
    if (parsed.session_id !== sessionId) {
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
