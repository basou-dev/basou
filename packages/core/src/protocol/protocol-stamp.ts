import { createHash } from "node:crypto";
import { PROTOCOL_END } from "../storage/markdown-store.js";

/**
 * The sync stamp carried INSIDE the managed protocol block, and the rule that
 * decides whether a running session is holding an out-of-date copy of it.
 *
 * Why a stamp in the block at all. `basou protocol sync` renders the declared
 * protocols into a user-global instruction file the AI tool auto-loads at
 * SESSION START. Update a protocol while a session is running and that session
 * keeps following the text it read at start — not a violation, the new text
 * simply never reached it. basou is a read-only reader: it cannot observe what
 * a running session holds, and it cannot observe whether an agent re-read
 * anything. What it CAN observe is when the block last changed, so the block
 * records that itself rather than basou keeping a side file. The stamp travels
 * with the bytes it describes: restore the file from a backup and the stamp
 * that comes back is the one for that content.
 *
 * The unit is the BLOCK, not the source file, because the block is what a
 * session read. Stamping sources would be blind to every way the rendered text
 * can change without a source's bytes changing — a reorder, a retitle, a
 * protocol withdrawn from the config — and a withdrawal is the most urgent case
 * of all: an operator deletes a rule because it is doing harm in the session
 * running right now. Block-level also makes the delivery honest. What is handed
 * over is the complete current set, so "this supersedes what you read" is
 * literally true, and there is no claim about WHICH protocol moved that the
 * session would have to take on trust.
 *
 * It also keeps the reader small. The hook parses one block and needs neither
 * the protocols config nor any source file, so a config that moved cannot make
 * the feature silently dead, and an edit the operator has NOT synced cannot
 * reach a session: unsynced text is not in the block, so there is nothing to
 * check and nothing to leak.
 *
 * `changedAt` moves only when the rendered text changes, so a no-op
 * `protocol sync` renders byte-identical bytes and the channel's "unchanged"
 * path still holds. That is also why the stamp has no last-synced-at field:
 * one would differ on every run and churn the operator's file.
 */

/**
 * Opening token of the stamp line, version included and closed by a SPACE.
 *
 * The trailing space is the version hinge: without it `startsWith` on "v1"
 * would also match a future "v10" line and half-parse it. Once v1 readers are
 * published there is no fixing that, so the delimiter is here from the start.
 */
const STAMP_PREFIX = "<!-- basou:protocols v1 ";

/** Hex digits kept from the rendered-text digest. */
const CONTENT_HASH_LENGTH = 16;

/** Prefix of the token embedded in a delivery; the content digest follows it. */
export const PROTOCOL_UPDATE_TOKEN_PREFIX = "basou:protocol-updated";

/** What the block records about itself. */
export type ProtocolStamp = {
  /** When the block's rendered protocol text last CHANGED (ISO 8601, UTC). */
  changedAt: string;
  /** Truncated digest of that rendered text. */
  contentHash: string;
};

/** Truncated digest of the block's rendered protocol text. */
export function protocolBlockHash(sections: string): string {
  return createHash("sha256").update(sections, "utf8").digest("hex").slice(0, CONTENT_HASH_LENGTH);
}

/**
 * The delivery's dedupe token for a given block state.
 *
 * It carries the content digest rather than being a bare literal, so "already
 * delivered" means "already delivered THIS text". A second update inside one
 * session — usually the correction of the first, after watching an agent
 * misapply it — is a different digest and still lands. A bare literal would
 * make the one edit most worth delivering the one guaranteed not to arrive.
 */
export function protocolUpdateToken(contentHash: string): string {
  return `${PROTOCOL_UPDATE_TOKEN_PREFIX}:${contentHash}`;
}

/**
 * Render the stamp line.
 *
 * Nothing operator-authored goes on it — only a timestamp and a digest — so a
 * source path or a protocol body containing a space, a quote, or a `-->` cannot
 * break the line it is rendered into.
 */
export function renderProtocolStamp(stamp: ProtocolStamp): string {
  return `${STAMP_PREFIX}changed=${stamp.changedAt} content=${stamp.contentHash} -->`;
}

/**
 * Find and parse the stamp line in a rendered block body.
 *
 * Returns `null` when the block carries no readable stamp — a block rendered by
 * a basou older than this feature, a hand-deleted stamp, a mangled one. A null
 * means "cannot tell", and every caller treats it as "say nothing": the point
 * of the feature is to speak only when basou actually knows something changed.
 */
export function parseProtocolStamp(blockBody: string): ProtocolStamp | null {
  const line = blockBody.split(/\r?\n/).find((l) => l.startsWith(STAMP_PREFIX));
  if (line === undefined) return null;
  const inner = line
    .slice(STAMP_PREFIX.length)
    .replace(/-->\s*$/, "")
    .trim();
  let changedAt: string | undefined;
  let contentHash: string | undefined;
  for (const field of inner.split(/\s+/)) {
    const eq = field.indexOf("=");
    if (eq <= 0) continue;
    const name = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (name === "changed") changedAt = value;
    else if (name === "content") contentHash = value;
  }
  if (changedAt === undefined || contentHash === undefined) return null;
  if (changedAt.length === 0 || contentHash.length === 0) return null;
  if (Number.isNaN(Date.parse(changedAt))) return null;
  return { changedAt, contentHash };
}

