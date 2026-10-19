import { normalizeIsoTimestamp } from "../../schemas/iso-timestamp.js";
import type { ClaudeTranscriptRecord } from "./transcript-importer.js";

/**
 * The `uuid` a Claude Code transcript record carries, or `undefined` when it
 * carries none (the `queue-operation`, `custom-title` and similar lines do not).
 *
 * A transcript that forks another one (a session resumed into a new session id,
 * or one started from another's conversation) opens with copies of the records
 * it took over, each keeping its `uuid` and `timestamp` while its `sessionId`
 * is rewritten. The `uuid` is therefore what identifies a record across
 * transcripts, and the first record that carries one is the conversation's root:
 * every transcript of one conversation, the original and each fork of it, opens
 * with the same one.
 */
export function claudeTranscriptRecordUuid(record: ClaudeTranscriptRecord): string | undefined {
  const uuid = record.uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

/** Options for {@link claudeTranscriptOwnRecords}. */
export type ClaudeTranscriptOwnRecordsOptions = {
  /**
   * The uuids of the records an older transcript of the same conversation holds.
   * A record carrying one of them is a copy this transcript took over, and is
   * left to the older transcript's session.
   */
  copiedUuids?: ReadonlySet<string>;
  /**
   * Records timestamped before this instant are left out: the start of the
   * session an earlier import made from this transcript. A forked transcript is
   * imported without its copies while the transcript they came from is there to
   * name them; once that one is gone, its uuids are not, and this is what keeps
   * the copies out of a later re-import. A transcript only grows at its end, so
   * for one that copied nothing this leaves out nothing.
   */
  notBefore?: string;
};

/**
 * The records of a Claude Code transcript that are its own: without the copies
 * it took over from an older transcript of the same conversation, and without
 * anything timestamped before `notBefore`. Pure; the input is not modified.
 *
 * The copies sit at the start of a forked transcript, in their original order.
 * Records without a uuid among them (the `queue-operation` lines written beside
 * a prompt) were copied with them and carry the original's timestamps, so every
 * record up to the last copy goes, and only records with a uuid of their own
 * are kept from that stretch. A record the filter cannot date is kept by
 * `notBefore`: it adds no time to a session either way.
 */
export function claudeTranscriptOwnRecords(
  records: ReadonlyArray<ClaudeTranscriptRecord>,
  options: ClaudeTranscriptOwnRecordsOptions,
): ClaudeTranscriptRecord[] {
  const copied = options.copiedUuids;
  let lastCopy = -1;
  if (copied !== undefined && copied.size > 0) {
    records.forEach((record, index) => {
      const uuid = claudeTranscriptRecordUuid(record);
      if (uuid !== undefined && copied.has(uuid)) lastCopy = index;
    });
  }
  const notBeforeMs = options.notBefore === undefined ? undefined : Date.parse(options.notBefore);
  return records.filter((record, index) => {
    const uuid = claudeTranscriptRecordUuid(record);
    if (uuid !== undefined) {
      if (copied?.has(uuid) === true) return false;
    } else if (index < lastCopy) {
      return false;
    }
    if (notBeforeMs === undefined || Number.isNaN(notBeforeMs)) return true;
    const raw = record.timestamp;
    const ts = typeof raw === "string" && raw.length > 0 ? normalizeIsoTimestamp(raw) : undefined;
    if (ts === undefined) return true;
    const ms = Date.parse(ts);
    return Number.isNaN(ms) || ms >= notBeforeMs;
  });
}
