import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isUlidBody } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import { BOARD_RECORD_VERSIONS } from "./record.js";

// The record versions this reader reads: every version a record has had
// (a version is added to BOARD_RECORD_VERSIONS, never removed).
const READABLE_VERSIONS = new Set<number>(BOARD_RECORD_VERSIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The components a record found, checked but kept as written, so that a key
// such as __proto__ stays a key of its own.
const foundSchema = z.custom<Record<string, { kinds: string[] }> | null>(
  (value) =>
    value === null ||
    (isRecord(value) &&
      Object.values(value).every(
        (c) => isRecord(c) && Array.isArray(c.kinds) && c.kinds.every((k) => typeof k === "string"),
      )),
);

// The parts of a record that are read back, kept loose: what is not named
// here is kept as it was written.
const readRecordSchema = z.looseObject({
  record_version: z.number(),
  recorded_at: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  measure: z.looseObject({
    methods: z.record(z.string(), z.number()),
    components: z.looseObject({ found: foundSchema }),
  }),
  observed: z.record(
    z.string(),
    z.looseObject({ value: z.unknown(), error: z.string().optional() }),
  ),
  cells: z.array(z.looseObject({ lane: z.string(), stage: z.string(), state: z.string() })),
  judged_by: z.looseObject({ model: z.string() }),
  axis_review: z.looseObject({ triggers: z.array(z.string()) }).nullable(),
});

/** A record as read back: the parts the board compares with, and the rest as written. */
export type ReadBoardRecord = z.output<typeof readRecordSchema>;

/** What was found where a record was looked for. */
export type PreviousOutcome<T> =
  | { status: "none" }
  | { status: "unreadable"; reason: string }
  | ({ status: "found" } & T);

/** The records a board compares with, from the `records/` beside its board.yaml. */
export type BoardPreviousRecords = {
  /** The previous record: of the files named as a ULID with `.json`, the last by name. */
  last: PreviousOutcome<{ id: string; record: ReadBoardRecord }>;
  /** The last record with an axis review, the previous one or one before it. */
  lastReview: PreviousOutcome<{ id: string; record: ReadBoardRecord }>;
};

/** The names that are records, as their ULIDs, oldest first. */
export function recordIds(names: readonly string[]): string[] {
  return names
    .filter((name) => name.endsWith(".json") && isUlidBody(name.slice(0, -".json".length)))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** No record to compare with. */
export const NO_PREVIOUS_RECORDS: BoardPreviousRecords = {
  last: { status: "none" },
  lastReview: { status: "none" },
};

/**
 * Read the records a board compares with. Only a file whose name is a ULID
 * with `.json` is a record; any other file (a temporary one, a copy) is
 * passed over. A record that cannot be read is never taken as no record:
 * what it alone would tell is then unknown, and so is anything before it.
 */
export async function readPreviousRecords(recordsDir: string): Promise<BoardPreviousRecords> {
  let names: string[];
  try {
    const entry = await lstat(recordsDir);
    if (!entry.isDirectory()) {
      const reason = "the records/ beside the board is not a directory (a symlink or a file)";
      return {
        last: { status: "unreadable", reason },
        lastReview: { status: "unreadable", reason },
      };
    }
    names = await readdir(recordsDir);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return NO_PREVIOUS_RECORDS;
    const reason = "the records/ beside the board could not be read";
    return { last: { status: "unreadable", reason }, lastReview: { status: "unreadable", reason } };
  }
  const ids = recordIds(names);

  let last: BoardPreviousRecords["last"] = { status: "none" };
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i] as string;
    const read = await readBoardRecordFile(recordsDir, id);
    if (!read.ok) {
      const unreadable = { status: "unreadable" as const, reason: read.reason };
      return { last: last.status === "none" ? unreadable : last, lastReview: unreadable };
    }
    if (last.status === "none") last = { status: "found", id, record: read.record };
    if (read.record.axis_review !== null) {
      return { last, lastReview: { status: "found", id, record: read.record } };
    }
  }
  return { last, lastReview: { status: "none" } };
}

/** Read the record named `id` in a records directory, or say why it cannot be read. */
export async function readBoardRecordFile(
  recordsDir: string,
  id: string,
): Promise<{ ok: true; record: ReadBoardRecord } | { ok: false; reason: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(recordsDir, `${id}.json`), "utf8"));
  } catch {
    return { ok: false, reason: `the record ${id} could not be read as JSON` };
  }
  const version = (value as { record_version?: unknown } | null)?.record_version;
  if (typeof version === "number" && !READABLE_VERSIONS.has(version)) {
    return {
      ok: false,
      reason: `the record ${id} is of record_version ${version}, which this basou does not read`,
    };
  }
  const parsed = readRecordSchema.safeParse(value);
  if (!parsed.success || !READABLE_VERSIONS.has(parsed.data.record_version)) {
    return { ok: false, reason: `the record ${id} is not in the shape of a record` };
  }
  return { ok: true, record: parsed.data };
}