/**
 * Build the stamp for the block about to be written: keep the previous
 * `changedAt` when the rendered text is unchanged, and set it to `now`
 * otherwise.
 *
 * `sections` is the rendered protocol text exactly as it will appear under the
 * stamp — the same bytes a session reads and the same bytes a delivery carries.
 * Hashing anything else (the raw source files, say) would let bytes no session
 * ever sees move the stamp, and basou would then tell a session that text it
 * already holds supersedes what it already holds.
 *
 * `changedAt` is forced strictly forward when the text did change. Wall-clock
 * time can move backwards — an NTP correction, a laptop waking in another
 * timezone — and a stamp dated before the session start would drop the delivery
 * for the rest of that session, silently and permanently.
 */
export function carryForwardProtocolStamp(input: {
  sections: string;
  previous: ProtocolStamp | null;
  now: string;
}): ProtocolStamp {
  const contentHash = protocolBlockHash(input.sections);
  if (input.previous !== null && input.previous.contentHash === contentHash) {
    return input.previous;
  }
  return { changedAt: forwardOf(input.now, input.previous), contentHash };
}

/** `now`, or one millisecond past the previous stamp when the clock went back. */
function forwardOf(now: string, previous: ProtocolStamp | null): string {
  if (previous === null) return now;
  const nowMs = Date.parse(now);
  const beforeMs = Date.parse(previous.changedAt);
  if (Number.isNaN(nowMs) || Number.isNaN(beforeMs) || nowMs > beforeMs) return now;
  return new Date(beforeMs + 1).toISOString();
}

/**
 * The rendered protocol text inside a block: everything below the stamp line.
 *
 * Anchored on the stamp rather than on "skip the leading comments" so a
 * protocol whose own body opens with an HTML comment keeps it. Returns `null`
 * when there is no stamp line to anchor on, and an empty string when the block
 * holds a stamp and nothing else.
 *
 * Takes a block BODY, but stops at a closing marker line if one is present, so
 * handing it a whole file yields the same answer instead of a digest that
 * silently includes the marker and matches nothing.
 */
export function protocolSectionsFrom(blockBody: string): string | null {
  const lines = blockBody.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(STAMP_PREFIX));
  if (at === -1) return null;
  return sectionsAfter(lines.slice(at + 1));
}

/**
 * The rendered protocol text inside a block written before stamps existed:
 * everything below the managed note.
 *
 * Only for reading the block an upgrade is about to replace. Knowing what that
 * block held is what lets an upgrade stay silent — if the text is the same, no
 * running session is owed anything, and dating the new stamp at `now` would
 * announce a change to every session on the machine the first time the new
 * basou syncs. Less precise than the stamped path (a protocol body opening
 * with its own HTML comment loses that line here), which is why it is confined
 * to blocks that carry no stamp: a wrong answer costs one redundant delivery,
 * never a wrong one.
 */
export function unstampedProtocolSectionsFrom(blockBody: string): string {
  const lines = blockBody.split(/\r?\n/);
  while (lines.length > 0) {
    const first = (lines[0] ?? "").trim();
    if (first.length === 0 || first.startsWith("<!--")) lines.shift();
    else break;
  }
  return sectionsAfter(lines);
}

/** Trim a block's trailing marker and surrounding blank lines to the text itself. */
function sectionsAfter(lines: string[]): string {
  const closing = lines.indexOf(PROTOCOL_END);
  const body = closing === -1 ? [...lines] : lines.slice(0, closing);
  while (body.length > 0 && (body[0] ?? "").trim().length === 0) body.shift();
  return body.join("\n").replace(/\s+$/, "");
}

/**
 * Whether a session that started at `sessionStartedAt` is holding an older copy
 * of the block than the one the stamp describes.
 *
 * A change dated at or before the start is one the session already read. An
 * unparseable start yields `false` rather than "everything": without a session
 * start there is no "after".
 */
export function isProtocolUpdateDue(input: {
  stamp: ProtocolStamp;
  sessionStartedAt: string;
}): boolean {
  const startedMs = Date.parse(input.sessionStartedAt);
  if (Number.isNaN(startedMs)) return false;
  return Date.parse(input.stamp.changedAt) > startedMs;
}

/**
 * The text handed to the running session: the protocols themselves, not a
 * pointer to them.
 *
 * basou cannot observe whether an agent re-read a file, so a notice saying "go
 * and re-read" would put the one step that decides the outcome outside what
 * basou can see. Carrying the text makes the delivery and the reading the same
 * act. It does not make the ADOPTION observable — nothing basou can do would —
 * but it removes the step that was avoidably invisible.
 *
 * The complete current set is sent, not a diff, so the lead line's claim is
 * exactly true: after this, the set below is the whole of the standing
 * protocols, and anything read at session start that is absent here is gone.
 */
export function renderProtocolUpdate(sections: string, stamp: ProtocolStamp): string {
  return [
    `The standing protocols changed after this session started (${protocolUpdateToken(stamp.contentHash)}). ` +
      "What follows is the COMPLETE current set and SUPERSEDES the copy read at session start — " +
      "follow it for the rest of the session, and treat anything read earlier but absent below as withdrawn.",
    sections,
  ].join("\n\n");
}
